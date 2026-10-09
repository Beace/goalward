//! Read-only, user-level discovery. These DTOs deliberately deserialize only model fields.
//! No credential file, shell profile, project config, or plugin code is read here.
//! TraeX also queries its CLI model catalog, which may refresh its own cache over the network.
mod pi;
mod traex;
use crate::{
    discovery,
    types::{DiscoveredModel, DiscoveredRuntime, LocalEnvironmentReport, ProbeResult},
};
use serde::de::DeserializeOwned;
use serde::Deserialize;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    collections::BTreeMap,
    env,
    fs::OpenOptions,
    io::Read,
    path::{Path, PathBuf},
    thread,
};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MODELS: usize = 256;
const MAX_PROFILES: usize = 128;
const MODEL_REASONING_EFFORTS: [&str; 8] = [
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];
const CLAUDE_MODEL_ENV: [&str; 5] = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
];
const RUNTIMES: [(&str, &str, &str, &str); 6] = [
    ("codex", "Codex", "codex", "codex"),
    ("claude", "Claude Code", "claude", "claude"),
    ("traex", "TraeX", "traex", "codex"),
    ("deepseek-harness", "DeepSeek Harness", "dsh", "generic"),
    ("kimi", "Kimi CLI", "kimi", "kimi"),
    ("pi", "Pi", "pi", "pi"),
];

struct Locations {
    codex: PathBuf,
    claude: PathBuf,
    traex: PathBuf,
    dsh: PathBuf,
    kimi: PathBuf,
    pi: PathBuf,
    claude_env: BTreeMap<String, String>,
}

impl Locations {
    fn current() -> Self {
        let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let config_dir = |key: &str, fallback: &str| {
            env::var_os(key)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .unwrap_or_else(|| home.join(fallback))
        };
        Self {
            codex: config_dir("CODEX_HOME", ".codex"),
            claude: config_dir("CLAUDE_CONFIG_DIR", ".claude"),
            traex: config_dir("TRAE_HOME", ".trae"),
            dsh: config_dir("DSH_HOME", ".dsh"),
            kimi: config_dir("KIMI_CODE_HOME", ".kimi-code"),
            pi: config_dir("PI_CODING_AGENT_DIR", ".pi/agent"),
            claude_env: CLAUDE_MODEL_ENV
                .iter()
                .filter_map(|key| env::var(key).ok().map(|value| ((*key).into(), value)))
                .collect(),
        }
    }
}

/// Runs bounded `--version` probes concurrently. This is called on Tauri's blocking pool.
pub fn discover() -> LocalEnvironmentReport {
    let locations = Locations::current();
    let probes = thread::scope(|scope| {
        let handles: Vec<_> = RUNTIMES
            .iter()
            .map(|(_, _, executable, _)| scope.spawn(move || discovery::probe(executable)))
            .collect();
        handles
            .into_iter()
            .map(|handle| {
                handle.join().unwrap_or_else(|_| ProbeResult {
                    found: false,
                    path: String::new(),
                    version: String::new(),
                    error: Some("Runtime 检测未能完成".into()),
                })
            })
            .collect()
    });
    build_report(&locations, probes)
}

fn build_report(locations: &Locations, probes: Vec<ProbeResult>) -> LocalEnvironmentReport {
    let runtimes = RUNTIMES
        .iter()
        .zip(probes)
        .map(|((id, name, executable, adapter), probe)| {
            let mut runtime = DiscoveredRuntime {
                id: (*id).into(),
                name: (*name).into(),
                executable: (*executable).into(),
                adapter: (*adapter).into(),
                probe,
                models: Vec::new(),
                config_sources: Vec::new(),
                warnings: Vec::new(),
            };
            match *id {
                "codex" => discover_codex(&locations.codex, &mut runtime),
                "claude" => discover_claude(&locations.claude, &locations.claude_env, &mut runtime),
                "traex" => traex::discover(&locations.traex, &mut runtime),
                "deepseek-harness" => discover_dsh(&locations.dsh, &mut runtime),
                "kimi" => discover_kimi(&locations.kimi, &mut runtime),
                "pi" => pi::discover(&locations.pi, &mut runtime),
                _ => {
                    if runtime.probe.found {
                        runtime.warnings.push(
                            "尚未接入此 Runtime 的模型配置格式，请在设置中添加模型与启动参数"
                                .into(),
                        );
                    }
                }
            }
            if !runtime.models.is_empty() {
                runtime
                    .warnings
                    .push("模型来自配置、缓存或 CLI 列表，尚未验证实际可调用性".into());
            }
            runtime
        })
        .collect();
    LocalEnvironmentReport {
        scanned_at: chrono::Utc::now().to_rfc3339(),
        runtimes,
    }
}

fn read_file(path: &Path, runtime: &mut DiscoveredRuntime) -> Option<String> {
    // O_NONBLOCK prevents a malformed config path pointing at a FIFO from hanging
    // before metadata validation. Regular files retain ordinary read semantics.
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK);
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => {
            runtime
                .warnings
                .push(format!("无法读取配置文件：{}", path.display()));
            return None;
        }
    };
    runtime
        .config_sources
        .push(path.to_string_lossy().into_owned());
    if !file
        .metadata()
        .map(|metadata| metadata.is_file() && metadata.len() <= MAX_FILE_BYTES)
        .unwrap_or(false)
    {
        runtime.warnings.push(format!(
            "跳过非普通文件或超过 2 MiB 的配置：{}",
            path.display()
        ));
        return None;
    }
    let mut bytes = Vec::new();
    if file
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_FILE_BYTES
    {
        runtime
            .warnings
            .push(format!("配置读取失败或超过大小限制：{}", path.display()));
        return None;
    }
    match String::from_utf8(bytes) {
        Ok(text) => Some(text),
        Err(_) => {
            runtime
                .warnings
                .push(format!("配置不是有效 UTF-8：{}", path.display()));
            None
        }
    }
}

fn read_json<T: DeserializeOwned>(path: &Path, runtime: &mut DiscoveredRuntime) -> Option<T> {
    let text = read_file(path, runtime)?;
    match serde_json::from_str(&text) {
        Ok(value) => Some(value),
        Err(_) => {
            runtime
                .warnings
                .push(format!("JSON 模型配置无法解析：{}", path.display()));
            None
        }
    }
}

fn safe_id(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= 200
        && !value.starts_with("sk-")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:/@[]+".contains(&byte)))
    .then_some(value)
}

fn add_model(
    runtime: &mut DiscoveredRuntime,
    id: &str,
    name: Option<&str>,
    source: &str,
    selected: bool,
) {
    let Some(id) = safe_id(id) else {
        return;
    };
    if let Some(existing) = runtime.models.iter_mut().find(|model| model.model_id == id) {
        existing.selected |= selected;
        if existing.name == id {
            if let Some(name) = name.filter(|value| {
                value.chars().count() <= 100 && !value.chars().any(char::is_control)
            }) {
                existing.name = name.into();
            }
        }
        if !existing.source.split(" · ").any(|item| item == source)
            && existing.source.len() + source.len() < 600
        {
            existing.source.push_str(" · ");
            existing.source.push_str(source);
        }
        return;
    }
    if runtime.models.len() >= MAX_MODELS {
        let warning = "模型条目过多，仅显示前 256 个".to_string();
        if !runtime.warnings.contains(&warning) {
            runtime.warnings.push(warning);
        }
        return;
    }
    let name = name
        .filter(|value| value.chars().count() <= 100 && !value.chars().any(char::is_control))
        .unwrap_or(id);
    runtime.models.push(DiscoveredModel {
        aliases: Vec::new(),
        model_id: id.into(),
        name: name.into(),
        source: source.into(),
        selected,
        supported_reasoning_efforts: None,
    });
}

#[derive(Default, Deserialize)]
struct CodexConfig {
    model: Option<String>,
    profile: Option<String>,
    #[serde(default)]
    profiles: BTreeMap<String, CodexProfile>,
    model_catalog_json: Option<String>,
}

#[derive(Default, Deserialize)]
struct CodexProfile {
    model: Option<String>,
    model_catalog_json: Option<String>,
}

#[derive(Deserialize)]
struct CodexCatalog {
    models: Vec<CodexModel>,
}
#[derive(Deserialize)]
struct CodexModel {
    slug: String,
    display_name: Option<String>,
    visibility: Option<String>,
    supported_reasoning_levels: Option<Vec<CodexReasoningLevel>>,
}

#[derive(Deserialize)]
struct CodexReasoningLevel {
    effort: String,
}

fn discover_codex(directory: &Path, runtime: &mut DiscoveredRuntime) {
    let path = directory.join("config.toml");
    let config =
        read_file(&path, runtime).and_then(|text| match toml::from_str::<CodexConfig>(&text) {
            Ok(value) => Some(value),
            Err(_) => {
                runtime
                    .warnings
                    .push(format!("TOML 模型配置无法解析：{}", path.display()));
                None
            }
        });
    if let Some(config) = config {
        let active = config
            .profile
            .as_ref()
            .and_then(|name| config.profiles.get(name));
        let selected = active
            .and_then(|profile| profile.model.as_deref())
            .or(config.model.as_deref());
        if let Some(model) = selected {
            add_model(
                runtime,
                model,
                None,
                if active.and_then(|profile| profile.model.as_ref()).is_some() {
                    "config.toml / 当前 profile"
                } else {
                    "config.toml / model"
                },
                true,
            );
        }
        if let Some(model) = &config.model {
            add_model(
                runtime,
                model,
                None,
                "config.toml / model",
                selected == Some(model.as_str()),
            );
        }
        for (name, profile) in config.profiles.iter().take(MAX_PROFILES) {
            if let Some(model) = &profile.model {
                let label = safe_id(name).unwrap_or("已配置 profile");
                add_model(
                    runtime,
                    model,
                    None,
                    &format!("config.toml / profiles.{label}.model"),
                    config.profile.as_ref() == Some(name) && selected == Some(model.as_str()),
                );
            }
        }
        if config.profiles.len() > MAX_PROFILES {
            runtime
                .warnings
                .push("Profile 过多，仅检查前 128 个及当前选中项".into());
        }
        if config.profile.is_some() && active.is_none() {
            runtime
                .warnings
                .push("config.toml 指定的 profile 不存在，默认模型需确认".into());
            for model in &mut runtime.models {
                model.selected = false;
            }
        }
        if let Some(catalog) = active
            .and_then(|profile| profile.model_catalog_json.as_ref())
            .or(config.model_catalog_json.as_ref())
        {
            let catalog = PathBuf::from(catalog);
            let path = if catalog.is_absolute() {
                catalog
            } else {
                directory.join(catalog)
            };
            read_codex_catalog(&path, "本机模型目录", runtime);
        }
    }
    read_codex_catalog(
        &directory.join("models_cache.json"),
        "models_cache.json / 缓存",
        runtime,
    );
    runtime
        .warnings
        .push("仅检查用户级配置；项目配置、托管策略和启动参数可能覆盖默认模型".into());
}

fn read_codex_catalog(path: &Path, source: &str, runtime: &mut DiscoveredRuntime) {
    if let Some(catalog) = read_json::<CodexCatalog>(path, runtime) {
        for model in catalog
            .models
            .iter()
            .take(MAX_MODELS + 1)
            .filter(|model| model.visibility.as_deref() != Some("hide"))
        {
            add_model(
                runtime,
                &model.slug,
                model.display_name.as_deref(),
                source,
                false,
            );
            // The configured catalog is read before the shared cache. Its explicit
            // capability list (including an empty one) takes precedence. Only the
            // verified effort IDs leave this boundary; descriptions and other
            // catalog fields are deliberately not deserialized or returned.
            if let (Some(id), Some(levels)) =
                (safe_id(&model.slug), &model.supported_reasoning_levels)
            {
                if let Some(existing) = runtime.models.iter_mut().find(|item| item.model_id == id) {
                    if existing.supported_reasoning_efforts.is_none() {
                        let efforts = MODEL_REASONING_EFFORTS
                            .iter()
                            .filter(|effort| levels.iter().any(|level| level.effort == **effort))
                            .map(|effort| (*effort).to_string())
                            .collect();
                        existing.supported_reasoning_efforts = Some(efforts);
                    }
                }
            }
        }
    }
}

#[derive(Default, Deserialize)]
struct ClaudeSettings {
    model: Option<String>,
    #[serde(default)]
    env: ClaudeEnv,
}
#[derive(Default, Deserialize)]
struct ClaudeEnv {
    #[serde(rename = "ANTHROPIC_MODEL")]
    model: Option<String>,
    #[serde(rename = "ANTHROPIC_DEFAULT_OPUS_MODEL")]
    opus: Option<String>,
    #[serde(rename = "ANTHROPIC_DEFAULT_SONNET_MODEL")]
    sonnet: Option<String>,
    #[serde(rename = "ANTHROPIC_DEFAULT_HAIKU_MODEL")]
    haiku: Option<String>,
    #[serde(rename = "CLAUDE_CODE_SUBAGENT_MODEL")]
    subagent: Option<String>,
}

fn discover_claude(
    directory: &Path,
    inherited: &BTreeMap<String, String>,
    runtime: &mut DiscoveredRuntime,
) {
    let settings =
        read_json::<ClaudeSettings>(&directory.join("settings.json"), runtime).unwrap_or_default();
    let values = [
        &settings.env.model,
        &settings.env.opus,
        &settings.env.sonnet,
        &settings.env.haiku,
        &settings.env.subagent,
    ];
    // Settings env values are applied by Claude when it starts. A conflicting inherited
    // ANTHROPIC_MODEL cannot be resolved safely here, so neither is marked selected.
    let inherited_model = inherited.get("ANTHROPIC_MODEL");
    let conflict = inherited_model.is_some()
        && settings.env.model.is_some()
        && inherited_model != settings.env.model.as_ref();
    let selected = if conflict {
        None
    } else {
        settings
            .env
            .model
            .as_ref()
            .or(inherited_model)
            .or(settings.model.as_ref())
    };
    if let Some(model) = selected {
        add_model(runtime, model, None, "Claude Code / 当前模型配置", true);
    }
    if let Some(model) = &settings.model {
        add_model(
            runtime,
            model,
            None,
            "settings.json / model",
            selected == Some(model),
        );
    }
    for (key, value) in CLAUDE_MODEL_ENV.iter().zip(values) {
        if let Some(model) = value {
            add_model(
                runtime,
                model,
                None,
                &format!("settings.json / env.{key}"),
                *key == "ANTHROPIC_MODEL" && selected == Some(model),
            );
        }
        if let Some(model) = inherited.get(*key) {
            add_model(
                runtime,
                model,
                None,
                &format!("进程环境 / {key}"),
                *key == "ANTHROPIC_MODEL" && selected == Some(model),
            );
        }
    }
    if conflict {
        runtime
            .warnings
            .push("进程环境和 settings.json 指定了不同默认模型，保留 Runtime 自身选择".into());
    }
    runtime.warnings.push(
        "仅检查用户级配置和已继承的模型环境变量；项目或托管配置可能覆盖，未读取 shell 启动文件"
            .into(),
    );
}

// Only model aliases, display names and supported effort IDs are deserialized; provider credentials,
// hooks, MCP configuration and project files are neither surfaced nor executed.
#[derive(Default, Deserialize)]
struct KimiConfig {
    default_model: Option<String>,
    #[serde(default)]
    models: BTreeMap<String, KimiModel>,
}
#[derive(Default, Deserialize)]
struct KimiModel {
    display_name: Option<String>,
    support_efforts: Option<Vec<String>>,
    overrides: Option<KimiModelOverride>,
}
#[derive(Default, Deserialize)]
struct KimiModelOverride {
    display_name: Option<String>,
    support_efforts: Option<Vec<String>>,
}

fn discover_kimi(directory: &Path, runtime: &mut DiscoveredRuntime) {
    let path = directory.join("config.toml");
    if let Some(text) = read_file(&path, runtime) {
        match toml::from_str::<KimiConfig>(&text) {
            Ok(config) => {
                for (alias, model) in config.models.iter().take(MAX_MODELS + 1) {
                    let name = model
                        .overrides
                        .as_ref()
                        .and_then(|value| value.display_name.as_deref())
                        .or(model.display_name.as_deref());
                    add_model(
                        runtime,
                        alias,
                        name,
                        "Kimi Code config.toml / models alias",
                        config.default_model.as_ref() == Some(alias),
                    );
                    // Kimi resolves an explicitly present override before the base field,
                    // including an empty override. Missing/empty capabilities are authoritative:
                    // emit [] so a fresh import can clear an older discovered capability list.
                    // The global thinking preference and model default_effort stay with Kimi.
                    let levels = model
                        .overrides
                        .as_ref()
                        .and_then(|value| value.support_efforts.as_deref())
                        .or(model.support_efforts.as_deref())
                        .unwrap_or_default();
                    if let Some(id) = safe_id(alias) {
                        if let Some(existing) =
                            runtime.models.iter_mut().find(|item| item.model_id == id)
                        {
                            existing.supported_reasoning_efforts = Some(
                                MODEL_REASONING_EFFORTS
                                    .iter()
                                    .filter(|effort| levels.iter().any(|level| level == **effort))
                                    .map(|effort| (*effort).to_string())
                                    .collect(),
                            );
                        }
                    }
                }
                if let Some(model) = &config.default_model {
                    if !config.models.contains_key(model) {
                        runtime.warnings.push(
                            "Kimi 默认模型别名不在 models 中，请在 Kimi CLI 中修复配置".into(),
                        );
                    }
                }
            }
            Err(_) => runtime
                .warnings
                .push("Kimi Code config.toml 模型配置无法解析".into()),
        }
    }
    runtime.warnings.push("使用 Kimi Code CLI 的 ACP 协议；执行前确认手动审批模式。模型与思考设置默认继承 Runtime，旧 Python kimi-cli 不兼容".into());
}

#[derive(Default, Deserialize)]
struct DshSettings {
    #[serde(rename = "agent-default-model")]
    default_model: Option<DshDefault>,
    #[serde(rename = "llm-pi-ai", default)]
    pi_ai: DshProviders,
}
#[derive(Deserialize)]
struct DshDefault {
    model: String,
}
#[derive(Default, Deserialize)]
struct DshProviders {
    #[serde(default)]
    providers: BTreeMap<String, DshProvider>,
}
#[derive(Deserialize)]
struct DshProvider {
    #[serde(default)]
    models: Vec<DshModel>,
}
#[derive(Deserialize)]
struct DshModel {
    id: String,
    name: Option<String>,
}

fn discover_dsh(directory: &Path, runtime: &mut DiscoveredRuntime) {
    let path = directory.join("settings.yaml");
    let Some(text) = read_file(&path, runtime) else {
        return;
    };
    // Discovery intentionally excludes advanced YAML aliases and custom tags. It must
    // never evaluate DSH's executable !!js configuration or expand alias bombs.
    if has_advanced_yaml(&text) {
        runtime
            .warnings
            .push("DSH 配置包含标签或引用语法，已跳过自动解析；请手动添加模型".into());
        return;
    }
    let settings = match serde_yaml::from_str::<DshSettings>(&text) {
        Ok(settings) => settings,
        Err(_) => {
            runtime
                .warnings
                .push(format!("YAML 模型配置无法解析：{}", path.display()));
            return;
        }
    };
    if let Some(default) = settings.default_model {
        add_model(
            runtime,
            &default.model,
            None,
            "settings.yaml / agent-default-model",
            true,
        );
    }
    for (provider, settings) in settings.pi_ai.providers.iter().take(MAX_PROFILES) {
        let provider = safe_id(provider).unwrap_or("已配置 provider");
        for model in settings.models.iter().take(MAX_MODELS + 1) {
            add_model(
                runtime,
                &model.id,
                model.name.as_deref(),
                &format!("settings.yaml / llm-pi-ai.providers.{provider}"),
                false,
            );
        }
    }
    runtime.warnings.push(
        "仅发现 settings.yaml 显式模型；Profile / 插件目录及 Provider 路由需在启动参数中配置"
            .into(),
    );
}

// A small lexical guard, not a YAML parser. Only tokens starting YAML tags,
// anchors, or aliases are excluded; punctuation in quoted credentials/comments
// must not prevent otherwise ordinary model fields from being discovered.
fn has_advanced_yaml(text: &str) -> bool {
    let mut quote = None;
    let mut escaped = false;
    let mut comment = false;
    let mut previous = '\n';
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        if comment {
            if character == '\n' {
                comment = false;
                previous = '\n';
            }
            continue;
        }
        if let Some(delimiter) = quote {
            if escaped {
                escaped = false;
                continue;
            }
            if delimiter == '"' && character == '\\' {
                escaped = true;
                continue;
            }
            if character == delimiter {
                if delimiter == '\'' && chars.peek() == Some(&'\'') {
                    chars.next();
                } else {
                    quote = None;
                    previous = delimiter;
                }
            }
            continue;
        }
        let starts_token = previous.is_whitespace() || "[{,:".contains(previous);
        if starts_token && character == '#' {
            comment = true;
            continue;
        }
        if starts_token && (character == '\'' || character == '"') {
            quote = Some(character);
            continue;
        }
        if starts_token && "!&*".contains(character) {
            return true;
        }
        previous = character;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    fn locations(root: &Path) -> Locations {
        Locations {
            codex: root.join("codex"),
            claude: root.join("claude"),
            traex: root.join("traex"),
            dsh: root.join("dsh"),
            kimi: root.join("kimi"),
            pi: root.join("pi"),
            claude_env: BTreeMap::new(),
        }
    }
    fn fixtures() -> Vec<ProbeResult> {
        RUNTIMES
            .iter()
            .map(|_| ProbeResult {
                found: false,
                path: String::new(),
                version: String::new(),
                error: None,
            })
            .collect()
    }
    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn absent_runtime_and_config_returns_six_empty_results() {
        let directory = tempfile::tempdir().unwrap();
        let report = build_report(&locations(directory.path()), fixtures());
        assert_eq!(report.runtimes.len(), 6);
        assert!(report
            .runtimes
            .iter()
            .all(|runtime| !runtime.probe.found && runtime.models.is_empty()));
    }

    #[test]
    fn kimi_discovery_uses_aliases_overrides_and_never_exports_provider_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let locations = locations(directory.path());
        write(
            &locations.kimi.join("config.toml"),
            r#"
            default_model = "work/kimi"
            [models."work/kimi"]
            model = "different-wire-id"
            provider = "internal"
            display_name = "Original"
            [models."work/kimi".overrides]
            display_name = "My Kimi"
            [providers.internal]
            api_key = "SECRET_NEVER_EXPORTED"
            [models.other]
            model = "wire-other"
            [hooks]
            command = "DO_NOT_EXECUTE"
        "#,
        );
        let report = build_report(&locations, fixtures());
        let runtime = report
            .runtimes
            .iter()
            .find(|runtime| runtime.id == "kimi")
            .unwrap();
        assert_eq!(runtime.models.len(), 2);
        assert!(runtime
            .models
            .iter()
            .any(|model| model.model_id == "work/kimi"
                && model.name == "My Kimi"
                && model.selected));
        assert!(runtime
            .models
            .iter()
            .all(|model| model.supported_reasoning_efforts == Some(vec![])));
        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("SECRET_NEVER_EXPORTED"));
        assert!(!serialized.contains("DO_NOT_EXECUTE"));
        assert!(!serialized.contains("different-wire-id"));
    }

    #[test]
    fn kimi_reasoning_capabilities_respect_overrides_and_export_only_allowed_efforts() {
        let directory = tempfile::tempdir().unwrap();
        let locations = locations(directory.path());
        write(
            &locations.kimi.join("config.toml"),
            r#"
            default_model = "kimi-code/current"
            [thinking]
            enabled = true
            effort = "SECRET_GLOBAL_EFFORT"
            [models."kimi-code/current"]
            display_name = "Current"
            support_efforts = ["max", "high", "low", "low", "SECRET_CUSTOM", ""]
            default_effort = "SECRET_MODEL_DEFAULT"
            [models.all]
            support_efforts = ["ultra", "max", "xhigh", "high", "medium", "low", "minimal", "none"]
            [models.override]
            support_efforts = ["low", "high", "max"]
            [models.override.overrides]
            display_name = "Pinned"
            support_efforts = ["high"]
            default_effort = "SECRET_OVERRIDE_DEFAULT"
            [models.cleared]
            support_efforts = ["low", "high", "max"]
            [models.cleared.overrides]
            support_efforts = []
            [models.empty]
            support_efforts = []
            [models.missing]
            default_effort = "max"
            [models.missing.overrides]
            display_name = "No capability list"
            [models.inherited]
            support_efforts = ["low", "high", "max"]
            [models.inherited.overrides]
            display_name = "Name only override"
            [models.unknown]
            support_efforts = ["future-effort", "SECRET_UNKNOWN"]
        "#,
        );
        let report = build_report(&locations, fixtures());
        let runtime = report
            .runtimes
            .iter()
            .find(|item| item.id == "kimi")
            .unwrap();
        let model = |id: &str| {
            runtime
                .models
                .iter()
                .find(|item| item.model_id == id)
                .unwrap()
        };
        assert_eq!(runtime.models.len(), 8);
        assert_eq!(
            model("kimi-code/current").supported_reasoning_efforts,
            Some(vec!["low".into(), "high".into(), "max".into()])
        );
        assert!(model("kimi-code/current").selected);
        assert_eq!(
            model("all").supported_reasoning_efforts,
            Some(MODEL_REASONING_EFFORTS.map(String::from).to_vec())
        );
        assert_eq!(model("override").name, "Pinned");
        assert_eq!(
            model("override").supported_reasoning_efforts,
            Some(vec!["high".into()])
        );
        assert_eq!(
            model("inherited").supported_reasoning_efforts,
            Some(vec!["low".into(), "high".into(), "max".into()])
        );
        for id in ["cleared", "empty", "missing", "unknown"] {
            assert_eq!(model(id).supported_reasoning_efforts, Some(vec![]));
        }
        let exported = serde_json::to_value(&report).unwrap();
        let models = exported["runtimes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == "kimi")
            .unwrap()["models"]
            .as_array()
            .unwrap();
        assert!(models
            .iter()
            .all(|item| item["supportedReasoningEfforts"].is_array()));
        assert!(models
            .iter()
            .all(|item| item.get("reasoningEffort").is_none()));
        assert!(!exported.to_string().contains("SECRET"));
    }

    #[test]
    fn codex_active_profile_overrides_top_level_and_merges_cache_sources() {
        let directory = tempfile::tempdir().unwrap();
        let locations = locations(directory.path());
        write(&locations.codex.join("config.toml"), "model='base'\nprofile='work'\n[profiles.work]\nmodel='selected'\n[profiles.other]\nmodel='other'\n");
        write(
            &locations.codex.join("models_cache.json"),
            r#"{"models":[{"slug":"selected","display_name":"Selected"},{"slug":"cache-only","display_name":"Cache"},{"slug":"hidden","visibility":"hide"}]}"#,
        );
        let report = build_report(&locations, fixtures());
        let models = &report.runtimes[0].models;
        assert_eq!(models.len(), 4);
        assert_eq!(
            models
                .iter()
                .filter(|model| model.selected)
                .map(|model| &model.model_id)
                .collect::<Vec<_>>(),
            vec!["selected"]
        );
        assert!(models
            .iter()
            .find(|model| model.model_id == "selected")
            .unwrap()
            .source
            .contains("缓存"));
    }

    #[test]
    fn codex_reasoning_capabilities_are_whitelisted_deduplicated_and_optional() {
        let directory = tempfile::tempdir().unwrap();
        let locations = locations(directory.path());
        write(
            &locations.codex.join("models_cache.json"),
            r#"{"models":[{"slug":"gpt-test","default_reasoning_level":"SECRET_DEFAULT","supported_reasoning_levels":[{"effort":"ultra","description":"SECRET_DESCRIPTION"},{"effort":"max"},{"effort":"high"},{"effort":"xhigh"},{"effort":"medium"},{"effort":"low"},{"effort":"minimal"},{"effort":"none"},{"effort":"high"},{"effort":"persistent"},{"effort":"SECRET_CUSTOM"},{"effort":""}]},{"slug":"legacy"},{"slug":"hidden","visibility":"hide","supported_reasoning_levels":[{"effort":"ultra"}]}]}"#,
        );
        let report = build_report(&locations, fixtures());
        let models = &report.runtimes[0].models;
        assert_eq!(models.len(), 2);
        assert_eq!(
            models[0].supported_reasoning_efforts,
            Some(MODEL_REASONING_EFFORTS.map(String::from).to_vec())
        );
        assert!(models[1].supported_reasoning_efforts.is_none());
        let exported = serde_json::to_value(&report).unwrap();
        assert!(exported["runtimes"][0]["models"][1]
            .get("supportedReasoningEfforts")
            .is_none());
        assert!(!exported.to_string().contains("SECRET"));
    }

    #[test]
    fn configured_codex_catalog_efforts_take_precedence_over_shared_cache() {
        let directory = tempfile::tempdir().unwrap();
        let locations = locations(directory.path());
        write(
            &locations.codex.join("config.toml"),
            "model='configured'\nmodel_catalog_json='catalog.json'\nmodel_reasoning_effort='medium'\n",
        );
        write(
            &locations.codex.join("catalog.json"),
            r#"{"models":[{"slug":"configured","supported_reasoning_levels":[{"effort":"high"}]},{"slug":"no-thinking","supported_reasoning_levels":[]},{"slug":"unknown-only","supported_reasoning_levels":[{"effort":"persistent"},{"effort":"future-mode"}]},{"slug":"legacy"}]}"#,
        );
        write(
            &locations.codex.join("models_cache.json"),
            r#"{"models":[{"slug":"configured","supported_reasoning_levels":[{"effort":"low"},{"effort":"ultra"}]},{"slug":"no-thinking","supported_reasoning_levels":[{"effort":"high"}]},{"slug":"unknown-only","supported_reasoning_levels":[{"effort":"ultra"}]},{"slug":"legacy","supported_reasoning_levels":[{"effort":"low"}]},{"slug":"cache-only","supported_reasoning_levels":[{"effort":"max"},{"effort":"ultra"}]}]}"#,
        );
        let report = build_report(&locations, fixtures());
        let models = &report.runtimes[0].models;
        let efforts = |id: &str| {
            models
                .iter()
                .find(|model| model.model_id == id)
                .unwrap()
                .supported_reasoning_efforts
                .clone()
        };
        assert_eq!(efforts("configured"), Some(vec!["high".into()]));
        assert_eq!(efforts("no-thinking"), Some(vec![]));
        assert_eq!(efforts("unknown-only"), Some(vec![]));
        assert_eq!(efforts("legacy"), Some(vec!["low".into()]));
        assert_eq!(
            efforts("cache-only"),
            Some(vec!["max".into(), "ultra".into()])
        );
        assert!(
            models
                .iter()
                .find(|model| model.model_id == "configured")
                .unwrap()
                .selected
        );
    }

    #[test]
    fn invalid_config_errors_never_contain_source_secrets_and_other_runtime_survives() {
        let directory = tempfile::tempdir().unwrap();
        let locations = locations(directory.path());
        write(
            &locations.codex.join("config.toml"),
            "token='SECRET_BAD_CONFIG\n",
        );
        write(
            &locations.claude.join("settings.json"),
            r#"{"model":"sonnet","env":{"ANTHROPIC_API_KEY":"SECRET_KEY","ANTHROPIC_BASE_URL":"SECRET_URL"},"hooks":{"Secret":"SECRET_HOOK"}}"#,
        );
        let report = build_report(&locations, fixtures());
        assert!(report.runtimes[0].models.is_empty());
        assert!(report.runtimes[0]
            .warnings
            .iter()
            .any(|warning| warning.contains("无法解析")));
        assert_eq!(report.runtimes[1].models[0].model_id, "sonnet");
        assert!(!serde_json::to_string(&report).unwrap().contains("SECRET"));
    }

    #[test]
    fn claude_model_env_overrides_settings_model_but_aliases_are_not_selected() {
        let directory = tempfile::tempdir().unwrap();
        let mut locations = locations(directory.path());
        write(
            &locations.claude.join("settings.json"),
            r#"{"model":"sonnet","env":{"ANTHROPIC_DEFAULT_SONNET_MODEL":"custom-sonnet","ANTHROPIC_DEFAULT_OPUS_MODEL":"custom-opus"}}"#,
        );
        locations
            .claude_env
            .insert("ANTHROPIC_MODEL".into(), "explicit-model".into());
        let report = build_report(&locations, fixtures());
        let models = &report.runtimes[1].models;
        assert_eq!(models.iter().filter(|model| model.selected).count(), 1);
        assert!(models
            .iter()
            .any(|model| model.model_id == "explicit-model" && model.selected));
        assert!(models
            .iter()
            .any(|model| model.model_id == "custom-sonnet" && !model.selected));
    }

    #[test]
    fn dsh_whitelist_ignores_credentials_and_combines_default_with_catalog() {
        let directory = tempfile::tempdir().unwrap();
        let locations = locations(directory.path());
        write(&locations.dsh.join("settings.yaml"), "agent-default-model:\n  provider: cloud\n  model: deepseek-chat\nllm-pi-ai:\n  providers:\n    cloud:\n      apiKeyEnv: SECRET_ENV\n      apiKey: SECRET_KEY\n      baseURL: SECRET_URL\n      models:\n        - id: deepseek-chat\n          name: DeepSeek Chat\n        - id: custom-model\n");
        let report = build_report(&locations, fixtures());
        assert_eq!(report.runtimes[3].models.len(), 2);
        assert!(report.runtimes[3].models[0].selected);
        assert!(!serde_json::to_string(&report).unwrap().contains("SECRET"));
    }

    #[test]
    fn oversized_file_and_yaml_tags_are_bounded_and_not_evaluated() {
        let directory = tempfile::tempdir().unwrap();
        let locations = locations(directory.path());
        write(
            &locations.codex.join("config.toml"),
            &"x".repeat(MAX_FILE_BYTES as usize + 1),
        );
        write(
            &locations.dsh.join("settings.yaml"),
            "agent-default-model: !!js SECRET_EXECUTION\n",
        );
        let report = build_report(&locations, fixtures());
        assert!(report
            .runtimes
            .iter()
            .all(|runtime| runtime.models.is_empty()));
        assert!(report.runtimes[0]
            .warnings
            .iter()
            .any(|warning| warning.contains("2 MiB")));
        assert!(report.runtimes[3]
            .warnings
            .iter()
            .any(|warning| warning.contains("标签")));
        assert!(!serde_json::to_string(&report).unwrap().contains("SECRET"));
    }

    #[test]
    fn yaml_guard_excludes_aliases_but_ignores_quoted_punctuation_and_comments() {
        assert!(has_advanced_yaml("models: &models [one]\ncopy: *models\n"));
        assert!(!has_advanced_yaml(
            "apiKey: 'secret ! & *'\n# !!js ignored\nurl: https://example.test/?a=1&b=2\n"
        ));
    }

    #[test]
    fn missing_profile_and_conflicting_claude_env_do_not_claim_selected_models() {
        let directory = tempfile::tempdir().unwrap();
        let mut locations = locations(directory.path());
        write(
            &locations.codex.join("config.toml"),
            "model='base'\nprofile='missing'\n",
        );
        write(
            &locations.claude.join("settings.json"),
            r#"{"model":"sonnet","env":{"ANTHROPIC_MODEL":"config-model"}}"#,
        );
        locations
            .claude_env
            .insert("ANTHROPIC_MODEL".into(), "environment-model".into());
        let report = build_report(&locations, fixtures());
        assert!(report.runtimes[0]
            .models
            .iter()
            .all(|model| !model.selected));
        assert!(report.runtimes[1]
            .models
            .iter()
            .all(|model| !model.selected));
    }

    #[cfg(unix)]
    #[test]
    fn fifo_config_cannot_block_detection() {
        use std::ffi::CString;
        let directory = tempfile::tempdir().unwrap();
        let locations = locations(directory.path());
        std::fs::create_dir_all(&locations.codex).unwrap();
        let path = CString::new(
            locations
                .codex
                .join("config.toml")
                .as_os_str()
                .as_encoded_bytes(),
        )
        .unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let report = build_report(&locations, fixtures());
        assert!(report.runtimes[0].models.is_empty());
        assert!(report.runtimes[0]
            .warnings
            .iter()
            .any(|warning| warning.contains("非普通文件")));
    }

    /// Manual read-only smoke test; only whitelisted report data is printed.
    #[test]
    #[ignore = "explicitly opt into reading local runtime config"]
    fn print_local_discovery_report() {
        println!("{}", serde_json::to_string_pretty(&discover()).unwrap());
    }

    /// Manual Kimi-only check without probing or refreshing other runtimes.
    #[test]
    #[ignore = "explicitly opt into reading local Kimi model config"]
    fn print_local_kimi_discovery_report() {
        let mut runtime = DiscoveredRuntime {
            id: "kimi".into(),
            name: "Kimi CLI".into(),
            executable: "kimi".into(),
            adapter: "kimi".into(),
            probe: discovery::probe("kimi"),
            models: Vec::new(),
            config_sources: Vec::new(),
            warnings: Vec::new(),
        };
        discover_kimi(&Locations::current().kimi, &mut runtime);
        let report = LocalEnvironmentReport {
            scanned_at: chrono::Utc::now().to_rfc3339(),
            runtimes: vec![runtime],
        };
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
    }
}

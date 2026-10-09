use super::{
    add_model, read_file, read_json, safe_id, DiscoveredRuntime, MAX_MODELS, MAX_PROFILES,
};
use serde::{de::IgnoredAny, Deserialize};
use std::path::{Path, PathBuf};

#[derive(Default, Deserialize)]
struct Config {
    model: Option<String>,
    model_provider: Option<String>,
    // Current TraeX rejects Codex-style profile configuration. Do not silently
    // treat an invalid legacy configuration as an effective default.
    profile: Option<IgnoredAny>,
    profiles: Option<IgnoredAny>,
}

#[derive(Deserialize)]
struct ListedModel {
    name: String,
    config_name: Option<String>,
    provider: Option<String>,
}

#[derive(Deserialize)]
struct Catalog {
    models: Vec<CachedModel>,
}

#[derive(Deserialize)]
struct CachedModel {
    slug: String,
    config_name: Option<String>,
    model_provider_id: Option<String>,
    visibility: Option<String>,
    supported_in_api: Option<bool>,
}

fn read_config(path: &Path, runtime: &mut DiscoveredRuntime) -> Option<Config> {
    let text = read_file(path, runtime)?;
    match toml::from_str::<Config>(&text) {
        Ok(config) => Some(config),
        Err(_) => {
            runtime
                .warnings
                .push(format!("TraeX TOML 模型配置无法解析：{}", path.display()));
            None
        }
    }
}

fn path_component(value: &str) -> Option<&str> {
    safe_id(value).filter(|value| {
        !matches!(*value, "." | "..")
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    })
}

fn is_legacy(config: &Config) -> bool {
    config.profile.is_some() || config.profiles.is_some()
}

/// Read only user-level model fields. CLI enumeration uses the same home and
/// provider, from that directory rather than the application's project cwd.
pub(super) fn discover(directory: &Path, runtime: &mut DiscoveredRuntime) {
    let path = directory.join("traecli.toml");
    let config = read_config(&path, runtime);
    let config_valid = config.is_some() || !path.exists();
    let config = config.unwrap_or_default();
    let legacy = is_legacy(&config);
    if legacy {
        runtime.warnings.push(
            "TraeX 不再支持顶层 profile / profiles 配置；请通过 --profile 和 <name>.traecli.toml 选择，未标记默认模型".into(),
        );
    }
    // This is TraeX's own default provider, not Codex's default.
    let provider = config.model_provider.as_deref().unwrap_or("trae");
    let provider = path_component(provider);
    if provider.is_none() {
        runtime
            .warnings
            .push("TraeX model_provider 格式无法识别，已跳过模型目录与缓存查询".into());
    }
    if let Some(model) = &config.model {
        add_model(
            runtime,
            model,
            None,
            "traecli.toml / model",
            config_valid && !legacy && provider.is_some(),
        );
    }
    let Some(provider) = provider.filter(|_| config_valid) else {
        return;
    };
    read_profiles(directory, provider, runtime);

    let queried = if runtime.probe.found && !runtime.probe.path.is_empty() && !legacy {
        // `models` does not apply the top-level --profile option. Explicitly
        // pin the user-level provider to keep its list consistent with fallback.
        let args = vec![
            "models".into(),
            "--json".into(),
            "-c".into(),
            format!("model_provider=\"{provider}\""),
        ];
        match crate::traex_query::query_models(Path::new(&runtime.probe.path), &args, directory) {
            Ok(output) => match serde_json::from_str::<Vec<ListedModel>>(&output) {
                Ok(models) => {
                    for model in models.iter().take(MAX_MODELS + 1) {
                        if model
                            .provider
                            .as_deref()
                            .is_some_and(|value| value != provider)
                        {
                            continue;
                        }
                        add_catalog_model(
                            runtime,
                            &model.name,
                            model.config_name.as_deref(),
                            &format!("traex models --json / {provider}"),
                        );
                    }
                    if models.is_empty() {
                        runtime.warnings.push("TraeX CLI 当前返回空模型列表".into());
                    }
                    true
                }
                Err(_) => {
                    runtime
                        .warnings
                        .push("TraeX 模型列表 JSON 无法解析，尝试本机缓存".into());
                    false
                }
            },
            Err(error) => {
                runtime.warnings.push(format!("{error}，尝试本机缓存"));
                false
            }
        }
    } else {
        false
    };
    if !queried {
        read_cache(directory, provider, runtime);
    }
    if runtime.probe.found || !runtime.models.is_empty() {
        runtime.warnings.push(
            "TraeX 默认模型来自用户级配置；与 Codex 共用执行协议，自动传入消息并续接任务会话"
                .into(),
        );
    }
}

fn read_profiles(directory: &Path, provider: &str, runtime: &mut DiscoveredRuntime) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".traecli.toml"))
        })
        .take(MAX_PROFILES + 1)
        .collect();
    paths.sort();
    if paths.len() > MAX_PROFILES {
        runtime
            .warnings
            .push("TraeX Profile 过多，仅检查前 128 个".into());
    }
    for path in paths.iter().take(MAX_PROFILES) {
        let Some(name) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".traecli.toml"))
            .and_then(path_component)
        else {
            continue;
        };
        let Some(profile) = read_config(path, runtime) else {
            continue;
        };
        if is_legacy(&profile) {
            runtime.warnings.push(format!(
                "TraeX Profile {name} 包含旧版 profile 配置，已跳过"
            ));
            continue;
        }
        if profile.model_provider.as_deref().unwrap_or(provider) != provider {
            runtime.warnings.push(format!(
                "TraeX Profile {name} 使用不同 provider，未合并其模型；请通过启动参数选择"
            ));
            continue;
        }
        if let Some(model) = profile.model {
            add_model(
                runtime,
                &model,
                None,
                &format!("{name}.traecli.toml / 候选（--profile {name}）"),
                false,
            );
        }
    }
}

fn add_catalog_model(
    runtime: &mut DiscoveredRuntime,
    name: &str,
    config_name: Option<&str>,
    source: &str,
) -> bool {
    let name = name.trim();
    if name.is_empty() {
        return false;
    }
    let Some(id) = config_name.and_then(safe_id).or_else(|| safe_id(name)) else {
        return false;
    };
    // Use the CLI's stable config_name even if the selected default changes.
    // Only report aliases actually confirmed by this catalog, not guessed by case.
    let aliases: Vec<usize> = runtime
        .models
        .iter()
        .enumerate()
        .filter(|(_, model)| model.model_id == id || model.model_id == name)
        .map(|(index, _)| index)
        .collect();
    // Merge both forms if the base and a profile used different aliases.
    for index in aliases.into_iter().rev() {
        if runtime.models[index].model_id != id {
            let alias = runtime.models.remove(index);
            add_model(runtime, id, Some(name), &alias.source, alias.selected);
        }
    }
    add_model(runtime, id, Some(name), source, false);
    if let Some(model) = runtime.models.iter_mut().find(|model| model.model_id == id) {
        if let Some(alias) = safe_id(name).filter(|alias| *alias != id) {
            if !model.aliases.iter().any(|value| value == alias) {
                model.aliases.push(alias.into());
            }
        }
    }
    true
}

fn read_cache(directory: &Path, provider: &str, runtime: &mut DiscoveredRuntime) {
    let paths = [
        (
            directory
                .join("model-provider")
                .join(provider)
                .join("models_cache.json"),
            true,
        ),
        (
            directory
                .join("cli/model-catalog")
                .join(provider)
                .join("models_cache.json"),
            true,
        ),
        (directory.join("cli/models_cache.json"), false),
    ];
    for (path, scoped) in paths {
        let Some(catalog) = read_json::<Catalog>(&path, runtime) else {
            continue;
        };
        let mut usable = false;
        for model in catalog.models.iter().take(MAX_MODELS + 1) {
            let matches_provider = match model.model_provider_id.as_deref() {
                Some(value) => value == provider,
                None => scoped,
            };
            if !matches_provider
                || model.visibility.as_deref() == Some("hide")
                || model.supported_in_api == Some(false)
            {
                continue;
            }
            usable |= add_catalog_model(
                runtime,
                &model.slug,
                model.config_name.as_deref(),
                &format!("models_cache.json / {provider} / 缓存"),
            );
        }
        if usable {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ProbeResult;
    use std::fs;

    fn runtime() -> DiscoveredRuntime {
        DiscoveredRuntime {
            id: "traex".into(),
            name: "TraeX".into(),
            executable: "traex".into(),
            adapter: "codex".into(),
            probe: ProbeResult {
                found: false,
                path: String::new(),
                version: String::new(),
                error: None,
            },
            models: Vec::new(),
            config_sources: Vec::new(),
            warnings: Vec::new(),
        }
    }

    fn write(root: &Path, path: &str, text: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[cfg(unix)]
    fn cli(root: &Path, runtime: &mut DiscoveredRuntime, script: &str) {
        use std::os::unix::fs::PermissionsExt;
        let path = root.join("fixture-traex");
        fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        runtime.probe.found = true;
        runtime.probe.path = path.to_string_lossy().into_owned();
    }

    #[test]
    fn cache_respects_provider_and_aliases_and_filters_unavailable_rows() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = runtime();
        write(
            dir.path(),
            "traecli.toml",
            "model='GPT-6-Astra'\nmodel_provider='trae'\napi_key='SECRET_KEY'\n",
        );
        write(
            dir.path(),
            "model-provider/trae/models_cache.json",
            r#"{"models":[
            {"slug":"GPT-6-Astra","config_name":"gpt-6-astra","model_provider_id":"trae"},
            {"slug":"Visible","config_name":"visible","model_provider_id":"trae"},
            {"slug":"Hidden","config_name":"hidden","visibility":"hide"},
            {"slug":"","config_name":"empty-slug"},
            {"slug":"Wrong","model_provider_id":"openai"},
            {"slug":"Unavailable","supported_in_api":false}
        ]}"#,
        );
        write(
            dir.path(),
            "model-provider/openai/models_cache.json",
            r#"{"models":[{"slug":"wrong-provider-cache"}]}"#,
        );
        discover(dir.path(), &mut runtime);
        assert_eq!(runtime.models.len(), 2);
        assert_eq!(runtime.models[0].model_id, "gpt-6-astra");
        assert_eq!(runtime.models[0].aliases, vec!["GPT-6-Astra"]);
        assert!(runtime.models[0].selected);
        assert!(runtime.models[0].source.contains("缓存"));
        assert_eq!(runtime.models[1].model_id, "visible");
        assert!(!runtime.models[1].selected);
        assert!(!serde_json::to_string(&runtime).unwrap().contains("SECRET"));
    }

    #[test]
    fn profile_candidates_inherit_provider_and_never_override_the_base_default() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = runtime();
        write(
            dir.path(),
            "traecli.toml",
            "model='base'\nmodel_provider='trae'\n",
        );
        write(dir.path(), "work.traecli.toml", "model='work-model'\n");
        write(
            dir.path(),
            "other.traecli.toml",
            "model='other-model'\nmodel_provider='openai'\n",
        );
        write(
            dir.path(),
            "legacy.traecli.toml",
            "model='invalid-profile'\n[profiles.old]\nmodel='ignored'\n",
        );
        discover(dir.path(), &mut runtime);
        assert_eq!(runtime.models.len(), 2);
        assert_eq!(
            runtime
                .models
                .iter()
                .find(|model| model.selected)
                .unwrap()
                .model_id,
            "base"
        );
        assert_eq!(runtime.models[1].model_id, "work-model");
        assert!(runtime.models[1].source.contains("--profile work"));
        assert!(runtime
            .warnings
            .iter()
            .any(|warning| warning.contains("不同 provider")));
    }

    #[test]
    fn legacy_profile_is_reported_without_claiming_an_effective_default() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = runtime();
        write(
            dir.path(),
            "traecli.toml",
            "model='base'\nprofile='work'\n[profiles.work]\nmodel='legacy'\n",
        );
        discover(dir.path(), &mut runtime);
        assert_eq!(runtime.models.len(), 1);
        assert!(!runtime.models[0].selected);
        assert!(runtime
            .warnings
            .iter()
            .any(|warning| warning.contains("不再支持")));
    }

    #[test]
    fn missing_config_uses_trae_cache_but_legacy_unscoped_cache_requires_provider_tags() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = runtime();
        write(
            dir.path(),
            "cli/models_cache.json",
            r#"{"models":[
            {"slug":"Tagged","config_name":"tagged","model_provider_id":"trae"},
            {"slug":"Untagged"},{"slug":"Other","model_provider_id":"openai"}
        ]}"#,
        );
        discover(dir.path(), &mut runtime);
        assert_eq!(runtime.models.len(), 1);
        assert_eq!(runtime.models[0].model_id, "tagged");
        assert!(!runtime.models[0].selected);
    }

    #[test]
    fn invalid_config_and_unsafe_provider_do_not_leak_or_read_unrelated_cache() {
        let dir = tempfile::tempdir().unwrap();
        for content in ["model='SECRET_BAD\n", "model_provider='../openai'\n"] {
            let mut runtime = runtime();
            write(dir.path(), "traecli.toml", content);
            write(
                dir.path(),
                "cli/models_cache.json",
                r#"{"models":[{"slug":"stale","model_provider_id":"trae"}]}"#,
            );
            discover(dir.path(), &mut runtime);
            assert!(runtime.models.is_empty());
            assert!(!runtime.warnings.is_empty());
            assert!(!serde_json::to_string(&runtime).unwrap().contains("SECRET"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn cli_is_authoritative_merges_aliases_and_uses_the_explicit_provider() {
        let dir = tempfile::tempdir().unwrap();
        let mut runtime = runtime();
        write(
            dir.path(),
            "traecli.toml",
            "model='GPT-6-Astra'\nmodel_provider='trae'\n",
        );
        write(dir.path(), "work.traecli.toml", "model='gpt-6-astra'\n");
        write(
            dir.path(),
            "model-provider/trae/models_cache.json",
            r#"{"models":[{"slug":"stale"}]}"#,
        );
        cli(
            dir.path(),
            &mut runtime,
            r#"
test "$1" = models && test "$2" = --json && test "$3" = -c && test "$4" = 'model_provider="trae"' || exit 4
printf '%s' '[{"name":"GPT-6-Astra","config_name":"gpt-6-astra","provider":"trae","backend_model":"SECRET_ROUTE"},{"name":"Other","config_name":"other","provider":"trae"},{"name":"Wrong","provider":"openai"}]'
"#,
        );
        discover(dir.path(), &mut runtime);
        assert_eq!(runtime.models.len(), 2);
        assert_eq!(runtime.models[0].model_id, "gpt-6-astra");
        assert_eq!(runtime.models[0].aliases, vec!["GPT-6-Astra"]);
        assert!(runtime.models[0].selected);
        assert!(runtime.models[0].source.contains("--profile work"));
        assert!(runtime.models[0].source.contains("traex models --json"));
        assert_eq!(runtime.models[1].model_id, "other");
        assert!(!serde_json::to_string(&runtime).unwrap().contains("SECRET"));
        assert!(!runtime
            .config_sources
            .iter()
            .any(|source| source.contains("cache")));
        // Changing the native default must not change the identity of a model
        // that is now present only as a catalog/profile candidate.
        write(dir.path(), "traecli.toml", "model='Other'\n");
        let mut rescanned = super::tests::runtime();
        rescanned.probe.found = true;
        rescanned.probe.path = runtime.probe.path.clone();
        discover(dir.path(), &mut rescanned);
        assert_eq!(rescanned.models.len(), 2);
        assert_eq!(
            rescanned
                .models
                .iter()
                .find(|model| model.selected)
                .unwrap()
                .model_id,
            "other"
        );
        assert!(rescanned
            .models
            .iter()
            .any(|model| model.model_id == "gpt-6-astra" && !model.selected));
    }

    #[cfg(unix)]
    #[test]
    fn failed_or_malformed_query_falls_back_but_empty_success_does_not_resurrect_stale_cache() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "traecli.toml", "model='configured'\n");
        write(
            dir.path(),
            "model-provider/trae/models_cache.json",
            r#"{"models":[{"slug":"cached"}]}"#,
        );
        for (script, expected_count) in [
            ("printf SECRET_ERROR >&2; exit 2", 2),
            ("printf SECRET_INVALID_JSON", 2),
            ("printf '[]'", 1),
        ] {
            let mut runtime = runtime();
            cli(dir.path(), &mut runtime, script);
            discover(dir.path(), &mut runtime);
            assert_eq!(runtime.models.len(), expected_count);
            assert!(runtime.models[0].selected);
            assert!(!serde_json::to_string(&runtime).unwrap().contains("SECRET"));
            if expected_count == 2 {
                assert!(runtime
                    .warnings
                    .iter()
                    .any(|warning| warning.contains("尝试本机缓存")));
            }
        }
    }
}

use super::{add_model, read_json, safe_id};
use crate::types::DiscoveredRuntime;
use serde::Deserialize;
use std::{collections::BTreeMap, path::Path};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    default_provider: Option<String>,
    default_model: Option<String>,
}
#[derive(Default, Deserialize)]
struct Catalog {
    #[serde(default)]
    providers: BTreeMap<String, Provider>,
}
#[derive(Default, Deserialize)]
struct Provider {
    #[serde(default)]
    models: Vec<Model>,
}
#[derive(Deserialize)]
struct Model {
    id: String,
    name: Option<String>,
}

fn identity(provider: &str, model: &str) -> Option<String> {
    let provider = safe_id(provider)?;
    let model = safe_id(model)?;
    if provider.contains('/') {
        return None;
    }
    Some(format!("{provider}/{model}"))
}

fn add_catalog(text: &str, runtime: &mut DiscoveredRuntime) -> Result<(), String> {
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let header: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    if header
        != [
            "provider", "model", "context", "max-out", "thinking", "images",
        ]
    {
        return Err("Pi 模型列表格式无法识别，保留配置文件中的模型".into());
    }
    for line in lines {
        let columns: Vec<_> = line.split_whitespace().collect();
        if columns.len() != 6
            || !matches!(columns[4], "yes" | "no")
            || !matches!(columns[5], "yes" | "no")
        {
            continue;
        }
        if let Some(id) = identity(columns[0], columns[1]) {
            // The table says only whether thinking exists, not its supported levels.
            add_model(runtime, &id, None, "pi --list-models", false);
        }
    }
    Ok(())
}

pub(super) fn discover(directory: &Path, runtime: &mut DiscoveredRuntime) {
    let settings =
        read_json::<Settings>(&directory.join("settings.json"), runtime).unwrap_or_default();
    let selected = settings
        .default_provider
        .as_deref()
        .zip(settings.default_model.as_deref())
        .and_then(|(provider, model)| identity(provider, model));
    if let Some(id) = &selected {
        add_model(runtime, id, None, "settings.json", true);
    }
    if let Some(catalog) = read_json::<Catalog>(&directory.join("models.json"), runtime) {
        for (provider, config) in catalog.providers {
            for model in config.models {
                if let Some(id) = identity(&provider, &model.id) {
                    add_model(
                        runtime,
                        &id,
                        model.name.as_deref(),
                        "models.json",
                        selected.as_ref() == Some(&id),
                    );
                }
            }
        }
    }
    if runtime.probe.found && runtime.probe.error.is_none() && !runtime.probe.path.is_empty() {
        let args = ["--offline", "--no-extensions", "--list-models"].map(String::from);
        match crate::pi_query::query_models(Path::new(&runtime.probe.path), &args, directory)
            .and_then(|text| add_catalog(&text, runtime))
        {
            Ok(()) => runtime
                .config_sources
                .push("pi --offline --no-extensions --list-models".into()),
            Err(error) => runtime.warnings.push(error),
        }
    }
    runtime.warnings.push("Pi 模型使用 provider/model 标识；思考强度继承 Pi。扫描不加载扩展，扩展注册的模型请手动添加；项目配置可能覆盖默认值".into());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ProbeResult;
    fn runtime() -> DiscoveredRuntime {
        DiscoveredRuntime {
            id: "pi".into(),
            name: "Pi".into(),
            executable: "pi".into(),
            adapter: "pi".into(),
            probe: ProbeResult {
                found: false,
                path: String::new(),
                version: String::new(),
                error: None,
            },
            models: vec![],
            config_sources: vec![],
            warnings: vec![],
        }
    }

    #[test]
    #[ignore = "explicitly opt into reading local Pi model config"]
    fn pi_local_discovery_report() {
        let mut runtime = runtime();
        runtime.probe = crate::discovery::probe("pi");
        discover(&super::super::Locations::current().pi, &mut runtime);
        assert!(runtime.probe.found);
        println!("{}", serde_json::to_string_pretty(&runtime).unwrap());
    }
    #[test]
    fn preserves_provider_identity_and_does_not_export_credentials() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"defaultProvider":"one","defaultModel":"shared"}"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("models.json"), r#"{"providers":{"one":{"apiKey":"SECRET","models":[{"id":"shared","name":"One"}]},"two":{"baseUrl":"SECRET","models":[{"id":"shared"}]}}}"#).unwrap();
        let mut runtime = runtime();
        discover(dir.path(), &mut runtime);
        assert_eq!(runtime.models.len(), 2);
        assert!(runtime
            .models
            .iter()
            .any(|model| model.model_id == "one/shared" && model.selected));
        assert!(runtime
            .models
            .iter()
            .any(|model| model.model_id == "two/shared" && !model.selected));
        assert!(!serde_json::to_string(&runtime).unwrap().contains("SECRET"));
        add_catalog("provider model context max-out thinking images\none shared 1M 32K yes no\nother model 32K 8K no yes\n", &mut runtime).unwrap();
        assert_eq!(runtime.models.len(), 3);
        assert!(runtime
            .models
            .iter()
            .all(|model| model.supported_reasoning_efforts.is_none()));
        assert!(add_catalog("unexpected output", &mut runtime).is_err());
    }
}

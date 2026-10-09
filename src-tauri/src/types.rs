use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub adapter: String,
    pub enabled: bool,
    pub args: Vec<String>,
    #[serde(default)]
    pub default_model: String,
    #[serde(default)]
    pub permissions: Option<RuntimePermissions>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePermissions {
    pub codex: Option<CodexPermissions>,
    pub claude: Option<ClaudePermissions>,
    pub generic: Option<GenericPermissions>,
    pub kimi: Option<KimiPermissions>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KimiPermissions {
    pub mode: String,
}

fn inherit() -> String {
    "inherit".into()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexPermissions {
    #[serde(default = "inherit")]
    pub sandbox: String,
    #[serde(default = "inherit")]
    pub network: String,
    #[serde(default)]
    pub additional_directories: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudePermissions {
    #[serde(default = "inherit")]
    pub mode: String,
    #[serde(default)]
    pub additional_directories: Vec<String>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenericPermissions {
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub task_id: String,
    pub run_id: String,
    pub member_id: String,
    pub runtime: RuntimeConfig,
    pub model: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    pub directory: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub id: String,
    pub task_id: String,
    pub run_id: String,
    pub member_id: String,
    pub timestamp: String,
    pub kind: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub found: bool,
    pub path: String,
    pub version: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModel {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    pub model_id: String,
    pub name: String,
    pub source: String,
    pub selected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supported_reasoning_efforts: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRuntime {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub adapter: String,
    pub probe: ProbeResult,
    pub models: Vec<DiscoveredModel>,
    pub config_sources: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEnvironmentReport {
    pub scanned_at: String,
    pub runtimes: Vec<DiscoveredRuntime>,
}

#[derive(Serialize)]
pub struct StorageInfo {
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRef {
    pub task_id: String,
    pub run_id: String,
    pub member_id: String,
}

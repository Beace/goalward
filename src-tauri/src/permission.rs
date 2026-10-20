//! Maps per-runtime preferences to the runtime's own CLI. This is not an OS sandbox.
use crate::types::RuntimeConfig;
use std::path::Path;

fn validate_list(values: &[String]) -> Result<(), String> {
    if values.len() > 128
        || values
            .iter()
            .any(|value| value.len() > 4096 || value.contains('\0'))
    {
        return Err("Permission lists allow at most 128 entries, each at most 4096 bytes and without null characters.".into());
    }
    Ok(())
}

fn validate_directories(directories: &[String]) -> Result<(), String> {
    validate_list(directories)?;
    for directory in directories {
        let path = Path::new(directory);
        if directory.trim() != directory || !path.is_absolute() || !path.is_dir() {
            return Err(format!(
                "Additional permission directories must be existing absolute paths: {directory}"
            ));
        }
    }
    Ok(())
}

fn codex_config_conflicts(config: &str) -> bool {
    // Codex's CliConfigOverrides splits at the first '=' and trims the whole key.
    // Compare the root, not a substring: sandbox_workspace_write={...} is an
    // override just as sandbox_workspace_write.network_access=true is.
    let key = config.split('=').next().unwrap_or("").trim();
    let root = key
        .split('.')
        .next()
        .unwrap_or("")
        .trim_matches(['\'', '"']);
    matches!(
        root,
        "sandbox"
            | "sandbox_mode"
            | "sandbox_read_only"
            | "sandbox_workspace_write"
            | "sandbox_permissions"
            | "approval_policy"
            | "approvals_reviewer"
            | "permissions"
            | "default_permissions"
            | "permission_profile"
            | "profiles"
            | "profile"
            | "features"
            | "use_legacy_landlock"
            | "projects"
            | "forced_auto_mode"
            | "cwd"
            | "experimental_use_profile"
    )
}

fn reject_conflicts(adapter: &str, extra: &[String]) -> Result<(), String> {
    for (index, arg) in extra.iter().enumerate() {
        let flag = arg.split('=').next().unwrap_or(arg);
        let conflict = if adapter == "codex" {
            let config = if matches!(arg.as_str(), "-c" | "--config") {
                extra.get(index + 1).map(String::as_str)
            } else if let Some(value) = arg.strip_prefix("--config=") {
                Some(value)
            } else {
                arg.strip_prefix("-c")
                    .filter(|value| !value.is_empty())
                    .map(|value| value.strip_prefix('=').unwrap_or(value))
            };
            config.is_some_and(codex_config_conflicts)
                || matches!(
                    flag,
                    "--sandbox"
                        | "-s"
                        | "--add-dir"
                        | "--full-auto"
                        | "--approve-for-me"
                        | "--yolo"
                        | "--not-so-yolo"
                        | "--ask-for-approval"
                        | "-a"
                        | "--profile"
                        | "-p"
                        | "--cd"
                        | "-C"
                        | "--ignore-user-config"
                        | "--ignore-rules"
                        | "--enable"
                        | "--disable"
                )
                || flag.starts_with("--dangerously-")
                || (["-s", "-a", "-p", "-C"]
                    .iter()
                    .any(|prefix| arg.starts_with(prefix) && arg.len() > prefix.len()))
        } else {
            matches!(
                flag,
                "--permission-mode"
                    | "--permission-prompts"
                    | "--permission-prompt-tool"
                    | "--dangerously-skip-permissions"
                    | "--allow-dangerously-skip-permissions"
                    | "--allowedTools"
                    | "--allowed-tools"
                    | "--disallowedTools"
                    | "--disallowed-tools"
                    | "--add-dir"
                    | "--settings"
                    | "--setting-sources"
                    | "--restricted"
                    | "--tools"
                    | "--bare"
                    | "--safe-mode"
            )
        };
        // A user-supplied separator could turn our managed permission flags into
        // positional prompt text. Reject it before launching rather than silently
        // claiming that the configured permissions were applied.
        if conflict || arg == "--" {
            return Err(format!("The extra launch argument {flag} conflicts with access permissions. Configure it in permission settings or restore inherited runtime permissions."));
        }
    }
    Ok(())
}

/// Built-in generic runtimes have verified native unattended policies. Custom
/// commands keep their own protocol and explicitly supplied permission args.
pub fn builtin_generic_defaults(runtime: &RuntimeConfig) -> bool {
    runtime.adapter == "generic"
        && runtime
            .permissions
            .as_ref()
            .and_then(|p| p.generic.as_ref())
            .is_none()
}

pub fn arguments(runtime: &RuntimeConfig, extra: &[String]) -> Result<Vec<String>, String> {
    let defaults = crate::types::RuntimePermissions::default();
    let permissions = runtime.permissions.as_ref().unwrap_or(&defaults);
    let mut args = Vec::new();
    match runtime.adapter.as_str() {
        "codex" => {
            let Some(config) = &permissions.codex else {
                // Keep explicit legacy CLI overrides; otherwise default to unattended full access.
                if reject_conflicts("codex", extra).is_err() {
                    return Ok(args);
                }
                return Ok(vec![
                    "--sandbox".into(),
                    "danger-full-access".into(),
                    "-c".into(),
                    "approval_policy=\"never\"".into(),
                ]);
            };
            if !matches!(
                config.sandbox.as_str(),
                "inherit" | "read-only" | "workspace-write" | "danger-full-access"
            ) {
                return Err("Unknown Codex sandbox permission mode.".into());
            }
            if !matches!(config.network.as_str(), "inherit" | "allow" | "deny") {
                return Err("Unknown Codex sandbox command network permission.".into());
            }
            if config.sandbox != "workspace-write"
                && (config.network != "inherit" || !config.additional_directories.is_empty())
            {
                return Err("Codex network and additional writable directory settings only apply in workspace-write mode.".into());
            }
            validate_directories(&config.additional_directories)?;
            let explicit = config.sandbox != "inherit"
                || config.network != "inherit"
                || !config.additional_directories.is_empty();
            if !explicit {
                return Ok(args);
            }
            reject_conflicts("codex", extra)?;
            args.extend(["--sandbox".into(), config.sandbox.clone()]);
            if config.network != "inherit" {
                args.extend([
                    "-c".into(),
                    format!(
                        "sandbox_workspace_write.network_access={}",
                        config.network == "allow"
                    ),
                ]);
            }
            for directory in &config.additional_directories {
                args.extend(["--add-dir".into(), directory.clone()]);
            }
        }
        "claude" => {
            let Some(config) = &permissions.claude else {
                if reject_conflicts("claude", extra).is_err() {
                    return Ok(args);
                }
                return Ok(vec![
                    "--permission-mode".into(),
                    "bypassPermissions".into(),
                    "--permission-prompts".into(),
                    "none".into(),
                ]);
            };
            if !matches!(
                config.mode.as_str(),
                "inherit" | "manual" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions"
            ) {
                return Err("Unknown Claude Code permission mode.".into());
            }
            validate_directories(&config.additional_directories)?;
            validate_list(&config.allowed_tools)?;
            validate_list(&config.disallowed_tools)?;
            if config
                .allowed_tools
                .iter()
                .chain(config.disallowed_tools.iter())
                .any(|tool| {
                    tool.trim().is_empty() || tool.starts_with('-') || tool.contains(['\r', '\n'])
                })
            {
                return Err(
                    "Claude Code tool rules cannot be empty or start with a hyphen.".into(),
                );
            }
            let explicit = config.mode != "inherit"
                || !config.additional_directories.is_empty()
                || !config.allowed_tools.is_empty()
                || !config.disallowed_tools.is_empty();
            if !explicit {
                return Ok(args);
            }
            reject_conflicts("claude", extra)?;
            if config.mode != "inherit" {
                args.extend(["--permission-mode".into(), config.mode.clone()]);
            }
            // The app consumes stream-json output but does not implement Claude's
            // SDK permission request protocol. Deny requests that need a host.
            args.extend(["--permission-prompts".into(), "none".into()]);
            for directory in &config.additional_directories {
                args.extend(["--add-dir".into(), directory.clone()]);
            }
            if !config.allowed_tools.is_empty() {
                args.push("--allowedTools".into());
                args.extend(config.allowed_tools.clone());
            }
            if !config.disallowed_tools.is_empty() {
                args.push("--disallowedTools".into());
                args.extend(config.disallowed_tools.clone());
            }
        }
        "kimi" => {
            if permissions
                .kimi
                .as_ref()
                .is_some_and(|config| !matches!(config.mode.as_str(), "auto" | "manual"))
            {
                return Err("Unknown Kimi permission mode.".into());
            }
        }
        "generic" => {
            if let Some(config) = &permissions.generic {
                validate_list(&config.args)?;
                args.extend(config.args.clone());
            }
        }
        _ => {}
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn runtime(adapter: &str, permissions: serde_json::Value) -> RuntimeConfig {
        serde_json::from_value(json!({
            "id": "fixture", "name": "Fixture", "executable": "/bin/true",
            "adapter": adapter, "enabled": true, "args": [], "permissions": permissions,
        }))
        .unwrap()
    }

    #[test]
    fn legacy_and_inherit_leave_runtime_permissions_unchanged() {
        for permissions in [serde_json::Value::Null, json!({}), json!({"codex": {}})] {
            let runtime = runtime("codex", permissions);
            assert!(arguments(&runtime, &["--sandbox=workspace-write".into()])
                .unwrap()
                .is_empty());
        }
        let old: RuntimeConfig = serde_json::from_value(json!({
            "id": "old", "name": "Old", "executable": "codex", "adapter": "codex",
            "enabled": true, "args": []
        }))
        .unwrap();
        assert!(old.permissions.is_none());
    }

    #[test]
    fn missing_permissions_default_to_unattended_execution() {
        for permissions in [serde_json::Value::Null, json!({})] {
            assert_eq!(
                arguments(&runtime("codex", permissions.clone()), &[]).unwrap(),
                vec![
                    "--sandbox",
                    "danger-full-access",
                    "-c",
                    "approval_policy=\"never\""
                ]
            );
            assert_eq!(
                arguments(&runtime("claude", permissions.clone()), &[]).unwrap(),
                vec![
                    "--permission-mode",
                    "bypassPermissions",
                    "--permission-prompts",
                    "none"
                ]
            );
            assert!(arguments(&runtime("kimi", permissions), &[])
                .unwrap()
                .is_empty());
        }
        assert!(arguments(&runtime("kimi", json!({"kimi":{"mode":"typo"}})), &[]).is_err());
    }

    #[test]
    fn codex_workspace_settings_map_to_cli_without_shell_interpolation() {
        let dir = tempfile::Builder::new()
            .prefix("permissions with spaces ")
            .tempdir()
            .unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        let runtime = runtime(
            "codex",
            json!({"codex": {
                "sandbox": "workspace-write", "network": "deny", "additionalDirectories": [path]
            }}),
        );
        assert_eq!(
            arguments(&runtime, &[]).unwrap(),
            vec![
                "--sandbox",
                "workspace-write",
                "-c",
                "sandbox_workspace_write.network_access=false",
                "--add-dir",
                &path
            ]
        );
    }

    #[test]
    fn codex_cannot_claim_network_or_directory_restrictions_outside_workspace_sandbox() {
        for sandbox in ["inherit", "read-only", "danger-full-access"] {
            let config = runtime(
                "codex",
                json!({"codex": {"sandbox":sandbox, "network":"deny"}}),
            );
            assert!(arguments(&config, &[]).is_err());
            let config = runtime(
                "codex",
                json!({"codex": {"sandbox":sandbox, "additionalDirectories":["/tmp"]}}),
            );
            assert!(arguments(&config, &[]).is_err());
        }
        for sandbox in ["read-only", "danger-full-access"] {
            let config = runtime("codex", json!({"codex": {"sandbox":sandbox}}));
            assert_eq!(arguments(&config, &[]).unwrap(), vec!["--sandbox", sandbox]);
        }
    }

    #[test]
    fn codex_rejects_all_supported_spellings_of_conflicting_overrides() {
        let runtime = runtime("codex", json!({"codex": {"sandbox":"read-only"}}));
        let variants = [
            vec!["--sandbox=danger-full-access"],
            vec!["-sdanger-full-access"],
            vec!["--dangerously-bypass-approvals-and-sandbox"],
            vec!["--approve-for-me"],
            vec!["--yolo"],
            vec!["--not-so-yolo"],
            vec!["--add-dir", "/tmp"],
            vec!["-c", "sandbox_mode='danger-full-access'"],
            vec!["--config=sandbox_workspace_write.network_access=true"],
            vec!["-c= sandbox_workspace_write = {network_access=true}"],
            vec!["-capproval_policy='never'"],
            vec!["--config", "permissions.extra={}"],
            vec!["--config", "default_permissions=':danger-full-access'"],
            vec!["--config", "sandbox_permissions=['disk-full-write-access']"],
            vec!["--profile", "other"],
            vec!["-pother"],
            vec!["--cd=/tmp"],
            vec!["--enable=use_legacy_landlock"],
            vec!["--"],
        ];
        for args in variants {
            let args: Vec<String> = args.iter().map(|arg| (*arg).into()).collect();
            assert!(arguments(&runtime, &args).is_err(), "accepted {args:?}");
        }
        assert!(arguments(&runtime, &["--config=model_reasoning_effort='high'".into()]).is_ok());
    }

    #[test]
    fn directories_must_exist_and_be_absolute() {
        for path in ["relative", "/nonexistent-goalward-permission-directory"] {
            for adapter in ["codex", "claude"] {
                let value = if adapter == "codex" {
                    json!({"codex": {"sandbox":"workspace-write", "additionalDirectories":[path]}})
                } else {
                    json!({"claude": {"additionalDirectories":[path]}})
                };
                assert!(arguments(&runtime(adapter, value), &[]).is_err());
            }
        }
    }

    #[test]
    fn claude_maps_rules_and_denies_unhandled_host_approval_requests() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        let runtime = runtime(
            "claude",
            json!({"claude":{
                "mode":"acceptEdits", "additionalDirectories":[path],
                "allowedTools":["Read", "Bash(git status)"], "disallowedTools":["WebFetch"]
            }}),
        );
        assert_eq!(
            arguments(&runtime, &[]).unwrap(),
            vec![
                "--permission-mode",
                "acceptEdits",
                "--permission-prompts",
                "none",
                "--add-dir",
                &path,
                "--allowedTools",
                "Read",
                "Bash(git status)",
                "--disallowedTools",
                "WebFetch"
            ]
        );
        for flag in [
            "--permission-mode=bypassPermissions",
            "--allowed-tools=Edit",
            "--disallowedTools=Read",
            "--settings={}",
            "--dangerously-skip-permissions",
            "--permission-prompts=host",
        ] {
            assert!(arguments(&runtime, &[flag.into()]).is_err());
        }
    }

    #[test]
    fn generic_only_passes_the_requested_args_and_unknown_modes_fail() {
        let config = runtime(
            "generic",
            json!({"generic":{"args":["--allow-dir", "/tmp/quoted ' path"]}}),
        );
        assert_eq!(
            arguments(&config, &[]).unwrap(),
            vec!["--allow-dir", "/tmp/quoted ' path"]
        );
        assert!(arguments(
            &runtime("codex", json!({"codex":{"sandbox":"future-mode"}})),
            &[]
        )
        .is_err());
        assert!(arguments(
            &runtime("claude", json!({"claude":{"mode":"future-mode"}})),
            &[]
        )
        .is_err());
    }
}

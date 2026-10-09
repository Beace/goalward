//! Explicit reasoning preferences map to native CLI options. Model capability
//! selection belongs to the model catalog; the runtime remains authoritative.

fn codex_config_conflicts(config: &str) -> bool {
    let key = config.split('=').next().unwrap_or("").trim();
    let root = key
        .split('.')
        .next()
        .unwrap_or("")
        .trim_matches(['\'', '"']);
    matches!(
        root,
        "model_reasoning_effort" | "model" | "profiles" | "profile" | "experimental_use_profile"
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
                || matches!(flag, "--profile" | "-p" | "--model" | "-m")
                || (["-p", "-m"]
                    .iter()
                    .any(|prefix| arg.starts_with(prefix) && arg.len() > 2))
        } else {
            matches!(
                flag,
                "--effort"
                    | "--settings"
                    | "--setting-sources"
                    | "--model"
                    | "-m"
                    | "--fallback-model"
            ) || (arg.starts_with("-m") && arg.len() > 2)
        };
        if conflict || arg == "--" {
            return Err(format!(
                "额外启动参数 {flag} 与思考强度配置冲突；请移除冲突参数，或将思考强度设为继承 Runtime 配置"
            ));
        }
    }
    Ok(())
}

pub fn arguments(
    adapter: &str,
    effort: Option<&str>,
    extra: &[String],
) -> Result<Vec<String>, String> {
    let Some(effort) = effort.filter(|effort| *effort != "inherit") else {
        return Ok(Vec::new());
    };
    match adapter {
        "codex" => {
            // These are named values in the installed Codex schema. A selected
            // model may support only a subset; never silently lower the effort.
            if !matches!(
                effort,
                "none"
                    | "minimal"
                    | "low"
                    | "medium"
                    | "high"
                    | "xhigh"
                    | "max"
                    | "ultra"
            ) {
                return Err("Codex 不支持此思考强度配置".into());
            }
            reject_conflicts(adapter, extra)?;
            Ok(vec![
                "-c".into(),
                format!("model_reasoning_effort=\"{effort}\""),
            ])
        }
        "claude" => {
            if !matches!(effort, "low" | "medium" | "high" | "xhigh" | "max") {
                return Err("Claude Code 不支持此思考强度配置".into());
            }
            reject_conflicts(adapter, extra)?;
            Ok(vec!["--effort".into(), effort.into()])
        }
        "kimi" => {
            // ACP negotiates the selected model's options after session creation.
            // This validates only the wire value; the session must still confirm
            // both support and the effective value before sending the prompt.
            if effort.is_empty()
                || effort.len() > 64
                || !effort.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            {
                return Err("Kimi 不支持此思考强度配置".into());
            }
            Ok(Vec::new())
        }
        "pi" => Err("Pi 思考强度当前继承 Runtime 配置；未验证模型支持的档位，不能显式覆盖".into()),
        "generic" => Err(
            "通用 Runtime 尚未提供统一的思考强度参数；请使用继承 Runtime 配置，并按该 Runtime 文档配置启动参数".into(),
        ),
        _ => Err("Unsupported runtime adapter".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_or_inherited_effort_preserves_legacy_arguments() {
        for adapter in ["codex", "claude", "kimi", "generic"] {
            for effort in [None, Some("inherit")] {
                assert!(
                    arguments(adapter, effort, &["--effort=high".into(), "--".into()])
                        .unwrap()
                        .is_empty()
                );
            }
        }
    }

    #[test]
    fn known_efforts_map_to_native_flags_without_shell_interpolation() {
        for effort in [
            "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
        ] {
            assert_eq!(
                arguments("codex", Some(effort), &[]).unwrap(),
                vec![
                    "-c".to_string(),
                    format!("model_reasoning_effort=\"{effort}\"")
                ]
            );
        }
        for effort in ["low", "medium", "high", "xhigh", "max"] {
            assert_eq!(
                arguments("claude", Some(effort), &[]).unwrap(),
                vec!["--effort", effort]
            );
            assert!(arguments("kimi", Some(effort), &[]).unwrap().is_empty());
        }
    }

    #[test]
    fn unknown_or_adapter_incompatible_efforts_are_rejected() {
        for adapter in ["codex", "claude"] {
            for effort in [
                "",
                " high",
                "extreme",
                "persistent",
                "high\"; echo unsafe",
                "high\0",
            ] {
                assert!(arguments(adapter, Some(effort), &[]).is_err());
            }
        }
        for effort in ["none", "minimal", "ultra", "persistent"] {
            assert!(arguments("claude", Some(effort), &[]).is_err());
        }
        assert!(arguments("generic", Some("high"), &[])
            .unwrap_err()
            .contains("尚未提供统一"));
    }

    #[test]
    fn codex_conflicts_cover_config_forms_and_profiles() {
        for args in [
            vec!["-c", "model_reasoning_effort=low"],
            vec!["--config", "model_reasoning_effort=low"],
            vec!["--config=model_reasoning_effort=low"],
            vec!["-cmodel_reasoning_effort=low"],
            vec!["-c=model_reasoning_effort=low"],
            vec!["-c", " model_reasoning_effort = 'low'"],
            vec!["-c", "profiles.custom={model_reasoning_effort='low'}"],
            vec!["-cprofile=custom"],
            vec!["--profile", "custom"],
            vec!["--profile=custom"],
            vec!["-pcustom"],
            vec!["--model=other"],
            vec!["-mother"],
            vec!["-cmodel='other'"],
            vec!["--"],
        ] {
            let args: Vec<String> = args.iter().map(|arg| (*arg).into()).collect();
            assert!(
                arguments("codex", Some("high"), &args).is_err(),
                "accepted {args:?}"
            );
        }
        assert!(arguments(
            "codex",
            Some("high"),
            &["-cmodel_reasoning_summary=concise".into()]
        )
        .is_ok());
    }

    #[test]
    fn claude_conflicts_cover_effort_and_settings_overrides() {
        for flag in [
            "--effort",
            "--effort=low",
            "--settings",
            "--settings={}",
            "--setting-sources=project",
            "--model=other",
            "-mother",
            "--fallback-model=other",
            "--",
        ] {
            assert!(arguments("claude", Some("high"), &[flag.into()]).is_err());
        }
        assert!(arguments("claude", Some("high"), &["--verbose".into()]).is_ok());
    }
}

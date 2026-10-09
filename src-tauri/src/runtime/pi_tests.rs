use super::*;
use std::{os::unix::fs::PermissionsExt, path::Path, sync::mpsc};

fn request(directory: &Path, executable: &Path) -> StartRequest {
    serde_json::from_value(serde_json::json!({
        "taskId":"pi-test", "runId":"turn-1", "memberId":"pi-member",
        "runtime":{"id":"pi", "name":"Pi", "adapter":"pi", "executable":executable,
            "enabled":true,"args":[],"defaultModel":""},
        "directory":directory,"model":"", "prompt":"Hello Pi"
    }))
    .unwrap()
}
fn script(path: &Path, body: &str) {
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}
fn run(manager: &RuntimeManager, request: StartRequest, timeout: Duration) -> Vec<RuntimeEvent> {
    let (tx, rx) = mpsc::channel();
    manager
        .start(
            request,
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .unwrap();
    let started = Instant::now();
    let mut events = Vec::new();
    loop {
        let result = rx.recv_timeout(timeout.saturating_sub(started.elapsed()));
        let event = match result {
            Ok(event) => event,
            Err(error) => {
                manager.shutdown();
                panic!("Pi did not terminate within deadline: {error}");
            }
        };
        let done = matches!(event.kind.as_str(), "completed" | "failed" | "stopped");
        events.push(event);
        if done {
            return events;
        }
    }
}

#[test]
fn pi_arguments_own_model_session_protocol_and_keep_prompt_off_argv() {
    let dir = tempfile::tempdir().unwrap();
    let mut req = request(dir.path(), Path::new("pi"));
    req.model = "custom/model:variant".into();
    req.session_id = Some("exact-session".into());
    assert_eq!(
        build_arguments(&req).unwrap(),
        [
            "--print",
            "--mode",
            "json",
            "--provider",
            "custom",
            "--model",
            "model:variant",
            "--session",
            "exact-session"
        ]
    );
    for flag in [
        "--continue",
        "-c",
        "--resume",
        "--session",
        "--session-dir",
        "--no-session",
        "--mode=rpc",
        "--model",
        "--provider",
        "--thinking",
        "--",
        "extra prompt",
        "@file",
    ] {
        req.runtime.args = vec![flag.into()];
        assert!(build_arguments(&req).is_err(), "accepted {flag}");
    }
    req.runtime.args = vec!["--tools".into(), "read,ls".into()];
    assert!(build_arguments(&req).is_ok());
    req.runtime.args = vec!["--tools".into()];
    assert!(build_arguments(&req).is_err());
}

#[test]
fn pi_native_manager_does_not_promote_zero_exit_to_success_and_preserves_stdin() {
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("pi-fixture");
    let manager = RuntimeManager::new(Arc::new(Storage::new(dir.path().join("data")).unwrap()));
    for (index, stop) in ["stop", "error", "aborted", "length"].iter().enumerate() {
        script(
            &executable,
            &format!(
                r#"cat > prompt.txt
printf '%s\n' '{{"type":"session","id":"session-test"}}' '{{"type":"agent_start"}}' '{{"type":"message_end","message":{{"role":"assistant","stopReason":"{stop}","content":[{{"type":"text","text":"done"}}]}}}}' '{{"type":"agent_end"}}'
"#
            ),
        );
        let mut req = request(dir.path(), &executable);
        req.run_id = format!("turn-{index}");
        req.prompt = "中文🙂 $(literal) @file --flag\n".repeat(10000);
        let prompt = req.prompt.clone();
        let events = run(&manager, req, Duration::from_secs(5));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("prompt.txt")).unwrap(),
            prompt
        );
        assert_eq!(
            events.last().unwrap().kind,
            if *stop == "stop" {
                "completed"
            } else {
                "failed"
            }
        );
    }
    manager.shutdown();
}

#[test]
fn pi_stop_retains_partial_output_and_reaps_the_process() {
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("pi-fixture");
    script(
        &executable,
        "cat > /dev/null\nprintf '%s\\n' '{\"type\":\"session\",\"id\":\"partial\"}'\nsleep 30",
    );
    let manager = RuntimeManager::new(Arc::new(Storage::new(dir.path().join("data")).unwrap()));
    let (tx, rx) = mpsc::channel();
    manager
        .start(
            request(dir.path(), &executable),
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .unwrap();
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if event.kind == "stdout" {
            assert!(event.text.contains("partial"));
            break;
        }
    }
    manager.stop("turn-1", Some("pi-member")).unwrap();
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if matches!(event.kind.as_str(), "completed" | "failed" | "stopped") {
            assert_eq!(event.kind, "stopped");
            break;
        }
    }
    manager.shutdown();
}

/// Opt-in: uses the installed CLI and its existing authenticated default model.
/// Tools and extensions are disabled; session and trace files live in a temp dir.
#[test]
#[ignore]
fn pi_live_native_two_turn_session() {
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("pi-live");
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let pi = resolve("pi").unwrap();
    script(
        &executable,
        &format!(
            "export PI_CODING_AGENT_SESSION_DIR={}\nexec {} \"$@\"",
            quote(&dir.path().join("sessions").to_string_lossy()),
            quote(&pi.to_string_lossy())
        ),
    );
    let manager = RuntimeManager::new(Arc::new(Storage::new(dir.path().join("data")).unwrap()));
    let mut req = request(dir.path(), &executable);
    req.runtime.args = [
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--offline",
    ]
    .map(String::from)
    .to_vec();
    let token = format!("PI_SESSION_{}", uuid::Uuid::new_v4().simple());
    req.prompt = format!("Remember the exact token {token}. Reply only ACK. Do not use tools.");
    let first = run(&manager, req.clone(), Duration::from_secs(120));
    assert_eq!(
        first.last().unwrap().kind,
        "completed",
        "{}",
        first.last().unwrap().text
    );
    let frames = |events: &[RuntimeEvent]| {
        events
            .iter()
            .filter(|event| event.kind == "stdout")
            .map(|event| event.text.as_str())
            .collect::<String>()
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .collect::<Vec<_>>()
    };
    let first_frames = frames(&first);
    let session = first_frames
        .iter()
        .find(|value| value["type"] == "session")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    req.run_id = "turn-2".into();
    req.session_id = Some(session.clone());
    req.prompt =
        "Return only the exact token I asked you to remember in my previous message.".into();
    let second = run(&manager, req, Duration::from_secs(120));
    manager.shutdown();
    assert_eq!(
        second.last().unwrap().kind,
        "completed",
        "{}",
        second.last().unwrap().text
    );
    let second_frames = frames(&second);
    assert!(second_frames
        .iter()
        .any(|value| value["type"] == "session" && value["id"] == session));
    assert!(second_frames
        .iter()
        .any(|value| value["type"] == "message_end"
            && value["message"]["role"] == "assistant"
            && value["message"]["content"]
                .as_array()
                .is_some_and(|blocks| blocks.iter().any(|block| block["text"]
                    .as_str()
                    .is_some_and(|text| text.contains(&token))))));
    println!("Pi native remote inference passed: two completed turns, same native session, exact random-token recall; tools/extensions disabled.");
}

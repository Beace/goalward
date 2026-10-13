use super::*;
use std::{fs, os::unix::fs::PermissionsExt, sync::mpsc};

fn fixture(directory: &std::path::Path, ending: &str, resume: bool) -> StartRequest {
    let executable = directory.join("codex-fixture");
    let method = if resume {
        "thread/resume"
    } else {
        "thread/start"
    };
    let script = format!(
        r##"#!/bin/sh
set -eu
[ "$1" = app-server ]
read -r line
case "$line" in *'"id":1'*'"method":"initialize"'*) ;; *) exit 11;; esac
printf '%s\n' '{{"id":1,"result":{{"userAgent":"fixture/1"}}}}'
read -r line
case "$line" in *'"method":"initialized"'*) ;; *) exit 12;; esac
read -r line
case "$line" in *'"method":"{method}"'*'"approvalPolicy":"never"'*'"model":"fixture-model"'*'"sandbox":"read-only"'*) ;; *) exit 13;; esac
{resume_assertion}
printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"fixture-thread","turns":[{{"items":[{{"type":"agentMessage","id":"old","text":"OLD_REPLAY"}}]}}]}},"approvalPolicy":"never","sandbox":{{"type":"readOnly","networkAccess":false}}}}}}'
read -r line
case "$line" in *'"method":"turn/start"'*'"approvalPolicy":"never"'*'"effort":"high"'*'literal $(do not execute) café'*'"model":"fixture-model"'*'"networkAccess":false'*'"type":"readOnly"'*'"threadId":"fixture-thread"'*) ;; *) exit 14;; esac
printf '%s\n' '{{"id":3,"result":{{"turn":{{"id":"fixture-turn","status":"inProgress","items":[]}}}}}}'
{ending}
"##,
        resume_assertion = if resume {
            r#"case "$line" in *'"threadId":"fixture-thread"'*) ;; *) exit 15;; esac"#
        } else {
            ""
        },
    );
    fs::write(&executable, script).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    serde_json::from_value(serde_json::json!({
        "taskId":"codex-assistant", "runId":"run-codex", "memberId":"assistant-member",
        "runtime":{"id":"codex","name":"Codex fixture","executable":executable,"adapter":"codex","enabled":true,"args":[],"defaultModel":"", "permissions":{"codex":{"sandbox":"read-only"}}},
        "codexStreaming":true,"model":"fixture-model", "reasoningEffort":"high",
        "sessionId":if resume { Some("fixture-thread") } else { None },
        "directory":directory,"prompt":"literal $(do not execute) café"
    })).unwrap()
}

fn manager(
    directory: &std::path::Path,
    request: StartRequest,
) -> (RuntimeManager, mpsc::Receiver<RuntimeEvent>) {
    let manager = RuntimeManager::new(Arc::new(Storage::new(directory.join("data")).unwrap()));
    let (tx, rx) = mpsc::channel();
    manager
        .start(
            request,
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .unwrap();
    (manager, rx)
}

fn terminal(rx: &mpsc::Receiver<RuntimeEvent>) -> Vec<RuntimeEvent> {
    let mut events = Vec::new();
    loop {
        let event = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("Codex fixture must finish");
        let done = matches!(event.kind.as_str(), "completed" | "failed" | "stopped");
        events.push(event);
        if done {
            return events;
        }
    }
}

const DELTA: &str = r#"printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"fixture-thread","turnId":"fixture-turn","itemId":"message","delta":"Public"}}'
"#;
const COMPLETE: &str = r#"printf '%s\n' '{"method":"item/completed","params":{"threadId":"fixture-thread","turnId":"fixture-turn","item":{"type":"agentMessage","id":"message","text":"Public answer"}}}'
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"fixture-thread","turn":{"id":"fixture-turn","status":"completed","items":[]}}}'
while read -r line; do :; done
"#;

#[test]
fn codex_streams_partial_before_the_live_server_turn_completes() {
    let directory = tempfile::tempdir().unwrap();
    let ending = format!("{DELTA}\nwhile [ ! -e release-turn ]; do sleep 0.02; done\n{COMPLETE}");
    let request = fixture(directory.path(), &ending, false);
    let (manager, rx) = manager(directory.path(), request.clone());
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            !matches!(event.kind.as_str(), "completed" | "failed" | "stopped"),
            "{}",
            event.text
        );
        if event.text.contains("item/agentMessage/delta") {
            let value: serde_json::Value = serde_json::from_str(&event.text).unwrap();
            assert_eq!(value["params"]["delta"], "Public");
            assert!(
                manager.while_idle(|| Ok(())).is_err(),
                "App-server must still be alive during the delta"
            );
            break;
        }
    }
    fs::write(directory.path().join("release-turn"), "release").unwrap();
    let events = terminal(&rx);
    assert_eq!(
        events.last().unwrap().kind,
        "completed",
        "{}",
        events.last().unwrap().text
    );
    manager.shutdown();
    assert!(manager.processes.lock().unwrap().is_empty());
    let trace = fs::read_to_string(
        manager
            .storage
            .trace_path(&request.task_id, &request.run_id, &request.member_id)
            .unwrap(),
    )
    .unwrap();
    assert!(trace.contains("item/agentMessage/delta"));
    assert!(trace.contains("Public answer"));
}

#[test]
fn codex_resumes_exact_thread_without_replaying_old_responses() {
    let directory = tempfile::tempdir().unwrap();
    let request = fixture(directory.path(), &format!("{DELTA}{COMPLETE}"), true);
    let (manager, rx) = manager(directory.path(), request);
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(
        events.last().unwrap().kind,
        "completed",
        "{}",
        events.last().unwrap().text
    );
    let text = events
        .iter()
        .map(|event| event.text.as_str())
        .collect::<String>();
    assert!(!text.contains("OLD_REPLAY"));
    assert!(text.contains("\"thread_id\":\"fixture-thread\""));
    assert!(text.contains("Public answer"));
}

#[test]
fn codex_failed_interrupted_and_disconnected_turns_are_never_completed() {
    for ending in [
        "exit 0",
        r#"printf '%s\n' '{"method":"turn/completed","params":{"threadId":"fixture-thread","turn":{"id":"fixture-turn","status":"failed","error":{"message":"model unavailable"},"items":[]}}}'
while read -r line; do :; done"#,
        r#"printf '%s\n' '{"method":"turn/completed","params":{"threadId":"fixture-thread","turn":{"id":"fixture-turn","status":"interrupted","items":[]}}}'
while read -r line; do :; done"#,
        "printf 'invalid json\\n'",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let (manager, rx) = manager(directory.path(), fixture(directory.path(), ending, false));
        let events = terminal(&rx);
        manager.shutdown();
        assert_eq!(
            events.last().unwrap().kind,
            "failed",
            "Ending {ending}: {}",
            events.last().unwrap().text
        );
        assert!(!events.iter().any(|event| event.kind == "completed"));
    }
}

#[test]
fn codex_stop_interrupts_the_turn_and_drains_the_process() {
    let directory = tempfile::tempdir().unwrap();
    let ending = format!(
        r#"{DELTA}
read -r line
case "$line" in *'"method":"turn/interrupt"'*'"threadId":"fixture-thread"'*'"turnId":"fixture-turn"'*) ;; *) exit 16;; esac
touch interrupted
printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"fixture-thread","turn":{{"id":"fixture-turn","status":"interrupted","items":[]}}}}}}'
while read -r line; do :; done
"#
    );
    let (manager, rx) = manager(directory.path(), fixture(directory.path(), &ending, false));
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_ne!(event.kind, "failed", "{}", event.text);
        if event.text.contains("item/agentMessage/delta") {
            break;
        }
    }
    manager.stop("run-codex", Some("assistant-member")).unwrap();
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(events.last().unwrap().kind, "stopped");
    assert!(directory.path().join("interrupted").exists());
    assert!(manager.processes.lock().unwrap().is_empty());
}

#[test]
fn codex_rejects_server_approvals_instead_of_bypassing_restrictions() {
    let directory = tempfile::tempdir().unwrap();
    let ending = r#"printf '%s\n' '{"id":71,"method":"item/commandExecution/requestApproval","params":{"threadId":"fixture-thread","turnId":"fixture-turn"}}'
read -r line
case "$line" in *'"id":71'*'"decision":"decline"'*) touch declined;; *) exit 16;; esac
while read -r line; do :; done
"#;
    let (manager, rx) = manager(directory.path(), fixture(directory.path(), ending, false));
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(events.last().unwrap().kind, "failed");
    assert!(directory.path().join("declined").exists());
    assert!(events
        .iter()
        .any(|event| event.text.contains("request_rejected")));
}

#[test]
fn codex_unknown_client_requests_fail_without_enabling_a_tool() {
    let directory = tempfile::tempdir().unwrap();
    let ending = r#"printf '%s\n' '{"id":"unexpected-tool","method":"item/tool/call","params":{"threadId":"fixture-thread","turnId":"fixture-turn","tool":"write_file"}}'
read -r line
case "$line" in *'"code":-32601'*'"id":"unexpected-tool"'*) touch rejected;; *) exit 16;; esac
while read -r line; do :; done
"#;
    let (manager, rx) = manager(directory.path(), fixture(directory.path(), ending, false));
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(events.last().unwrap().kind, "failed");
    assert!(directory.path().join("rejected").exists());
}

#[test]
fn codex_mismatched_thread_and_permission_readback_never_send_the_prompt() {
    for replacement in [
        (
            "\"approvalPolicy\":\"never\"",
            "\"approvalPolicy\":\"untrusted\"",
        ),
        ("\"type\":\"readOnly\"", "\"type\":\"dangerFullAccess\""),
        ("\"networkAccess\":false", "\"networkAccess\":true"),
        ("\"networkAccess\":false", "\"networkAccess\":null"),
        ("\"id\":\"fixture-thread\"", "\"id\":\"wrong-thread\""),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let request = fixture(directory.path(), "touch prompt-sent; exit 0", true);
        let script = fs::read_to_string(&request.runtime.executable).unwrap();
        // Change only the response, leaving the outgoing request assertions intact.
        let script = script
            .lines()
            .map(|line| {
                if line.starts_with("printf") && line.contains("\"id\":2") {
                    line.replace(replacement.0, replacement.1)
                } else {
                    line.to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&request.runtime.executable, script).unwrap();
        let (manager, rx) = manager(directory.path(), request);
        let events = terminal(&rx);
        manager.shutdown();
        assert_eq!(events.last().unwrap().kind, "failed");
        assert!(!directory.path().join("prompt-sent").exists());
    }
}

#[test]
fn codex_notifications_before_turn_response_and_other_threads_are_correlated() {
    let directory = tempfile::tempdir().unwrap();
    let request = fixture(directory.path(), COMPLETE, false);
    let script = fs::read_to_string(&request.runtime.executable).unwrap();
    let premature = DELTA.replace("Public", "early");
    let foreign = DELTA
        .replace("fixture-thread", "foreign-thread")
        .replace("Public", "foreign");
    let script = script
        .lines()
        .map(|line| {
            if line.starts_with("printf") && line.contains("\"id\":3") {
                format!("{foreign}{premature}{line}")
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&request.runtime.executable, script).unwrap();
    let (manager, rx) = manager(directory.path(), request);
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(
        events.last().unwrap().kind,
        "completed",
        "{}",
        events.last().unwrap().text
    );
    let text = events
        .iter()
        .map(|event| event.text.as_str())
        .collect::<String>();
    assert!(text.contains("early"));
    assert!(!text.contains("foreign"));
}

#[test]
fn codex_ignores_same_thread_errors_from_another_turn() {
    let directory = tempfile::tempdir().unwrap();
    let ending = format!(
        r#"{DELTA}
printf '%s\n' '{{"method":"error","params":{{"threadId":"fixture-thread","turnId":"old-turn","willRetry":false,"error":{{"message":"OLD_TURN_ERROR"}}}}}}'
{COMPLETE}"#
    );
    let (manager, rx) = manager(directory.path(), fixture(directory.path(), &ending, false));
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(
        events.last().unwrap().kind,
        "completed",
        "{}",
        events.last().unwrap().text
    );
    assert!(!events
        .iter()
        .any(|event| event.text.contains("OLD_TURN_ERROR")));
}

#[test]
fn codex_large_public_delta_is_chunked_without_cumulative_snapshots() {
    let directory = tempfile::tempdir().unwrap();
    let text = "café public".repeat(2000);
    let value = serde_json::json!({"method":"item/agentMessage/delta","params":{"threadId":"fixture-thread","turnId":"fixture-turn","itemId":"large-message","delta":text}});
    let ending = format!("printf '%s\\n' '{value}'\n{COMPLETE}");
    let (manager, rx) = manager(directory.path(), fixture(directory.path(), &ending, false));
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(
        events.last().unwrap().kind,
        "completed",
        "{}",
        events.last().unwrap().text
    );
    let chunks = events
        .iter()
        .filter(|event| event.kind == "stdout")
        .collect::<Vec<_>>();
    assert!(chunks.iter().all(|event| event.text.len() <= 4096));
    let wire = chunks
        .iter()
        .map(|event| event.text.as_str())
        .collect::<String>();
    let frames = wire
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    let deltas = frames
        .iter()
        .filter(|value| value["method"] == "item/agentMessage/delta")
        .collect::<Vec<_>>();
    assert_eq!(deltas.len(), 1);
    assert_eq!(deltas[0]["params"]["delta"], text);
    assert!(!wire.contains("item.updated"));
}

#[test]
fn codex_public_progress_and_metadata_are_emitted_before_completion_and_sanitized() {
    let directory = tempfile::tempdir().unwrap();
    let notifications = [
        serde_json::json!({"method":"turn/started","params":{"threadId":"fixture-thread","turn":{
            "id":"fixture-turn","status":"inProgress","startedAt":100,
            "items":[{"id":"reasoning-start","type":"reasoning","summary":["Public opening"],"content":["PRIVATE_STARTED_THOUGHT"],"config":"PRIVATE_ITEM_CONFIG"}],
            "config":"PRIVATE_TURN_CONFIG"
        },"credentials":"PRIVATE_START_CREDENTIALS"}}),
        serde_json::json!({"method":"item/reasoning/summaryPartAdded","params":{"threadId":"fixture-thread","turnId":"fixture-turn","itemId":"reasoning","summaryIndex":0,"secret":"PRIVATE_PART_FIELD"}}),
        serde_json::json!({"method":"item/reasoning/summaryTextDelta","params":{"threadId":"fixture-thread","turnId":"fixture-turn","itemId":"reasoning","summaryIndex":0,"delta":"Public planning summary","secret":"PRIVATE_SUMMARY_FIELD"}}),
        serde_json::json!({"method":"item/reasoning/textDelta","params":{"threadId":"fixture-thread","turnId":"fixture-turn","itemId":"reasoning","delta":"PRIVATE_RAW_THOUGHT"}}),
        serde_json::json!({"method":"item/completed","params":{"threadId":"fixture-thread","turnId":"fixture-turn","item":{"id":"reasoning","type":"reasoning","summary":["Public planning summary"],"content":["PRIVATE_COMPLETED_THOUGHT"],"secret":"PRIVATE_REASONING_FIELD"}}}),
        serde_json::json!({"method":"thread/tokenUsage/updated","params":{"threadId":"fixture-thread","turnId":"fixture-turn","tokenUsage":{
            "total":{"totalTokens":120,"inputTokens":80,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":20,"secret":"PRIVATE_COUNT_FIELD"},
            "last":{"totalTokens":60,"inputTokens":40,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":10},
            "modelContextWindow":200000,"config":"PRIVATE_USAGE_CONFIG"
        },"secret":"PRIVATE_USAGE_FIELD"}}),
        serde_json::json!({"method":"model/rerouted","params":{"threadId":"fixture-thread","turnId":"fixture-turn","fromModel":"fixture-model","toModel":"rerouted-model","reason":"highRiskCyberActivity","config":"PRIVATE_MODEL_CONFIG"}}),
        serde_json::json!({"method":"item/mcpToolCall/progress","params":{"threadId":"fixture-thread","turnId":"fixture-turn","itemId":"tool","message":"Inspecting public reference","credentials":"PRIVATE_TOOL_CREDENTIALS"}}),
    ];
    let prelude = notifications
        .iter()
        .map(|value| format!("printf '%s\\n' '{value}'\n"))
        .collect::<String>();
    let ending = format!("{prelude}\nwhile [ ! -e release-turn ]; do sleep 0.02; done\n{COMPLETE}");
    let request = fixture(directory.path(), &ending, false);
    let script = fs::read_to_string(&request.runtime.executable).unwrap().replace(
        "\"approvalPolicy\":\"never\",\"sandbox\":",
        "\"model\":\"fixture-model\",\"modelProvider\":\"fixture-provider\",\"reasoningEffort\":\"medium\",\"config\":\"PRIVATE_THREAD_CONFIG\",\"credentials\":\"PRIVATE_THREAD_CREDENTIALS\",\"approvalPolicy\":\"never\",\"sandbox\":",
    );
    fs::write(&request.runtime.executable, script).unwrap();
    let (manager, rx) = manager(directory.path(), request);
    let mut frames = Vec::new();
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            !matches!(event.kind.as_str(), "completed" | "failed" | "stopped"),
            "{}",
            event.text
        );
        if event.kind != "stdout" {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(&event.text).unwrap();
        let last = value["method"] == "item/mcpToolCall/progress";
        frames.push(value);
        if last {
            break;
        }
    }
    assert!(
        manager.while_idle(|| Ok(())).is_err(),
        "Progress must be emitted while server turn is still running"
    );
    let metadata = frames
        .iter()
        .find(|value| value["type"] == "codex.app_server.thread_ready")
        .unwrap();
    assert_eq!(
        metadata,
        &serde_json::json!({"type":"codex.app_server.thread_ready","source":"server","threadId":"fixture-thread","model":"fixture-model","modelProvider":"fixture-provider","reasoningEffort":"medium"})
    );
    for method in [
        "turn/started",
        "item/reasoning/summaryPartAdded",
        "item/reasoning/summaryTextDelta",
        "thread/tokenUsage/updated",
        "model/rerouted",
        "item/mcpToolCall/progress",
    ] {
        assert!(
            frames.iter().any(|value| value["method"] == method),
            "Missing public event {method}"
        );
    }
    let reasoning = frames
        .iter()
        .find(|value| {
            value["type"] == "codex.app_server.item" && value["item"]["id"] == "reasoning"
        })
        .unwrap();
    assert_eq!(reasoning["threadId"], "fixture-thread");
    assert_eq!(reasoning["turnId"], "fixture-turn");
    assert_eq!(
        reasoning["item"],
        serde_json::json!({"id":"reasoning","type":"reasoning","summary":["Public planning summary"]})
    );
    let usage = frames
        .iter()
        .find(|value| value["method"] == "thread/tokenUsage/updated")
        .unwrap();
    assert_eq!(usage["params"]["tokenUsage"]["total"]["totalTokens"], 120);
    assert_eq!(usage["params"]["tokenUsage"]["modelContextWindow"], 200000);
    assert!(
        !frames
            .iter()
            .any(|value| value.to_string().contains("PRIVATE_")),
        "Private/unknown fields entered public trace output"
    );
    fs::write(directory.path().join("release-turn"), "release").unwrap();
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(
        events.last().unwrap().kind,
        "completed",
        "{}",
        events.last().unwrap().text
    );
}

#[test]
fn codex_public_progress_requires_the_exact_current_thread_and_turn() {
    let directory = tempfile::tempdir().unwrap();
    let notifications = [
        serde_json::json!({"method":"thread/tokenUsage/updated","params":{"threadId":"fixture-thread","turnId":"fixture-turn","tokenUsage":{"total":{"totalTokens":99},"last":{"totalTokens":99},"modelContextWindow":1000}}}),
        serde_json::json!({"method":"model/rerouted","params":{"threadId":"fixture-thread","turnId":"fixture-turn","fromModel":"old","toModel":"new","reason":"highRiskCyberActivity"}}),
        serde_json::json!({"method":"item/reasoning/summaryPartAdded","params":{"threadId":"fixture-thread","turnId":"fixture-turn","itemId":"reasoning","summaryIndex":0}}),
        serde_json::json!({"method":"item/reasoning/summaryTextDelta","params":{"threadId":"fixture-thread","turnId":"fixture-turn","itemId":"reasoning","summaryIndex":0,"delta":"FOREIGN_PROGRESS"}}),
        serde_json::json!({"method":"item/mcpToolCall/progress","params":{"threadId":"fixture-thread","turnId":"fixture-turn","itemId":"tool","message":"FOREIGN_PROGRESS"}}),
    ];
    let mut prelude = String::new();
    for value in &notifications {
        for field in ["threadId", "turnId"] {
            let mut foreign = value.clone();
            foreign["params"][field] = "foreign".into();
            prelude.push_str(&format!("printf '%s\\n' '{foreign}'\n"));
        }
    }
    prelude.push_str("printf '%s\\n' '{\"method\":\"turn/started\",\"params\":{\"threadId\":\"fixture-thread\",\"turn\":{\"id\":\"foreign\",\"status\":\"inProgress\",\"items\":[]}}}'\n");
    let (manager, rx) = manager(
        directory.path(),
        fixture(directory.path(), &format!("{prelude}{COMPLETE}"), false),
    );
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(
        events.last().unwrap().kind,
        "completed",
        "{}",
        events.last().unwrap().text
    );
    let wire = events
        .iter()
        .filter(|event| event.kind == "stdout")
        .map(|event| event.text.as_str())
        .collect::<String>();
    assert!(!wire.contains("foreign"));
    assert!(!wire.contains("FOREIGN_PROGRESS"));
    assert!(!wire.contains("thread/tokenUsage/updated"));
    assert!(!wire.contains("model/rerouted"));
    assert!(!wire.contains("item/reasoning/summary"));
    assert!(!wire.contains("item/mcpToolCall/progress"));
}

#[test]
fn codex_uses_native_protocol_by_default_and_preserves_readonly_restrictions() {
    let directory = tempfile::tempdir().unwrap();
    let mut request = fixture(directory.path(), COMPLETE, false);
    assert_eq!(build_arguments(&request).unwrap()[0], "app-server");
    request.codex_streaming = false;
    assert_eq!(build_arguments(&request).unwrap()[0], "app-server");
    request.codex_streaming = true;
    request.runtime.args = vec!["--yolo".into()];
    assert!(build_arguments(&request).is_err());
    request.runtime.args.clear();
    request.runtime.permissions = None;
    assert!(build_arguments(&request).is_err());
}

#[test]
#[ignore = "manual real installed Codex validation; uses local login, read-only temporary directory, synthetic prose only"]
fn installed_codex_goal_assistant_streams_real_model_and_resumes() {
    let directory = tempfile::tempdir().unwrap();
    let executable = crate::discovery::resolve("codex").expect("Install Codex first");
    let mut request = fixture(directory.path(), COMPLETE, false);
    request.runtime.executable = executable.to_string_lossy().into_owned();
    request.model = "".into();
    request.reasoning_effort = None;
    request.prompt = "This is a streaming integration test. Do not call tools or read files. Reply with eight numbered short sentences explaining why visible progress helps users. Include the exact token GOALWARD_STREAM_FIRST once. Use plain prose and no code blocks.".into();
    let manager = RuntimeManager::new(Arc::new(
        Storage::new(directory.path().join("real-data")).unwrap(),
    ));
    for round in 0..2 {
        if round == 1 {
            request.run_id = "run-codex-resumed".into();
            request.prompt = "Continue the previous conversation. Do not call tools or read files. Mention the exact uppercase test token from my previous message, followed by four brief sentences about feedback. Use plain prose.".into();
        }
        let (tx, rx) = mpsc::channel();
        manager
            .start(
                request.clone(),
                Arc::new(move |event| {
                    let _ = tx.send(event);
                }),
            )
            .unwrap();
        let start = Instant::now();
        let mut deltas = 0;
        let mut public_text = String::new();
        let mut session = None;
        let mut metadata_reports = 0;
        let mut metadata_thread = None;
        let mut model_confirmed = false;
        let mut turn_started_reports = 0;
        let mut usage_reports = 0;
        let mut last_usage_tokens = None;
        let mut summary_deltas = 0;
        loop {
            let event =
                match rx.recv_timeout(Duration::from_secs(180).saturating_sub(start.elapsed())) {
                    Ok(event) => event,
                    Err(error) => {
                        manager.shutdown();
                        panic!("Installed Codex timed out: {error}");
                    }
                };
            if event.kind == "stdout" {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&event.text) {
                    if value["type"] == "thread.started" {
                        session = value["thread_id"].as_str().map(str::to_owned);
                    }
                    if value["type"] == "codex.app_server.thread_ready" {
                        metadata_reports += 1;
                        metadata_thread = value["threadId"].as_str().map(str::to_owned);
                        model_confirmed = value["model"]
                            .as_str()
                            .is_some_and(|model| !model.trim().is_empty());
                    }
                    if value["method"] == "turn/started" {
                        turn_started_reports += 1;
                    }
                    if value["method"] == "thread/tokenUsage/updated" {
                        usage_reports += 1;
                        last_usage_tokens =
                            value["params"]["tokenUsage"]["last"]["totalTokens"].as_u64();
                    }
                    if value["method"] == "item/reasoning/summaryTextDelta" {
                        summary_deltas += 1;
                    }
                    if value["method"] == "item/agentMessage/delta" {
                        deltas += 1;
                        public_text.push_str(value["params"]["delta"].as_str().unwrap_or(""));
                    }
                    if value["item"]["type"] == "agent_message" {
                        public_text = value["item"]["text"].as_str().unwrap_or("").to_owned();
                    }
                }
            }
            if matches!(event.kind.as_str(), "completed" | "failed" | "stopped") {
                assert_eq!(event.kind, "completed", "{}", event.text);
                break;
            }
        }
        assert!(
            deltas >= 2,
            "Expected multiple public deltas before completion, received {deltas}"
        );
        assert_eq!(
            metadata_reports, 1,
            "Expected one server-confirmed thread metadata report"
        );
        assert!(
            model_confirmed,
            "Codex did not confirm a nonempty model in thread metadata"
        );
        assert_eq!(
            metadata_thread, session,
            "Thread metadata must describe the native conversation"
        );
        assert!(
            turn_started_reports > 0,
            "Codex did not report the current turn starting"
        );
        assert!(
            public_text.contains("GOALWARD_STREAM_FIRST"),
            "Model did not preserve the synthetic conversation token"
        );
        if round == 0 {
            request.session_id = session;
            assert!(request.session_id.is_some());
        } else {
            assert_eq!(session, request.session_id);
        }
        // Token usage and public reasoning summaries remain provider/runtime
        // dependent. Report what arrived rather than manufacture required data.
        println!("Installed Codex round {round}: {deltas} public deltas; metadata_reports={metadata_reports}, model_confirmed={model_confirmed}, turn_started_reports={turn_started_reports}, token_usage_reports={usage_reports}, last_usage_tokens={last_usage_tokens:?}, public_summary_deltas={summary_deltas}; native thread {}", if round == 0 { "created" } else { "resumed exactly" });
    }
    manager.shutdown();
    assert!(manager.processes.lock().unwrap().is_empty());
}

fn persistent_fixture(directory: &std::path::Path, prompt: &str) -> StartRequest {
    let mut request = fixture(directory, "exit 0", false);
    request.codex_streaming = false;
    request.prompt = prompt.into();
    fs::write(&request.runtime.executable, r##"#!/bin/sh
set -eu
[ "$1" = app-server ]
printf '%s\n' "$$" >> connection-pids
turn=0
while IFS= read -r line; do
  printf '%s\n' "$line" >> native-requests
  id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\1/')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{"userAgent":"fixture"}}\n' "$id";;
    *'"method":"initialized"'*) :;;
    *'"method":"thread/start"'*|*'"method":"thread/resume"'*) printf '{"id":%s,"result":{"thread":{"id":"fixture-thread"},"approvalPolicy":"on-request","sandbox":{"type":"readOnly","networkAccess":false}}}\n' "$id";;
    *'"method":"turn/start"'*)
      turn=$((turn + 1))
      if [ "$turn" -gt 1 ]; then
        printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"fixture-thread","turnId":"turn-1","itemId":"old-message","delta":"STALE_OLD_TURN"}}'
      fi
      printf '{"id":%s,"result":{"turn":{"id":"turn-%s","status":"inProgress"}}}\n' "$id" "$turn"
      printf '{"method":"item/agentMessage/delta","params":{"threadId":"fixture-thread","turnId":"turn-%s","itemId":"message-%s","delta":"live partial"}}\n' "$turn" "$turn"
      case "$line" in
        *'approve-tool'*) printf '{"id":71,"method":"item/commandExecution/requestApproval","params":{"threadId":"fixture-thread","turnId":"turn-%s","command":"echo tool"}}\n' "$turn";;
        *'wait-for-control'*) :;;
        *) printf '{"method":"turn/completed","params":{"threadId":"fixture-thread","turn":{"id":"turn-%s","status":"completed","items":[]}}}\n' "$turn";;
      esac;;
    *'"method":"turn/steer"'*)
      case "$line" in *'"expectedTurnId":"turn-1"'*) ;; *) exit 71;; esac
      printf '{"id":%s,"result":{"turnId":"turn-%s"}}\n' "$id" "$turn"
      printf '{"method":"item/commandExecution/outputDelta","params":{"threadId":"fixture-thread","turnId":"turn-%s","itemId":"tool-1","delta":"live tool progress"}}\n' "$turn"
      printf '{"method":"turn/completed","params":{"threadId":"fixture-thread","turn":{"id":"turn-%s","status":"completed","items":[]}}}\n' "$turn";;
    *'"method":"turn/interrupt"'*)
      printf '{"id":%s,"result":{}}\n' "$id"
      printf '{"method":"turn/completed","params":{"threadId":"fixture-thread","turn":{"id":"turn-%s","status":"interrupted","items":[]}}}\n' "$turn";;
    *'"id":71'*'"decision":"accept"'*)
      touch tool-approved
      printf '{"method":"turn/completed","params":{"threadId":"fixture-thread","turn":{"id":"turn-%s","status":"completed","items":[]}}}\n' "$turn";;
    *) exit 72;;
  esac
done
"##).unwrap();
    request
}

#[test]
fn business_codex_reuses_one_connection_and_thread_but_separates_turn_traces() {
    let directory = tempfile::tempdir().unwrap();
    let request = persistent_fixture(directory.path(), "first turn");
    let (manager, rx) = manager(directory.path(), request.clone());
    let first = terminal(&rx);
    assert_eq!(first.last().unwrap().kind, "completed");
    assert_eq!(manager.connections.lock().unwrap().len(), 1);
    assert!(manager.processes.lock().unwrap().is_empty());
    assert!(
        manager.active_turns().unwrap().is_empty(),
        "An idle native connection is not an active Turn after webview reload"
    );
    let mut second_request = request.clone();
    second_request.run_id = "run-codex-2".into();
    second_request.session_id = Some("fixture-thread".into());
    second_request.prompt = "second turn".into();
    let (tx, second_rx) = mpsc::channel();
    manager
        .start(
            second_request.clone(),
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .unwrap();
    let second = terminal(&second_rx);
    assert_eq!(
        second.last().unwrap().kind,
        "completed",
        "{}",
        second.last().unwrap().text
    );
    assert!(second
        .iter()
        .all(|event| event.run_id == second_request.run_id));
    assert!(!second
        .iter()
        .any(|event| event.text.contains("STALE_OLD_TURN")));
    assert_eq!(
        fs::read_to_string(directory.path().join("connection-pids"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    let requests = fs::read_to_string(directory.path().join("native-requests")).unwrap();
    assert_eq!(requests.matches("\"method\":\"initialize\"").count(), 1);
    assert_eq!(requests.matches("\"method\":\"turn/start\"").count(), 2);
    // Idle app-server is not an active task; update guard closes its connection.
    manager.while_idle(|| Ok(())).unwrap();
    assert!(manager.connections.lock().unwrap().is_empty());
}

#[test]
fn codex_interrupt_preserves_live_conversation_for_the_next_turn() {
    let directory = tempfile::tempdir().unwrap();
    let request = persistent_fixture(directory.path(), "wait-for-control");
    let (manager, rx) = manager(directory.path(), request.clone());
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if event.text.contains("item/agentMessage/delta") {
            break;
        }
        assert_ne!(event.kind, "failed", "{}", event.text);
    }
    manager
        .stop(&request.run_id, Some(&request.member_id))
        .unwrap();
    assert_eq!(terminal(&rx).last().unwrap().kind, "stopped");
    assert_eq!(manager.connections.lock().unwrap().len(), 1);
    let mut next = request;
    next.run_id = "run-after-stop".into();
    next.prompt = "continue".into();
    next.session_id = Some("fixture-thread".into());
    let (tx, next_rx) = mpsc::channel();
    manager
        .start(
            next,
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .unwrap();
    assert_eq!(terminal(&next_rx).last().unwrap().kind, "completed");
    assert_eq!(
        fs::read_to_string(directory.path().join("connection-pids"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    manager.shutdown();
}

#[test]
fn codex_native_steering_and_tool_progress_are_correlated_to_active_turn() {
    let directory = tempfile::tempdir().unwrap();
    let request = persistent_fixture(directory.path(), "wait-for-control");
    let (manager, rx) = manager(directory.path(), request.clone());
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if event.text.contains("item/agentMessage/delta") {
            break;
        }
        assert_ne!(event.kind, "failed", "{}", event.text);
    }
    manager
        .steer(&request.run_id, &request.member_id, "additional input")
        .unwrap();
    let events = terminal(&rx);
    assert_eq!(events.last().unwrap().kind, "completed");
    assert!(events
        .iter()
        .any(|event| event.text.contains("live tool progress")));
    assert!(manager
        .steer(&request.run_id, &request.member_id, "after completion")
        .is_err());
    manager.shutdown();
}

#[test]
fn codex_native_approvals_round_trip_only_the_selected_request() {
    let directory = tempfile::tempdir().unwrap();
    let request = persistent_fixture(directory.path(), "approve-tool");
    let (manager, rx) = manager(directory.path(), request.clone());
    let token = loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_ne!(event.kind, "failed", "{}", event.text);
        if event.text.contains("runtime.permission_requested") {
            let value: serde_json::Value = serde_json::from_str(&event.text).unwrap();
            break value["requestId"].as_str().unwrap().to_owned();
        }
    };
    assert!(manager
        .respond_permission(
            &request.run_id,
            &request.member_id,
            &token,
            Some("invented-approval")
        )
        .is_err());
    manager
        .respond_permission(&request.run_id, &request.member_id, &token, Some("accept"))
        .unwrap();
    assert_eq!(terminal(&rx).last().unwrap().kind, "completed");
    assert!(directory.path().join("tool-approved").exists());
    manager.shutdown();
}

#[test]
fn native_connection_scope_change_closes_old_process_before_the_next_turn() {
    let directory = tempfile::tempdir().unwrap();
    let extra = directory.path().join("additional-root");
    fs::create_dir(&extra).unwrap();
    let request = persistent_fixture(directory.path(), "first");
    let (manager, rx) = manager(directory.path(), request.clone());
    assert_eq!(terminal(&rx).last().unwrap().kind, "completed");
    let original = manager
        .connections
        .lock()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone();
    let mut changed = request;
    changed.run_id = "changed-root-turn".into();
    changed.session_id = Some("fixture-thread".into());
    changed.additional_directories = vec![extra.to_string_lossy().into_owned()];
    let (tx, rx) = mpsc::channel();
    manager
        .start(
            changed,
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .unwrap();
    assert!(
        *original.done.0.lock().unwrap(),
        "Old connection must be fully reaped before a new scope starts"
    );
    assert_eq!(terminal(&rx).last().unwrap().kind, "completed");
    assert_eq!(manager.connections.lock().unwrap().len(), 1);
    assert_eq!(
        fs::read_to_string(directory.path().join("connection-pids"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    let requests = fs::read_to_string(directory.path().join("native-requests")).unwrap();
    assert!(requests.contains("sandbox_workspace_write.writable_roots"));
    manager.shutdown();
}

#[test]
fn native_manager_rejects_parallel_turns_on_the_same_member_even_if_scope_changes() {
    let directory = tempfile::tempdir().unwrap();
    let request = persistent_fixture(directory.path(), "wait-for-control");
    let (manager, rx) = manager(directory.path(), request.clone());
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if event.text.contains("item/agentMessage/delta") {
            break;
        }
        assert_ne!(event.kind, "failed", "{}", event.text);
    }
    for model in ["fixture-model", "another-model"] {
        let mut parallel = request.clone();
        parallel.run_id = "parallel-turn".into();
        parallel.model = model.into();
        assert!(manager.start(parallel, Arc::new(|_| {})).is_err());
    }
    assert_eq!(
        fs::read_to_string(directory.path().join("connection-pids"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    manager.stop(&request.run_id, None).unwrap();
    assert_eq!(terminal(&rx).last().unwrap().kind, "stopped");
    manager.shutdown();
}

#[test]
fn native_manager_does_not_replay_a_disconnected_or_unresponsive_turn() {
    for disconnect in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let request = persistent_fixture(directory.path(), "wait-for-control");
        let script = fs::read_to_string(&request.runtime.executable).unwrap();
        let script = if disconnect {
            script.replace(
                "*'wait-for-control'*) :;;",
                "*'wait-for-control'*) exit 0;;",
            )
        } else {
            script.replace("*'\"method\":\"turn/interrupt\"'*)", "*'\"method\":\"turn/interrupt\"'*) while :; do sleep 1; done;;\n    *'unused-interrupt'*)")
        };
        fs::write(&request.runtime.executable, script).unwrap();
        let (manager, rx) = manager(directory.path(), request.clone());
        if !disconnect {
            loop {
                let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
                if event.text.contains("item/agentMessage/delta") {
                    break;
                }
            }
            manager.stop(&request.run_id, None).unwrap();
            assert!(
                manager
                    .active_turns()
                    .unwrap()
                    .iter()
                    .any(|turn| turn.run_id == request.run_id
                        && turn.member_id == request.member_id
                        && turn.stopping),
                "Reload must retain an actually stopping native Turn"
            );
        }
        let terminal_event = terminal(&rx).pop().unwrap();
        assert_eq!(
            terminal_event.kind,
            if disconnect { "failed" } else { "stopped" }
        );
        manager.shutdown();
        assert_eq!(
            fs::read_to_string(directory.path().join("connection-pids"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert_eq!(
            fs::read_to_string(directory.path().join("native-requests"))
                .unwrap()
                .matches("\"method\":\"turn/start\"")
                .count(),
            1
        );
        assert!(manager.connections.lock().unwrap().is_empty());
    }
}

#[test]
fn codex_native_stdin_preserves_large_unicode_prompt_without_argv_or_truncation() {
    let directory = tempfile::tempdir().unwrap();
    let mut request = persistent_fixture(directory.path(), "first");
    request.prompt = "Conversation history café\n".repeat(20_000);
    let expected = request.prompt.clone();
    let (manager, rx) = manager(directory.path(), request);
    assert_eq!(terminal(&rx).last().unwrap().kind, "completed");
    manager.shutdown();
    let requests = fs::read_to_string(directory.path().join("native-requests")).unwrap();
    let prompt = requests
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|frame| frame["method"] == "turn/start")
        .unwrap();
    assert_eq!(prompt["params"]["input"][0]["text"], expected);
}

#[test]
fn codex_native_launch_preserves_supported_config_flags_and_rejects_batch_scope_overrides() {
    let directory = tempfile::tempdir().unwrap();
    let mut request = persistent_fixture(directory.path(), "configuration");
    request.reasoning_effort = None;
    request.runtime.args = vec![
        "--profile".into(),
        "development".into(),
        "-c".into(),
        "model_provider=local-provider".into(),
        "--config=notify=[\"literal notifier\"]".into(),
        "--enable".into(),
        "shell_tool".into(),
        "--disable=collab".into(),
        "--strict-config".into(),
    ];
    let args = build_arguments(&request).unwrap();
    assert_eq!(
        &args[..5],
        [
            "--profile",
            "development",
            "app-server",
            "--listen",
            "stdio://"
        ]
    );
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-c", "model_provider=local-provider"]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-c", "notify=[\"literal notifier\"]"]));
    assert!(args.windows(2).any(|pair| pair == ["--disable", "collab"]));
    for extra in [
        vec!["exec"],
        vec!["--json"],
        vec!["--listen", "ws://0.0.0.0:1234"],
        vec!["--last"],
        vec!["--sandbox", "danger-full-access"],
        vec!["-c", "sandbox_mode='danger-full-access'"],
        vec!["-c", "'sandbox_workspace_write' .network_access=true"],
        vec!["-c", "notify=['{prompt}']"],
        vec!["--enable"],
        vec!["--profile", "--last"],
    ] {
        request.runtime.args = extra.iter().map(|s| (*s).into()).collect();
        assert!(build_arguments(&request).is_err(), "Rejected: {extra:?}");
    }
    request.runtime.args = vec!["-c".into(), "model_reasoning_effort=high".into()];
    assert!(build_arguments(&request).is_ok());
    request.reasoning_effort = Some("low".into());
    assert!(build_arguments(&request).is_err());
    request.codex_streaming = true;
    request.runtime.args = vec!["--strict-config".into()];
    assert!(
        build_arguments(&request).is_err(),
        "Restricted goal assistant must not accept user launch overrides"
    );
}

#[test]
fn codex_workspace_write_inherits_native_network_and_preserves_existing_and_goal_roots() {
    let directory = tempfile::tempdir().unwrap();
    let extra = directory.path().join("extra");
    let inherited = directory.path().join("native-root");
    fs::create_dir(&extra).unwrap();
    fs::create_dir(&inherited).unwrap();
    let mut request = persistent_fixture(directory.path(), "workspace permissions");
    request.runtime.permissions = Some(
        serde_json::from_value(
            serde_json::json!({"codex":{"sandbox":"workspace-write","network":"inherit"}}),
        )
        .unwrap(),
    );
    request.additional_directories = vec![extra.to_string_lossy().into_owned()];
    let script = fs::read_to_string(&request.runtime.executable).unwrap();
    let old = r#""sandbox":{"type":"readOnly","networkAccess":false}"#;
    let new=serde_json::json!({"type":"workspaceWrite","networkAccess":true,"writableRoots":[inherited]}).to_string();
    fs::write(
        &request.runtime.executable,
        script.replace(old, &format!("\"sandbox\":{new}")),
    )
    .unwrap();
    let (manager, rx) = manager(directory.path(), request.clone());
    assert_eq!(terminal(&rx).last().unwrap().kind, "completed");
    manager.shutdown();
    let requests = fs::read_to_string(directory.path().join("native-requests")).unwrap();
    let turn = requests
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|frame| frame["method"] == "turn/start")
        .unwrap();
    let sandbox = &turn["params"]["sandboxPolicy"];
    assert_eq!(sandbox["networkAccess"], true);
    let roots = sandbox["writableRoots"].as_array().unwrap();
    for root in [directory.path(), extra.as_path(), inherited.as_path()] {
        assert!(roots
            .iter()
            .any(|value| value.as_str() == Some(root.to_str().unwrap())));
    }
}

#[test]
fn native_connection_cache_eviction_starts_the_seventeenth_idle_conversation_without_retry() {
    let directory = tempfile::tempdir().unwrap();
    let request = persistent_fixture(directory.path(), "cache capacity");
    let manager = RuntimeManager::new(Arc::new(
        Storage::new(directory.path().join("cache-data")).unwrap(),
    ));
    for index in 0..17 {
        let mut next = request.clone();
        next.task_id = format!("task-cache-{index}");
        next.run_id = format!("run-cache-{index}");
        let (tx, rx) = mpsc::channel();
        manager
            .start(
                next,
                Arc::new(move |event| {
                    let _ = tx.send(event);
                }),
            )
            .expect("Idle cache cleanup must continue this user turn without requiring a retry");
        assert_eq!(terminal(&rx).last().unwrap().kind, "completed");
        assert!(manager.connections.lock().unwrap().len() <= 16);
    }
    assert_eq!(
        fs::read_to_string(directory.path().join("connection-pids"))
            .unwrap()
            .lines()
            .count(),
        17
    );
    manager.shutdown();
    assert!(manager.connections.lock().unwrap().is_empty());
}

#[test]
fn codex_steering_waits_for_matching_acceptance_and_rejections_do_not_fail_the_turn() {
    let acknowledgement =
        "printf '{\"id\":%s,\"result\":{\"turnId\":\"turn-%s\"}}\\n' \"$id\" \"$turn\"";
    for mode in [
        "rejected",
        "foreign-turn",
        "foreign-id",
        "completed-before-ack",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let request = persistent_fixture(directory.path(), "wait-for-control");
        let script = fs::read_to_string(&request.runtime.executable).unwrap();
        let replacement=match mode {
            "rejected"=>"printf '{\"id\":%s,\"error\":{\"code\":-32000,\"message\":\"native turn no longer accepts input\"}}\\n' \"$id\"".into(),
            "foreign-turn"=>"printf '{\"id\":%s,\"result\":{\"turnId\":\"another-turn\"}}\\n' \"$id\"".into(),
            "foreign-id"=>format!("printf '%s\\n' '{{\"id\":9999,\"result\":{{\"turnId\":\"turn-1\"}}}}'\n{acknowledgement}"),
            _=>format!("printf '{{\"method\":\"turn/completed\",\"params\":{{\"threadId\":\"fixture-thread\",\"turn\":{{\"id\":\"turn-%s\",\"status\":\"completed\",\"items\":[]}}}}}}\\n' \"$turn\"\n{acknowledgement}"),
        };
        assert!(script.contains(acknowledgement));
        fs::write(
            &request.runtime.executable,
            script.replace(acknowledgement, &replacement),
        )
        .unwrap();
        let (manager, rx) = manager(directory.path(), request.clone());
        loop {
            let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            if event.text.contains("item/agentMessage/delta") {
                break;
            }
            assert_ne!(event.kind, "failed", "{}", event.text);
        }
        let result = manager.steer(
            &request.run_id,
            &request.member_id,
            "keep my draft if rejected",
        );
        assert_eq!(result.is_ok(), mode == "foreign-id", "{mode}: {result:?}");
        let events = terminal(&rx);
        assert_eq!(events.last().unwrap().kind, "completed", "{mode}");
        assert_eq!(
            events
                .iter()
                .any(|event| event.text.contains("runtime.input_accepted")),
            mode == "foreign-id",
            "{mode}"
        );
        manager.shutdown();
    }
}

#[test]
fn codex_steering_ack_timeout_preserves_turn_and_ignores_late_acknowledgement() {
    let directory = tempfile::tempdir().unwrap();
    let request = persistent_fixture(directory.path(), "wait-for-control");
    let script = fs::read_to_string(&request.runtime.executable).unwrap();
    let acknowledgement =
        "printf '{\"id\":%s,\"result\":{\"turnId\":\"turn-%s\"}}\\n' \"$id\" \"$turn\"";
    fs::write(
        &request.runtime.executable,
        script.replace(
            acknowledgement,
            &format!("while [ ! -e release-steer-ack ]; do sleep 0.02; done\n{acknowledgement}"),
        ),
    )
    .unwrap();
    let (manager, rx) = manager(directory.path(), request.clone());
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        if event.text.contains("item/agentMessage/delta") {
            break;
        }
    }
    let since = Instant::now();
    let error = manager
        .steer(
            &request.run_id,
            &request.member_id,
            "bounded acknowledgement",
        )
        .unwrap_err();
    assert!(error.contains("5 seconds"), "{error}");
    assert!(since.elapsed() < Duration::from_secs(7));
    assert!(
        manager.while_idle(|| Ok(())).is_err(),
        "An input ACK timeout must not falsely complete the original turn"
    );
    fs::write(directory.path().join("release-steer-ack"), "release").unwrap();
    let events = terminal(&rx);
    assert_eq!(events.last().unwrap().kind, "completed");
    assert!(!events
        .iter()
        .any(|event| event.text.contains("runtime.input_accepted")));
    manager.shutdown();
}

#[test]
fn codex_permission_profile_approval_grants_only_the_requested_profile_for_this_turn() {
    let directory = tempfile::tempdir().unwrap();
    let request = persistent_fixture(directory.path(), "approve-tool");
    let script=fs::read_to_string(&request.runtime.executable).unwrap().replace("item/commandExecution/requestApproval","item/permissions/requestApproval").replace("\"command\":\"echo tool\"","\"permissions\":{\"network\":{\"enabled\":true}},\"reason\":\"Network access for current turn\"").replace("*'\"id\":71'*'\"decision\":\"accept\"'*)","*'\"id\":71'*'\"enabled\":true'*'\"scope\":\"turn\"'*)");
    fs::write(&request.runtime.executable, script).unwrap();
    let (manager, rx) = manager(directory.path(), request.clone());
    let token = loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_ne!(event.kind, "failed", "{}", event.text);
        if event.text.contains("runtime.permission_requested") {
            let value: serde_json::Value = serde_json::from_str(&event.text).unwrap();
            assert_eq!(
                value["toolCall"]["rawInput"]["permissions"]["network"]["enabled"],
                true
            );
            break value["requestId"].as_str().unwrap().to_owned();
        }
    };
    manager
        .respond_permission(&request.run_id, &request.member_id, &token, Some("accept"))
        .unwrap();
    assert_eq!(terminal(&rx).last().unwrap().kind, "completed");
    manager.shutdown();
    let requests = fs::read_to_string(directory.path().join("native-requests")).unwrap();
    let grant = requests
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|frame| frame["id"] == 71)
        .unwrap();
    assert_eq!(
        grant["result"],
        serde_json::json!({"permissions":{"network":{"enabled":true}},"scope":"turn"})
    );
}

#[test]
fn codex_native_feature_configuration_does_not_replace_inherited_profile_permissions() {
    let directory = tempfile::tempdir().unwrap();
    let mut request = persistent_fixture(directory.path(), "inherit native scope");
    request.runtime.permissions = None;
    request.runtime.args = vec!["-c".into(), "features.shell_tool=true".into()];
    let (manager, rx) = manager(directory.path(), request);
    assert_eq!(terminal(&rx).last().unwrap().kind, "completed");
    manager.shutdown();
    let requests = fs::read_to_string(directory.path().join("native-requests")).unwrap();
    let frames: Vec<serde_json::Value> = requests
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let start = frames
        .iter()
        .find(|frame| frame["method"] == "thread/start")
        .unwrap();
    assert!(start["params"]["sandbox"].is_null() && start["params"]["approvalPolicy"].is_null());
    let turn = frames
        .iter()
        .find(|frame| frame["method"] == "turn/start")
        .unwrap();
    assert_eq!(turn["params"]["sandboxPolicy"]["type"], "readOnly");
    assert!(turn["params"]["approvalPolicy"].is_null());
}

#[test]
fn pending_native_reservation_is_visible_and_can_be_stopped_before_worker_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let request = persistent_fixture(directory.path(), "must never launch");
    let manager = RuntimeManager::new(Arc::new(
        Storage::new(directory.path().join("pending-data")).unwrap(),
    ));
    let pending = manager.prepare_start(&request).unwrap();
    let active = manager.active_turns().unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].run_id, request.run_id);
    assert!(!active[0].stopping);
    assert!(
        manager.while_idle(|| Ok(())).is_err(),
        "An async pending start is not idle"
    );
    manager.stop(&request.run_id, None).unwrap();
    assert!(manager.active_turns().unwrap()[0].stopping);
    let (tx, rx) = mpsc::channel();
    manager
        .start_prepared(
            request,
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
            pending,
        )
        .unwrap();
    let events = terminal(&rx);
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "stopped")
            .count(),
        1
    );
    assert!(!events
        .iter()
        .any(|event| event.kind == "started" || event.kind == "failed"));
    assert!(!directory.path().join("connection-pids").exists());
    assert!(manager.active_turns().unwrap().is_empty());
    manager.shutdown();
}

#[test]
fn stopping_pending_scope_cleanup_never_spawns_or_sends_input_after_the_wait() {
    let directory = tempfile::tempdir().unwrap();
    let request = persistent_fixture(directory.path(), "first old scope");
    // Keep the old idle process alive until manager escalation, creating a
    // deterministic cancellation window rather than racing a fast spawn.
    let script = fs::read_to_string(&request.runtime.executable)
        .unwrap()
        .replace("set -eu\n", "set -eu\ntrap '' TERM\n");
    fs::write(&request.runtime.executable, script).unwrap();
    let (manager, rx) = manager(directory.path(), request.clone());
    assert_eq!(terminal(&rx).last().unwrap().kind, "completed");
    let mut next = request.clone();
    next.run_id = "pending-new-scope".into();
    next.model = "changed-model".into();
    next.prompt = "cancel before spawning this prompt".into();
    let pending = manager.prepare_start(&next).unwrap();
    let native_manager = manager.clone();
    let started_request = next.clone();
    let (tx, rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        native_manager.start_prepared(
            started_request,
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
            pending,
        )
    });
    let until = Instant::now() + Duration::from_secs(3);
    loop {
        if manager
            .connections
            .lock()
            .unwrap()
            .values()
            .any(|connection| connection.closing.load(Ordering::SeqCst))
        {
            break;
        }
        assert!(Instant::now() < until, "Old scope must enter cleanup");
        thread::sleep(Duration::from_millis(5));
    }
    assert!(manager
        .active_turns()
        .unwrap()
        .iter()
        .any(|turn| turn.run_id == next.run_id));
    manager.stop(&next.run_id, Some(&next.member_id)).unwrap();
    assert!(worker.join().unwrap().is_ok());
    let events = terminal(&rx);
    assert_eq!(events.last().unwrap().kind, "stopped");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "stopped")
            .count(),
        1
    );
    assert!(!events
        .iter()
        .any(|event| event.kind == "failed" || event.kind == "started"));
    assert_eq!(
        fs::read_to_string(directory.path().join("connection-pids"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert!(
        !fs::read_to_string(directory.path().join("native-requests"))
            .unwrap()
            .contains(&next.prompt)
    );
    assert!(manager.active_turns().unwrap().is_empty());
    manager.shutdown();
}

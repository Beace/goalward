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
case "$line" in *'"method":"turn/start"'*'"approvalPolicy":"never"'*'"effort":"high"'*'literal $(do not execute) 中文'*'"model":"fixture-model"'*'"networkAccess":false'*'"type":"readOnly"'*'"threadId":"fixture-thread"'*) ;; *) exit 14;; esac
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
        "directory":directory,"prompt":"literal $(do not execute) 中文"
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

const DELTA: &str = r#"printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"fixture-thread","turnId":"fixture-turn","itemId":"message","delta":"公开"}}'
"#;
const COMPLETE: &str = r#"printf '%s\n' '{"method":"item/completed","params":{"threadId":"fixture-thread","turnId":"fixture-turn","item":{"type":"agentMessage","id":"message","text":"公开回答"}}}'
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
            assert_eq!(value["params"]["delta"], "公开");
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
    assert!(trace.contains("公开回答"));
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
    assert!(text.contains("公开回答"));
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
    let premature = DELTA.replace("公开", "early");
    let foreign = DELTA
        .replace("fixture-thread", "foreign-thread")
        .replace("公开", "foreign");
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
    let text = "中文public".repeat(2000);
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
        &serde_json::json!({"type":"codex.app_server.thread_ready","threadId":"fixture-thread","model":"fixture-model","modelProvider":"fixture-provider","reasoningEffort":"medium"})
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
fn codex_streaming_defaults_off_and_rejects_non_readonly_or_custom_arguments() {
    let directory = tempfile::tempdir().unwrap();
    let mut request = fixture(directory.path(), COMPLETE, false);
    assert_eq!(build_arguments(&request).unwrap()[0], "app-server");
    request.codex_streaming = false;
    assert_eq!(build_arguments(&request).unwrap()[0], "exec");
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

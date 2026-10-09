use super::*;
use std::{fs, os::unix::fs::PermissionsExt, sync::mpsc};

fn fixture(directory: &std::path::Path, ending: &str) -> StartRequest {
    let executable = directory.join("kimi-fixture");
    let script = format!(
        r##"#!/bin/sh
set -eu
[ "$1" = acp ]
read -r line
case "$line" in *'"method":"initialize"'*) ;; *) exit 11;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1,"agentInfo":{{"name":"Kimi Code CLI","version":"0.39.1"}}}}}}'
read -r line
case "$line" in *'"method":"session/new"'*) ;; *) exit 12;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"fixture-session","modes":{{"availableModes":[{{"id":"default"}}]}}}}}}'
read -r line
case "$line" in *'"modeId":"default"'*) ;; *) exit 13;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":3,"result":{{}}}}'
read -r line
case "$line" in *'"configId":"model"'*'"value":"fixture-model"'*) ;; *) exit 14;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":4,"result":{{}}}}'
read -r line
case "$line" in *'"method":"session/prompt"'*) ;; *) exit 15;; esac
{ending}
"##
    );
    fs::write(&executable, script).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    StartRequest {
        task_id: "task-kimi".into(),
        run_id: "run-kimi".into(),
        member_id: "member-kimi".into(),
        runtime: crate::types::RuntimeConfig {
            id: "kimi".into(),
            name: "Kimi fixture".into(),
            executable: executable.to_string_lossy().into(),
            adapter: "kimi".into(),
            enabled: true,
            args: vec![],
            default_model: "".into(),
            permissions: Some(
                serde_json::from_value(serde_json::json!({"kimi":{"mode":"manual"}})).unwrap(),
            ),
        },
        model: "fixture-model".into(),
        reasoning_effort: None,
        session_id: None,
        directory: directory.to_string_lossy().into(),
        prompt: "literal $(do not execute) 中文".into(),
    }
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
            .recv_timeout(Duration::from_secs(5))
            .expect("Kimi fixture must finish");
        let done = matches!(event.kind.as_str(), "completed" | "failed" | "stopped");
        events.push(event);
        if done {
            return events;
        }
    }
}
const PERMISSION: &str = r#"printf '%s\n' '{"jsonrpc":"2.0","id":73,"method":"session/request_permission","params":{"sessionId":"fixture-session","toolCall":{"toolCallId":"tool-1","title":"Read fixture","rawInput":{"path":"fixture.txt"}},"options":[{"optionId":"allow","name":"Allow once","kind":"allow_once"},{"optionId":"deny","name":"Reject","kind":"reject_once"}]}}'
read -r line
"#;

#[test]
fn kimi_permissions_gate_public_stream_and_completion_is_protocol_driven() {
    let directory = tempfile::tempdir().unwrap();
    let update = serde_json::json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fixture-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"超过旧上限前的公开输出"}}}});
    let prelude =
        format!("i=0; while [ $i -lt 5105 ]; do printf '%s\\n' '{update}'; i=$((i + 1)); done");
    let ending = format!(
        r#"{prelude}
{PERMISSION}
case "$line" in *'"id":73'*'"optionId":"allow"'*) ;; *) exit 16;; esac
printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"fixture-session","update":{{"sessionUpdate":"agent_thought_chunk","content":{{"type":"text","text":"PRIVATE_THOUGHT"}}}}}}}}'
printf '%s\n' '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"fixture-session","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"公开回答"}}}}}}}}'
printf '%s\n' '{{"jsonrpc":"2.0","id":6,"result":{{"stopReason":"end_turn"}}}}'
while read -r line; do :; done
"#
    );
    let (manager, rx) = manager(directory.path(), fixture(directory.path(), &ending));
    let mut output_records = 0;
    let mut output_bytes = 0;
    let requested = loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_ne!(event.kind, "failed", "{}", event.text);
        if event.kind == "stdout" {
            output_records += 1;
            output_bytes += event.text.len();
        }
        if event.text.contains("kimi.permission_requested") {
            break serde_json::from_str::<serde_json::Value>(&event.text).unwrap();
        }
    };
    assert!(output_records > 5000);
    assert!(output_bytes > 65536);
    let token = requested["requestId"].as_str().unwrap();
    assert!(manager
        .respond_permission("run-kimi", "member-kimi", token, Some("forged"))
        .is_err());
    assert!(manager
        .respond_permission("other", "member-kimi", token, Some("allow"))
        .is_err());
    manager
        .respond_permission("run-kimi", "member-kimi", token, Some("allow"))
        .unwrap();
    assert!(manager
        .respond_permission("run-kimi", "member-kimi", token, Some("allow"))
        .is_err());
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(
        events.last().unwrap().kind,
        "completed",
        "{}",
        events.last().unwrap().text
    );
    let all = events
        .iter()
        .map(|event| event.text.as_str())
        .collect::<String>();
    assert!(all.contains("公开回答"));
    assert!(!all.contains("PRIVATE_THOUGHT"));
    let saved = fs::read_to_string(
        directory
            .path()
            .join("data/traces/task-kimi/run-kimi/member-kimi.jsonl"),
    )
    .unwrap();
    assert!(!saved.contains("PRIVATE_THOUGHT"));
    assert!(!saved.contains("authMethods"));
}

#[test]
fn kimi_stop_sends_cancel_while_permission_is_pending() {
    let directory = tempfile::tempdir().unwrap();
    let ending = format!(
        r#"{PERMISSION}
case "$line" in *'"method":"session/cancel"'*) printf cancelled > cancelled;; *) exit 17;; esac
exit 0
"#
    );
    let (manager, rx) = manager(directory.path(), fixture(directory.path(), &ending));
    loop {
        if rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .text
            .contains("kimi.permission_requested")
        {
            break;
        }
    }
    manager.stop("run-kimi", None).unwrap();
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(events.last().unwrap().kind, "stopped");
    assert_eq!(
        fs::read_to_string(directory.path().join("cancelled")).unwrap(),
        "cancelled"
    );
}

#[test]
fn kimi_exit_zero_without_successful_prompt_is_failure() {
    for ending in [
        "exit 0",
        "printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":6,\"error\":{\"code\":-32000,\"message\":\"Authentication required\"}}'\nexit 0",
        "printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":6,\"result\":{\"stopReason\":\"max_tokens\"}}'\nexit 0",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let (manager,rx) = manager(directory.path(),fixture(directory.path(),ending));
        let events = terminal(&rx);
        manager.shutdown();
        assert_eq!(events.last().unwrap().kind, "failed");
    }
}

#[test]
fn kimi_rejects_legacy_identity_before_sending_prompt_and_rejects_extra_flags() {
    let directory = tempfile::tempdir().unwrap();
    let mut request = fixture(directory.path(), "exit 0");
    let file = &request.runtime.executable;
    fs::write(
        file,
        fs::read_to_string(file)
            .unwrap()
            .replace("Kimi Code CLI", "Kimi CLI"),
    )
    .unwrap();
    let (manager, rx) = manager(directory.path(), request.clone());
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(events.last().unwrap().kind, "failed");
    assert!(events.last().unwrap().text.contains("legacy"));
    request.runtime.args = vec!["--auto".into()];
    assert!(build_arguments(&request).is_err());
    request.runtime.args.clear();
    request.reasoning_effort = Some("high".into());
    assert_eq!(build_arguments(&request).unwrap(), vec!["acp"]);
}

fn config_options(model: &str, efforts: &[&str], current: &str) -> serde_json::Value {
    serde_json::json!([
        {"type":"select", "id":"model", "category":"model", "currentValue":model, "options":[{"value":model}]},
        {"type":"select", "id":"thinking", "category":"thought_level", "currentValue":current,
            "options":efforts.iter().map(|effort| serde_json::json!({"value":effort})).collect::<Vec<_>>()}
    ])
}

fn thinking_fixture(
    directory: &std::path::Path,
    initial: serde_json::Value,
    selected: serde_json::Value,
    applied: serde_json::Value,
    explicit_model: bool,
) -> StartRequest {
    let mut request = fixture(directory, "exit 0");
    let response = |id, result: serde_json::Value| {
        format!(
            "printf '%s\\n' '{}'\n",
            serde_json::json!({"jsonrpc":"2.0", "id":id, "result":result})
        )
    };
    let read = "read -r line\nprintf '%s\\n' \"$line\" >> requests.jsonl\n";
    let mut script = String::from("#!/bin/sh\nset -eu\n[ \"$1\" = acp ]\n");
    script.push_str(read);
    script.push_str(&response(
        1,
        serde_json::json!({"protocolVersion":1,"agentInfo":{"name":"Kimi Code CLI"}}),
    ));
    script.push_str(read);
    script.push_str(&response(2, serde_json::json!({"sessionId":"fixture-session","modes":{"availableModes":[{"id":"default"}]},"configOptions":initial})));
    script.push_str(read);
    script.push_str(&response(3, serde_json::json!({})));
    if explicit_model {
        script.push_str(read);
        script.push_str("case \"$line\" in *'\"configId\":\"model\"'*) ;; *) exit 23;; esac\n");
        script.push_str(&response(4, serde_json::json!({"configOptions":selected})));
    } else {
        request.model.clear();
    }
    script.push_str(read);
    script.push_str("case \"$line\" in *'\"configId\":\"thinking\"'*) ;; *) exit 24;; esac\n");
    script.push_str(&response(5, serde_json::json!({"configOptions":applied})));
    script.push_str(read);
    script.push_str("case \"$line\" in *'\"method\":\"session/prompt\"'*) ;; *) exit 25;; esac\n");
    script.push_str(&response(6, serde_json::json!({"stopReason":"end_turn"})));
    script.push_str("while read -r line; do :; done\n");
    fs::write(&request.runtime.executable, script).unwrap();
    request
}

fn recorded_requests(directory: &std::path::Path) -> Vec<serde_json::Value> {
    fs::read_to_string(directory.join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn kimi_negotiates_each_effort_after_the_selected_models_config_and_before_prompt() {
    for effort in ["low", "high", "max"] {
        let directory = tempfile::tempdir().unwrap();
        // The old/default model only has a boolean picker; model selection must
        // refresh capabilities before evaluating this request's graded effort.
        let mut request = thinking_fixture(
            directory.path(),
            config_options("old-model", &["off", "on"], "on"),
            config_options("fixture-model", &["low", "high", "max"], "high"),
            config_options("fixture-model", &["low", "high", "max"], effort),
            true,
        );
        request.reasoning_effort = Some(effort.into());
        let (manager, rx) = manager(directory.path(), request);
        let events = terminal(&rx);
        manager.shutdown();
        assert_eq!(
            events.last().unwrap().kind,
            "completed",
            "{}",
            events.last().unwrap().text
        );
        let requests = recorded_requests(directory.path());
        assert_eq!(
            requests
                .iter()
                .map(|request| request["method"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "initialize",
                "session/new",
                "session/set_mode",
                "session/set_config_option",
                "session/set_config_option",
                "session/prompt"
            ]
        );
        assert_eq!(requests[4]["params"]["value"], effort);
        assert_eq!(requests[4]["params"]["configId"], "thinking");
    }
}

#[test]
fn kimi_default_model_can_negotiate_an_explicit_effort() {
    let directory = tempfile::tempdir().unwrap();
    let mut request = thinking_fixture(
        directory.path(),
        config_options("default-model", &["low", "high"], "low"),
        serde_json::Value::Null,
        config_options("default-model", &["low", "high"], "high"),
        false,
    );
    request.reasoning_effort = Some("high".into());
    let (manager, rx) = manager(directory.path(), request);
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(
        events.last().unwrap().kind,
        "completed",
        "{}",
        events.last().unwrap().text
    );
    let requests = recorded_requests(directory.path());
    assert_eq!(requests.len(), 5);
    assert_eq!(requests[3]["params"]["configId"], "thinking");
}

#[test]
fn kimi_missing_or_changed_model_capabilities_stop_before_setting_effort_or_prompt() {
    for selected in [
        serde_json::Value::Null,
        config_options("fixture-model", &["low"], "low"),
        config_options("wrong-model", &["high"], "high"),
        config_options("fixture-model", &["off", "on"], "on"),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let mut request = thinking_fixture(
            directory.path(),
            config_options("old-model", &["high"], "high"),
            selected,
            config_options("fixture-model", &["high"], "high"),
            true,
        );
        request.reasoning_effort = Some("high".into());
        let (manager, rx) = manager(directory.path(), request);
        let events = terminal(&rx);
        manager.shutdown();
        assert_eq!(events.last().unwrap().kind, "failed");
        let requests = recorded_requests(directory.path());
        assert!(!requests
            .iter()
            .any(|request| request["method"] == "session/prompt"
                || request["params"]["configId"] == "thinking"));
    }
}

#[test]
fn kimi_requires_the_effective_effort_and_model_to_match_before_prompt() {
    for applied in [
        serde_json::Value::Null,
        config_options("fixture-model", &["low", "high"], "low"),
        config_options("wrong-model", &["high"], "high"),
        config_options("fixture-model", &["low"], "high"),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let mut request = thinking_fixture(
            directory.path(),
            serde_json::Value::Null,
            config_options("fixture-model", &["low", "high"], "low"),
            applied,
            true,
        );
        request.reasoning_effort = Some("high".into());
        let (manager, rx) = manager(directory.path(), request);
        let events = terminal(&rx);
        manager.shutdown();
        assert_eq!(events.last().unwrap().kind, "failed");
        let requests = recorded_requests(directory.path());
        assert!(requests
            .iter()
            .any(|request| request["params"]["configId"] == "thinking"));
        assert!(!requests
            .iter()
            .any(|request| request["method"] == "session/prompt"));
    }
}

#[test]
fn kimi_configuration_rpc_failure_cannot_fall_through_to_prompt() {
    let directory = tempfile::tempdir().unwrap();
    let mut request = thinking_fixture(
        directory.path(),
        serde_json::Value::Null,
        config_options("fixture-model", &["high"], "high"),
        serde_json::Value::Null,
        true,
    );
    request.reasoning_effort = Some("high".into());
    let script = fs::read_to_string(&request.runtime.executable).unwrap().replace(
        "{\"id\":5,\"jsonrpc\":\"2.0\",\"result\":{\"configOptions\":null}}",
        "{\"id\":5,\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}",
    );
    assert!(script.contains("Method not found"));
    fs::write(&request.runtime.executable, script).unwrap();
    let (manager, rx) = manager(directory.path(), request);
    let events = terminal(&rx);
    manager.shutdown();
    assert_eq!(events.last().unwrap().kind, "failed");
    assert!(events.last().unwrap().text.contains("-32601"));
    assert!(!recorded_requests(directory.path())
        .iter()
        .any(|request| request["method"] == "session/prompt"));
}

#[test]
fn kimi_inherited_effort_preserves_the_existing_cli_configuration() {
    let directory = tempfile::tempdir().unwrap();
    let mut request = fixture(directory.path(), "printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":6,\"result\":{\"stopReason\":\"end_turn\"}}'\nwhile read -r line; do :; done");
    request.reasoning_effort = Some("inherit".into());
    let (manager, rx) = manager(directory.path(), request);
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
#[ignore = "opt-in installed Kimi test: isolated config, no credentials, loopback provider only"]
fn kimi_installed_cli_receives_negotiated_efforts_from_runtime_manager() {
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    let executable = crate::discovery::resolve("kimi").expect("Install Kimi Code CLI first");
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    for effort in ["low", "high", "max"] {
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let provider = thread::spawn(move || {
            (0..4).map(|index| {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut stream = loop {
                if let Ok((stream, _)) = listener.accept() {
                    break stream;
                }
                assert!(
                    Instant::now() < deadline,
                    "Kimi never called the loopback fixture"
                );
                thread::sleep(Duration::from_millis(10));
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let (headers_end, length) = loop {
                let mut chunk = [0; 4096];
                let count = stream.read(&mut chunk).unwrap();
                assert_ne!(count, 0, "Fixture request disconnected");
                bytes.extend_from_slice(&chunk[..count]);
                assert!(bytes.len() < 1024 * 1024, "Fixture request exceeds 1 MiB");
                if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..index]).to_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .and_then(|length| length.trim().parse::<usize>().ok())
                        })
                        .unwrap();
                    break (index + 4, length);
                }
            };
            assert!(length < 1024 * 1024);
            while bytes.len() < headers_end + length {
                let mut chunk = [0; 4096];
                let count = stream.read(&mut chunk).unwrap();
                assert_ne!(count, 0);
                bytes.extend_from_slice(&chunk[..count]);
            }
            let request: serde_json::Value =
                serde_json::from_slice(&bytes[headers_end..headers_end + length]).unwrap();
            let body = if index % 2 == 0 {
                let tools = request["tools"].as_array().expect("Kimi must expose tools");
                let bash = tools.iter().find(|tool| tool["function"]["name"] == "Bash").expect("Kimi Bash tool missing");
                assert!(bash["function"]["parameters"]["properties"].get("command").is_some());
                let chunk = serde_json::json!({"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":format!("call-{index}"),"type":"function","function":{"name":"Bash","arguments":format!("{{\"command\":\"printf approved >> approval-marker\"}}")}}]},"finish_reason":null}]});
                format!("data: {chunk}\n\ndata: {{\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n")
            } else {
                "data: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"KIMI_NATIVE_FIXTURE_OK\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"fixture\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n" .to_string()
            };
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            stream.flush().unwrap();
            request
            }).collect::<Vec<serde_json::Value>>()
        });
        fs::write(
            directory.path().join("config.toml"),
            format!(
                r#"default_model="fixture-model"
telemetry=false
builtin_product_skills=false
[providers.fixture]
type="kimi"
base_url="http://127.0.0.1:{port}/v1"
api_key="local-fixture"
[models.fixture-model]
provider="fixture"
model="fixture-model"
max_context_size=65536
capabilities=["thinking","always_thinking"]
support_efforts=["low","high","max"]
default_effort="high"
[thinking]
enabled=true
effort="high"
"#
            ),
        )
        .unwrap();
        let mut request = fixture(directory.path(), "exit 0");
        // Clear inherited Kimi/provider environment and load no user/project
        // hooks, credentials, or model endpoints. The model endpoint is loopback.
        fs::write(&request.runtime.executable, format!(
            "#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin KIMI_CODE_HOME={} TMPDIR={} {} \"$@\"\n",
            quote(&directory.path().to_string_lossy()), quote(&directory.path().to_string_lossy()), quote(&executable.to_string_lossy())
        )).unwrap();
        request.reasoning_effort = Some(effort.into());
        request.runtime.permissions = None;
        let (manager, rx) = manager(directory.path(), request.clone());
        let events = terminal(&rx);
        manager.shutdown();
        assert_eq!(
            events.last().unwrap().kind,
            "completed",
            "{}",
            events.last().unwrap().text
        );
        assert!(events
            .iter()
            .any(|event| event.text.contains("KIMI_NATIVE_FIXTURE_OK")));
        let session = events
            .iter()
            .filter_map(|event| serde_json::from_str::<serde_json::Value>(&event.text).ok())
            .find(|value| value["type"] == "kimi.session")
            .unwrap();
        let session_id = session["sessionId"].as_str().unwrap().to_owned();
        request.session_id = Some(session_id.clone());
        request.run_id = "second-run".into();
        request.prompt = "SECOND_TURN_WITHOUT_HISTORY".into();
        // A new manager and CLI process model an application restart.
        let resumed = RuntimeManager::new(Arc::new(
            Storage::new(directory.path().join("data")).unwrap(),
        ));
        let (tx, rx) = mpsc::channel();
        resumed
            .start(
                request,
                Arc::new(move |event| {
                    let _ = tx.send(event);
                }),
            )
            .unwrap();
        let second = terminal(&rx);
        resumed.shutdown();
        assert_eq!(
            second.last().unwrap().kind,
            "completed",
            "{}",
            second.last().unwrap().text
        );
        let chunks: String = second
            .iter()
            .filter(|event| event.kind == "stdout")
            .map(|event| event.text.as_str())
            .collect();
        assert_eq!(
            chunks.matches("KIMI_NATIVE_FIXTURE_OK").count(),
            1,
            "Do not replay old answers into the second Run"
        );
        assert!(chunks.contains(&session_id));
        assert!(chunks.contains("\"resumed\":true"));
        let wires = provider.join().unwrap();
        for wire in &wires {
            assert_eq!(wire["model"], "fixture-model");
            assert_eq!(wire["thinking"]["effort"], effort);
        }
        assert_eq!(
            fs::read_to_string(directory.path().join("approval-marker")).unwrap(),
            "approvedapproved"
        );
        let history = wires[2]["messages"].to_string();
        assert!(
            history.contains("literal $(do not execute) 中文"),
            "Original user prompt must reach the second model request: {}",
            wires[1]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] != "system")
                .map(|m| m.to_string())
                .collect::<Vec<_>>()
                .join("\n")
        );
        assert!(
            history.contains("KIMI_NATIVE_FIXTURE_OK"),
            "Original assistant answer must reach the second model request"
        );
        assert!(history.contains("SECOND_TURN_WITHOUT_HISTORY"));
        println!("Auto approval executed Bash in both turns. RuntimeManager → installed Kimi → loopback provider: effort={effort}; same native session across two processes; first prompt + answer present on second request; no chat replay duplication");
    }
}

#[test]
fn kimi_resumes_the_exact_session_without_replaying_old_chat() {
    let directory = tempfile::tempdir().unwrap();
    let ending = r#"printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fixture-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"NEW_ANSWER"}}}}'
printf '%s\n' '{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}'
while read -r line; do :; done
"#;
    let mut request = fixture(directory.path(), ending);
    request.session_id = Some("fixture-session".into());
    let replay = r#"printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"fixture-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"OLD_REPLAY"}}}}'
"#;
    let script = fs::read_to_string(&request.runtime.executable)
        .unwrap()
        .replace(
            "\"protocolVersion\":1,",
            "\"protocolVersion\":1,\"agentCapabilities\":{\"loadSession\":true},",
        )
        .replace(
            "*'\"method\":\"session/new\"'*",
            "*'\"method\":\"session/load\"'*'\"sessionId\":\"fixture-session\"'*",
        )
        .replace(
            "printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":2",
            &format!("{replay}printf '%s\\n' '{{\"jsonrpc\":\"2.0\",\"id\":2"),
        )
        .replace("\"sessionId\":\"fixture-session\",\"modes\"", "\"modes\"");
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
    assert!(text.contains("NEW_ANSWER"));
    assert!(!text.contains("OLD_REPLAY"));
    assert!(text.contains("\"resumed\":true"));
    assert!(text.contains("\"sessionId\":\"fixture-session\""));
}

#[test]
fn kimi_resume_failure_never_creates_an_empty_session_or_sends_prompt() {
    for unsupported in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let mut request = fixture(directory.path(), "touch prompt-sent");
        request.session_id = Some("missing-session".into());
        let mut script = fs::read_to_string(&request.runtime.executable).unwrap();
        if !unsupported {
            script = script.replace("\"protocolVersion\":1,", "\"protocolVersion\":1,\"agentCapabilities\":{\"loadSession\":true},")
                .replace("session/new", "session/load")
                .replace("\"result\":{\"sessionId\":\"fixture-session\",\"modes\":{\"availableModes\":[{\"id\":\"default\"}]}}", "\"error\":{\"code\":-32001,\"message\":\"session not found\"}");
        }
        fs::write(&request.runtime.executable, script).unwrap();
        let (manager, rx) = manager(directory.path(), request);
        let events = terminal(&rx);
        manager.shutdown();
        assert_eq!(events.last().unwrap().kind, "failed");
        assert!(!directory.path().join("prompt-sent").exists());
        assert!(!events
            .iter()
            .any(|event| event.text.contains("kimi.session")));
    }
}

#[test]
fn kimi_waits_for_advertised_close_ack_before_terminal_completion() {
    let directory = tempfile::tempdir().unwrap();
    let request = fixture(
        directory.path(),
        r#"printf '%s\n' '{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}'
read -r line
case "$line" in *'"method":"session/close"'*'"sessionId":"fixture-session"'*) ;; *) exit 90;; esac
printf 'persisted' > close-confirmed
printf '%s\n' '{"jsonrpc":"2.0","id":7,"result":{}}'
while read -r line; do :; done
"#,
    );
    let script = fs::read_to_string(&request.runtime.executable)
        .unwrap()
        .replace(
            "\"protocolVersion\":1,",
            "\"protocolVersion\":1,\"agentCapabilities\":{\"sessionCapabilities\":{\"close\":{}}},",
        );
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
    assert_eq!(
        fs::read_to_string(directory.path().join("close-confirmed")).unwrap(),
        "persisted"
    );
}

#[test]
fn kimi_auto_default_answers_repeated_requests_without_user_prompts() {
    for native_yolo in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let ending = format!(
            r#"{PERMISSION}
case "$line" in *'"id":73'*'"optionId":"allow"'*) ;; *) exit 81;; esac
{PERMISSION}
case "$line" in *'"id":73'*'"optionId":"allow"'*) ;; *) exit 82;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":6,"result":{{"stopReason":"end_turn"}}}}'
while read -r line; do :; done
"#
        );
        let mut request = fixture(directory.path(), &ending);
        request.runtime.permissions = None;
        if native_yolo {
            let script = fs::read_to_string(&request.runtime.executable)
                .unwrap()
                .replace(
                    "\"availableModes\":[{\"id\":\"default\"}]",
                    "\"availableModes\":[{\"id\":\"default\"},{\"id\":\"yolo\"}]",
                )
                .replace("\"modeId\":\"default\"", "\"modeId\":\"yolo\"");
            fs::write(&request.runtime.executable, script).unwrap();
        }
        let (manager, rx) = manager(directory.path(), request);
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
            .any(|event| event.text.contains("kimi.permission_requested")));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.text.contains("\"automatic\":true"))
                .count(),
            2
        );
    }
}

#[test]
fn kimi_session_grant_survives_manager_restart_and_is_scoped_to_member() {
    let directory = tempfile::tempdir().unwrap();
    let permission = PERMISSION.replace("\"allow_once\"", "\"allow_always\"");
    let ending = format!(
        r#"{permission}
case "$line" in *'"id":73'*'"optionId":"allow"'*) ;; *) exit 83;; esac
{PERMISSION}
case "$line" in *'"id":73'*'"optionId":"allow"'*) ;; *) exit 84;; esac
printf '%s\n' '{{"jsonrpc":"2.0","id":6,"result":{{"stopReason":"end_turn"}}}}'
while read -r line; do :; done
"#
    );
    let request = fixture(directory.path(), &ending);
    for (round, member) in [(0, "member-kimi"), (1, "member-kimi"), (2, "other-member")] {
        let mut request = request.clone();
        request.run_id = format!("run-{round}");
        request.member_id = member.into();
        if round > 0 {
            request.session_id = Some("fixture-session".into());
            let script = fs::read_to_string(&request.runtime.executable)
                .unwrap()
                .replace(
                    "\"protocolVersion\":1,",
                    "\"protocolVersion\":1,\"agentCapabilities\":{\"loadSession\":true},",
                )
                .replace("session/new", "session/load");
            fs::write(&request.runtime.executable, script).unwrap();
        }
        let (manager, rx) = manager(directory.path(), request);
        if round != 1 {
            loop {
                let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
                assert_ne!(event.kind, "failed", "{}", event.text);
                if event.text.contains("kimi.permission_requested") {
                    let frame: serde_json::Value = serde_json::from_str(&event.text).unwrap();
                    manager
                        .respond_permission(
                            &format!("run-{round}"),
                            member,
                            frame["requestId"].as_str().unwrap(),
                            Some("allow"),
                        )
                        .unwrap();
                    break;
                }
            }
        }
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
            .any(|event| event.text.contains("kimi.permission_requested")));
    }
}

#[test]
fn kimi_auto_never_selects_a_rejection_or_unknown_option() {
    let directory = tempfile::tempdir().unwrap();
    let ending = PERMISSION.replace("\"allow_once\"", "\"future_kind\"");
    let mut request = fixture(
        directory.path(),
        &format!("{ending}\nwhile read -r line; do :; done\n"),
    );
    request.runtime.permissions = None;
    let (manager, rx) = manager(directory.path(), request);
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_ne!(event.kind, "failed", "{}", event.text);
        if event.text.contains("kimi.permission_requested") {
            break;
        }
    }
    manager.stop("run-kimi", None).unwrap();
    assert_eq!(terminal(&rx).last().unwrap().kind, "stopped");
    manager.shutdown();
}

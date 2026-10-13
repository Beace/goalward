use super::*;
use serde_json::{json, Value};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, sync::mpsc};

const PRELUDE: &str = r#"import json,sys,pathlib,time
def read():
    line=sys.stdin.readline()
    if not line: sys.exit(0)
    return json.loads(line)
def emit(value): print(json.dumps(value,ensure_ascii=False),flush=True)
def ack(value,data=None): emit({'type':'response','id':value['id'],'command':value['type'],'success':True,'data':data})
def state(command,busy=False): ack(command,{'sessionId':'pi-session','isStreaming':busy,'isCompacting':False,'pendingMessageCount':0,'model':{'provider':'fixture','id':'model'},'thinkingLevel':'high'})
def answer(text):
    emit({'type':'message_end','message':{'role':'assistant','content':[{'type':'text','text':text}],'stopReason':'stop'}})
    emit({'type':'agent_end','messages':[],'willRetry':False})
    emit({'type':'agent_settled','aborted':False})
with open('starts','a') as f: f.write('started\n')
assert '--mode' in sys.argv and 'rpc' in sys.argv and '--print' not in sys.argv
first=read()
assert first['type']=='get_state'
state(first)
"#;
fn request(directory: &Path, body: &str) -> StartRequest {
    let executable = directory.join("pi-native-fixture");
    fs::write(
        &executable,
        format!("#!/usr/bin/env python3\n{PRELUDE}\n{body}\n"),
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    serde_json::from_value(json!({"taskId":"pi-task","runId":"first","memberId":"member",
        "runtime":{"id":"pi","name":"Pi fixture","adapter":"pi","executable":executable,"enabled":true,"args":[]},
        "directory":directory,"model":"fixture/model","prompt":"literal $(do not execute) café\nline two"})).unwrap()
}
fn manager(directory: &Path) -> RuntimeManager {
    RuntimeManager::new(Arc::new(Storage::new(directory.join("data")).unwrap()))
}
fn start(manager: &RuntimeManager, request: StartRequest) -> mpsc::Receiver<RuntimeEvent> {
    let (tx, rx) = mpsc::channel();
    manager
        .start(
            request,
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        )
        .unwrap();
    rx
}
fn terminal(rx: &mpsc::Receiver<RuntimeEvent>) -> Vec<RuntimeEvent> {
    let mut events = Vec::new();
    loop {
        let event = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("Pi fixture should finish");
        let done = matches!(event.kind.as_str(), "completed" | "failed" | "stopped");
        events.push(event);
        if done {
            return events;
        }
    }
}
fn frame_until(rx: &mpsc::Receiver<RuntimeEvent>, kind: &str) -> Value {
    loop {
        let event = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(
            !matches!(event.kind.as_str(), "completed" | "failed" | "stopped"),
            "{}",
            event.text
        );
        if let Ok(value) = serde_json::from_str::<Value>(&event.text) {
            if value["type"] == kind {
                return value;
            }
        }
    }
}

#[test]
fn pi_rpc_arguments_own_native_protocol_and_disable_tools_for_goal_assistant() {
    let dir = tempfile::tempdir().unwrap();
    let mut req = request(dir.path(), "while True: read()");
    req.session_id = Some("pi-session".into());
    req.reasoning_effort = Some("high".into());
    assert!(pi_rpc::arguments(&req).is_err());
    req.reasoning_effort = None;
    let args = pi_rpc::arguments(&req).unwrap();
    assert_eq!(args[0..2], ["--mode", "rpc"]);
    assert!(!args.contains(&"--print".into()) && !args.contains(&req.prompt));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--session", "pi-session"]));
    assert!(!args.contains(&"--thinking".into()));
    req.runtime.args = vec!["--no-tools".into(), "--no-extensions".into()];
    assert!(pi_rpc::arguments(&req)
        .unwrap()
        .contains(&"--no-mcp".into()));
    req.runtime.args = vec![
        "--tools".into(),
        "read,grep,find,ls".into(),
        "--no-extensions".into(),
    ];
    let args = pi_rpc::arguments(&req).unwrap();
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--tools", "read,grep,find,ls"]));
    assert!(args.contains(&"--no-mcp".into()));
    assert!(!args
        .iter()
        .any(|arg| matches!(arg.as_str(), "bash" | "edit" | "write" | "powershell")));
    for flag in [
        "--continue",
        "--mode=json",
        "--session",
        "--model",
        "--print",
        "@file",
        "--",
    ] {
        req.runtime.args = vec![flag.into()];
        assert!(pi_rpc::arguments(&req).is_err());
    }
}

#[test]
fn pi_reuses_one_rpc_process_and_native_session_across_two_turns() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"index=0
while True:
    command=read()
    if command['type']=='get_state': state(command); continue
    assert command['type']=='prompt'
    index+=1
    if index==1: assert command['message']=='literal $(do not execute) café\nline two'
    ack(command,{'disposition':'started'})
    emit({'type':'agent_start'})
    emit({'type':'message_update','assistantMessageEvent':{'type':'text_delta','contentIndex':0,'delta':'live'}})
    answer('answer-'+str(index))
"#,
    );
    let manager = manager(dir.path());
    let first = terminal(&start(&manager, req.clone()));
    assert_eq!(
        first.last().unwrap().kind,
        "completed",
        "{}",
        first.last().unwrap().text
    );
    assert!(first.iter().any(|event| event.text.contains("text_delta")));
    let mut next = req;
    next.run_id = "second".into();
    next.session_id = Some("pi-session".into());
    let second = terminal(&start(&manager, next));
    manager.shutdown();
    assert_eq!(
        second.last().unwrap().kind,
        "completed",
        "{}",
        second.last().unwrap().text
    );
    assert!(second.iter().all(|event| event.run_id == "second"));
    assert!(!second.iter().any(|event| event.text.contains("answer-1")));
    assert_eq!(
        fs::read_to_string(dir.path().join("starts")).unwrap(),
        "started\n"
    );
}

#[test]
fn pi_does_not_complete_at_prompt_ack_or_low_level_agent_end_during_retry() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"prompt=read()
ack(prompt,{'disposition':'started'})
emit({'type':'agent_start'})
emit({'type':'message_end','message':{'role':'assistant','stopReason':'error'}})
emit({'type':'agent_end','messages':[],'willRetry':True})
while not pathlib.Path('release').exists(): time.sleep(.01)
emit({'type':'agent_start'})
answer('after retry')
while True:
    command=read()
    if command['type']=='get_state': state(command)
"#,
    );
    let manager = manager(dir.path());
    let rx = start(&manager, req);
    frame_until(&rx, "agent_end");
    assert!(
        rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "Retrying agent_end must not finish the run"
    );
    fs::write(dir.path().join("release"), "release").unwrap();
    assert_eq!(terminal(&rx).last().unwrap().kind, "completed");
    manager.shutdown();
}

#[test]
fn pi_steering_uses_native_command_and_stop_clears_queue_before_abort() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"prompt=read()
ack(prompt,{'disposition':'started'})
emit({'type':'agent_start'})
steer=read()
assert steer['type']=='steer' and steer['message']=='new instruction'
ack(steer,{'disposition':'queued'})
clear=read()
assert clear['type']=='clear_queue'
ack(clear,{'steering':['new instruction'],'followUp':[]})
abort=read()
assert abort['type']=='abort'
emit({'type':'message_end','message':{'role':'assistant','stopReason':'aborted'}})
emit({'type':'agent_settled','aborted':True})
ack(abort)
while True:
    command=read()
    if command['type']=='get_state': state(command)
    elif command['type']=='prompt':
        ack(command,{'disposition':'started'})
        emit({'type':'agent_start'})
        answer('after stop')
"#,
    );
    let manager = manager(dir.path());
    let rx = start(&manager, req.clone());
    frame_until(&rx, "agent_start");
    manager.steer("first", "member", "new instruction").unwrap();
    let response = frame_until(&rx, "response");
    assert_eq!(response["command"], "steer");
    manager.stop("first", None).unwrap();
    assert_eq!(terminal(&rx).last().unwrap().kind, "stopped");
    let mut next = req;
    next.run_id = "second".into();
    next.session_id = Some("pi-session".into());
    assert_eq!(
        terminal(&start(&manager, next)).last().unwrap().kind,
        "completed"
    );
    manager.shutdown();
    assert_eq!(
        fs::read_to_string(dir.path().join("starts")).unwrap(),
        "started\n"
    );
}

#[test]
fn pi_extension_confirmation_is_answerable_and_unsupported_dialogs_cancel() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"prompt=read()
ack(prompt,{'disposition':'started'})
emit({'type':'agent_start'})
emit({'type':'extension_ui_request','id':'confirm-token','method':'confirm','title':'Extension asks','message':'Confirm action?'})
reply=read()
assert reply=={'type':'extension_ui_response','id':'confirm-token','confirmed':True}
emit({'type':'extension_ui_request','id':'input-token','method':'input','title':'Type a value'})
reply=read()
assert reply=={'type':'extension_ui_response','id':'input-token','cancelled':True}
answer('confirmed')
while True:
    command=read()
    if command['type']=='get_state': state(command)
"#,
    );
    let manager = manager(dir.path());
    let rx = start(&manager, req);
    let permission = frame_until(&rx, "runtime.permission_requested");
    assert_eq!(permission["source"], "pi-extension-confirm");
    assert!(manager
        .respond_permission("first", "member", "wrong", Some("allow_once"))
        .is_err());
    manager
        .respond_permission("first", "member", "confirm-token", Some("allow_once"))
        .unwrap();
    let events = terminal(&rx);
    assert_eq!(events.last().unwrap().kind, "completed");
    assert!(events
        .iter()
        .any(|event| event.text.contains("runtime.interaction_unsupported")));
    manager.shutdown();
}

#[test]
fn pi_exact_session_mismatch_never_sends_prompt() {
    let dir = tempfile::tempdir().unwrap();
    let mut req = request(dir.path(), "while True: read()");
    req.session_id = Some("wrong-session".into());
    let manager = manager(dir.path());
    assert_eq!(
        terminal(&start(&manager, req)).last().unwrap().kind,
        "failed"
    );
    manager.shutdown();
}

#[test]
fn pi_live_connection_rejects_a_different_explicit_session_before_writing_input() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"while True:
    command=read()
    if command['type']=='get_state': state(command); continue
    with open('received-users','a') as f: f.write('user\n')
    ack(command,{'disposition':'started'})
    emit({'type':'agent_start'})
    answer('original session')
"#,
    );
    let manager = manager(dir.path());
    assert_eq!(
        terminal(&start(&manager, req.clone())).last().unwrap().kind,
        "completed"
    );
    let mut next = req;
    next.run_id = "second".into();
    next.session_id = Some("other-session".into());
    assert!(manager.start(next, Arc::new(|_| {})).is_err());
    manager.shutdown();
    assert_eq!(
        fs::read_to_string(dir.path().join("received-users")).unwrap(),
        "user\n"
    );
}

#[test]
fn pi_old_protocol_polls_busy_then_idle_without_later_notifications() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"prompt=read()
ack(prompt,{'disposition':'started'})
emit({'type':'agent_start'})
emit({'type':'message_end','message':{'role':'assistant','stopReason':'stop','content':[{'type':'text','text':'done'}]}})
emit({'type':'agent_end','willRetry':False,'messages':[]})
query=read()
state(query,True)
busy_at=time.monotonic()
query=read()
assert query['type']=='get_state'
assert time.monotonic()-busy_at>=.2
state(query,False)
while True: read()
"#,
    );
    let manager = manager(dir.path());
    let events = terminal(&start(&manager, req));
    assert_eq!(
        events.last().unwrap().kind,
        "completed",
        "{}",
        events.last().unwrap().text
    );
    assert!(!events
        .iter()
        .any(|event| event.text.contains("agent_settled")));
    manager.shutdown();
}

#[test]
fn pi_steer_returns_error_for_native_rejection_instead_of_accepted() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"prompt=read()
ack(prompt,{'disposition':'started'})
emit({'type':'agent_start'})
steer=read()
assert steer['type']=='steer'
emit({'type':'response','id':steer['id'],'command':'steer','success':False,'error':'native steer rejection'})
answer('original work finished')
while True:
    command=read()
    if command['type']=='get_state': state(command)
"#,
    );
    let manager = manager(dir.path());
    let rx = start(&manager, req);
    frame_until(&rx, "agent_start");
    assert!(manager.steer("first", "member", "reject this").is_err());
    let events = terminal(&rx);
    assert_eq!(events.last().unwrap().kind, "completed");
    assert!(!events
        .iter()
        .any(|event| event.text.contains("runtime.input_queued")));
    manager.shutdown();
}

#[test]
fn pi_steer_waits_for_correlated_success_acknowledgement() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"prompt=read()
ack(prompt,{'disposition':'started'})
emit({'type':'agent_start'})
steer=read()
assert steer['type']=='steer'
emit({'type':'fixture_ack_pending'})
while not pathlib.Path('release-ack').exists(): time.sleep(.01)
ack(steer,{'disposition':'queued'})
answer('with additional input')
while True:
    command=read()
    if command['type']=='get_state': state(command)
"#,
    );
    let manager = manager(dir.path());
    let rx = start(&manager, req);
    frame_until(&rx, "agent_start");
    let cloned = manager.clone();
    let (tx, result) = mpsc::channel();
    let wait = thread::spawn(move || {
        tx.send(cloned.steer("first", "member", "additional input"))
            .unwrap();
    });
    frame_until(&rx, "fixture_ack_pending");
    assert!(
        result.try_recv().is_err(),
        "Writing stdin must not confirm acceptance"
    );
    fs::write(dir.path().join("release-ack"), "release").unwrap();
    assert!(result.recv_timeout(Duration::from_secs(5)).unwrap().is_ok());
    wait.join().unwrap();
    assert_eq!(terminal(&rx).last().unwrap().kind, "completed");
    manager.shutdown();
}

#[test]
fn pi_steer_disconnection_rejects_unconfirmed_input() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"prompt=read()
ack(prompt,{'disposition':'started'})
emit({'type':'agent_start'})
assert read()['type']=='steer'
sys.exit(0)
"#,
    );
    let manager = manager(dir.path());
    let rx = start(&manager, req);
    frame_until(&rx, "agent_start");
    assert!(manager
        .steer("first", "member", "unconfirmed input")
        .is_err());
    assert_eq!(terminal(&rx).last().unwrap().kind, "failed");
    manager.shutdown();
}

#[test]
fn pi_steer_acknowledgement_timeout_closes_unknown_input_without_replay() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"prompt=read()
ack(prompt,{'disposition':'started'})
emit({'type':'agent_start'})
assert read()['type']=='steer'
# No acknowledgement. A client must reject uncertain acceptance and reclaim
# this connection rather than silently report that the added input succeeded.
while True: read()
"#,
    );
    let manager = manager(dir.path());
    let rx = start(&manager, req);
    frame_until(&rx, "agent_start");
    let error = manager
        .steer("first", "member", "unconfirmed input")
        .unwrap_err();
    assert!(error.contains("did not confirm acceptance"));
    assert_eq!(terminal(&rx).last().unwrap().kind, "failed");
    manager.shutdown();
    assert!(manager.connections.lock().unwrap().is_empty());
}

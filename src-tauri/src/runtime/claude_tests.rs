use super::*;
use serde_json::{json, Value};
use std::{fs, os::unix::fs::PermissionsExt, path::Path, sync::mpsc};

fn request(directory: &Path, body: &str) -> StartRequest {
    let executable = directory.join("claude-native-fixture");
    fs::write(
        &executable,
        format!("#!/usr/bin/env python3\n{PRELUDE}\n{body}\n"),
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    serde_json::from_value(json!({"taskId":"claude-task","runId":"first","memberId":"member",
        "runtime":{"id":"claude","name":"Claude fixture","adapter":"claude","executable":executable,"enabled":true,"args":[],"permissions":{"claude":{"mode":"manual"}}},
        "directory":directory,"model":"fixture-model","prompt":"literal $(do not execute) café\nline two"})).unwrap()
}
const PRELUDE: &str = r#"import json,sys,pathlib,time
def read():
    line=sys.stdin.readline()
    if not line: sys.exit(0)
    return json.loads(line)
def emit(value):
    print(json.dumps(value,ensure_ascii=False),flush=True)
def result(text):
    emit({'type':'assistant','session_id':'native-session','message':{'id':text,'role':'assistant','content':[{'type':'text','text':text}]}})
    emit({'type':'result','subtype':'success','is_error':False,'session_id':'native-session','result':text})
with open('starts','a') as f: f.write('started\n')
init=read()
assert init['type']=='control_request' and init['request']['subtype']=='initialize'
emit({'type':'control_response','response':{'subtype':'success','request_id':init['request_id'],'response':{'account':{'doNotLeak':'PRIVATE_INITIALIZE'}}}})
"#;
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
            .expect("Claude fixture should finish");
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
fn claude_native_arguments_route_permissions_and_confine_plan_tools() {
    let dir = tempfile::tempdir().unwrap();
    let mut req = request(dir.path(), "while True: read()");
    req.additional_directories = vec![dir.path().to_string_lossy().into()];
    req.session_id = Some("native-session".into());
    let args = claude::arguments(&req).unwrap();
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--input-format", "stream-json"]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--permission-prompt-tool", "stdio"]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--permission-mode", "default"]));
    assert!(!args.iter().any(|arg| arg == "none" || arg == &req.prompt));
    assert!(args.contains(&"--resume=native-session".into()));
    req.runtime.permissions =
        Some(serde_json::from_value(json!({"claude":{"mode":"plan"}})).unwrap());
    let args = claude::arguments(&req).unwrap();
    assert!(args.contains(&"--restricted".into()));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["--tools", "Read,Grep,Glob"]));
    assert!(args.contains(&"--strict-mcp-config".into()));
    for flag in [
        "--input-format=stream-json",
        "--output-format",
        "--permission-prompt-tool",
        "--continue",
        "--",
    ] {
        req.runtime.args = vec![flag.into()];
        assert!(claude::arguments(&req).is_err());
    }
}

#[test]
fn claude_reuses_one_connection_and_routes_two_exact_session_turns() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"index=0
while True:
    user=read()
    assert user['type']=='user' and user['parent_tool_use_id'] is None
    index+=1
    if index==1: assert user['message']['content']=='literal $(do not execute) café\nline two'
    else: assert user['session_id']=='native-session'
    emit({'type':'stream_event','session_id':'native-session','event':{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'live'}}})
    result('answer-'+str(index))
"#,
    );
    let manager = manager(dir.path());
    let first = terminal(&start(&manager, req.clone()));
    assert_eq!(first.last().unwrap().kind, "completed");
    assert!(first
        .iter()
        .any(|event| event.text.contains("content_block_delta")));
    assert!(!first
        .iter()
        .any(|event| event.text.contains("PRIVATE_INITIALIZE")));
    let mut next = req;
    next.run_id = "second".into();
    next.session_id = Some("native-session".into());
    next.prompt = "second prompt".into();
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
fn claude_approval_requires_matching_unanswered_token_and_preserves_input() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"read()
emit({'type':'control_request','request_id':'approval-token','request':{'subtype':'can_use_tool','tool_name':'Bash','tool_use_id':'tool-1','input':{'command':'literal $(do not execute)'}}})
reply=read()
assert reply['type']=='control_response' and reply['response']['request_id']=='approval-token'
assert reply['response']['response']=={'behavior':'allow','updatedInput':{'command':'literal $(do not execute)'}}
result('approved')
while True: read()
"#,
    );
    let manager = manager(dir.path());
    let rx = start(&manager, req);
    let permission = frame_until(&rx, "runtime.permission_requested");
    assert_eq!(permission["toolCall"]["title"], "Bash");
    assert!(manager
        .respond_permission("first", "member", "wrong", Some("allow_once"))
        .is_err());
    assert!(manager
        .respond_permission("first", "member", "approval-token", Some("allow_always"))
        .is_err());
    manager
        .respond_permission("first", "member", "approval-token", Some("allow_once"))
        .unwrap();
    let events = terminal(&rx);
    assert_eq!(events.last().unwrap().kind, "completed");
    assert!(manager
        .respond_permission("first", "member", "approval-token", Some("allow_once"))
        .is_err());
    manager.shutdown();
}

#[test]
fn claude_queued_input_waits_for_all_native_results() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"read()
emit({'type':'stream_event','session_id':'native-session','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'partial'}}})
queued=read()
assert queued['type']=='user' and queued['message']['content']=='queued input'
result('first answer')
while not pathlib.Path('release').exists(): time.sleep(.01)
result('queued answer')
while True: read()
"#,
    );
    let manager = manager(dir.path());
    let rx = start(&manager, req);
    frame_until(&rx, "stream_event");
    manager.steer("first", "member", "queued input").unwrap();
    frame_until(&rx, "result");
    assert!(
        rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "The first result must not finish queued input"
    );
    fs::write(dir.path().join("release"), "release").unwrap();
    assert_eq!(terminal(&rx).last().unwrap().kind, "completed");
    manager.shutdown();
}

#[test]
fn claude_stop_interrupts_current_turn_but_retains_native_connection() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"read()
emit({'type':'stream_event','session_id':'native-session','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'partial'}}})
control=read()
assert control['type']=='control_request' and control['request']['subtype']=='interrupt'
emit({'type':'control_response','response':{'subtype':'success','request_id':control['request_id'],'response':{}}})
emit({'type':'result','session_id':'native-session','subtype':'error_during_execution','is_error':True})
user=read()
assert user['session_id']=='native-session'
result('after stop')
while True: read()
"#,
    );
    let manager = manager(dir.path());
    let rx = start(&manager, req.clone());
    frame_until(&rx, "stream_event");
    manager.stop("first", None).unwrap();
    assert_eq!(terminal(&rx).last().unwrap().kind, "stopped");
    let mut next = req;
    next.run_id = "second".into();
    next.session_id = Some("native-session".into());
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
fn claude_stop_after_queued_input_recycles_connection_before_exact_resume() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"starts=pathlib.Path('starts').read_text().count('started')
user=read()
if starts==1:
    emit({'type':'stream_event','session_id':'native-session','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'partial'}}})
    queued=read()
    assert queued['type']=='user'
    import threading
    def queued_work_after_stop_returns():
        while not pathlib.Path('stop-returned').exists(): time.sleep(.001)
        pathlib.Path('unwanted-queued-work').write_text('process remained runnable after Stop')
    threading.Thread(target=queued_work_after_stop_returns,daemon=True).start()
    emit({'type':'user','session_id':'native-session','message':queued['message']})
    interrupt=read()
    assert interrupt['request']['subtype']=='interrupt'
    # Native interrupt has no clear-queue control and can immediately release
    # pending work. No interrupt frame may be delivered in this queue case.
    pathlib.Path('unexpected-interrupt').write_text('queue was released')
    pathlib.Path('unwanted-queued-work').write_text('should never execute')
    result('old queued result')
else:
    assert '--resume=native-session' in sys.argv
    assert user['type']=='user' and user['message']['content']=='after queued stop'
    result('exact resumed session')
while True: read()
"#,
    );
    let manager = manager(dir.path());
    let rx = start(&manager, req.clone());
    frame_until(&rx, "stream_event");
    manager.steer("first", "member", "queued input").unwrap();
    frame_until(&rx, "user");
    manager.stop("first", None).unwrap();
    fs::write(
        dir.path().join("stop-returned"),
        "Stop must already have terminated queued connection",
    )
    .unwrap();
    assert_eq!(terminal(&rx).last().unwrap().kind, "stopped");
    assert!(!dir.path().join("unexpected-interrupt").exists());
    assert!(!dir.path().join("unwanted-queued-work").exists());
    let mut next = req;
    next.run_id = "second".into();
    next.session_id = Some("native-session".into());
    next.prompt = "after queued stop".into();
    // The stopped callback can precede final connection map cleanup by a few
    // milliseconds; await idle cleanup rather than sending an ambiguous retry.
    let until = Instant::now() + Duration::from_secs(3);
    while !manager.connections.lock().unwrap().is_empty() && Instant::now() < until {
        thread::sleep(Duration::from_millis(10));
    }
    let second = terminal(&start(&manager, next));
    assert_eq!(second.last().unwrap().kind, "completed");
    assert!(!second
        .iter()
        .any(|event| event.text.contains("old queued result")));
    manager.shutdown();
    assert_eq!(
        fs::read_to_string(dir.path().join("starts")).unwrap(),
        "started\nstarted\n"
    );
}

#[test]
fn claude_large_prompt_is_preserved_inside_one_native_user_record() {
    let dir = tempfile::tempdir().unwrap();
    let mut req = request(
        dir.path(),
        r#"user=read()
pathlib.Path('prompt.txt').write_text(user['message']['content'])
result('large input accepted')
while True: read()
"#,
    );
    req.prompt = "café🙂 $(literal) @file --flag\n".repeat(16000);
    let prompt = req.prompt.clone();
    let manager = manager(dir.path());
    assert_eq!(
        terminal(&start(&manager, req)).last().unwrap().kind,
        "completed"
    );
    manager.shutdown();
    assert_eq!(
        fs::read_to_string(dir.path().join("prompt.txt")).unwrap(),
        prompt
    );
}

#[test]
fn claude_rejects_a_different_explicit_session_before_writing_input() {
    let dir = tempfile::tempdir().unwrap();
    let req = request(
        dir.path(),
        r#"while True:
    user=read()
    with open('received-users','a') as f: f.write('user\n')
    result('original session')
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

//! Claude Code's native streaming-input transport, the same bidirectional
//! JSONL control protocol used by the official Agent SDK. No Node sidecar or
//! replacement model/tool loop is involved: the user's Claude executable owns
//! authentication, native sessions, tools, and configuration.
use super::{EventSink, NativeSession, RoutedSink};
use crate::{permission, reasoning, types::StartRequest};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    process::ChildStdin,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const MAX_FRAME: u64 = 4 * 1024 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

pub(super) fn arguments(request: &StartRequest) -> Result<Vec<String>, String> {
    let extra = &request.runtime.args;
    for arg in extra {
        let flag = arg.split('=').next().unwrap_or(arg);
        if matches!(
            flag,
            "--input-format"
                | "--output-format"
                | "--print"
                | "-p"
                | "--resume"
                | "-r"
                | "--continue"
                | "-c"
                | "--session-id"
                | "--fork-session"
                | "--no-session-persistence"
                | "--replay-user-messages"
                | "--permission-prompt-tool"
                | "--permission-prompts"
                | "--"
        ) {
            return Err(format!("Native Claude sessions are managed by the app. The extra argument {flag} is not supported."));
        }
    }
    let model = if request.model.trim().is_empty() {
        request.runtime.default_model.trim()
    } else {
        request.model.trim()
    };
    let expanded: Vec<String> = extra
        .iter()
        .map(|arg| super::expand_template(arg, &request.prompt, model))
        .collect();
    let mut permissions = permission::arguments(&request.runtime, &expanded)?;
    // The old print adapter deliberately denied prompts it could not answer.
    // This transport implements can_use_tool, so retain the policy and route
    // unresolved requests back to the human instead of silently denying them.
    let mut index = 0;
    while index < permissions.len() {
        if permissions[index] == "--permission-prompts" {
            permissions.drain(index..(index + 2).min(permissions.len()));
        } else {
            if permissions[index] == "manual" {
                permissions[index] = "default".into();
            }
            index += 1;
        }
    }
    let mut args = vec![
        "--print".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
        "--permission-prompt-tool".into(),
        "stdio".into(),
    ];
    if !model.is_empty() {
        args.extend(["--model".into(), model.into()]);
    }
    if let Some(id) = &request.session_id {
        args.push(format!("--resume={id}"));
    }
    args.extend(expanded);
    args.extend(permissions);
    args.extend(reasoning::arguments(
        "claude",
        request.reasoning_effort.as_deref(),
        extra,
    )?);
    for directory in &request.additional_directories {
        args.extend(["--add-dir".into(), directory.clone()]);
    }
    if read_only(request) {
        // Plan mode alone is not a sandbox: restrict the actual tool set and
        // disable MCP/config customizations which could introduce write tools.
        args.extend([
            "--restricted".into(),
            "--tools".into(),
            "Read,Grep,Glob".into(),
            "--strict-mcp-config".into(),
            "--mcp-config".into(),
            "{\"mcpServers\":{}}".into(),
        ]);
    }
    Ok(args)
}

fn read_only(request: &StartRequest) -> bool {
    request
        .runtime
        .permissions
        .as_ref()
        .and_then(|p| p.claude.as_ref())
        .is_some_and(|p| p.mode == "plan")
}

struct Pending {
    rpc_id: String,
    input: Value,
}
struct Inner {
    input: ChildStdin,
    initialized: bool,
    init_id: String,
    since: Instant,
    session: Option<String>,
    pending: HashMap<String, Pending>,
    results_pending: usize,
    outcome: Option<Result<(), String>>,
    cancelled: bool,
    disconnected: bool,
}
pub(super) struct ClaudeSession {
    inner: Mutex<Inner>,
    sink: RoutedSink,
}

impl ClaudeSession {
    pub(super) fn new(input: ChildStdin, sink: Arc<EventSink>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                input,
                initialized: false,
                init_id: uuid::Uuid::new_v4().to_string(),
                since: Instant::now(),
                session: None,
                pending: HashMap::new(),
                results_pending: 0,
                outcome: None,
                cancelled: false,
                disconnected: false,
            }),
            sink: RoutedSink::new(sink),
        })
    }
    fn write(inner: &mut Inner, value: Value) -> Result<(), String> {
        serde_json::to_writer(&mut inner.input, &value)
            .map_err(|_| "Cannot write Claude native request")?;
        inner
            .input
            .write_all(b"\n")
            .and_then(|_| inner.input.flush())
            .map_err(|_| "Claude native input disconnected".into())
    }
    fn control(inner: &mut Inner, request: Value) -> Result<(), String> {
        Self::write(
            inner,
            json!({"type":"control_request","request_id":uuid::Uuid::new_v4().to_string(),"request":request}),
        )
    }
    fn emit(&self, value: Value) {
        emit(&self.sink.current(), value);
    }
    fn capabilities(&self) {
        self.emit(json!({"type":"runtime.capabilities","steer":false,"followUp":true,"approvals":!read_only(&self.sink.current().request)}));
    }
    fn prompt(inner: &mut Inner, prompt: &str) -> Result<(), String> {
        Self::write(
            inner,
            json!({"type":"user","uuid":uuid::Uuid::new_v4().to_string(),
            "session_id":inner.session.as_deref().unwrap_or(""),"message":{"role":"user","content":prompt},"parent_tool_use_id":null}),
        )?;
        inner.results_pending += 1;
        Ok(())
    }
    pub(super) fn begin(
        self: &Arc<Self>,
        output: impl Read + Send + 'static,
    ) -> thread::JoinHandle<()> {
        let session = self.clone();
        thread::spawn(move || {
            let initialize = session.inner.lock().map_err(|_| "Claude lock unavailable".to_string()).and_then(|mut inner| {
                let id = inner.init_id.clone();
                Self::write(&mut inner, json!({"type":"control_request","request_id":id,"request":{"subtype":"initialize","hooks":null}}))
            });
            if let Err(error) = initialize {
                session.fail(error);
                return;
            }
            let mut reader = BufReader::new(output);
            loop {
                let mut frame = Vec::new();
                match reader
                    .by_ref()
                    .take(MAX_FRAME + 1)
                    .read_until(b'\n', &mut frame)
                {
                    Ok(0) => {
                        session.fail("Claude native connection closed".into());
                        break;
                    }
                    Ok(_) if frame.len() as u64 > MAX_FRAME => {
                        session.fail("Claude native frame exceeds 4 MiB".into());
                        break;
                    }
                    Ok(_) => {
                        if frame.iter().all(u8::is_ascii_whitespace) {
                            continue;
                        }
                        let value = match serde_json::from_slice::<Value>(&frame) {
                            Ok(value) => value,
                            Err(_) => {
                                session.fail("Claude emitted invalid streaming-input JSON; check CLI compatibility".into());
                                break;
                            }
                        };
                        if let Err(error) = session.receive(value) {
                            session.fail(error);
                            break;
                        }
                    }
                    Err(_) => {
                        session.fail("Cannot read Claude native output".into());
                        break;
                    }
                }
            }
        })
    }
    fn fail(&self, error: String) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.disconnected = true;
            if inner.outcome.is_none() {
                inner.outcome = Some(Err(error));
            }
        }
    }
    fn receive(&self, value: Value) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Claude lock unavailable")?;
        match value["type"].as_str() {
            Some("control_response") => {
                if value["response"]["request_id"].as_str() == Some(&inner.init_id) {
                    if value["response"]["subtype"] != "success" {
                        return Err("Claude native initialization was rejected; update the Claude executable".into());
                    }
                    inner.initialized = true;
                    self.capabilities();
                    let prompt = self.sink.current().request.prompt.clone();
                    Self::prompt(&mut inner, &prompt)?;
                }
                // Initialize includes account details and full SDK internals.
                // Only expose public session/runtime events, not that payload.
            }
            Some("control_request") => {
                let id = value["request_id"]
                    .as_str()
                    .ok_or("Claude permission request lacks an ID")?
                    .to_owned();
                let request = &value["request"];
                if request["subtype"] == "can_use_tool" {
                    if inner.cancelled || read_only(&self.sink.current().request) {
                        Self::write(
                            &mut inner,
                            permission_response(&id, false, &request["input"]),
                        )?;
                        self.emit(json!({"type":"runtime.permission_resolved","requestId":id,"optionId":"reject_once","automatic":true,"reason":"restricted-session"}));
                    } else {
                        if inner.pending.len() >= 128 {
                            return Err("Claude sent too many pending approval requests".into());
                        }
                        inner.pending.insert(
                            id.clone(),
                            Pending {
                                rpc_id: id.clone(),
                                input: request["input"].clone(),
                            },
                        );
                        self.emit(json!({"type":"runtime.permission_requested","requestId":id,
                            "options":[{"optionId":"allow_once","name":"Allow once","kind":"allow_once"},{"optionId":"reject_once","name":"Deny","kind":"reject_once"}],
                            "toolCall":{"title":request["tool_name"],"toolCallId":request["tool_use_id"],"rawInput":request["input"]}}));
                    }
                } else {
                    Self::write(
                        &mut inner,
                        json!({"type":"control_response","response":{"subtype":"error","request_id":id,"error":"Goalward does not expose this client capability"}}),
                    )?;
                }
            }
            Some("control_cancel_request") => {
                if let Some(id) = value["request_id"].as_str() {
                    inner.pending.remove(id);
                    self.emit(json!({"type":"runtime.permission_resolved","requestId":id,"optionId":null,"cancelled":true}));
                }
            }
            _ => {
                if let Some(id) = value["session_id"].as_str().filter(|id| !id.is_empty()) {
                    let expected = self.sink.current().request.session_id.clone();
                    if expected.as_deref().is_some_and(|expected| expected != id)
                        || inner
                            .session
                            .as_deref()
                            .is_some_and(|session| session != id)
                    {
                        return Err(
                            "Claude did not resume the exact requested native session".into()
                        );
                    }
                    inner.session = Some(id.into());
                }
                if value["type"] == "result" {
                    if inner.results_pending == 0 {
                        return Err("Claude returned an uncorrelated turn result".into());
                    }
                    inner.results_pending -= 1;
                    if value["is_error"] == true || value["subtype"] != "success" {
                        inner.outcome = Some(Err("Claude returned a failed or incomplete native result; inspect the trace".into()));
                        // A failed early result must not leave already queued
                        // users running behind a Run that is now terminal.
                        if inner.results_pending > 0 {
                            inner.disconnected = true;
                        }
                    } else if inner.results_pending == 0 {
                        inner.outcome = Some(if inner.session.is_some() {
                            Ok(())
                        } else {
                            Err("Claude result lacks a native session ID".into())
                        });
                    }
                    inner.pending.clear();
                }
                self.emit(value);
            }
        }
        Ok(())
    }
}

impl NativeSession for ClaudeSession {
    fn start_turn(&self, sink: Arc<EventSink>) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Claude lock unavailable")?;
        if inner.disconnected || !inner.initialized {
            return Err("Claude native connection is unavailable".into());
        }
        if inner.outcome.is_none() {
            return Err("Claude already has an active turn".into());
        }
        if sink
            .request
            .session_id
            .as_deref()
            .is_some_and(|expected| inner.session.as_deref() != Some(expected))
        {
            return Err("Claude live connection belongs to a different native session; this input was not sent".into());
        }
        inner.outcome = None;
        inner.cancelled = false;
        inner.results_pending = 0;
        inner.pending.clear();
        self.sink.replace(sink.clone());
        self.capabilities();
        Self::prompt(&mut inner, &sink.request.prompt)
    }
    fn outcome(&self) -> Option<Result<(), String>> {
        let mut inner = self.inner.lock().ok()?;
        if !inner.initialized && inner.outcome.is_none() && inner.since.elapsed() > STARTUP_TIMEOUT
        {
            inner.disconnected = true;
            inner.outcome = Some(Err(
                "Claude native initialization timed out; check executable and login".into(),
            ));
        }
        inner.outcome.clone()
    }
    fn cancel(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.outcome.is_some() || inner.cancelled {
                return;
            }
            inner.cancelled = true;
            // The native interrupt control cancels the current generation, but
            // provides no clear-queue operation for already submitted users.
            // Recycle this connection if queued input could otherwise execute
            // after Stop; the persisted native session can still be resumed.
            if inner.results_pending > 1 {
                inner.disconnected = true;
                // Interrupt can immediately advance Claude's input queue. The
                // manager must terminate this connection without sending any
                // control frame that could release pending work first.
                return;
            }
            let pending = std::mem::take(&mut inner.pending);
            for (token, request) in pending {
                let _ = Self::write(
                    &mut inner,
                    permission_response(&request.rpc_id, false, &request.input),
                );
                self.emit(json!({"type":"runtime.permission_resolved","requestId":token,"optionId":null,"cancelled":true}));
            }
            let _ = Self::control(&mut inner, json!({"subtype":"interrupt"}));
        }
    }
    fn steer(&self, prompt: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Claude lock unavailable")?;
        if !inner.initialized || inner.disconnected || inner.cancelled || inner.outcome.is_some() {
            return Err("Claude has no active turn to queue input for".into());
        }
        if inner.results_pending >= 32 {
            return Err("Claude queued-message limit reached".into());
        }
        Self::prompt(&mut inner, prompt)?;
        self.emit(json!({"type":"runtime.input_submitted","behavior":"followUp"}));
        Ok(())
    }
    fn respond(&self, token: &str, option: Option<&str>) -> Result<(), String> {
        if !matches!(option, None | Some("allow_once" | "reject_once")) {
            return Err("Unknown Claude approval option".into());
        }
        let mut inner = self.inner.lock().map_err(|_| "Claude lock unavailable")?;
        if inner.cancelled || inner.outcome.is_some() {
            return Err("This Claude turn is no longer active".into());
        }
        let pending = inner
            .pending
            .get(token)
            .ok_or("Claude approval expired or was already answered")?;
        let reply = permission_response(
            &pending.rpc_id,
            option == Some("allow_once"),
            &pending.input,
        );
        Self::write(&mut inner, reply)?;
        inner.pending.remove(token);
        self.emit(
            json!({"type":"runtime.permission_resolved","requestId":token,"optionId":option}),
        );
        Ok(())
    }
    fn disconnected(&self) -> bool {
        self.inner.lock().map_or(true, |inner| inner.disconnected)
    }
    fn hard_disconnect(&self) -> bool {
        self.inner
            .lock()
            .is_ok_and(|inner| inner.disconnected && inner.results_pending > 0)
    }
}

fn permission_response(id: &str, allow: bool, input: &Value) -> Value {
    let response = if allow {
        json!({"behavior":"allow","updatedInput":input})
    } else {
        json!({"behavior":"deny","message":"Denied by the Goalward user or restricted session"})
    };
    json!({"type":"control_response","response":{"subtype":"success","request_id":id,"response":response}})
}

fn emit(sink: &EventSink, value: Value) {
    let mut bytes = serde_json::to_vec(&value).unwrap_or_default();
    bytes.push(b'\n');
    let mut start = 0;
    while start < bytes.len() {
        let mut end = (start + 4096).min(bytes.len());
        while end < bytes.len() && (bytes[end] & 0xc0) == 0x80 {
            end -= 1;
        }
        sink.output("stdout", &bytes[start..end]);
        start = end;
    }
}

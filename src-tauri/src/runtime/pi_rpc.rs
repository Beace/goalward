//! Pi's native long-lived RPC mode. A command acknowledgement is acceptance,
//! not completion; wait for session-level idle/settled after model/tool events.
use super::{EventSink, NativeSession, RoutedSink};
use crate::{reasoning, types::StartRequest};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    process::ChildStdin,
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};
const MAX_FRAME: u64 = 4 * 1024 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const IDLE_CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);
const INPUT_ACK_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) fn arguments(request: &StartRequest) -> Result<Vec<String>, String> {
    let model = if request.model.trim().is_empty() {
        request.runtime.default_model.trim()
    } else {
        request.model.trim()
    };
    let extra: Vec<String> = request
        .runtime
        .args
        .iter()
        .map(|arg| super::expand_template(arg, &request.prompt, model))
        .collect();
    let mut index = 0;
    while index < extra.len() {
        match extra[index].as_str() {
            "--no-tools"
            | "--no-builtin-tools"
            | "--no-extensions"
            | "--no-skills"
            | "--no-prompt-templates"
            | "--no-themes"
            | "--no-context-files"
            | "--no-mcp"
            | "--offline"
            | "--approve"
            | "--no-approve" => index += 1,
            "--tools"
            | "--exclude-tools"
            | "--extension"
            | "--skill"
            | "--append-system-prompt"
            | "--system-prompt" => {
                if extra
                    .get(index + 1)
                    .is_none_or(|value| value.is_empty() || value.starts_with('-'))
                {
                    return Err("Pi 启动参数缺少有效值".into());
                }
                index += 2;
            }
            _ => {
                return Err(format!(
                    "Pi 原生会话由应用管理，不支持额外参数 {}",
                    extra[index]
                ))
            }
        }
    }
    let mut args = vec!["--mode".into(), "rpc".into()];
    if !model.is_empty() {
        let Some((provider, id)) = model.split_once('/') else {
            return Err("Pi 模型必须使用 provider/model 格式".into());
        };
        if provider.is_empty() || id.is_empty() || provider.starts_with('-') || id.starts_with('-')
        {
            return Err("Pi 模型标识无效".into());
        }
        args.extend([
            "--provider".into(),
            provider.into(),
            "--model".into(),
            id.into(),
        ]);
    }
    if let Some(id) = &request.session_id {
        args.extend(["--session".into(), id.clone()]);
    }
    // The selected model catalog has not established supported effort levels.
    // Preserve Pi's native setting and report its actual level from get_state.
    args.extend(reasoning::arguments(
        "pi",
        request.reasoning_effort.as_deref(),
        &extra,
    )?);
    // Pi's --tools builtin allowlist keeps MCP tools unless MCP is explicitly
    // disabled. A read-only goal assistant must not gain custom write tools.
    if read_only(request) && !extra.iter().any(|arg| arg == "--no-mcp") {
        args.push("--no-mcp".into());
    }
    args.extend(extra);
    Ok(args)
}

struct Inner {
    input: ChildStdin,
    since: Instant,
    session: Option<String>,
    requests: HashMap<String, (&'static str, u64)>,
    approvals: HashMap<String, Value>,
    initialized: bool,
    started: bool,
    last_stop: Option<String>,
    outcome: Option<Result<(), String>>,
    cancelled: bool,
    disconnected: bool,
    settling: bool,
    generation: u64,
    idle_confirmation_since: Option<Instant>,
    next_idle_check: Option<Instant>,
    input_acks: HashMap<String, Option<Result<(), String>>>,
    hard_disconnect: bool,
}
pub(super) struct PiSession {
    inner: Mutex<Inner>,
    sink: RoutedSink,
    input_acknowledged: Condvar,
}
impl PiSession {
    pub(super) fn new(input: ChildStdin, sink: Arc<EventSink>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                input,
                since: Instant::now(),
                session: None,
                requests: HashMap::new(),
                approvals: HashMap::new(),
                initialized: false,
                started: false,
                last_stop: None,
                outcome: None,
                cancelled: false,
                disconnected: false,
                settling: false,
                generation: 0,
                idle_confirmation_since: None,
                next_idle_check: None,
                input_acks: HashMap::new(),
                hard_disconnect: false,
            }),
            sink: RoutedSink::new(sink),
            input_acknowledged: Condvar::new(),
        })
    }
    fn write(inner: &mut Inner, value: Value) -> Result<(), String> {
        serde_json::to_writer(&mut inner.input, &value)
            .map_err(|_| "Cannot write Pi RPC request")?;
        inner
            .input
            .write_all(b"\n")
            .and_then(|_| inner.input.flush())
            .map_err(|_| "Pi RPC input disconnected".into())
    }
    fn command(inner: &mut Inner, command: &'static str, mut value: Value) -> Result<(), String> {
        Self::submit(inner, command, &mut value).map(|_| ())
    }
    fn submit(
        inner: &mut Inner,
        command: &'static str,
        value: &mut Value,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        value["id"] = Value::String(id.clone());
        value["type"] = Value::String(command.into());
        Self::write(inner, value.clone())?;
        inner
            .requests
            .insert(id.clone(), (command, inner.generation));
        Ok(id)
    }
    fn emit(&self, value: Value) {
        let mut bytes = serde_json::to_vec(&value).unwrap_or_default();
        bytes.push(b'\n');
        let mut start = 0;
        while start < bytes.len() {
            let mut end = (start + 4096).min(bytes.len());
            while end < bytes.len() && (bytes[end] & 0xc0) == 0x80 {
                end -= 1;
            }
            self.sink.current().output("stdout", &bytes[start..end]);
            start = end;
        }
    }
    fn capabilities(&self) {
        self.emit(
            json!({"type":"runtime.capabilities","steer":true,"followUp":true,"approvals":false}),
        );
    }
    pub(super) fn begin(
        self: &Arc<Self>,
        output: impl Read + Send + 'static,
    ) -> thread::JoinHandle<()> {
        let session = self.clone();
        thread::spawn(move || {
            let initialize = session
                .inner
                .lock()
                .map_err(|_| "Pi RPC lock unavailable".to_string())
                .and_then(|mut inner| Self::command(&mut inner, "get_state", json!({})));
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
                        session.fail("Pi RPC connection closed".into());
                        break;
                    }
                    Ok(_) if frame.len() as u64 > MAX_FRAME => {
                        session.fail("Pi RPC frame exceeds 4 MiB".into());
                        break;
                    }
                    Ok(_) => {
                        if frame.iter().all(u8::is_ascii_whitespace) {
                            continue;
                        }
                        let value = match serde_json::from_slice::<Value>(&frame) {
                            Ok(value) => value,
                            Err(_) => {
                                session.fail(
                                    "Pi emitted invalid RPC JSON; check CLI and extensions".into(),
                                );
                                break;
                            }
                        };
                        if let Err(error) = session.receive(value) {
                            session.fail(error);
                            break;
                        }
                    }
                    Err(_) => {
                        session.fail("Cannot read Pi RPC output".into());
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
            self.input_acknowledged.notify_all();
        }
    }
    fn finish(inner: &mut Inner) {
        inner.approvals.clear();
        inner.idle_confirmation_since = None;
        inner.next_idle_check = None;
        inner.outcome = Some(match inner.last_stop.as_deref() {
            Some("stop") if !inner.cancelled => Ok(()),
            Some("length") => Err("Pi 回答达到输出长度限制，本轮执行未完成".into()),
            Some("error") => Err("Pi 模型请求失败，请查看 Trace".into()),
            Some("aborted") => Err("Pi 当前执行已中止".into()),
            _ if inner.cancelled => Err("Pi 当前执行已中止".into()),
            _ => Err("Pi 未返回正常结束的 Agent 回答".into()),
        });
    }
    fn receive(&self, value: Value) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Pi RPC lock unavailable")?;
        match value["type"].as_str() {
            Some("response") => {
                let Some(id) = value["id"].as_str() else {
                    return Err("Pi RPC response lacks a command ID".into());
                };
                let Some((command, generation)) = inner.requests.remove(id) else {
                    return Err("Pi RPC returned an uncorrelated command response".into());
                };
                if value["command"] != command {
                    return Err("Pi RPC response command does not match its request".into());
                }
                if generation != inner.generation {
                    self.input_acknowledged.notify_all();
                    return Ok(());
                }
                if command == "steer" {
                    if let Some(pending) = inner.input_acks.get_mut(id) {
                        *pending = Some(if value["success"] == true {
                            Ok(())
                        } else {
                            Err("Pi rejected the additional input; inspect its native response in Trace".into())
                        });
                    }
                    self.input_acknowledged.notify_all();
                }
                if value["success"] != true {
                    self.emit(value.clone());
                    if matches!(command, "get_state" | "prompt") {
                        inner.outcome =
                            Some(Err(format!("Pi RPC rejected {command}; inspect the trace")));
                        if command == "get_state" {
                            inner.disconnected = true;
                        }
                    }
                    return Ok(());
                }
                if command == "get_state" {
                    let data = &value["data"];
                    let id = data["sessionId"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or("Pi RPC returned no native session ID")?;
                    let expected = self.sink.current().request.session_id.clone();
                    if expected.as_deref().is_some_and(|expected| expected != id)
                        || inner
                            .session
                            .as_deref()
                            .is_some_and(|session| session != id)
                    {
                        return Err("Pi did not resume the exact requested native session".into());
                    }
                    inner.session = Some(id.to_owned());
                    if !inner.initialized {
                        if data["isStreaming"] == true || data["isCompacting"] == true {
                            return Err("Pi native session is already busy".into());
                        }
                        inner.initialized = true;
                        self.capabilities();
                        self.emit(json!({"type":"session","id":id,"cwd":self.sink.current().request.directory}));
                        self.emit(json!({"type":"runtime.session_ready","sessionId":id,"model":data["model"],"reasoningEffort":data["thinkingLevel"]}));
                        let prompt = self.sink.current().request.prompt.clone();
                        Self::command(&mut inner, "prompt", json!({"message":prompt}))?;
                    } else if inner.settling {
                        inner.settling = false;
                        // Older Pi versions use agent_end. Check public session
                        // state rather than assuming low-level agent_end is idle.
                        if data["isStreaming"] == false
                            && data["isCompacting"] != true
                            && data["pendingMessageCount"].as_u64().unwrap_or(0) == 0
                        {
                            Self::finish(&mut inner);
                        } else {
                            inner
                                .idle_confirmation_since
                                .get_or_insert_with(Instant::now);
                            inner.next_idle_check = Some(Instant::now() + IDLE_POLL_INTERVAL);
                        }
                    }
                } else if command == "prompt" && value["data"]["disposition"] == "handled" {
                    // An extension consumed the input: no model run is promised.
                    inner.outcome =
                        Some(Err("Pi 扩展处理了输入，没有可验证的 Agent 完成结果".into()));
                } else if command == "abort" && inner.cancelled && inner.outcome.is_none() {
                    Self::finish(&mut inner);
                } else if command == "steer" {
                    self.emit(json!({"type":"runtime.input_queued","behavior":"steer"}));
                    if inner.outcome.is_some() && !inner.cancelled && !inner.disconnected {
                        // The prior settled event may race the stdin command.
                        // Keep this Run active until native state confirms all
                        // accepted input is idle rather than publishing the
                        // previous completion ahead of the additional input.
                        inner.outcome = None;
                        inner.settling = true;
                        inner.idle_confirmation_since = Some(Instant::now());
                        Self::command(&mut inner, "get_state", json!({}))?;
                    }
                }
                self.emit(value);
            }
            Some("agent_start") => {
                inner.started = true;
                inner.last_stop = None;
                inner.idle_confirmation_since = None;
                inner.next_idle_check = None;
                self.emit(value);
            }
            Some("message_end") => {
                if value["message"]["role"] == "assistant" {
                    inner.last_stop = value["message"]["stopReason"].as_str().map(str::to_owned);
                }
                self.emit(value);
            }
            Some("agent_end") => {
                self.emit(value.clone());
                if inner.started && value["willRetry"] != true && !inner.settling {
                    inner.settling = true;
                    inner.idle_confirmation_since = Some(Instant::now());
                    Self::command(&mut inner, "get_state", json!({}))?;
                }
            }
            Some("agent_settled") => {
                if !inner.started {
                    return Err("Pi returned settled without a started Agent run".into());
                }
                inner.cancelled |= value["aborted"] == true;
                Self::finish(&mut inner);
                self.emit(value);
            }
            Some("extension_ui_request") => {
                let method = value["method"].as_str().unwrap_or("");
                let id = value["id"]
                    .as_str()
                    .ok_or("Pi extension UI request lacks an ID")?
                    .to_owned();
                if method == "confirm"
                    && !inner.cancelled
                    && !read_only(&self.sink.current().request)
                {
                    if inner.approvals.len() >= 128 {
                        return Err("Pi sent too many pending confirmation requests".into());
                    }
                    inner.approvals.insert(id.clone(), value.clone());
                    self.emit(json!({"type":"runtime.permission_requested","requestId":id,"source":"pi-extension-confirm",
                        "options":[{"optionId":"allow_once","name":"确认","kind":"allow_once"},{"optionId":"reject_once","name":"取消","kind":"reject_once"}],
                        "toolCall":{"title":value["title"],"rawInput":{"message":value["message"]}}}));
                } else if matches!(method, "select" | "input" | "editor" | "confirm") {
                    Self::write(
                        &mut inner,
                        json!({"type":"extension_ui_response","id":id,"cancelled":true}),
                    )?;
                    self.emit(json!({"type":"runtime.interaction_unsupported","method":method,"requestId":id,"message":"This extension dialog is not supported by Goalward and was cancelled"}));
                } else {
                    self.emit(value);
                }
            }
            _ => self.emit(value),
        }
        Ok(())
    }
}
fn read_only(request: &StartRequest) -> bool {
    request.runtime.args.iter().any(|arg| arg == "--no-tools")
        || request.runtime.args.windows(2).any(|pair| {
            pair[0] == "--tools"
                && !pair[1].is_empty()
                && pair[1]
                    .split(',')
                    .all(|tool| matches!(tool, "read" | "grep" | "find" | "ls"))
        })
}
impl NativeSession for PiSession {
    fn start_turn(&self, sink: Arc<EventSink>) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Pi RPC lock unavailable")?;
        if inner.disconnected || !inner.initialized {
            return Err("Pi RPC connection is unavailable".into());
        }
        if inner.outcome.is_none() {
            return Err("Pi already has an active run".into());
        }
        if sink
            .request
            .session_id
            .as_deref()
            .is_some_and(|expected| inner.session.as_deref() != Some(expected))
        {
            return Err(
                "Pi live connection belongs to a different native session; this input was not sent"
                    .into(),
            );
        }
        inner.outcome = None;
        inner.cancelled = false;
        inner.started = false;
        inner.last_stop = None;
        inner.settling = false;
        inner.idle_confirmation_since = None;
        inner.next_idle_check = None;
        inner.approvals.clear();
        inner.generation += 1;
        self.input_acknowledged.notify_all();
        // Settling queries from the previous turn may still be in flight. They
        // remain correlated but cannot mark a new run complete before it starts.
        self.sink.replace(sink.clone());
        self.capabilities();
        if let Some(id) = &inner.session {
            self.emit(json!({"type":"session","id":id,"cwd":sink.request.directory}));
        }
        Self::command(&mut inner, "prompt", json!({"message":sink.request.prompt}))
    }
    fn outcome(&self) -> Option<Result<(), String>> {
        let mut inner = self.inner.lock().ok()?;
        if !inner.initialized && inner.outcome.is_none() && inner.since.elapsed() > STARTUP_TIMEOUT
        {
            inner.disconnected = true;
            inner.outcome = Some(Err(
                "Pi RPC initialization timed out; check executable and extensions".into(),
            ));
        }
        if inner.outcome.is_none() {
            if inner
                .idle_confirmation_since
                .is_some_and(|since| since.elapsed() > IDLE_CONFIRM_TIMEOUT)
            {
                inner.disconnected = true;
                inner.hard_disconnect = true;
                inner.outcome = Some(Err("Pi RPC could not confirm the native run became idle within 120 seconds; partial output and session history were retained".into()));
                self.input_acknowledged.notify_all();
            } else if !inner.settling
                && inner
                    .next_idle_check
                    .is_some_and(|next| Instant::now() >= next)
            {
                inner.next_idle_check = None;
                inner.settling = true;
                if let Err(error) = Self::command(&mut inner, "get_state", json!({})) {
                    inner.disconnected = true;
                    inner.outcome = Some(Err(error));
                    self.input_acknowledged.notify_all();
                }
            }
        }
        if !inner.disconnected && !inner.cancelled && inner.input_acks.values().any(Option::is_none)
        {
            None
        } else {
            inner.outcome.clone()
        }
    }
    fn cancel(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.outcome.is_some() || inner.cancelled {
                return;
            }
            inner.cancelled = true;
            self.input_acknowledged.notify_all();
            let pending = std::mem::take(&mut inner.approvals);
            for (id, _) in pending {
                let _ = Self::write(
                    &mut inner,
                    json!({"type":"extension_ui_response","id":id,"cancelled":true}),
                );
                self.emit(json!({"type":"runtime.permission_resolved","requestId":id,"optionId":null,"cancelled":true}));
            }
            // abort alone can continue queued messages; clear them first.
            let _ = Self::command(&mut inner, "clear_queue", json!({}));
            let _ = Self::command(&mut inner, "abort", json!({}));
        }
    }
    fn steer(&self, prompt: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Pi RPC lock unavailable")?;
        if !inner.initialized || inner.disconnected || inner.cancelled || inner.outcome.is_some() {
            return Err("Pi has no active run to steer".into());
        }
        let generation = inner.generation;
        let id = Self::submit(&mut inner, "steer", &mut json!({"message":prompt}))?;
        inner.input_acks.insert(id.clone(), None);
        let deadline = Instant::now() + INPUT_ACK_TIMEOUT;
        loop {
            if inner.disconnected || inner.cancelled || inner.generation != generation {
                inner.input_acks.remove(&id);
                return Err("Pi additional input was not confirmed before the connection stopped or changed".into());
            }
            if let Some(Some(result)) = inner.input_acks.get(&id) {
                let result = result.clone();
                inner.input_acks.remove(&id);
                return result;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                inner.input_acks.remove(&id);
                inner.disconnected = true;
                inner.hard_disconnect = true;
                inner.outcome = Some(Err("Pi did not acknowledge additional input within 5 seconds; its connection was closed without replaying that input".into()));
                return Err("Pi did not confirm acceptance of additional input; the connection was closed and the text was retained".into());
            }
            let (guard, _) = self
                .input_acknowledged
                .wait_timeout(inner, remaining)
                .map_err(|_| "Pi acknowledgement lock unavailable")?;
            inner = guard;
        }
    }
    fn respond(&self, token: &str, option: Option<&str>) -> Result<(), String> {
        if !matches!(option, None | Some("allow_once" | "reject_once")) {
            return Err("Unknown Pi confirmation option".into());
        }
        let mut inner = self.inner.lock().map_err(|_| "Pi RPC lock unavailable")?;
        if inner.cancelled || inner.outcome.is_some() {
            return Err("This Pi run is no longer active".into());
        }
        if !inner.approvals.contains_key(token) {
            return Err("Pi confirmation expired or was already answered".into());
        }
        Self::write(
            &mut inner,
            json!({"type":"extension_ui_response","id":token,"confirmed":option == Some("allow_once")}),
        )?;
        inner.approvals.remove(token);
        self.emit(
            json!({"type":"runtime.permission_resolved","requestId":token,"optionId":option}),
        );
        Ok(())
    }
    fn disconnected(&self) -> bool {
        self.inner.lock().map_or(true, |inner| inner.disconnected)
    }
    fn hard_disconnect(&self) -> bool {
        self.inner.lock().is_ok_and(|inner| inner.hard_disconnect)
    }
}

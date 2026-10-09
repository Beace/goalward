//! Kimi Code ACP transport. No file/terminal client capabilities are advertised:
//! Kimi executes its own tools and asks this client for approval in default mode.
use super::EventSink;
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
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const PROMPT_STAGE: u64 = 6;
const CLOSE_STAGE: u64 = 7;

struct Pending {
    rpc_id: Value,
    options: Vec<Value>,
}
struct Inner {
    input: ChildStdin,
    session: Option<String>,
    stage: u64,
    since: Instant,
    pending: HashMap<String, Pending>,
    outcome: Option<Result<(), String>>,
    cancelled: bool,
    config_options: Value,
    thinking_config: Option<(String, String)>,
    can_close: bool,
    auto_approve: bool,
}
pub(super) struct KimiSession {
    inner: Mutex<Inner>,
    sink: Arc<EventSink>,
    storage: Arc<crate::storage::Storage>,
}

impl KimiSession {
    pub(super) fn new(
        input: ChildStdin,
        sink: Arc<EventSink>,
        storage: Arc<crate::storage::Storage>,
    ) -> Arc<Self> {
        let auto_approve = sink
            .request
            .runtime
            .permissions
            .as_ref()
            .and_then(|p| p.kimi.as_ref())
            .is_none_or(|p| p.mode == "auto");
        Arc::new(Self {
            inner: Mutex::new(Inner {
                input,
                session: None,
                stage: 1,
                since: Instant::now(),
                pending: HashMap::new(),
                outcome: None,
                cancelled: false,
                config_options: Value::Null,
                thinking_config: None,
                can_close: false,
                auto_approve,
            }),
            sink,
            storage,
        })
    }
    fn write(inner: &mut Inner, value: Value) -> Result<(), String> {
        serde_json::to_writer(&mut inner.input, &value)
            .map_err(|_| "Cannot write Kimi ACP request")?;
        inner
            .input
            .write_all(b"\n")
            .and_then(|_| inner.input.flush())
            .map_err(|_| "Kimi ACP input disconnected".into())
    }
    fn request(inner: &mut Inner, id: u64, method: &str, params: Value) -> Result<(), String> {
        inner.stage = id;
        inner.since = Instant::now();
        Self::write(
            inner,
            json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}),
        )
    }
    fn emit(&self, value: Value) {
        // Keep the existing trace frame size contract (recovery has a 64 KiB
        // line bound), while frontend JSON projection reassembles split frames.
        let mut bytes = serde_json::to_vec(&value).unwrap_or_default();
        bytes.push(b'\n');
        let mut start = 0;
        while start < bytes.len() {
            let mut end = (start + 4096).min(bytes.len());
            while end < bytes.len() && (bytes[end] & 0xc0) == 0x80 {
                end -= 1;
            }
            self.sink.output("stdout", &bytes[start..end]);
            start = end;
        }
    }
    pub(super) fn begin(
        self: &Arc<Self>,
        output: impl Read + Send + 'static,
    ) -> thread::JoinHandle<()> {
        let session = self.clone();
        thread::spawn(move || {
            let initialize = session.inner.lock().map_err(|_| "Kimi ACP lock unavailable".to_string()).and_then(|mut inner| Self::request(&mut inner, 1, "initialize", json!({
                "protocolVersion":1, "clientInfo":{"name":"Goalward", "version":env!("CARGO_PKG_VERSION")}, "clientCapabilities":{}
            })));
            if let Err(error) = initialize {
                session.fail(error);
                return;
            }
            let mut reader = BufReader::new(output);
            loop {
                let mut frame = Vec::new();
                let result = reader
                    .by_ref()
                    .take(MAX_FRAME + 1)
                    .read_until(b'\n', &mut frame);
                match result {
                    Ok(0) => {
                        session.fail("Kimi ACP disconnected before completing the prompt".into());
                        break;
                    }
                    Ok(_) if frame.len() as u64 > MAX_FRAME => {
                        session.fail("Kimi ACP frame exceeds the 4 MiB limit".into());
                        break;
                    }
                    Ok(_) => match serde_json::from_slice::<Value>(&frame) {
                        Ok(value) => {
                            if let Err(error) = session.receive(value) {
                                session.fail(error);
                                break;
                            }
                        }
                        Err(_) => {
                            session.fail("Kimi emitted invalid ACP JSON; requires Kimi Code CLI with ACP protocol version 1".into());
                            break;
                        }
                    },
                    Err(_) => {
                        session.fail("Cannot read Kimi ACP output".into());
                        break;
                    }
                }
            }
        })
    }
    fn fail(&self, error: String) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.outcome.is_none() {
                inner.outcome = Some(Err(error));
            }
        }
    }
    pub(super) fn outcome(&self) -> Option<Result<(), String>> {
        let mut inner = self.inner.lock().ok()?;
        if inner.outcome.is_none()
            && inner.stage != PROMPT_STAGE
            && inner.since.elapsed() > STARTUP_TIMEOUT
        {
            inner.outcome = Some(Err("Kimi ACP initialization timed out; check the executable, login and model configuration".into()));
        }
        inner.outcome.clone()
    }
    pub(super) fn cancel(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.cancelled || inner.outcome.is_some() {
                return;
            }
            inner.cancelled = true;
            inner.pending.clear();
            if let Some(id) = &inner.session {
                let request =
                    json!({"jsonrpc":"2.0", "method":"session/cancel", "params":{"sessionId":id}});
                let _ = Self::write(&mut inner, request);
            }
        }
    }
    pub(super) fn respond(&self, token: &str, option: Option<&str>) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Kimi ACP lock unavailable")?;
        if inner.outcome.is_some() || inner.cancelled {
            return Err("This Kimi run is no longer active".into());
        }
        let pending = inner
            .pending
            .get(token)
            .ok_or("This permission request has expired or was already answered")?;
        if option.is_some_and(|value| {
            !pending
                .options
                .iter()
                .any(|candidate| candidate["optionId"] == value)
        }) {
            return Err("Permission option does not belong to this request".into());
        }
        let outcome = option
            .map(|value| json!({"outcome":"selected", "optionId":value}))
            .unwrap_or_else(|| json!({"outcome":"cancelled"}));
        let response = json!({"jsonrpc":"2.0", "id":pending.rpc_id, "result":{"outcome":outcome}});
        let remember = option.is_some_and(|id| {
            pending
                .options
                .iter()
                .any(|entry| entry["optionId"] == id && entry["kind"] == "allow_always")
        });
        if remember {
            self.save_session_approval(&inner)?;
        }
        Self::write(&mut inner, response)?;
        inner.pending.remove(token);
        if remember {
            inner.auto_approve = true;
        }
        self.emit(json!({"type":"kimi.permission_resolved", "requestId":token, "optionId":option, "sessionApproved":remember}));
        // A session grant also releases already queued requests, not just future ones.
        if remember {
            let approved: Vec<_> = inner
                .pending
                .iter()
                .filter_map(|(token, pending)| {
                    Self::allow_option(&pending.options)
                        .map(|id| (token.clone(), pending.rpc_id.clone(), id.to_owned()))
                })
                .collect();
            for (token, rpc_id, id) in approved {
                Self::write(
                    &mut inner,
                    json!({"jsonrpc":"2.0", "id":rpc_id, "result":{"outcome":{"outcome":"selected", "optionId":id}}}),
                )?;
                inner.pending.remove(&token);
                self.emit(json!({"type":"kimi.permission_resolved", "requestId":token, "optionId":id, "automatic":true}));
            }
        }
        Ok(())
    }
    fn allow_option(options: &[Value]) -> Option<&str> {
        ["allow_always", "allow_once"].iter().find_map(|kind| {
            options
                .iter()
                .find(|entry| entry["kind"] == *kind)
                .and_then(|entry| entry["optionId"].as_str())
        })
    }
    fn approval_path(&self, inner: &Inner) -> Result<std::path::PathBuf, String> {
        let session = inner.session.as_deref().ok_or("Kimi session missing")?;
        crate::storage::validate_id(session)?;
        Ok(self
            .storage
            .root
            .join("permissions")
            .join(&self.sink.request.task_id)
            .join(&self.sink.request.member_id)
            .join(format!("{session}.json")))
    }
    fn approval_identity(&self) -> Value {
        let request = &self.sink.request;
        json!({"runtimeId":request.runtime.id, "executable":request.runtime.executable, "args":request.runtime.args, "directory":request.directory})
    }
    fn save_session_approval(&self, inner: &Inner) -> Result<(), String> {
        let path = self.approval_path(inner)?;
        crate::storage::private_directory(path.parent().ok_or("Approval directory missing")?)?;
        let mut file = crate::storage::private_file(&path, false)?;
        serde_json::to_writer(&mut file, &self.approval_identity()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }
    fn session_approved(&self, inner: &Inner) -> Result<bool, String> {
        let path = self.approval_path(inner)?;
        match std::fs::read(path) {
            Ok(bytes) => Ok(
                serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())?
                    == self.approval_identity(),
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }
    fn prompt(&self, inner: &mut Inner) -> Result<(), String> {
        Self::request(
            inner,
            PROMPT_STAGE,
            "session/prompt",
            json!({"sessionId":inner.session, "prompt":[{"type":"text", "text":self.sink.request.prompt}]}),
        )
    }
    fn requested_effort(&self) -> Option<&str> {
        self.sink
            .request
            .reasoning_effort
            .as_deref()
            .filter(|value| *value != "inherit")
    }
    fn select_option<'a>(
        options: &'a Value,
        category: &str,
        fallback_id: &str,
    ) -> Result<&'a Value, String> {
        let mut matches = options
            .as_array()
            .ok_or("Kimi 未返回模型配置能力；无法确认思考强度，运行已停止")?
            .iter()
            .filter(|option| option["category"] == category || option["id"] == fallback_id);
        let option = matches
            .next()
            .ok_or("当前 Kimi 模型未提供思考强度选项；运行已停止")?;
        if matches.next().is_some() || option["type"] != "select" {
            return Err("Kimi 返回了无效或重复的模型配置选项；运行已停止".into());
        }
        Ok(option)
    }
    fn supports_value(option: &Value, value: &str) -> bool {
        option["options"].as_array().is_some_and(|options| {
            options.iter().any(|entry| {
                entry["value"] == value
                    || entry["options"]
                        .as_array()
                        .is_some_and(|group| group.iter().any(|entry| entry["value"] == value))
            })
        })
    }
    fn configure_thinking(&self, inner: &mut Inner) -> Result<(), String> {
        let Some(effort) = self.requested_effort() else {
            return self.prompt(inner);
        };
        let model = Self::select_option(&inner.config_options, "model", "model")?["currentValue"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or("Kimi 未确认当前模型；无法设置思考强度，运行已停止")?
            .to_owned();
        let thinking = Self::select_option(&inner.config_options, "thought_level", "thinking")?;
        if !Self::supports_value(thinking, effort) {
            return Err(format!("当前 Kimi 模型 {model} 不支持思考强度 {effort}；请重新检测模型或选择继承 Runtime 配置"));
        }
        let id = thinking["id"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .ok_or("Kimi 思考强度选项缺少有效 ID；运行已停止")?
            .to_owned();
        let params = json!({"sessionId":inner.session,"configId":id,"value":effort});
        inner.thinking_config = Some((id, model));
        Self::request(inner, 5, "session/set_config_option", params)
    }
    fn receive(&self, value: Value) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Kimi ACP lock unavailable")?;
        if inner.outcome.is_some() || inner.cancelled {
            return Ok(());
        }
        if let Some(method) = value["method"].as_str() {
            let params = &value["params"];
            match method {
                "session/update" => {
                    if params["sessionId"].as_str() != inner.session.as_deref() {
                        return Ok(());
                    }
                    let update = &params["update"];
                    // Ignore session/load's replay: earlier Runs already own it.
                    if inner.stage == 2 && self.sink.request.session_id.is_some() {
                        return Ok(());
                    }
                    if update["sessionUpdate"] == "config_option_update" {
                        inner.config_options = update["configOptions"].clone();
                    }
                    // Thought content is never persisted or forwarded as public output.
                    if update["sessionUpdate"] != "agent_thought_chunk" {
                        drop(inner);
                        self.emit(json!({"type":"kimi.acp.update", "update":update}));
                    }
                }
                "session/request_permission" => {
                    if value.get("id").is_none()
                        || params["sessionId"].as_str() != inner.session.as_deref()
                    {
                        return Err("Invalid Kimi permission request".into());
                    }
                    if inner.pending.len() >= 16 {
                        return Err("Too many pending Kimi approval requests".into());
                    }
                    let options = params["options"]
                        .as_array()
                        .ok_or("Kimi permission options missing")?;
                    if options.len() > 32 {
                        return Err("Kimi permission options exceed limit".into());
                    }
                    if inner
                        .pending
                        .values()
                        .any(|pending| pending.rpc_id == value["id"])
                    {
                        return Err("Duplicate Kimi permission request ID".into());
                    }
                    if options.iter().any(|option| {
                        !option["name"]
                            .as_str()
                            .is_some_and(|name| !name.is_empty() && name.len() <= 4096)
                    }) {
                        return Err("Kimi permission option has no readable label".into());
                    }
                    let ids: Vec<String> = options
                        .iter()
                        .filter_map(|option| option["optionId"].as_str().map(String::from))
                        .collect();
                    if ids.len() != options.len() || ids.is_empty() {
                        return Err("Invalid Kimi permission options".into());
                    }
                    let token = uuid::Uuid::new_v4().to_string();
                    if inner.auto_approve {
                        if let Some(option) = Self::allow_option(options) {
                            Self::write(
                                &mut inner,
                                json!({"jsonrpc":"2.0", "id":value["id"], "result":{"outcome":{"outcome":"selected", "optionId":option}}}),
                            )?;
                            self.emit(json!({"type":"kimi.permission_resolved", "requestId":token, "optionId":option, "automatic":true, "toolCall":params["toolCall"]}));
                            return Ok(());
                        }
                        // Never reinterpret reject/unknown options as an approval.
                    }
                    inner.pending.insert(
                        token.clone(),
                        Pending {
                            rpc_id: value["id"].clone(),
                            options: options.clone(),
                        },
                    );
                    drop(inner);
                    self.emit(json!({"type":"kimi.permission_requested", "requestId":token, "toolCall":params["toolCall"], "options":options}));
                }
                _ => {
                    if let Some(id) = value.get("id") {
                        Self::write(
                            &mut inner,
                            json!({"jsonrpc":"2.0", "id":id, "error":{"code":-32601,"message":"Client method not supported"}}),
                        )?;
                    }
                }
            }
            return Ok(());
        }
        let id = value["id"]
            .as_u64()
            .ok_or("Kimi ACP response has no request ID")?;
        if id != inner.stage {
            return Err("Kimi ACP response did not match the active request".into());
        }
        if let Some(error) = value.get("error") {
            let code = error["code"].as_i64().unwrap_or(0);
            // Error details remain useful without forwarding arbitrary auth metadata.
            let message: String = error["message"]
                .as_str()
                .unwrap_or("ACP request failed")
                .chars()
                .take(600)
                .collect();
            return Err(format!(
                "Kimi ACP error {code}: {message}. 请在终端完成 Kimi 登录与模型配置后重试。"
            ));
        }
        let result = value
            .get("result")
            .ok_or("Kimi ACP response has no result")?;
        match id {
            1 => {
                if result["protocolVersion"] != 1 || result["agentInfo"]["name"] != "Kimi Code CLI"
                {
                    return Err("Kimi adapter requires Kimi Code CLI (ACP version 1); legacy Python kimi-cli is not supported".into());
                }
                let resume = self.sink.request.session_id.as_ref();
                inner.can_close =
                    result["agentCapabilities"]["sessionCapabilities"]["close"].is_object();
                if resume.is_some() && result["agentCapabilities"]["loadSession"] != true {
                    return Err("当前 Kimi 不支持恢复会话；运行已停止，未新建空会话".into());
                }
                let mut params = json!({"cwd":self.sink.request.directory, "mcpServers":[]});
                if let Some(id) = resume {
                    inner.session = Some(id.clone());
                    params["sessionId"] = json!(id);
                }
                Self::request(
                    &mut inner,
                    2,
                    if resume.is_some() {
                        "session/load"
                    } else {
                        "session/new"
                    },
                    params,
                )?;
            }
            2 => {
                if let Some(expected) = &self.sink.request.session_id {
                    if result["sessionId"]
                        .as_str()
                        .is_some_and(|id| id != expected)
                    {
                        return Err("Kimi 返回的会话与请求恢复的会话不一致；未发送指令".into());
                    }
                }
                if self.sink.request.session_id.is_none() {
                    inner.session = Some(
                        result["sessionId"]
                            .as_str()
                            .filter(|id| !id.is_empty())
                            .ok_or("Kimi ACP session ID missing")?
                            .into(),
                    );
                }
                self.emit(json!({"type":"kimi.session", "sessionId":inner.session, "resumed":self.sink.request.session_id.is_some()}));
                inner.config_options = result["configOptions"].clone();
                inner.auto_approve = inner.auto_approve || self.session_approved(&inner)?;
                let modes = result["modes"]["availableModes"]
                    .as_array()
                    .ok_or("Kimi did not advertise approval modes")?;
                // Kimi ACP yolo is Never Ask; auto still asks for risky operations.
                // Older versions can use default with the client's approval broker.
                let mode = if inner.auto_approve && modes.iter().any(|mode| mode["id"] == "yolo") {
                    "yolo"
                } else {
                    "default"
                };
                if !modes.iter().any(|entry| entry["id"] == mode) {
                    return Err(
                        "Kimi does not advertise a supported approval mode; execution stopped"
                            .into(),
                    );
                }
                let params = json!({"sessionId":inner.session,"modeId":mode});
                Self::request(&mut inner, 3, "session/set_mode", params)?;
            }
            3 => {
                let request = &self.sink.request;
                let model = if request.model.trim().is_empty() {
                    request.runtime.default_model.trim()
                } else {
                    request.model.trim()
                };
                if model.is_empty() {
                    self.configure_thinking(&mut inner)?;
                } else {
                    let params =
                        json!({"sessionId":inner.session,"configId":"model","value":model});
                    Self::request(&mut inner, 4, "session/set_config_option", params)?;
                }
            }
            4 => {
                // A model switch can change both the available efforts and their
                // default. Never reuse session/new's previous-model snapshot.
                inner.config_options = result["configOptions"].clone();
                if self.requested_effort().is_some() {
                    let request = &self.sink.request;
                    let requested_model = if request.model.trim().is_empty() {
                        request.runtime.default_model.trim()
                    } else {
                        request.model.trim()
                    };
                    let model = Self::select_option(&inner.config_options, "model", "model")?;
                    if model["currentValue"] != requested_model {
                        return Err("Kimi 未确认所选模型；无法设置思考强度，运行已停止".into());
                    }
                }
                self.configure_thinking(&mut inner)?;
            }
            5 => {
                // Some CLI versions clamp unsupported effort to a default. A
                // successful RPC alone is insufficient proof of the user's value.
                inner.config_options = result["configOptions"].clone();
                let (id, model) = inner
                    .thinking_config
                    .as_ref()
                    .ok_or("Kimi 思考强度响应没有对应请求")?;
                let thinking =
                    Self::select_option(&inner.config_options, "thought_level", "thinking")?;
                let selected_model = Self::select_option(&inner.config_options, "model", "model")?;
                let effort = self.requested_effort().ok_or("Kimi 思考强度请求已失效")?;
                if thinking["id"] != id.as_str()
                    || thinking["currentValue"] != effort
                    || !Self::supports_value(thinking, effort)
                    || selected_model["currentValue"] != model.as_str()
                {
                    return Err(format!(
                        "Kimi 未确认思考强度 {effort} 已生效；运行已停止，未发送提示词"
                    ));
                }
                self.prompt(&mut inner)?;
            }
            PROMPT_STAGE => {
                inner.pending.clear();
                let outcome = match result["stopReason"].as_str() {
                    Some("end_turn") => Ok(()),
                    Some(reason) => Err(format!("Kimi prompt ended without completion: {reason}")),
                    None => Err("Kimi prompt response is missing its stop reason".into()),
                };
                if outcome.is_ok() && inner.can_close {
                    // Let the CLI finish persistence/dispose before terminating
                    // its process. Killing immediately after end_turn can race
                    // its session writer and leave the next load empty.
                    let params = json!({"sessionId":inner.session});
                    Self::request(&mut inner, CLOSE_STAGE, "session/close", params)?;
                } else {
                    inner.outcome = Some(outcome);
                }
                drop(inner);
                self.emit(
                    json!({"type":"kimi.prompt_completed", "stopReason":result["stopReason"]}),
                );
            }
            CLOSE_STAGE => {
                inner.outcome = Some(Ok(()));
            }
            _ => return Err("Unsupported Kimi ACP response".into()),
        }
        Ok(())
    }
}

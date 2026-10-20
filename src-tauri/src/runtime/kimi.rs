//! Kimi Code ACP transport. No file/terminal client capabilities are advertised:
//! Kimi executes its own tools and asks this client for approval in default mode.
use super::{EventSink, NativeSession, RoutedSink};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    process::ChildStdin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_FRAME: u64 = 4 * 1024 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const PROMPT_STAGE: u64 = 6;

struct Pending {
    rpc_id: Value,
    options: Vec<Value>,
}
struct Inner {
    input: ChildStdin,
    session: Option<String>,
    stage: u64,
    request_id: u64,
    next_id: u64,
    since: Instant,
    pending: HashMap<String, Pending>,
    outcome: Option<Result<(), String>>,
    cancelled: bool,
    config_options: Value,
    thinking_config: Option<(String, String)>,

    auto_approve: bool,
    can_close: bool,
    closing_id: Option<u64>,
    closed: bool,
}
pub(super) struct KimiSession {
    inner: Mutex<Inner>,
    sink: RoutedSink,
    disconnected: AtomicBool,
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
                request_id: 0,
                next_id: 1,
                since: Instant::now(),
                pending: HashMap::new(),
                outcome: None,
                cancelled: false,
                config_options: Value::Null,
                thinking_config: None,

                auto_approve,
                can_close: false,
                closing_id: None,
                closed: false,
            }),
            sink: RoutedSink::new(sink),
            disconnected: AtomicBool::new(false),
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
        let rpc_id = inner.next_id.max(id);
        inner.next_id = rpc_id + 1;
        inner.request_id = rpc_id;
        Self::write(
            inner,
            json!({"jsonrpc":"2.0", "id":rpc_id, "method":method, "params":params}),
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
            self.sink.current().output("stdout", &bytes[start..end]);
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
        self.disconnected.store(true, Ordering::SeqCst);
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
            self.disconnected.store(true, Ordering::SeqCst);
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
            let pending: Vec<Value> = inner.pending.values().map(|p| p.rpc_id.clone()).collect();
            for id in pending {
                let _ = Self::write(
                    &mut inner,
                    json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}}),
                );
            }
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
        self.emit(json!({"type":"runtime.permission_resolved", "requestId":token, "optionId":option, "sessionApproved":remember}));
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
                self.emit(json!({"type":"runtime.permission_resolved", "requestId":token, "optionId":id, "automatic":true}));
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
            .join(&self.sink.current().request.task_id)
            .join(&self.sink.current().request.member_id)
            .join(format!("{session}.json")))
    }
    fn approval_identity(&self) -> Value {
        let sink = self.sink.current();
        let request = &sink.request;
        json!({"runtimeId":request.runtime.id, "executable":request.runtime.executable, "args":request.runtime.args, "directory":request.directory,"additionalDirectories":request.additional_directories})
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
            json!({"sessionId":inner.session, "prompt":[{"type":"text", "text":self.sink.current().request.prompt}]}),
        )
    }
    fn requested_effort(&self) -> Option<String> {
        self.sink
            .current()
            .request
            .reasoning_effort
            .as_deref()
            .filter(|value| *value != "inherit")
            .map(String::from)
    }
    fn select_option<'a>(
        options: &'a Value,
        category: &str,
        fallback_id: &str,
    ) -> Result<&'a Value, String> {
        let mut matches = options
            .as_array()
            .ok_or("Kimi did not return model configuration capabilities. Reasoning effort could not be confirmed, and the run was stopped.")?
            .iter()
            .filter(|option| option["category"] == category || option["id"] == fallback_id);
        let option = matches
            .next()
            .ok_or("The current Kimi model does not provide reasoning effort options. The run was stopped.")?;
        if matches.next().is_some() || option["type"] != "select" {
            return Err("Kimi returned invalid or duplicate model configuration options. The run was stopped.".into());
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
            .ok_or("Kimi did not confirm the current model. Reasoning effort could not be set, and the run was stopped.")?
            .to_owned();
        let thinking = Self::select_option(&inner.config_options, "thought_level", "thinking")?;
        if !Self::supports_value(thinking, &effort) {
            return Err(format!("The current Kimi model {model} does not support reasoning effort {effort}. Detect models again or inherit runtime settings."));
        }
        let id = thinking["id"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .ok_or("The Kimi reasoning effort option is missing a valid ID. The run was stopped.")?
            .to_owned();
        let params = json!({"sessionId":inner.session,"configId":id,"value":effort});
        inner.thinking_config = Some((id, model));
        Self::request(inner, 5, "session/set_config_option", params)
    }
    fn receive(&self, value: Value) -> Result<(), String> {
        let sink = self.sink.current();
        let mut inner = self.inner.lock().map_err(|_| "Kimi ACP lock unavailable")?;
        if inner.closing_id.is_some() && value["id"].as_u64() == inner.closing_id {
            inner.closed = true;
            return Ok(());
        }
        if inner.outcome.is_some() {
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
                    if inner.stage == 2 && sink.request.session_id.is_some() {
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
                            self.emit(json!({"type":"runtime.permission_resolved", "requestId":token, "optionId":option, "automatic":true, "toolCall":params["toolCall"]}));
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
                    self.emit(json!({"type":"runtime.permission_requested", "requestId":token, "toolCall":params["toolCall"], "options":options}));
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
        if id != inner.request_id {
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
                "Kimi ACP error {code}: {message}. Complete Kimi login and model configuration in the terminal, then try again."
            ));
        }
        if inner.cancelled && inner.stage != PROMPT_STAGE {
            return Err("Kimi prompt interrupted before submission".into());
        }
        let result = value
            .get("result")
            .ok_or("Kimi ACP response has no result")?;
        match inner.stage {
            1 => {
                if result["protocolVersion"] != 1 || result["agentInfo"]["name"] != "Kimi Code CLI"
                {
                    return Err("Kimi adapter requires Kimi Code CLI (ACP version 1); legacy Python kimi-cli is not supported".into());
                }
                inner.can_close =
                    result["agentCapabilities"]["sessionCapabilities"]["close"].is_object();
                let resume = sink.request.session_id.as_ref();

                if resume.is_some() && result["agentCapabilities"]["loadSession"] != true {
                    return Err("This Kimi version does not support resuming sessions. The run was stopped without creating an empty session.".into());
                }
                let mut params = json!({"cwd":sink.request.directory, "mcpServers":[]});
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
                if let Some(expected) = &sink.request.session_id {
                    if result["sessionId"]
                        .as_str()
                        .is_some_and(|id| id != expected)
                    {
                        return Err("The session returned by Kimi does not match the requested session. No instruction was sent.".into());
                    }
                }
                if sink.request.session_id.is_none() {
                    inner.session = Some(
                        result["sessionId"]
                            .as_str()
                            .filter(|id| !id.is_empty())
                            .ok_or("Kimi ACP session ID missing")?
                            .into(),
                    );
                }
                self.emit(json!({"type":"kimi.session", "sessionId":inner.session, "resumed":sink.request.session_id.is_some()}));
                self.emit(json!({"type":"runtime.capabilities","steer":false,"followUp":false,"approvals":true}));
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
                let sink = self.sink.current();
                let request = &sink.request;
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
                    let sink = self.sink.current();
                    let request = &sink.request;
                    let requested_model = if request.model.trim().is_empty() {
                        request.runtime.default_model.trim()
                    } else {
                        request.model.trim()
                    };
                    let model = Self::select_option(&inner.config_options, "model", "model")?;
                    if model["currentValue"] != requested_model {
                        return Err("Kimi did not confirm the selected model. Reasoning effort could not be set, and the run was stopped.".into());
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
                    .ok_or("The Kimi reasoning effort response has no matching request.")?;
                let thinking =
                    Self::select_option(&inner.config_options, "thought_level", "thinking")?;
                let selected_model = Self::select_option(&inner.config_options, "model", "model")?;
                let effort = self
                    .requested_effort()
                    .ok_or("The Kimi reasoning effort request is no longer valid.")?;
                if thinking["id"] != id.as_str()
                    || thinking["currentValue"] != effort
                    || !Self::supports_value(thinking, &effort)
                    || selected_model["currentValue"] != model.as_str()
                {
                    return Err(format!(
                        "Kimi did not confirm that reasoning effort {effort} took effect. The run was stopped without sending the prompt."
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
                inner.outcome = Some(outcome);
                // Keep the turn lock until its final public event is routed;
                // the manager cannot bind the next Run ahead of this frame.
                self.emit(
                    json!({"type":"kimi.prompt_completed", "stopReason":result["stopReason"]}),
                );
            }
            _ => return Err("Unsupported Kimi ACP response".into()),
        }
        Ok(())
    }
}

impl NativeSession for KimiSession {
    fn start_turn(&self, sink: Arc<EventSink>) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Kimi state unavailable")?;
        if self.disconnected.load(Ordering::SeqCst) {
            return Err("Kimi connection disconnected; turn was not replayed".into());
        }
        if inner.outcome.is_none() {
            return Err("Kimi already has an active prompt".into());
        }
        let session = inner.session.clone().ok_or("Kimi session unavailable")?;
        if sink
            .request
            .session_id
            .as_deref()
            .is_some_and(|expected| expected != session)
        {
            return Err("Requested Kimi session differs from the live connection".into());
        }
        self.sink.replace(sink);
        inner.outcome = None;
        inner.cancelled = false;
        inner.pending.clear();
        self.emit(json!({"type":"kimi.session","sessionId":session,"resumed":true}));
        self.emit(
            json!({"type":"runtime.capabilities","steer":false,"followUp":false,"approvals":true}),
        );
        self.prompt(&mut inner)
    }
    fn outcome(&self) -> Option<Result<(), String>> {
        KimiSession::outcome(self)
    }
    fn cancel(&self) {
        KimiSession::cancel(self)
    }
    fn respond(&self, token: &str, option: Option<&str>) -> Result<(), String> {
        KimiSession::respond(self, token, option)
    }
    fn disconnected(&self) -> bool {
        self.disconnected.load(Ordering::SeqCst)
    }
    fn close(&self) {
        self.cancel();
        if let Ok(mut inner) = self.inner.lock() {
            if inner.outcome.is_some()
                && inner.can_close
                && inner.closing_id.is_none()
                && !self.disconnected.load(Ordering::SeqCst)
            {
                let id = inner.next_id;
                inner.next_id += 1;
                inner.closing_id = Some(id);
                let session = inner.session.clone();
                if Self::write(&mut inner,json!({"jsonrpc":"2.0","id":id,"method":"session/close","params":{"sessionId":session}})).is_err() {inner.closed=true;}
            }
        }
    }
    fn ready_to_close(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.closing_id.is_none() || inner.closed)
            .unwrap_or(true)
    }
    fn steer(&self, _: &str) -> Result<(), String> {
        Err("Kimi ACP v1 does not support appending input to an active prompt; stop or wait for this turn".into())
    }
}

//! Codex native thread/turn transport, with a restricted goal-assistant scope.
//! The app-server is
//! persistent, so process exit is not a successful turn: only the correlated
//! `turn/completed` notification can mark this execution completed.
use super::{EventSink, NativeSession, RoutedSink};
use crate::{reasoning, types::StartRequest};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader, Read, Write},
    process::ChildStdin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

const MAX_FRAME: u64 = 4 * 1024 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

fn native_arguments(request: &StartRequest) -> Result<(Vec<String>, Vec<String>), String> {
    let mut global = Vec::new();
    let mut native = Vec::new();
    let mut index = 0;
    while index < request.runtime.args.len() {
        let arg = &request.runtime.args[index];
        if arg.contains("{prompt}") || arg.contains('\0') || arg.len() > 4096 {
            return Err("Native Codex sessions cannot insert messages into launch arguments. Remove {prompt} or invalid arguments.".into());
        }
        let (flag, inline) = if let Some(value) = arg
            .strip_prefix("-c")
            .filter(|v| !v.is_empty() && !arg.starts_with("--"))
        {
            ("-c", Some(value.strip_prefix('=').unwrap_or(value)))
        } else if let Some((flag, value)) = arg.split_once('=') {
            (flag, Some(value))
        } else {
            (arg.as_str(), None)
        };
        if flag == "--strict-config" && inline.is_none() {
            native.push(arg.clone());
            index += 1;
            continue;
        }
        if !matches!(
            flag,
            "-c" | "--config" | "--enable" | "--disable" | "-p" | "--profile"
        ) {
            return Err(format!("Codex app-server does not support launch argument {flag}. Supported arguments are -c/--config, --enable/--disable, --strict-config, and --profile; messages, sessions, directories, and permissions are managed by the app."));
        }
        let value = if let Some(value) = inline {
            value
        } else {
            index += 1;
            request
                .runtime
                .args
                .get(index)
                .map(String::as_str)
                .ok_or_else(|| format!("Codex argument {flag} is missing a value."))?
        };
        if value.is_empty()
            || value.starts_with('-')
            || value.contains('\0')
            || value.contains("{prompt}")
            || value.len() > 4096
        {
            return Err(format!("Codex argument {flag} has an invalid value."));
        }
        let value = super::expand_template(
            value,
            "",
            if request.model.trim().is_empty() {
                request.runtime.default_model.trim()
            } else {
                request.model.trim()
            },
        );
        if matches!(flag, "-c" | "--config") {
            let (key, _) = value
                .split_once('=')
                .ok_or("Codex --config requires key=value format.")?;
            let root = key
                .trim()
                .split('.')
                .next()
                .unwrap_or("")
                .trim()
                .trim_matches(['\'', '"'])
                .trim();
            if matches!(
                root,
                "sandbox"
                    | "sandbox_mode"
                    | "sandbox_read_only"
                    | "sandbox_workspace_write"
                    | "sandbox_permissions"
                    | "approval_policy"
                    | "approvals_reviewer"
                    | "permissions"
                    | "default_permissions"
                    | "permission_profile"
                    | "profile"
                    | "profiles"
                    | "projects"
                    | "cwd"
                    | "forced_auto_mode"
                    | "experimental_use_profile"
            ) {
                return Err(format!(
                    "Codex configuration {root} conflicts with task permissions or session scope. Configure it through runtime permission settings."
                ));
            }
            if request
                .reasoning_effort
                .as_deref()
                .is_some_and(|e| e != "inherit")
                && matches!(root, "model" | "model_reasoning_effort")
            {
                return Err(
                    "Codex model or reasoning effort configuration conflicts with the current turn selection. Use the app model and reasoning effort settings."
                        .into(),
                );
            }
            native.extend(["-c".into(), value]);
        } else if matches!(flag, "-p" | "--profile") {
            // Profile is a top-level Codex option, not an app-server subcommand
            // option. Place it before `app-server` rather than dropping it.
            global.extend(["--profile".into(), value]);
        } else {
            native.extend([flag.into(), value]);
        }
        index += 1;
    }
    Ok((global, native))
}

pub(super) fn arguments(request: &StartRequest) -> Result<Vec<String>, String> {
    if request.runtime.adapter != "codex" {
        return Err("Codex app-server requires the Codex adapter".into());
    }
    if request.runtime.args.len() > 128 {
        return Err("Codex launch arguments allow at most 128 entries.".into());
    }
    if request.codex_streaming && !request.runtime.args.is_empty() {
        return Err("Goal assistant Codex sessions do not allow custom launch arguments.".into());
    }
    let (mut args, native_args) = native_arguments(request)?;
    let config = request
        .runtime
        .permissions
        .as_ref()
        .and_then(|p| p.codex.as_ref());
    if request.codex_streaming
        && config.is_none_or(|p| {
            p.sandbox != "read-only"
                || p.network != "inherit"
                || !p.additional_directories.is_empty()
        })
    {
        return Err("Goal assistant Codex sessions require read-only permissions.".into());
    }
    crate::permission::arguments(&request.runtime, &[])?;
    reasoning::arguments("codex", request.reasoning_effort.as_deref(), &[])?;
    args.extend(["app-server".into(), "--listen".into(), "stdio://".into()]);
    args.extend(native_args);
    if request.codex_streaming {
        args.extend([
            "-c".into(),
            "sandbox_mode=\"read-only\"".into(),
            "-c".into(),
            "approval_policy=\"never\"".into(),
        ]);
    }
    Ok(args)
}

fn policy(request: &StartRequest) -> (Option<String>, Option<Value>, Option<&'static str>) {
    if request.codex_streaming {
        return (
            Some("read-only".into()),
            Some(json!({"type":"readOnly","networkAccess":false})),
            Some("never"),
        );
    }
    let config = request
        .runtime
        .permissions
        .as_ref()
        .and_then(|p| p.codex.as_ref());
    match config.map(|c| c.sandbox.as_str()) {
        None if native_arguments(request).is_ok_and(|(global, native)| {
            !global.is_empty()
                || native.windows(2).any(|pair| {
                    matches!(pair[0].as_str(), "--enable" | "--disable")
                        || (pair[0] == "-c"
                            && pair[1]
                                .split('=')
                                .next()
                                .unwrap_or("")
                                .trim()
                                .split('.')
                                .next()
                                .unwrap_or("")
                                .trim()
                                .trim_matches(['\'', '"'])
                                == "features")
                })
        }) =>
        {
            (None, None, None)
        }
        None | Some("danger-full-access") => (
            Some("danger-full-access".into()),
            Some(json!({"type":"dangerFullAccess"})),
            Some("never"),
        ),
        Some("read-only") => (
            Some("read-only".into()),
            Some(json!({"type":"readOnly","networkAccess":false})),
            Some("on-request"),
        ),
        Some("workspace-write") => {
            let mut roots = vec![request.directory.clone()];
            roots.extend(request.additional_directories.clone());
            let c = config.unwrap();
            roots.extend(c.additional_directories.clone());
            roots.sort();
            roots.dedup();
            (
                Some("workspace-write".into()),
                Some(
                    json!({"type":"workspaceWrite","writableRoots":roots,"networkAccess":c.network == "allow"}),
                ),
                Some("on-request"),
            )
        }
        _ => (None, None, None),
    }
}

struct SteerReply {
    turn: String,
    prompt: String,
    result: Option<Result<(), String>>,
}

struct Inner {
    input: ChildStdin,
    stage: u64,
    request_id: u64,
    next_id: u64,
    controls: HashSet<u64>,
    steering: HashMap<u64, SteerReply>,
    completed_turns: HashSet<String>,
    pending: HashMap<String, (Value, String, Value)>,
    since: Instant,
    session: Option<String>,
    turn: Option<String>,
    messages: HashMap<String, String>,
    thread_metadata: Option<Value>,
    effective_sandbox: Option<Value>,
    outcome: Option<Result<(), String>>,
    cancelled: bool,
}

pub(super) struct CodexSession {
    inner: Mutex<Inner>,
    sink: RoutedSink,
    disconnected: AtomicBool,
    changed: Condvar,
}

impl CodexSession {
    pub(super) fn new(input: ChildStdin, sink: Arc<EventSink>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                input,
                stage: 1,
                request_id: 0,
                next_id: 1,
                controls: HashSet::new(),
                steering: HashMap::new(),
                completed_turns: HashSet::new(),
                pending: HashMap::new(),
                since: Instant::now(),
                session: None,
                turn: None,
                messages: HashMap::new(),
                thread_metadata: None,
                effective_sandbox: None,
                outcome: None,
                cancelled: false,
            }),
            sink: RoutedSink::new(sink),
            disconnected: AtomicBool::new(false),
            changed: Condvar::new(),
        })
    }
    fn write(inner: &mut Inner, value: Value) -> Result<(), String> {
        serde_json::to_writer(&mut inner.input, &value)
            .map_err(|_| "Cannot write Codex app-server request")?;
        inner
            .input
            .write_all(b"\n")
            .and_then(|_| inner.input.flush())
            .map_err(|_| "Codex app-server input disconnected".into())
    }
    fn request(inner: &mut Inner, id: u64, method: &str, params: Value) -> Result<(), String> {
        inner.stage = id;
        inner.since = Instant::now();
        let rpc_id = inner.next_id;
        inner.next_id += 1;
        inner.request_id = rpc_id;
        Self::write(inner, json!({"id":rpc_id,"method":method,"params":params}))
    }
    fn emit(&self, value: Value) {
        // Match the existing 4 KiB trace chunk contract. The frontend retains
        // incomplete JSONL records and combines them before projecting output.
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
            let initialize = session
                .inner
                .lock()
                .map_err(|_| "Codex app-server lock unavailable".to_string())
                .and_then(|mut inner| {
                    Self::request(
                        &mut inner,
                        1,
                        "initialize",
                        json!({
                            "clientInfo":{"name":"goalward","version":env!("CARGO_PKG_VERSION")}
                        }),
                    )
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
                        session.fail(
                            "Codex app-server disconnected before completing the turn".into(),
                        );
                        break;
                    }
                    Ok(_) if frame.len() as u64 > MAX_FRAME => {
                        session.fail("Codex app-server frame exceeds the 4 MiB limit".into());
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
                            session.fail("Codex emitted invalid app-server JSON; update Codex to a compatible app-server version".into());
                            break;
                        }
                    },
                    Err(_) => {
                        session.fail("Cannot read Codex app-server output".into());
                        break;
                    }
                }
            }
        })
    }
    fn reject_steering(&self, inner: &mut Inner, error: &str) {
        for reply in inner.steering.values_mut() {
            if reply.result.is_none() {
                reply.result = Some(Err(error.into()));
            }
        }
        self.changed.notify_all();
    }
    fn fail(&self, error: String) {
        self.disconnected.store(true, Ordering::SeqCst);
        if let Ok(mut inner) = self.inner.lock() {
            self.reject_steering(&mut inner, &error);
            if inner.outcome.is_none() {
                inner.outcome = Some(Err(error));
            }
        }
    }
    pub(super) fn outcome(&self) -> Option<Result<(), String>> {
        let mut inner = self.inner.lock().ok()?;
        if inner.outcome.is_none()
            && inner.turn.is_none()
            && inner.since.elapsed() > STARTUP_TIMEOUT
        {
            self.disconnected.store(true, Ordering::SeqCst);
            inner.outcome = Some(Err("Codex app-server initialization timed out; check the executable, login and model configuration".into()));
        }
        inner.outcome.clone()
    }
    pub(super) fn cancel(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.cancelled || inner.outcome.is_some() {
                return;
            }
            inner.cancelled = true;
            self.reject_steering(
                &mut inner,
                "Codex turn was interrupted before additional input was acknowledged",
            );
            let pending: Vec<_> = inner.pending.values().cloned().collect();
            for (id, method, _) in pending {
                let result = if method == "item/permissions/requestApproval" {
                    json!({"permissions":{},"scope":"turn"})
                } else {
                    json!({"decision":"decline"})
                };
                let _ = Self::write(&mut inner, json!({"id":id,"result":result}));
            }
            inner.pending.clear();
            if let (Some(session), Some(turn)) = (&inner.session, &inner.turn) {
                let session = session.clone();
                let turn = turn.clone();
                let id = inner.next_id;
                inner.next_id += 1;
                inner.controls.insert(id);
                let value = json!({"id":id,"method":"turn/interrupt","params":{"threadId":session,"turnId":turn}});
                let _ = Self::write(&mut inner, value);
            }
        }
    }
    fn model(&self) -> Option<String> {
        let sink = self.sink.current();
        let model = if sink.request.model.trim().is_empty() {
            sink.request.runtime.default_model.trim()
        } else {
            sink.request.model.trim()
        };
        (!model.is_empty()).then(|| model.to_owned())
    }
    fn turn_params(&self, session: &str, inherited: Option<&Value>) -> Value {
        let sink = self.sink.current();
        let (_, mut sandbox, approval) = policy(&sink.request);
        if let Some(inherited) = inherited {
            if sandbox.is_none() {
                sandbox = Some(inherited.clone());
            }
            if let Some(sandbox) = sandbox
                .as_mut()
                .filter(|sandbox| sandbox["type"] == "workspaceWrite")
            {
                let config = sink
                    .request
                    .runtime
                    .permissions
                    .as_ref()
                    .and_then(|p| p.codex.as_ref());
                if config.is_none_or(|p| p.network == "inherit") {
                    if let Some(network) = inherited["networkAccess"].as_bool() {
                        sandbox["networkAccess"] = network.into();
                    }
                }
                let mut roots: Vec<String> = sandbox["writableRoots"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect();
                roots.extend(
                    inherited["writableRoots"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(String::from),
                );
                roots.extend(sink.request.additional_directories.clone());
                roots.sort();
                roots.dedup();
                sandbox["writableRoots"] = json!(roots);
            }
        }
        json!({"threadId":session,"input":[{"type":"text","text":sink.request.prompt,"text_elements":[]}],
            "cwd":sink.request.directory,"model":self.model(),"approvalPolicy":approval,"sandboxPolicy":sandbox,
            "effort":sink.request.reasoning_effort.as_deref().filter(|e| *e != "inherit")})
    }
    fn same_turn(inner: &mut Inner, params: &Value, turn: Option<&str>) -> bool {
        if inner.stage < 3 || params["threadId"].as_str() != inner.session.as_deref() {
            return false;
        }
        let Some(turn) = turn.filter(|value| !value.is_empty()) else {
            return false;
        };
        if inner.completed_turns.contains(turn) {
            return false;
        }
        if let Some(active) = &inner.turn {
            active == turn
        } else {
            inner.turn = Some(turn.to_owned());
            true
        }
    }
    fn current_turn(inner: &Inner, params: &Value) -> bool {
        inner.stage >= 3
            && inner.session.is_some()
            && inner.turn.is_some()
            && params["threadId"].as_str() == inner.session.as_deref()
            && params["turnId"].as_str() == inner.turn.as_deref()
    }
    fn public_reasoning(item: &Value) -> Value {
        let summary = item["summary"]
            .as_array()
            .map(|entries| entries.iter().filter_map(Value::as_str).collect::<Vec<_>>())
            .unwrap_or_default();
        // Reasoning content is not a public summary. Never persist raw thought
        // text through item snapshots or turn lifecycle notifications either.
        json!({"type":"reasoning","id":item["id"].as_str(),"summary":summary})
    }
    fn public_token_usage(usage: &Value) -> Option<Value> {
        if !usage.is_object() {
            return None;
        }
        let mut result = serde_json::Map::new();
        for scope in ["total", "last"] {
            if !usage[scope].is_object() {
                continue;
            }
            let mut counts = serde_json::Map::new();
            for field in [
                "totalTokens",
                "inputTokens",
                "cachedInputTokens",
                "cacheWriteInputTokens",
                "outputTokens",
                "reasoningOutputTokens",
            ] {
                if let Some(count) = usage[scope][field].as_u64() {
                    counts.insert(field.into(), count.into());
                }
            }
            result.insert(scope.into(), counts.into());
        }
        if let Some(window) = usage["modelContextWindow"].as_u64() {
            result.insert("modelContextWindow".into(), window.into());
        } else if usage["modelContextWindow"].is_null() {
            result.insert("modelContextWindow".into(), Value::Null);
        }
        Some(result.into())
    }
    fn emit_turn_started(&self, params: &Value) {
        let source = &params["turn"];
        let items = source["items"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| {
                        if item["type"] == "reasoning" {
                            Self::public_reasoning(item)
                        } else {
                            item.clone()
                        }
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        // Keep the public protocol envelope and fields. Do not forward future
        // configuration or authentication fields attached to a turn response.
        let turn = json!({
            "id":source["id"].as_str(), "status":source["status"].as_str(), "items":items,
            "startedAt":source["startedAt"].as_u64(), "completedAt":source["completedAt"].as_u64(),
            "durationMs":source["durationMs"].as_u64(),
        });
        self.emit(
            json!({"method":"turn/started","params":{"threadId":params["threadId"],"turn":turn}}),
        );
    }
    fn receive(&self, value: Value) -> Result<(), String> {
        let sink = self.sink.current();
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Codex app-server lock unavailable")?;
        if let Some(id) = value["id"].as_u64() {
            if let Some(reply) = inner.steering.get_mut(&id) {
                let outcome = if !value["error"].is_null() {
                    Err(format!(
                        "Codex rejected the additional message: {}",
                        value["error"]["message"]
                            .as_str()
                            .unwrap_or("turn/steer rejected")
                            .chars()
                            .take(600)
                            .collect::<String>()
                    ))
                } else if value["result"]["turnId"].as_str() != Some(reply.turn.as_str()) {
                    Err("Codex additional-message acknowledgement did not match the current turn ID. The input was retained.".into())
                } else {
                    Ok(())
                };
                if reply.result.is_none() {
                    if outcome.is_ok() {
                        self.emit(json!({"type":"runtime.input_accepted","mode":"steer","text":reply.prompt}));
                    }
                    reply.result = Some(outcome);
                    self.changed.notify_all();
                }
                return Ok(());
            }
            if inner.controls.remove(&id) {
                if !value["error"].is_null() {
                    self.emit(json!({"type":"runtime.control_failed","message":value["error"]["message"]}));
                }
                return Ok(());
            }
        }
        if inner.outcome.is_some() {
            return Ok(());
        }
        if let Some(method) = value["method"].as_str() {
            if !value["id"].is_null() {
                let supported = matches!(
                    method,
                    "item/commandExecution/requestApproval"
                        | "item/fileChange/requestApproval"
                        | "item/permissions/requestApproval"
                );
                let correlated = value["params"]["threadId"].as_str() == inner.session.as_deref()
                    && value["params"]["turnId"].as_str() == inner.turn.as_deref();
                if supported && !sink.request.codex_streaming && correlated {
                    if inner.pending.len() >= 16 {
                        return Err("Too many pending Codex approvals".into());
                    }
                    let token = uuid::Uuid::new_v4().to_string();
                    inner.pending.insert(
                        token.clone(),
                        (
                            value["id"].clone(),
                            method.to_owned(),
                            value["params"]["permissions"].clone(),
                        ),
                    );
                    self.emit(json!({"type":"runtime.permission_requested","requestId":token,"toolCall":{"title":value["params"]["command"].as_str().or(value["params"]["reason"].as_str()).unwrap_or("Codex tool permission"),"kind":method,"rawInput":value["params"]},
                        "options":[{"optionId":"accept","name":"Allow this time","kind":"allow_once"},{"optionId":"decline","name":"Deny","kind":"reject_once"}]}));
                    return Ok(());
                }
                let result = match method {
                    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                        Some(json!({"decision":"decline"}))
                    }
                    "item/permissions/requestApproval" => {
                        Some(json!({"permissions":{},"scope":"turn"}))
                    }
                    _ => None,
                };
                let response = if let Some(result) = result {
                    json!({"id":value["id"],"result":result})
                } else {
                    json!({"id":value["id"],"error":{"code":-32601,"message":"Goalward does not provide this client capability"}})
                };
                Self::write(&mut inner, response)?;
                self.emit(json!({"type":"codex.app_server.request_rejected","method":method}));
                return Err(format!("Codex requested an unavailable client capability: {method}"));
            }
            let params = &value["params"];
            match method {
                "turn/started" | "turn/completed" => {
                    if !Self::same_turn(&mut inner, params, params["turn"]["id"].as_str()) {
                        return Ok(());
                    }
                    if method == "turn/started" {
                        self.emit_turn_started(params);
                    } else {
                        let turn = &params["turn"];
                        // The completed item is authoritative, even if a server
                        // coalesced or omitted some deltas at the end.
                        if let Some(items) = turn["items"].as_array() {
                            for item in items {
                                self.item(&mut inner, item, "item.completed")?;
                            }
                        }
                        self.emit(json!({"type":"codex.app_server.turn_completed","threadId":params["threadId"],"turnId":turn["id"],"status":turn["status"],"error":turn["error"]}));
                        inner.pending.clear();
                        self.reject_steering(
                            &mut inner,
                            "Codex turn completed before additional input was acknowledged",
                        );
                        if let Some(id) = inner.turn.clone() {
                            inner.completed_turns.insert(id);
                        }
                        inner.outcome = Some(if turn["status"] == "completed" {
                            Ok(())
                        } else {
                            Err(format!(
                                "Codex turn {}: {}",
                                turn["status"].as_str().unwrap_or("unknown"),
                                turn["error"]["message"]
                                    .as_str()
                                    .unwrap_or("turn did not complete")
                            ))
                        });
                    }
                }
                "item/agentMessage/delta" => {
                    if !Self::same_turn(&mut inner, params, params["turnId"].as_str()) {
                        return Ok(());
                    }
                    let id = params["itemId"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .ok_or("Codex message delta has no item ID")?;
                    let delta = params["delta"]
                        .as_str()
                        .ok_or("Codex message delta has no text")?;
                    let text = inner.messages.entry(id.to_owned()).or_default();
                    text.push_str(delta);
                    // Persist the actual delta once. Cumulative snapshots on
                    // every token make trace storage and IPC quadratic in the
                    // answer length; the frontend appends by this item ID.
                    self.emit(value.clone());
                }
                "item/started" | "item/completed" => {
                    if !Self::same_turn(&mut inner, params, params["turnId"].as_str()) {
                        return Ok(());
                    }
                    self.item(
                        &mut inner,
                        &params["item"],
                        if method == "item/started" {
                            "item.started"
                        } else {
                            "item.completed"
                        },
                    )?;
                }
                "thread/tokenUsage/updated" => {
                    if !Self::current_turn(&inner, params) {
                        return Ok(());
                    }
                    if let Some(usage) = Self::public_token_usage(&params["tokenUsage"]) {
                        self.emit(json!({"method":method,"params":{
                            "threadId":params["threadId"],"turnId":params["turnId"],"tokenUsage":usage
                        }}));
                    }
                }
                "model/rerouted" => {
                    if !Self::current_turn(&inner, params) {
                        return Ok(());
                    }
                    if params["fromModel"].is_string() && params["toModel"].is_string() {
                        let reason = params["reason"]
                            .as_str()
                            .filter(|reason| *reason == "highRiskCyberActivity");
                        self.emit(json!({"method":method,"params":{
                            "threadId":params["threadId"],"turnId":params["turnId"],
                            "fromModel":params["fromModel"],"toModel":params["toModel"],"reason":reason
                        }}));
                    }
                }
                "item/reasoning/summaryTextDelta" | "item/reasoning/summaryPartAdded" => {
                    if !Self::current_turn(&inner, params) {
                        return Ok(());
                    }
                    if let (Some(item), Some(index)) =
                        (params["itemId"].as_str(), params["summaryIndex"].as_u64())
                    {
                        let mut summary = json!({
                            "threadId":params["threadId"],"turnId":params["turnId"],
                            "itemId":item,"summaryIndex":index,
                        });
                        if method == "item/reasoning/summaryTextDelta" {
                            let Some(delta) = params["delta"].as_str() else {
                                return Ok(());
                            };
                            summary["delta"] = delta.into();
                        }
                        self.emit(json!({"method":method,"params":summary}));
                    }
                }
                "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
                    if Self::current_turn(&inner, params)
                        && params["itemId"].is_string()
                        && params["delta"].is_string()
                    {
                        self.emit(json!({"method":method,"params":{"threadId":params["threadId"],"turnId":params["turnId"],"itemId":params["itemId"],"delta":params["delta"]}}));
                    }
                }
                "item/mcpToolCall/progress" => {
                    if !Self::current_turn(&inner, params) {
                        return Ok(());
                    }
                    if let (Some(item), Some(message)) =
                        (params["itemId"].as_str(), params["message"].as_str())
                    {
                        self.emit(json!({"method":method,"params":{
                            "threadId":params["threadId"],"turnId":params["turnId"],"itemId":item,"message":message
                        }}));
                    }
                }
                "error" => {
                    if !Self::same_turn(&mut inner, params, params["turnId"].as_str()) {
                        return Ok(());
                    }
                    self.emit(json!({"type":"codex.app_server.error","params":params}));
                    if params["willRetry"] != true {
                        return Err(format!(
                            "Codex app-server error: {}",
                            params["error"]["message"]
                                .as_str()
                                .unwrap_or("unknown error")
                        ));
                    }
                }
                _ => {}
            }
            return Ok(());
        }
        let Some(id) = value["id"].as_u64() else {
            return Ok(());
        };
        if inner.controls.remove(&id) {
            if !value["error"].is_null() {
                self.emit(
                    json!({"type":"runtime.control_failed","message":value["error"]["message"]}),
                );
            }
            return Ok(());
        }
        if id != inner.request_id {
            return Ok(());
        }
        if !value["error"].is_null() {
            return Err(format!(
                "Codex app-server request failed: {}",
                value["error"]["message"]
                    .as_str()
                    .unwrap_or("unknown protocol error")
            ));
        }
        if inner.cancelled && inner.stage != 3 {
            return Err("Codex turn interrupted before submission".into());
        }
        let result = &value["result"];
        match inner.stage {
            1 => {
                if result.is_null() {
                    return Err("Codex app-server initialize response is missing".into());
                }
                Self::write(&mut inner, json!({"method":"initialized"}))?;
                let (sandbox, _, approval) = policy(&sink.request);
                let mut params = json!({"cwd":sink.request.directory,"model":self.model(),"approvalPolicy":approval,"sandbox":sandbox});
                if !sink.request.codex_streaming {
                    let config = sink
                        .request
                        .runtime
                        .permissions
                        .as_ref()
                        .and_then(|p| p.codex.as_ref());
                    let mut overrides = serde_json::Map::new();
                    let mut roots = sink.request.additional_directories.clone();
                    if let Some(config) = config {
                        roots.extend(config.additional_directories.clone());
                        if config.network != "inherit" {
                            overrides.insert(
                                "sandbox_workspace_write.network_access".into(),
                                (config.network == "allow").into(),
                            );
                        }
                    }
                    roots.sort();
                    roots.dedup();
                    if !roots.is_empty() {
                        overrides.insert(
                            "sandbox_workspace_write.writable_roots".into(),
                            json!(roots),
                        );
                    }
                    if !overrides.is_empty() {
                        params["config"] = overrides.into();
                    }
                }
                let method = if let Some(session) = &sink.request.session_id {
                    params["threadId"] = session.clone().into();
                    // The frontend already owns the persisted transcript.
                    // Request metadata only so a long native history does not
                    // consume the 4 MiB transport frame bound on every turn.
                    params["excludeTurns"] = true.into();
                    "thread/resume"
                } else {
                    "thread/start"
                };
                Self::request(&mut inner, 2, method, params)?;
            }
            2 => {
                let session = result["thread"]["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or("Codex app-server did not return a thread ID")?;
                if sink
                    .request
                    .session_id
                    .as_deref()
                    .is_some_and(|expected| expected != session)
                {
                    return Err(
                        "Codex resumed a different conversation; prompt was not sent".into(),
                    );
                }
                let (_, expected_policy, expected_approval) = policy(&sink.request);
                if expected_approval.is_some_and(|approval| result["approvalPolicy"] != approval)
                    || expected_policy
                        .as_ref()
                        .is_some_and(|sandbox| result["sandbox"]["type"] != sandbox["type"])
                    || expected_policy.as_ref().is_some_and(|sandbox| {
                        sandbox["type"] == "readOnly"
                            && result["sandbox"]["networkAccess"].as_bool() != Some(false)
                    })
                {
                    return Err("Codex did not confirm the requested permission scope. The turn message was not sent.".into());
                }
                inner.effective_sandbox = result["sandbox"]
                    .is_object()
                    .then(|| result["sandbox"].clone());
                inner.session = Some(session.to_owned());
                self.emit(json!({"type":"thread.started","thread_id":session}));
                let metadata = json!({"type":"codex.app_server.thread_ready","threadId":session,
                    "model":result["model"].as_str(),"modelProvider":result["modelProvider"].as_str(),
                    "reasoningEffort":result["reasoningEffort"].as_str(),"source":"server"});
                inner.thread_metadata = Some(metadata.clone());
                self.emit(metadata);
                self.emit(json!({"type":"runtime.capabilities","steer":true,"followUp":false,"approvals":!sink.request.codex_streaming}));
                let params = self.turn_params(session, inner.effective_sandbox.as_ref());
                Self::request(&mut inner, 3, "turn/start", params)?;
            }
            3 => {
                let turn = result["turn"]["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or("Codex app-server did not return a turn ID")?;
                if inner.turn.as_deref().is_some_and(|active| active != turn) {
                    return Err("Codex app-server returned a different active turn".into());
                }
                inner.turn = Some(turn.to_owned());
            }
            _ => return Err("Unexpected Codex app-server lifecycle response".into()),
        }
        Ok(())
    }
    fn item(&self, inner: &mut Inner, item: &Value, event_type: &str) -> Result<(), String> {
        if item["type"] == "agentMessage" {
            let id = item["id"]
                .as_str()
                .ok_or("Codex agent message has no item ID")?;
            let text = item["text"]
                .as_str()
                .ok_or("Codex agent message has no text")?;
            // An item.started notification can follow an early delta. Preserve
            // the visible snapshot instead of replacing it with an empty item.
            if event_type == "item.started" && inner.messages.contains_key(id) {
                return Ok(());
            }
            inner.messages.insert(id.to_owned(), text.to_owned());
            self.emit(
                json!({"type":event_type,"threadId":inner.session,"turnId":inner.turn,
                "item":{"id":id,"type":"agent_message","text":text}}),
            );
        } else {
            let public_item = if item["type"] == "reasoning" {
                Self::public_reasoning(item)
            } else {
                item.clone()
            };
            self.emit(
                json!({"type":"codex.app_server.item","eventType":event_type,
                "threadId":inner.session,"turnId":inner.turn,"item":public_item}),
            );
        }
        Ok(())
    }
}

impl NativeSession for CodexSession {
    fn start_turn(&self, sink: Arc<EventSink>) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Codex state unavailable")?;
        if self.disconnected.load(Ordering::SeqCst) {
            return Err("Codex connection disconnected; this turn was not replayed".into());
        }
        if inner.outcome.is_none() {
            return Err("Codex already has an active turn".into());
        }
        let session = inner
            .session
            .clone()
            .ok_or("Codex native thread is unavailable")?;
        if sink
            .request
            .session_id
            .as_deref()
            .is_some_and(|expected| expected != session)
        {
            return Err("Requested Codex thread differs from the live connection".into());
        }
        self.sink.replace(sink);
        inner.turn = None;
        inner.messages.clear();
        inner.pending.clear();
        inner.outcome = None;
        inner.cancelled = false;
        self.emit(json!({"type":"thread.started","thread_id":session}));
        if let Some(metadata) = &inner.thread_metadata {
            let mut metadata = metadata.clone();
            metadata["source"] = "liveConnection".into();
            self.emit(metadata);
        }
        let restricted = self.sink.current().request.codex_streaming;
        self.emit(json!({"type":"runtime.capabilities","steer":true,"followUp":false,"approvals":!restricted}));
        let params = self.turn_params(&session, inner.effective_sandbox.as_ref());
        Self::request(&mut inner, 3, "turn/start", params)
    }
    fn outcome(&self) -> Option<Result<(), String>> {
        CodexSession::outcome(self)
    }
    fn cancel(&self) {
        CodexSession::cancel(self)
    }
    fn disconnected(&self) -> bool {
        self.disconnected.load(Ordering::SeqCst)
    }
    fn steer(&self, prompt: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Codex state unavailable")?;
        if inner.outcome.is_some() || inner.cancelled {
            return Err("Codex turn is no longer active".into());
        }
        if inner.steering.len() >= 32 {
            return Err("Too many pending Codex input requests".into());
        }
        let session = inner.session.clone().ok_or("Codex thread is not ready")?;
        let turn = inner.turn.clone().ok_or("Codex turn is not ready")?;
        let id = inner.next_id;
        inner.next_id += 1;
        inner.steering.insert(
            id,
            SteerReply {
                turn: turn.clone(),
                prompt: prompt.into(),
                result: None,
            },
        );
        if let Err(error) = Self::write(
            &mut inner,
            json!({"id":id,"method":"turn/steer","params":{"threadId":session,"expectedTurnId":turn,"input":[{"type":"text","text":prompt,"text_elements":[]}]}}),
        ) {
            inner.steering.remove(&id);
            return Err(error);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(result) = inner
                .steering
                .get(&id)
                .and_then(|reply| reply.result.clone())
            {
                inner.steering.remove(&id);
                inner.controls.insert(id);
                return result;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                inner.steering.remove(&id);
                inner.controls.insert(id);
                return Err("Codex did not acknowledge the additional message within 5 seconds. The input was retained without automatic resend.".into());
            }
            let (next, _) = self
                .changed
                .wait_timeout(inner, remaining)
                .map_err(|_| "Codex input acknowledgement unavailable")?;
            inner = next;
        }
    }
    fn respond(&self, token: &str, option: Option<&str>) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "Codex state unavailable")?;
        if inner.outcome.is_some() || inner.cancelled {
            return Err("Codex approval expired".into());
        }
        let (id, method, permissions) = inner
            .pending
            .get(token)
            .cloned()
            .ok_or("Codex approval expired or already answered")?;
        let decision = match option {
            Some("accept") => "accept",
            Some("decline") | None => "decline",
            _ => return Err("Permission option does not belong to this request".into()),
        };
        let result = if method == "item/permissions/requestApproval" {
            if decision == "accept" && !permissions.is_object() {
                return Err(
                    "Codex permission request did not contain a valid permission profile".into(),
                );
            }
            json!({"permissions":if decision == "accept" {permissions} else {json!({})},"scope":"turn"})
        } else {
            json!({"decision":decision})
        };
        Self::write(&mut inner, json!({"id":id,"result":result}))?;
        inner.pending.remove(token);
        self.emit(
            json!({"type":"runtime.permission_resolved","requestId":token,"optionId":option}),
        );
        Ok(())
    }
}

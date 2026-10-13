//! Opt-in token streaming for the read-only goal assistant. The app-server is
//! persistent, so process exit is not a successful turn: only the correlated
//! `turn/completed` notification can mark this execution completed.
use super::EventSink;
use crate::{reasoning, types::StartRequest};
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

pub(super) fn arguments(request: &StartRequest) -> Result<Vec<String>, String> {
    if request.runtime.adapter != "codex" {
        return Err("Codex 流式协议仅适用于 Codex Runtime".into());
    }
    if !request.runtime.args.is_empty() {
        return Err("目标助手的 Codex 流式协议不支持额外启动参数".into());
    }
    let permissions = request
        .runtime
        .permissions
        .as_ref()
        .and_then(|p| p.codex.as_ref());
    if permissions.is_none_or(|p| {
        p.sandbox != "read-only" || p.network != "inherit" || !p.additional_directories.is_empty()
    }) {
        return Err("目标助手的 Codex 流式协议要求只读权限".into());
    }
    reasoning::arguments("codex", request.reasoning_effort.as_deref(), &[])?;
    Ok(vec![
        "app-server".into(),
        "--listen".into(),
        "stdio://".into(),
        "-c".into(),
        "sandbox_mode=\"read-only\"".into(),
        "-c".into(),
        "approval_policy=\"never\"".into(),
    ])
}

struct Inner {
    input: ChildStdin,
    stage: u64,
    since: Instant,
    session: Option<String>,
    turn: Option<String>,
    messages: HashMap<String, String>,
    outcome: Option<Result<(), String>>,
    cancelled: bool,
}

pub(super) struct CodexSession {
    inner: Mutex<Inner>,
    sink: Arc<EventSink>,
}

impl CodexSession {
    pub(super) fn new(input: ChildStdin, sink: Arc<EventSink>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                input,
                stage: 1,
                since: Instant::now(),
                session: None,
                turn: None,
                messages: HashMap::new(),
                outcome: None,
                cancelled: false,
            }),
            sink,
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
        Self::write(inner, json!({"id":id,"method":method,"params":params}))
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
            && inner.turn.is_none()
            && inner.since.elapsed() > STARTUP_TIMEOUT
        {
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
            if let (Some(session), Some(turn)) = (&inner.session, &inner.turn) {
                let value = json!({"id":4,"method":"turn/interrupt","params":{"threadId":session,"turnId":turn}});
                let _ = Self::write(&mut inner, value);
            }
        }
    }
    fn model(&self) -> Option<&str> {
        let model = if self.sink.request.model.trim().is_empty() {
            self.sink.request.runtime.default_model.trim()
        } else {
            self.sink.request.model.trim()
        };
        (!model.is_empty()).then_some(model)
    }
    fn same_turn(inner: &mut Inner, params: &Value, turn: Option<&str>) -> bool {
        if inner.stage < 3 || params["threadId"].as_str() != inner.session.as_deref() {
            return false;
        }
        let Some(turn) = turn.filter(|value| !value.is_empty()) else {
            return false;
        };
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
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Codex app-server lock unavailable")?;
        if inner.outcome.is_some() {
            return Ok(());
        }
        if let Some(method) = value["method"].as_str() {
            // Never authorize tools in the goal assistant. Unknown server RPC
            // requests are answered with an error and terminate this turn.
            if !value["id"].is_null() {
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
                    json!({"id":value["id"],"error":{"code":-32601,"message":"Goal assistant does not provide this client capability"}})
                };
                Self::write(&mut inner, response)?;
                self.emit(json!({"type":"codex.app_server.request_rejected","method":method}));
                return Err(format!("Codex 目标助手请求了不可用的客户端能力：{method}"));
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
        if id == 4 && inner.cancelled {
            return Ok(());
        }
        if id != inner.stage {
            return Err("Unexpected Codex app-server response ID".into());
        }
        if !value["error"].is_null() {
            return Err(format!(
                "Codex app-server request failed: {}",
                value["error"]["message"]
                    .as_str()
                    .unwrap_or("unknown protocol error")
            ));
        }
        let result = &value["result"];
        match id {
            1 => {
                if result.is_null() {
                    return Err("Codex app-server initialize response is missing".into());
                }
                Self::write(&mut inner, json!({"method":"initialized"}))?;
                let mut params = json!({"cwd":self.sink.request.directory,"model":self.model(),"approvalPolicy":"never","sandbox":"read-only"});
                let method = if let Some(session) = &self.sink.request.session_id {
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
                if self
                    .sink
                    .request
                    .session_id
                    .as_deref()
                    .is_some_and(|expected| expected != session)
                {
                    return Err(
                        "Codex resumed a different conversation; prompt was not sent".into(),
                    );
                }
                if result["approvalPolicy"] != "never"
                    || result["sandbox"]["type"] != "readOnly"
                    || result["sandbox"]["networkAccess"].as_bool() != Some(false)
                {
                    return Err("Codex 未确认目标助手的只读权限；未发送本轮消息".into());
                }
                inner.session = Some(session.to_owned());
                self.emit(json!({"type":"thread.started","thread_id":session}));
                self.emit(json!({
                    "type":"codex.app_server.thread_ready","threadId":session,
                    "model":result["model"].as_str(),"modelProvider":result["modelProvider"].as_str(),
                    "reasoningEffort":result["reasoningEffort"].as_str()
                }));
                let params = json!({
                    "threadId":session, "input":[{"type":"text","text":self.sink.request.prompt,"text_elements":[]}],
                    "cwd":self.sink.request.directory,"model":self.model(),
                    "approvalPolicy":"never","sandboxPolicy":{"type":"readOnly","networkAccess":false},
                    "effort":self.sink.request.reasoning_effort.as_deref().filter(|effort| *effort != "inherit")
                });
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

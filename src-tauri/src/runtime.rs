mod claude;
#[cfg(all(test, unix))]
mod claude_tests;
mod codex;
#[cfg(all(test, unix))]
mod codex_tests;
mod kimi;
#[cfg(all(test, unix))]
mod kimi_tests;
#[cfg(test)]
mod pi;
mod pi_rpc;
#[cfg(all(test, unix))]
mod pi_rpc_tests;
#[cfg(all(test, unix))]
mod pi_tests;
use crate::{
    discovery::{resolve, runtime_path, signal_group},
    permission, reasoning,
    storage::{private_file, validate_id, Storage},
    types::{ActiveRuntimeTurn, RuntimeEvent, StartRequest},
};
use chrono::{SecondsFormat, Utc};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Write},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

type EventCallback = Arc<dyn Fn(RuntimeEvent) + Send + Sync>;

/// A native process owns a connection and a native conversation. Runs own only
/// one turn and its trace. Disconnects are never automatically replayed.
pub(super) trait NativeSession: Send + Sync {
    fn start_turn(&self, sink: Arc<EventSink>) -> Result<(), String>;
    fn outcome(&self) -> Option<Result<(), String>>;
    fn cancel(&self);
    fn steer(&self, prompt: &str) -> Result<(), String>;
    fn respond(&self, token: &str, option: Option<&str>) -> Result<(), String>;
    fn disconnected(&self) -> bool;
    fn hard_disconnect(&self) -> bool {
        false
    }
    fn close(&self) {
        self.cancel();
    }
    fn ready_to_close(&self) -> bool {
        true
    }
}

#[derive(Clone)]
pub(super) struct RoutedSink(Arc<Mutex<Arc<EventSink>>>, Arc<AtomicBool>);
impl RoutedSink {
    pub(super) fn new(sink: Arc<EventSink>) -> Self {
        Self(Arc::new(Mutex::new(sink)), Arc::new(AtomicBool::new(true)))
    }
    pub(super) fn current(&self) -> Arc<EventSink> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub(super) fn replace(&self, sink: Arc<EventSink>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = sink;
        self.1.store(true, Ordering::SeqCst);
    }
    fn deactivate(&self) {
        self.1.store(false, Ordering::SeqCst);
    }
    fn output(&self, kind: &str, bytes: &[u8]) {
        if self.1.load(Ordering::SeqCst) {
            self.current().output(kind, bytes);
        }
    }
}

struct NativeTurn {
    key: String,
    control: Arc<Running>,
    sink: Arc<EventSink>,
    stopping_since: Option<Instant>,
}
struct NativeConnection {
    pid: u32,
    owner: (String, String),
    session: Arc<dyn NativeSession>,
    route: RoutedSink,
    active: Mutex<Option<NativeTurn>>,
    closing: AtomicBool,
    done: (Mutex<bool>, Condvar),
}

struct Running {
    pid: Option<u32>,
    stop: AtomicBool,
    done: (Mutex<bool>, Condvar),
    native: Mutex<Option<Arc<dyn NativeSession>>>,
}

fn signal_running(control: &Running, signal: i32) {
    if let Some(pid) = control.pid {
        signal_group(pid, signal);
    }
}

/// A command is registered before the async worker is scheduled, so Stop and
/// webview recovery cover initialization as well as actual Agent turns.
pub(super) struct PendingStart {
    key: String,
    control: Arc<Running>,
    processes: Arc<Mutex<HashMap<String, Arc<Running>>>>,
}
impl PendingStart {
    fn owns_slot(&self, processes: &HashMap<String, Arc<Running>>) -> bool {
        processes
            .get(&self.key)
            .is_some_and(|control| Arc::ptr_eq(control, &self.control))
    }
    fn canceled(&self) -> bool {
        self.control.stop.load(Ordering::SeqCst)
    }
}
impl Drop for PendingStart {
    fn drop(&mut self) {
        if let Ok(mut processes) = self.processes.lock() {
            if self.owns_slot(&processes) {
                processes.remove(&self.key);
            }
        }
        let (done, changed) = &self.control.done;
        if let Ok(mut done) = done.lock() {
            *done = true;
            changed.notify_all();
        }
    }
}

#[derive(Clone)]
pub struct RuntimeManager {
    storage: Arc<Storage>,
    processes: Arc<Mutex<HashMap<String, Arc<Running>>>>,
    lifecycle_gate: Arc<Mutex<()>>,
    connections: Arc<Mutex<HashMap<String, Arc<NativeConnection>>>>,
    shutting_down: Arc<AtomicBool>,
}

pub(super) struct EventSink {
    request: StartRequest,
    file: Mutex<File>,
    output_lock: Mutex<()>,
    disk_failed: AtomicBool,
    callback: EventCallback,
}

impl EventSink {
    fn event(&self, kind: &str, text: String, exit_code: Option<i32>) {
        let event = RuntimeEvent {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: self.request.task_id.clone(),
            run_id: self.request.run_id.clone(),
            member_id: self.request.member_id.clone(),
            timestamp: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            kind: kind.into(),
            text,
            exit_code,
        };
        // Never persist command arguments or environment variables. Only emitted runtime data and lifecycle records.
        let result = (|| -> Result<(), String> {
            let mut file = self.file.lock().map_err(|_| "Trace lock unavailable")?;
            serde_json::to_writer(&mut *file, &event).map_err(|e| e.to_string())?;
            file.write_all(b"\n")
                .and_then(|_| file.sync_data())
                .map_err(|e| e.to_string())
        })();
        if result.is_err() {
            self.disk_failed.store(true, Ordering::SeqCst);
        }
        (self.callback)(event);
    }

    fn output(&self, kind: &str, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        // Serialize stdout/stderr delivery as well as their disk writes. Every
        // chunk is retained; legacy per-run output budgets no longer apply.
        let _output = self.output_lock.lock().unwrap_or_else(|e| e.into_inner());
        self.event(kind, String::from_utf8_lossy(bytes).into_owned(), None);
    }
}

pub fn build_arguments(request: &StartRequest) -> Result<Vec<String>, String> {
    if let Some(id) = &request.session_id {
        if id.is_empty()
            || id.len() > 256
            || !id.as_bytes()[0].is_ascii_alphanumeric()
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err("Runtime 会话 ID 无效；未启动新会话".into());
        }
        if request.runtime.adapter == "generic" {
            return Err("通用 Runtime 尚无原生会话续接协议".into());
        }
    }
    match request.runtime.adapter.as_str() {
        "codex" => return codex::arguments(request),
        "claude" => return claude::arguments(request),
        "pi" => return pi_rpc::arguments(request),
        _ => {}
    }
    let model = if request.model.trim().is_empty() {
        request.runtime.default_model.trim()
    } else {
        request.model.trim()
    };
    let extra: Vec<String> = request
        .runtime
        .args
        .iter()
        .map(|arg| expand_template(arg, &request.prompt, model))
        .collect();
    let permission_args = permission::arguments(&request.runtime, &extra)?;
    reasoning::arguments(
        &request.runtime.adapter,
        request.reasoning_effort.as_deref(),
        &extra,
    )?;
    match request.runtime.adapter.as_str() {
        "kimi" => {
            if !extra.is_empty() {
                return Err("Kimi ACP manages its own protocol arguments; clear additional CLI arguments and select the model in the app".into());
            }
            Ok(vec!["acp".into()])
        }
        "generic" => {
            if !request
                .runtime
                .args
                .iter()
                .any(|arg| arg.contains("{prompt}"))
            {
                return Err("Generic runtime arguments must contain {prompt}; configure the runtime's non-interactive command first".into());
            }
            let mut args = Vec::new();
            if permission::builtin_generic_defaults(&request.runtime)
                && request.runtime.id == "traex"
                && !extra.iter().any(|arg| {
                    matches!(
                        arg.split('=').next().unwrap_or(arg),
                        "--permission-mode"
                            | "--sandbox"
                            | "-s"
                            | "--ask-for-approval"
                            | "-a"
                            | "--dangerously-bypass-approvals-and-sandbox"
                            | "-y"
                            | "--config"
                            | "-c"
                            | "--profile"
                            | "-p"
                    )
                })
            {
                args.extend(["--permission-mode".into(), "bypass_permissions".into()]);
            }
            args.extend(extra);
            args.extend(permission_args);
            Ok(args)
        }
        _ => Err("Unsupported runtime adapter".into()),
    }
}

fn expand_template(template: &str, prompt: &str, model: &str) -> String {
    let mut result = String::new();
    let mut remaining = template;
    while let Some(index) = remaining.find('{') {
        result.push_str(&remaining[..index]);
        remaining = &remaining[index..];
        if let Some(tail) = remaining.strip_prefix("{prompt}") {
            result.push_str(prompt);
            remaining = tail;
        } else if let Some(tail) = remaining.strip_prefix("{model}") {
            result.push_str(model);
            remaining = tail;
        } else {
            result.push('{');
            remaining = &remaining[1..];
        }
    }
    result.push_str(remaining);
    result
}

/// A read can end in the middle of a UTF-8 character. Emit everything before
/// that suffix immediately, including malformed bytes (decoded lossily by the
/// sink), while retaining only the incomplete trailing character for next read.
fn complete_utf8_prefix_len(bytes: &[u8]) -> usize {
    let mut offset = 0;
    while offset < bytes.len() {
        match std::str::from_utf8(&bytes[offset..]) {
            Ok(_) => return bytes.len(),
            Err(error) => {
                offset += error.valid_up_to();
                match error.error_len() {
                    Some(length) => offset += length,
                    None => return offset,
                }
            }
        }
    }
    offset
}

fn stream(
    mut reader: impl Read + Send + 'static,
    sink: Arc<EventSink>,
    kind: &'static str,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        let mut pending = Vec::with_capacity(4099);
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    pending.extend_from_slice(&buffer[..count]);
                    let complete = complete_utf8_prefix_len(&pending);
                    // Preserve complete line boundaries when available, but do
                    // not wait for a newline: JSONL decoders on the receiving
                    // side retain their own partial record per process/channel.
                    for chunk in pending[..complete].split_inclusive(|byte| *byte == b'\n') {
                        sink.output(kind, chunk);
                    }
                    pending.drain(..complete);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    sink.event(
                        "stderr",
                        "[Runtime output stream could not be read]".into(),
                        None,
                    );
                    break;
                }
            }
        }
        if !pending.is_empty() {
            sink.output(kind, &pending);
        }
    })
}

impl RuntimeManager {
    pub fn new(storage: Arc<Storage>) -> Self {
        Self {
            storage,
            processes: Arc::new(Mutex::new(HashMap::new())),
            lifecycle_gate: Arc::new(Mutex::new(())),
            connections: Arc::new(Mutex::new(HashMap::new())),
            shutting_down: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(super) fn prepare_start(&self, request: &StartRequest) -> Result<PendingStart, String> {
        for id in [
            &request.task_id,
            &request.run_id,
            &request.member_id,
            &request.runtime.id,
        ] {
            validate_id(id)?;
        }
        let key = format!("{}:{}", request.run_id, request.member_id);
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| "Process manager unavailable")?;
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err("Runtime manager is shutting down; input was not launched".into());
        }
        if processes.contains_key(&key) {
            return Err("This member already has a pending or active turn".into());
        }
        if processes.len() >= 16 {
            return Err("Maximum of 16 pending or active turns reached".into());
        }
        let control = Arc::new(Running {
            pid: None,
            stop: AtomicBool::new(false),
            done: (Mutex::new(false), Condvar::new()),
            native: Mutex::new(None),
        });
        processes.insert(key.clone(), control.clone());
        Ok(PendingStart {
            key,
            control,
            processes: self.processes.clone(),
        })
    }

    #[cfg(test)]
    pub fn start(&self, request: StartRequest, callback: EventCallback) -> Result<(), String> {
        let pending = self.prepare_start(&request)?;
        self.start_prepared(request, callback, pending)
    }

    pub(super) fn start_prepared(
        &self,
        request: StartRequest,
        callback: EventCallback,
        pending: PendingStart,
    ) -> Result<(), String> {
        let result = self.start_reserved(request.clone(), callback.clone(), &pending);
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| "Process manager unavailable")?;
        if pending.canceled() && pending.owns_slot(&processes) {
            processes.remove(&pending.key);
            let event = RuntimeEvent {
                id: uuid::Uuid::new_v4().to_string(),
                task_id: request.task_id.clone(),
                run_id: request.run_id.clone(),
                member_id: request.member_id.clone(),
                timestamp: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                kind: "stopped".into(),
                text: "Runtime startup canceled before launching or sending input".into(),
                exit_code: None,
            };
            if let Ok(path) =
                self.storage
                    .trace_path(&request.task_id, &request.run_id, &request.member_id)
            {
                if let Ok(mut file) = private_file(&path, true) {
                    let _ = serde_json::to_writer(&mut file, &event);
                    let _ = file.write_all(b"\n");
                    let _ = file.sync_data();
                }
            }
            callback(event);
            return Ok(());
        }
        drop(processes);
        result
    }

    fn start_reserved(
        &self,
        request: StartRequest,
        callback: EventCallback,
        pending: &PendingStart,
    ) -> Result<(), String> {
        if pending.canceled() {
            return Ok(());
        }
        let _lifecycle = self
            .lifecycle_gate
            .try_lock()
            .map_err(|_| "应用更新正在安装或重启，请稍后再启动任务")?;
        for id in [
            &request.task_id,
            &request.run_id,
            &request.member_id,
            &request.runtime.id,
        ] {
            validate_id(id)?;
        }
        if !request.runtime.enabled {
            return Err("Runtime is disabled".into());
        }
        if request.prompt.trim().is_empty() {
            return Err("Prompt cannot be empty".into());
        }
        if request.prompt.len() > 1024 * 1024 {
            return Err(
                "对话上下文超过单次发送的 1 MiB 限制；内容已保留，未截断或启动新会话".into(),
            );
        }
        let directory = std::path::Path::new(&request.directory);
        if !directory.is_absolute() || !directory.is_dir() {
            return Err("Select an existing absolute working directory".into());
        }
        for extra in &request.additional_directories {
            if !std::path::Path::new(extra).is_absolute() || !std::path::Path::new(extra).is_dir() {
                return Err("Additional working directories must exist and be absolute".into());
            }
        }
        if request.additional_directories.len() > 128 {
            return Err("Too many working directories".into());
        }
        if matches!(
            request.runtime.adapter.as_str(),
            "codex" | "kimi" | "claude" | "pi"
        ) {
            build_arguments(&request)?;
            return self.start_native(request, callback, pending);
        }
        let path = resolve(&request.runtime.executable)?;
        let args = build_arguments(&request)?;
        let key = format!("{}:{}", request.run_id, request.member_id);
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| "Process manager unavailable")?;
        if !pending.owns_slot(&processes) {
            return Err("Runtime startup reservation is no longer valid".into());
        }
        if pending.canceled() {
            return Ok(());
        }
        let file = private_file(
            &self
                .storage
                .trace_path(&request.task_id, &request.run_id, &request.member_id)?,
            true,
        )?;
        let mut command = Command::new(path);
        if permission::builtin_generic_defaults(&request.runtime)
            && request.runtime.id == "deepseek-harness"
        {
            command.env(
                "DSH_PERMISSION_MODE",
                std::env::var("DSH_PERMISSION_MODE")
                    .unwrap_or_else(|_| "danger-full-access".into()),
            );
        }
        command
            .args(args)
            .current_dir(directory)
            .env("PATH", runtime_path())
            .env("NO_COLOR", "1")
            .stdin(if request.runtime.adapter != "generic" {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start {}: {e}", request.runtime.name))?;
        let stdout = child.stdout.take().ok_or("Runtime stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("Runtime stderr unavailable")?;
        let control = Arc::new(Running {
            pid: Some(child.id()),
            stop: AtomicBool::new(false),
            done: (Mutex::new(false), Condvar::new()),
            native: Mutex::new(None),
        });
        processes.insert(key.clone(), control.clone());
        drop(processes);
        let sink = Arc::new(EventSink {
            request,
            file: Mutex::new(file),
            output_lock: Mutex::new(()),
            disk_failed: AtomicBool::new(false),
            callback,
        });
        sink.event(
            "started",
            format!("{} process started", sink.request.runtime.name),
            None,
        );
        let processes = self.processes.clone();
        thread::spawn(move || {
            let stdout_reader = stream(stdout, sink.clone(), "stdout");
            let stderr_reader = stream(stderr, sink.clone(), "stderr");
            let mut stopping_since = None;
            let status = loop {
                if (control.stop.load(Ordering::SeqCst) || sink.disk_failed.load(Ordering::SeqCst))
                    && stopping_since.is_none()
                {
                    signal_running(&control, libc::SIGTERM);
                    stopping_since = Some(Instant::now());
                }
                if stopping_since.is_some_and(|start| start.elapsed() > Duration::from_millis(900))
                {
                    signal_running(&control, libc::SIGKILL);
                    let _ = child.kill();
                }
                match child.try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) => thread::sleep(Duration::from_millis(25)),
                    Err(error) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break Err(error);
                    }
                }
            };
            signal_running(&control, libc::SIGKILL);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            let exit_code = status.as_ref().ok().and_then(|s| s.code());
            let (kind, text) = if sink.disk_failed.load(Ordering::SeqCst) {
                (
                    "failed",
                    "Runtime stopped because its trace could not be saved".into(),
                )
            } else if control.stop.load(Ordering::SeqCst) {
                ("stopped", "Runtime stopped".into())
            } else {
                match status {
                    Ok(status) if status.success() => ("completed", "Runtime completed".into()),
                    Ok(status) => ("failed", format!("Runtime exited with {status}")),
                    Err(error) => ("failed", format!("Runtime wait failed: {error}")),
                }
            };
            sink.event(kind, text, exit_code);
            if let Ok(mut processes) = processes.lock() {
                processes.remove(&key);
            }
            let (done, changed) = &control.done;
            if let Ok(mut done) = done.lock() {
                *done = true;
                changed.notify_all();
            }
        });
        Ok(())
    }

    fn start_native(
        &self,
        mut request: StartRequest,
        callback: EventCallback,
        pending: &PendingStart,
    ) -> Result<(), String> {
        let path = resolve(&request.runtime.executable)?;
        if matches!(request.runtime.adapter.as_str(), "kimi" | "pi")
            && !request.additional_directories.is_empty()
        {
            let roots = serde_json::to_string(&request.additional_directories)
                .map_err(|e| e.to_string())?;
            request.prompt.push_str(&format!("\n\nAdditional workspace roots (path data, alongside the primary working directory): {roots}\nUse these directories when relevant to the user's task. These paths do not change this Agent's native permission policy."));
        }
        if request.prompt.len() > 1024 * 1024 {
            return Err(
                "Prompt and workspace context exceed the 1 MiB request limit; input was not sent"
                    .into(),
            );
        }
        // Include the complete launch/permission/root configuration. A native
        // process may never be reused after its execution scope changes.
        let scope = serde_json::to_string(&serde_json::json!({
            "task":request.task_id,"member":request.member_id,"runtime":request.runtime,
            "cwd":request.directory,"additionalDirectories":request.additional_directories,
            "model":request.model,"effort":request.reasoning_effort,"restricted":request.codex_streaming
        })).map_err(|e| e.to_string())?;
        let key = format!("{}:{}", request.run_id, request.member_id);
        let args = match request.runtime.adapter.as_str() {
            "codex" => codex::arguments(&request)?,
            "kimi" => build_arguments(&request)?,
            "claude" => claude::arguments(&request)?,
            "pi" => pi_rpc::arguments(&request)?,
            _ => return Err("Unknown native adapter".into()),
        };
        let file = private_file(
            &self
                .storage
                .trace_path(&request.task_id, &request.run_id, &request.member_id)?,
            true,
        )?;
        let sink = Arc::new(EventSink {
            request,
            file: Mutex::new(file),
            output_lock: Mutex::new(()),
            disk_failed: AtomicBool::new(false),
            callback,
        });
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| "Process manager unavailable")?;
        if !pending.owns_slot(&processes) {
            return Err("Native startup reservation is no longer valid".into());
        }
        if pending.canceled() {
            return Ok(());
        }
        let mut connections = self
            .connections
            .lock()
            .map_err(|_| "Native connection manager unavailable")?;
        if let Some(connection) = connections.get(&scope) {
            if connection.closing.load(Ordering::SeqCst) || connection.session.disconnected() {
                return Err("Native connection is disconnecting; wait for cleanup and retry. This prompt was not sent".into());
            }
            let mut active = connection
                .active
                .lock()
                .map_err(|_| "Native turn state unavailable")?;
            if active.is_some() {
                return Err("This native conversation already has an active turn".into());
            }
            let control = Arc::new(Running {
                pid: Some(connection.pid),
                stop: AtomicBool::new(false),
                done: (Mutex::new(false), Condvar::new()),
                native: Mutex::new(Some(connection.session.clone())),
            });
            processes.insert(key.clone(), control.clone());
            connection.route.replace(sink.clone());
            // Emit starting before protocol output, just as on a fresh connection.
            sink.event(
                "started",
                format!("{} native session continued", sink.request.runtime.name),
                None,
            );
            if let Err(error) = connection.session.start_turn(sink.clone()) {
                processes.remove(&key);
                sink.event("failed", error.clone(), None);
                connection.closing.store(true, Ordering::SeqCst);
                return Err(error);
            }
            *active = Some(NativeTurn {
                key,
                control,
                sink,
                stopping_since: None,
            });
            return Ok(());
        }
        let mut stale_connections = Vec::new();
        for (existing_scope, existing) in connections.iter() {
            if existing_scope != &scope
                && existing.owner == (sink.request.task_id.clone(), sink.request.member_id.clone())
            {
                if existing
                    .active
                    .lock()
                    .map_err(|_| "Native turn state unavailable")?
                    .is_some()
                {
                    return Err(
                        "This member already has an active native turn under another configuration"
                            .into(),
                    );
                }
                existing.closing.store(true, Ordering::SeqCst);
                stale_connections.push(existing.clone());
            }
        }
        if !stale_connections.is_empty() {
            // Scope changes must not leave the previous permission/process tree
            // alive while resuming its native session with a new configuration.
            drop(connections);
            drop(processes);
            for connection in stale_connections {
                let (done, changed) = &connection.done;
                let done = done
                    .lock()
                    .map_err(|_| "Native connection state unavailable")?;
                let (done, _) = changed
                    .wait_timeout_while(done, Duration::from_secs(4), |done| !*done)
                    .map_err(|_| "Native connection cleanup unavailable")?;
                if !*done {
                    return Err("Previous native connection is still closing; retry after cleanup. This prompt was not sent".into());
                }
            }
            processes = self
                .processes
                .lock()
                .map_err(|_| "Process manager unavailable")?;
            connections = self
                .connections
                .lock()
                .map_err(|_| "Native connection manager unavailable")?;
        }
        if pending.canceled() {
            return Ok(());
        }
        // Bound idle native connections as well. Evict only idle connections;
        // the active map remains the authority for update/restart protection.
        if connections.len() >= 16 {
            let idle = connections
                .values()
                .find(|connection| {
                    connection
                        .active
                        .lock()
                        .is_ok_and(|active| active.is_none())
                })
                .cloned()
                .ok_or("Maximum of 16 active native connections reached")?;
            idle.closing.store(true, Ordering::SeqCst);
            drop(connections);
            drop(processes);
            let (done, changed) = &idle.done;
            let done = done
                .lock()
                .map_err(|_| "Native connection state unavailable")?;
            let (done, _) = changed
                .wait_timeout_while(done, Duration::from_secs(4), |done| !*done)
                .map_err(|_| "Native connection cleanup unavailable")?;
            if !*done {
                return Err("Idle native connection is still closing; retry after cleanup. This prompt was not sent".into());
            }
            processes = self
                .processes
                .lock()
                .map_err(|_| "Process manager unavailable")?;
            connections = self
                .connections
                .lock()
                .map_err(|_| "Native connection manager unavailable")?;
            if connections.len() >= 16 {
                return Err("Native connection limit reached; this prompt was not sent".into());
            }
        }
        if pending.canceled() {
            return Ok(());
        }
        let mut command = Command::new(path);
        command
            .args(args)
            .current_dir(&sink.request.directory)
            .env("PATH", runtime_path())
            .env("NO_COLOR", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start {}: {e}", sink.request.runtime.name))?;
        let input = child.stdin.take().ok_or("Native stdin unavailable")?;
        let output = child.stdout.take().ok_or("Native stdout unavailable")?;
        let stderr = child.stderr.take().ok_or("Native stderr unavailable")?;
        sink.event(
            "started",
            format!("{} native connection started", sink.request.runtime.name),
            None,
        );
        if !sink.request.additional_directories.is_empty() {
            sink.output("stdout", format!("{}\n",serde_json::json!({"type":"runtime.workspace_context","primaryDirectory":sink.request.directory,"additionalDirectories":sink.request.additional_directories})).as_bytes());
        }
        let (session, reader): (Arc<dyn NativeSession>, thread::JoinHandle<()>) =
            match sink.request.runtime.adapter.as_str() {
                "codex" => {
                    let session = codex::CodexSession::new(input, sink.clone());
                    let reader = session.begin(output);
                    (session, reader)
                }
                "kimi" => {
                    let session = kimi::KimiSession::new(input, sink.clone(), self.storage.clone());
                    let reader = session.begin(output);
                    (session, reader)
                }
                "claude" => {
                    let session = claude::ClaudeSession::new(input, sink.clone());
                    let reader = session.begin(output);
                    (session, reader)
                }
                "pi" => {
                    let session = pi_rpc::PiSession::new(input, sink.clone());
                    let reader = session.begin(output);
                    (session, reader)
                }
                _ => unreachable!(),
            };
        let control = Arc::new(Running {
            pid: Some(child.id()),
            stop: AtomicBool::new(false),
            done: (Mutex::new(false), Condvar::new()),
            native: Mutex::new(Some(session.clone())),
        });
        let route = RoutedSink::new(sink.clone());
        let connection = Arc::new(NativeConnection {
            pid: child.id(),
            owner: (sink.request.task_id.clone(), sink.request.member_id.clone()),
            session,
            route: route.clone(),
            active: Mutex::new(Some(NativeTurn {
                key: key.clone(),
                control: control.clone(),
                sink: sink.clone(),
                stopping_since: None,
            })),
            closing: AtomicBool::new(false),
            done: (Mutex::new(false), Condvar::new()),
        });
        processes.insert(key, control);
        connections.insert(scope.clone(), connection.clone());
        drop(processes);
        drop(connections);
        let process_map = self.processes.clone();
        let connection_map = self.connections.clone();
        thread::spawn(move || {
            let stderr_reader = thread::spawn(move || {
                let mut stderr = stderr;
                let mut buffer = [0_u8; 4096];
                let mut pending = Vec::with_capacity(4099);
                while let Ok(count) = stderr.read(&mut buffer) {
                    if count == 0 {
                        break;
                    }
                    pending.extend_from_slice(&buffer[..count]);
                    let complete = complete_utf8_prefix_len(&pending);
                    for chunk in pending[..complete].split_inclusive(|byte| *byte == b'\n') {
                        route.output("stderr", chunk);
                    }
                    pending.drain(..complete);
                }
                if !pending.is_empty() {
                    route.output("stderr", &pending);
                }
            });
            let mut closing_since = None;
            let mut terminating_since = None;
            let mut idle_since = None;
            loop {
                let mut process_entries = process_map.lock().unwrap_or_else(|e| e.into_inner());
                let mut active = connection.active.lock().unwrap_or_else(|e| e.into_inner());
                if active.is_some() {
                    idle_since = None;
                }
                if let Some(turn) = active.as_mut() {
                    if turn.control.stop.load(Ordering::SeqCst)
                        || turn.sink.disk_failed.load(Ordering::SeqCst)
                    {
                        if turn.stopping_since.is_none() {
                            connection.session.cancel();
                            // Some native transports cannot clear accepted input
                            // queues. Their cancellation marks the connection
                            // disconnected, requiring immediate process cleanup.
                            if connection.session.disconnected() {
                                signal_group(connection.pid, libc::SIGKILL);
                            }
                            turn.stopping_since = Some(Instant::now());
                        }
                        // An unresponsive interrupt cannot leave a live unknown turn.
                        // Close that connection; its prompt is never automatically replayed.
                        if turn
                            .stopping_since
                            .is_some_and(|s| s.elapsed() > Duration::from_secs(2))
                        {
                            connection.closing.store(true, Ordering::SeqCst);
                        }
                    }
                    if connection.session.hard_disconnect() {
                        // Claude has no native clear-queue control. Once its
                        // queued turn is stopped or an early result fails,
                        // reclaim the process before publishing a terminal
                        // Run; a normal close grace period could execute the
                        // remaining native input behind a finished UI.
                        connection.closing.store(true, Ordering::SeqCst);
                        signal_group(connection.pid, libc::SIGKILL);
                        let _ = child.kill();
                        let _ = child.wait();
                        closing_since = Some(Instant::now());
                        terminating_since = Some(Instant::now());
                    }
                    if let Some(outcome) = connection.session.outcome() {
                        let (kind, text) = if turn.sink.disk_failed.load(Ordering::SeqCst) {
                            (
                                "failed",
                                "Native turn stopped because its trace could not be saved".into(),
                            )
                        } else if turn.control.stop.load(Ordering::SeqCst) {
                            (
                                "stopped",
                                "Native turn interrupted; conversation retained".into(),
                            )
                        } else {
                            match outcome {
                                Ok(()) => ("completed", "Native Agent turn completed".into()),
                                Err(error) => ("failed", error),
                            }
                        };
                        process_entries.remove(&turn.key);
                        turn.sink.event(kind, text, None);
                        let (done, changed) = &turn.control.done;
                        *done.lock().unwrap_or_else(|e| e.into_inner()) = true;
                        changed.notify_all();
                        connection.route.deactivate();
                        *active = None;
                        idle_since = Some(Instant::now());
                    }
                }
                // Reclaim idle Agent processes; native history remains on disk
                // and the next explicit user turn resumes its exact session ID.
                if active.is_none()
                    && idle_since.is_some_and(|since| since.elapsed() > Duration::from_secs(300))
                {
                    connection.closing.store(true, Ordering::SeqCst);
                }
                let disconnected = connection.session.disconnected();
                let status = child.try_wait();
                let exited = matches!(status, Ok(Some(_))) || status.is_err();
                if disconnected || exited {
                    connection.closing.store(true, Ordering::SeqCst);
                }
                if connection.closing.load(Ordering::SeqCst) && closing_since.is_none() {
                    connection.session.close();
                    closing_since = Some(Instant::now());
                }
                if connection.closing.load(Ordering::SeqCst) && active.is_none() {
                    connection.session.close();
                }
                // Allow already-written declines/cancellation replies and an
                // advertised session/close acknowledgement to be consumed.
                let may_terminate = closing_since
                    .is_some_and(|s| s.elapsed() > Duration::from_millis(150))
                    && ((active.is_none() && connection.session.ready_to_close())
                        || closing_since.is_some_and(|s| s.elapsed() > Duration::from_secs(2)));
                if may_terminate && terminating_since.is_none() {
                    signal_group(connection.pid, libc::SIGTERM);
                    terminating_since = Some(Instant::now());
                }
                if terminating_since.is_some_and(|s| s.elapsed() > Duration::from_millis(900)) {
                    signal_group(connection.pid, libc::SIGKILL);
                    let _ = child.kill();
                }
                if exited {
                    if let Some(turn) = active.take() {
                        process_entries.remove(&turn.key);
                        let (kind, text) = if turn.control.stop.load(Ordering::SeqCst) {
                            (
                                "stopped",
                                "Native connection closed after interrupt timeout".into(),
                            )
                        } else {
                            ("failed","Native Agent connection disconnected before completing this turn; input was not replayed".into())
                        };
                        turn.sink.event(kind, text, None);
                        let (done, changed) = &turn.control.done;
                        *done.lock().unwrap_or_else(|e| e.into_inner()) = true;
                        changed.notify_all();
                    }
                    break;
                }
                drop(active);
                drop(process_entries);
                thread::sleep(Duration::from_millis(25));
            }
            signal_group(connection.pid, libc::SIGKILL);
            let _ = child.wait();
            let _ = reader.join();
            let _ = stderr_reader.join();
            let mut connections = connection_map.lock().unwrap_or_else(|e| e.into_inner());
            if connections
                .get(&scope)
                .is_some_and(|current| Arc::ptr_eq(current, &connection))
            {
                connections.remove(&scope);
            }
            let (done, changed) = &connection.done;
            *done.lock().unwrap_or_else(|e| e.into_inner()) = true;
            changed.notify_all();
        });
        Ok(())
    }

    pub fn active_turns(&self) -> Result<Vec<ActiveRuntimeTurn>, String> {
        let processes = self
            .processes
            .lock()
            .map_err(|_| "Cannot determine live runtime turn state")?;
        let mut turns: Vec<_> = processes
            .iter()
            .filter_map(|(key, control)| {
                key.split_once(':')
                    .map(|(run_id, member_id)| ActiveRuntimeTurn {
                        run_id: run_id.into(),
                        member_id: member_id.into(),
                        stopping: control.stop.load(Ordering::SeqCst),
                    })
            })
            .collect();
        turns.sort_by(|a, b| (&a.run_id, &a.member_id).cmp(&(&b.run_id, &b.member_id)));
        Ok(turns)
    }

    pub fn steer(&self, run_id: &str, member_id: &str, prompt: &str) -> Result<(), String> {
        for id in [run_id, member_id] {
            validate_id(id)?;
        }
        if prompt.trim().is_empty() || prompt.len() > 1024 * 1024 {
            return Err("Additional input must be nonempty and at most 1 MiB".into());
        }
        let processes = self
            .processes
            .lock()
            .map_err(|_| "Runtime state unavailable")?;
        let control = processes
            .get(&format!("{run_id}:{member_id}"))
            .ok_or("This turn is no longer active")?;
        if control.stop.load(Ordering::SeqCst) {
            return Err("This turn is stopping".into());
        }
        let session = control
            .native
            .lock()
            .map_err(|_| "Native connection unavailable")?
            .clone()
            .ok_or("This runtime does not support input while running")?;
        drop(processes);
        session.steer(prompt)
    }

    /// Keep actual process creation excluded throughout installation or restart.
    /// The process map includes children that are still stopping and draining.
    /// This operation never stops an existing Runtime or changes its task state.
    pub fn while_idle<T>(
        &self,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let _lifecycle = self
            .lifecycle_gate
            .try_lock()
            .map_err(|_| "本机任务正在启动或应用更新正在进行，请稍后重试")?;
        if !self
            .processes
            .lock()
            .map_err(|_| "无法确认本机 Runtime 状态，未安装或重启应用")?
            .is_empty()
        {
            return Err("仍有本机任务正在运行或停止，请等待任务结束后再安装或重启应用".into());
        }
        self.close_native_connections();
        operation()
    }

    pub fn stop(&self, run_id: &str, member_id: Option<&str>) -> Result<(), String> {
        validate_id(run_id)?;
        if let Some(member_id) = member_id {
            validate_id(member_id)?;
        }
        let processes = self
            .processes
            .lock()
            .map_err(|_| "Process manager unavailable")?;
        let mut native_sessions = Vec::new();
        for (key, control) in processes.iter() {
            if key.starts_with(&format!("{run_id}:"))
                && member_id.is_none_or(|id| key == &format!("{run_id}:{id}"))
            {
                control.stop.store(true, Ordering::SeqCst);
                if let Some(session) = control
                    .native
                    .lock()
                    .map_err(|_| "Native protocol state unavailable")?
                    .clone()
                {
                    native_sessions.push((session, control.pid));
                }
            }
        }
        drop(processes);
        for (session, pid) in native_sessions {
            session.cancel();
            if session.disconnected() {
                if let Some(pid) = pid {
                    signal_group(pid, libc::SIGKILL);
                }
            }
        }
        Ok(())
    }

    pub fn respond_permission(
        &self,
        run_id: &str,
        member_id: &str,
        request_id: &str,
        option_id: Option<&str>,
    ) -> Result<(), String> {
        for id in [run_id, member_id, request_id] {
            validate_id(id)?;
        }
        let processes = self
            .processes
            .lock()
            .map_err(|_| "Process manager unavailable")?;
        let control = processes
            .get(&format!("{run_id}:{member_id}"))
            .ok_or("This run is no longer active")?;
        if control.stop.load(Ordering::SeqCst) {
            return Err("This run is stopping".into());
        }
        let native = control
            .native
            .lock()
            .map_err(|_| "Native protocol state unavailable")?
            .clone();
        if let Some(session) = native {
            drop(processes);
            return session.respond(request_id, option_id);
        }
        Err("This runtime does not support permission responses".into())
    }

    fn close_native_connections(&self) {
        let connections: Vec<_> = self
            .connections
            .lock()
            .map(|c| c.values().cloned().collect())
            .unwrap_or_default();
        for c in &connections {
            c.closing.store(true, Ordering::SeqCst);
            c.session.close();
        }
        for c in connections {
            let (done, changed) = &c.done;
            if let Ok(done) = done.lock() {
                let _ = changed.wait_timeout_while(done, Duration::from_secs(4), |done| !*done);
            }
        }
    }

    pub fn shutdown(&self) {
        let controls: Vec<Arc<Running>> = if let Ok(processes) = self.processes.lock() {
            // Mark reservations while holding the same map lock used for their
            // pending-to-process swap. Shutdown cannot miss a newly spawned PID.
            self.shutting_down.store(true, Ordering::SeqCst);
            for control in processes.values() {
                control.stop.store(true, Ordering::SeqCst);
            }
            processes.values().cloned().collect()
        } else {
            self.shutting_down.store(true, Ordering::SeqCst);
            Vec::new()
        };
        self.close_native_connections();
        for control in &controls {
            if control.native.lock().is_ok_and(|session| session.is_none()) {
                signal_running(control, libc::SIGTERM);
            }
        }
        for control in controls {
            let (done, changed) = &control.done;
            if let Ok(done) = done.lock() {
                let _ = changed.wait_timeout_while(done, Duration::from_secs(2), |done| !*done);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::RuntimeConfig;
    use std::sync::mpsc;

    fn request(directory: &std::path::Path, script: &str) -> StartRequest {
        StartRequest {
            task_id: "task-1".into(),
            run_id: "run-1".into(),
            member_id: "member-1".into(),
            runtime: RuntimeConfig {
                id: "fixture".into(),
                name: "Fixture".into(),
                executable: "/bin/sh".into(),
                adapter: "generic".into(),
                enabled: true,
                args: vec![
                    "-c".into(),
                    script.into(),
                    "fixture".into(),
                    "{prompt}".into(),
                ],
                default_model: String::new(),
                permissions: None,
            },
            model: String::new(),
            reasoning_effort: None,
            session_id: None,
            codex_streaming: false,
            directory: directory.to_string_lossy().into_owned(),
            additional_directories: vec![],
            prompt: "literal prompt $(unsafe) ' quoted".into(),
        }
    }

    #[test]
    fn update_installation_guard_preserves_active_and_stopping_children() {
        let directory = tempfile::tempdir().unwrap();
        let manager = RuntimeManager::new(Arc::new(
            Storage::new(directory.path().join("data")).unwrap(),
        ));
        let child = Arc::new(Running {
            pid: None,
            stop: AtomicBool::new(false),
            done: (Mutex::new(false), Condvar::new()),
            native: Mutex::new(None),
        });
        manager
            .processes
            .lock()
            .unwrap()
            .insert("run-1:member-1".into(), child.clone());
        let installed = AtomicBool::new(false);
        for stopping in [false, true] {
            child.stop.store(stopping, Ordering::SeqCst);
            assert!(manager
                .while_idle(|| {
                    installed.store(true, Ordering::SeqCst);
                    Ok(())
                })
                .is_err());
            assert_eq!(manager.processes.lock().unwrap().len(), 1);
            assert_eq!(child.stop.load(Ordering::SeqCst), stopping);
        }
        assert!(!installed.load(Ordering::SeqCst));
    }

    #[test]
    fn update_installation_excludes_runtime_start_and_releases_gate_for_retry() {
        let directory = tempfile::tempdir().unwrap();
        let manager = RuntimeManager::new(Arc::new(
            Storage::new(directory.path().join("data")).unwrap(),
        ));
        manager
            .while_idle(|| {
                let error = manager
                    .start(request(directory.path(), "exit 0"), Arc::new(|_| {}))
                    .unwrap_err();
                assert!(error.contains("应用更新"));
                assert!(manager.processes.lock().unwrap().is_empty());
                Ok(())
            })
            .unwrap();
        assert!(manager
            .while_idle(|| Err::<(), _>("fixture install failed".into()))
            .is_err());
        assert!(manager.while_idle(|| Ok(())).is_ok());
    }

    #[test]
    fn native_resume_uses_exact_id_and_retains_managed_permissions() {
        let mut request = request(std::path::Path::new("/tmp"), "unused");
        request.runtime.args.clear();
        request.runtime.adapter = "codex".into();
        request.session_id = Some("native-session".into());
        request.runtime.permissions = Some(serde_json::from_value(serde_json::json!({"codex":{"sandbox":"read-only","network":"inherit","additionalDirectories":[]}})).unwrap());
        let args = build_arguments(&request).unwrap();
        assert_eq!(args, ["app-server", "--listen", "stdio://"]);
        assert!(!args.iter().any(|arg| arg == "exec" || arg == "resume"));
        // Session IDs and permission policies are sent in correlated RPCs,
        // covered by native fixtures, rather than CLI positional arguments.
        request.runtime.adapter = "claude".into();
        request.runtime.permissions = None;
        let args = build_arguments(&request).unwrap();
        assert!(args.contains(&"--resume=native-session".into()));
        assert!(!args.contains(&"--continue".into()));
        for invalid in ["", "--last", "../other", "contains space"] {
            request.session_id = Some(invalid.into());
            assert!(build_arguments(&request).is_err());
        }
        request.session_id = None;
        for flag in [
            "--continue",
            "--resume=foreign-session",
            "--fork-session",
            "--no-session-persistence",
        ] {
            request.runtime.args = vec![flag.into()];
            assert!(build_arguments(&request).is_err());
        }
    }

    #[test]
    fn traex_default_approval_flags_precede_the_command_and_prompt() {
        let mut request = request(std::path::Path::new("/tmp"), "unused");
        request.runtime.id = "traex".into();
        request.runtime.args = vec!["exec".into(), "--".into(), "{prompt}".into()];
        assert_eq!(
            &build_arguments(&request).unwrap()[..3],
            &["--permission-mode", "bypass_permissions", "exec"]
        );
        request.runtime.permissions =
            Some(serde_json::from_value(serde_json::json!({"generic":{"args":[]}})).unwrap());
        assert_eq!(build_arguments(&request).unwrap()[0], "exec");
    }

    #[test]
    fn dsh_default_permission_mode_is_applied_only_to_its_child_process() {
        let directory = tempfile::tempdir().unwrap();
        let mut request = request(directory.path(), "printf '%s' \"$DSH_PERMISSION_MODE\"");
        request.runtime.id = "deepseek-harness".into();
        let manager = RuntimeManager::new(Arc::new(
            Storage::new(directory.path().join("data")).unwrap(),
        ));
        let (tx, rx) = mpsc::channel();
        manager
            .start(
                request,
                Arc::new(move |event| {
                    let _ = tx.send(event);
                }),
            )
            .unwrap();
        let events = collect_until_terminal(&rx);
        manager.shutdown();
        let expected =
            std::env::var("DSH_PERMISSION_MODE").unwrap_or_else(|_| "danger-full-access".into());
        assert!(events
            .iter()
            .any(|event| event.kind == "stdout" && event.text == expected));
        assert_eq!(events.last().unwrap().kind, "completed");
    }

    #[test]
    fn prompt_and_model_substitution_preserve_argument_boundaries() {
        let mut request = request(std::path::Path::new("/tmp"), "printf '%s' \"$1\"");
        let arguments = build_arguments(&request).unwrap();
        assert_eq!(arguments.last().unwrap(), &request.prompt);
        assert_eq!(
            expand_template("{prompt}/{model}", "literal {model}", "chosen"),
            "literal {model}/chosen"
        );
        request.runtime.adapter = "codex".into();
        request.runtime.args.clear();
        request.model = "test-model".into();
        let arguments = build_arguments(&request).unwrap();
        assert_eq!(arguments, ["app-server", "--listen", "stdio://"]);
        assert!(!arguments.contains(&request.prompt));
        request.runtime.adapter = "generic".into();
        assert!(build_arguments(&request).is_err());
    }

    #[test]
    fn traex_reuses_codex_arguments_for_initial_and_resumed_turns() {
        let mut codex = request(std::path::Path::new("/tmp"), "unused");
        codex.runtime.id = "codex".into();
        codex.runtime.executable = "codex".into();
        codex.runtime.adapter = "codex".into();
        codex.runtime.args.clear();
        codex.model = "shared-model".into();
        codex.reasoning_effort = Some("high".into());
        for session in [None, Some("traex-task-session".to_string())] {
            codex.session_id = session;
            let mut traex = codex.clone();
            traex.runtime.id = "traex".into();
            traex.runtime.executable = "traex".into();
            assert_eq!(
                build_arguments(&traex).unwrap(),
                build_arguments(&codex).unwrap()
            );
            assert!(!build_arguments(&traex).unwrap().contains(&traex.prompt));
        }
    }

    #[test]
    #[ignore = "manual live TraeX inference; uses existing login for two read-only turns"]
    fn installed_traex_native_roundtrip_resumes_context() {
        let directory = tempfile::tempdir().unwrap();
        let manager = RuntimeManager::new(Arc::new(
            Storage::new(directory.path().join("data")).unwrap(),
        ));
        let mut request = request(directory.path(), "unused");
        request.runtime.id = "traex".into();
        request.runtime.executable = resolve("traex")
            .expect("installed TraeX")
            .to_string_lossy()
            .into_owned();
        request.runtime.adapter = "codex".into();
        request.runtime.args.clear();
        request.runtime.permissions = Some(serde_json::from_value(serde_json::json!({"codex":{"sandbox":"read-only","network":"inherit","additionalDirectories":[]}})).unwrap());
        let token = format!("SA-{}", uuid::Uuid::new_v4());
        request.prompt = format!("Remember this token for the next turn: {token}. Reply with only the token. Do not use tools or access files.");
        let mut session = None;
        for turn in 0..2 {
            request.run_id = format!("traex-live-{turn}");
            if turn == 1 {
                request.session_id = session.clone();
                request.prompt = "What token did I ask you to remember in the previous turn? Reply with only that token. Do not use tools or access files.".into();
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
            let deadline = Instant::now() + Duration::from_secs(90);
            let mut events = Vec::new();
            loop {
                let event =
                    match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(event) => event,
                        Err(error) => {
                            manager.shutdown();
                            panic!("TraeX turn {turn} timed out: {error}");
                        }
                    };
                let terminal = matches!(event.kind.as_str(), "completed" | "failed" | "stopped");
                events.push(event);
                if terminal {
                    break;
                }
            }
            let stdout: String = events
                .iter()
                .filter(|event| event.kind == "stdout")
                .map(|event| event.text.as_str())
                .collect();
            let frames: Vec<serde_json::Value> = stdout
                .lines()
                .filter_map(|line| serde_json::from_str(line).ok())
                .collect();
            assert_eq!(
                events.last().unwrap().kind,
                "completed",
                "TraeX process failed"
            );
            let observed = frames
                .iter()
                .find(|frame| frame["type"] == "thread.started")
                .and_then(|frame| frame["thread_id"].as_str())
                .expect("native session id")
                .to_string();
            if let Some(previous) = &session {
                assert_eq!(previous, &observed);
            }
            session = Some(observed);
            assert!(
                frames.iter().any(|frame| frame["type"] == "turn.completed"),
                "missing successful protocol terminal"
            );
            assert!(
                frames.iter().any(|frame| frame["type"] == "item.completed"
                    && frame["item"]["type"] == "agent_message"
                    && frame["item"]["text"]
                        .as_str()
                        .is_some_and(|text| text.trim() == token)),
                "missing remembered token in model reply"
            );
            eprintln!("TraeX live turn {}: process completed, JSONL reply verified, exact session continuity verified", turn + 1);
        }
        manager.shutdown();
    }

    #[test]
    fn claude_requests_partial_stream_json_messages() {
        let mut request = request(std::path::Path::new("/tmp"), "unused");
        request.runtime.adapter = "claude".into();
        request.runtime.args.clear();
        let args = build_arguments(&request).unwrap();
        assert!(args.contains(&"--include-partial-messages".into()));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--output-format", "stream-json"]));
    }

    #[test]
    fn utf8_prefix_only_retains_incomplete_trailing_characters() {
        for (bytes, expected) in [
            (&b"plain"[..], 5),
            (&b"A\xe4"[..], 1),
            (&b"A\xe4\xb8"[..], 1),
            (&b"A\xe4\xb8\xad"[..], 4),
            (&b"\xff\xe4\xb8"[..], 1),
            (&b"\xff\xe4\xb8\xad"[..], 4),
            (&b"\xe4A"[..], 2),
        ] {
            assert_eq!(complete_utf8_prefix_len(bytes), expected);
        }
    }

    #[test]
    fn managed_permissions_precede_prompt_separator_and_generic_args_are_forwarded() {
        let mut request = request(std::path::Path::new("/tmp"), "unused");
        request.runtime.adapter = "codex".into();
        request.runtime.args = vec!["-c".into(), "model_reasoning_effort=high".into()];
        request.runtime.permissions = Some(
            serde_json::from_value(serde_json::json!({
                "codex": {"sandbox":"read-only"}
            }))
            .unwrap(),
        );
        assert!(build_arguments(&request)
            .unwrap()
            .windows(2)
            .any(|pair| pair == ["-c", "model_reasoning_effort=high"]));
        request.runtime.args = vec!["--skip-git-repo-check".into()];
        assert!(
            build_arguments(&request).is_err(),
            "Batch-only flags cannot be silently applied to app-server"
        );
        request.runtime.args.clear();
        assert_eq!(
            build_arguments(&request).unwrap(),
            ["app-server", "--listen", "stdio://"]
        );
        request.runtime.adapter = "generic".into();
        request.runtime.args = vec!["run".into(), "{prompt}".into()];
        request.runtime.permissions = Some(
            serde_json::from_value(serde_json::json!({
                "generic": {"args":["--restricted"]}
            }))
            .unwrap(),
        );
        assert_eq!(
            build_arguments(&request).unwrap(),
            vec!["run", &request.prompt, "--restricted"]
        );
    }

    #[test]
    fn start_request_reasoning_is_optional_and_explicit_effort_precedes_prompt() {
        let old: StartRequest = serde_json::from_value(serde_json::json!({
            "taskId":"task", "runId":"run", "memberId":"member", "runtime": {
                "id":"codex", "name":"Codex", "executable":"codex", "adapter":"codex",
                "enabled":true, "args":[]
            }, "model":"test", "directory":"/tmp", "prompt":"say hi", "outputLimit":65536
        }))
        .unwrap();
        assert!(old.reasoning_effort.is_none());
        let mut request = old;
        request.reasoning_effort = Some("high".into());
        let args = build_arguments(&request).unwrap();
        assert_eq!(args, ["app-server", "--listen", "stdio://"]);
        request.runtime.adapter = "claude".into();
        let args = build_arguments(&request).unwrap();
        assert!(args.windows(2).any(|pair| pair == ["--effort", "high"]));
    }

    #[test]
    #[ignore = "manual installed Codex validation; isolated home and missing authentication prevent model requests"]
    fn installed_codex_passes_non_git_gate_without_auth_or_model_request() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let work = root.path().join("ordinary-folder");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        let executable = resolve("codex").expect("installed Codex");
        let mut request = request(&work, "unused");
        request.runtime.adapter = "codex".into();
        request.runtime.args = vec![
            "--ignore-user-config".into(),
            "-c".into(), "model_provider='super_agents_validation'".into(),
            "-c".into(), "model_providers.super_agents_validation={name='Local validation',base_url='http://127.0.0.1:1/v1',env_key='SUPER_AGENTS_MISSING_TEST_CREDENTIAL',wire_api='responses'}".into(),
        ];
        request.model = "fixture-model".into();
        request.reasoning_effort = Some("high".into());
        let mut args = vec![
            "exec".into(),
            "--json".into(),
            "--skip-git-repo-check".into(),
        ];
        args.extend(request.runtime.args.clone());
        args.push("-".into());
        for skip in [false, true] {
            let mut command = Command::new(&executable);
            command
                .args(
                    args.iter()
                        .filter(|arg| skip || arg.as_str() != "--skip-git-repo-check"),
                )
                .current_dir(&work)
                .env_clear()
                .env("HOME", &home)
                .env("CODEX_HOME", &home)
                .env("PATH", runtime_path())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut child = command.spawn().unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(request.prompt.as_bytes())
                .unwrap();
            let start = Instant::now();
            loop {
                if child.try_wait().unwrap().is_some() {
                    break;
                }
                if start.elapsed() > Duration::from_secs(20) {
                    let _ = child.kill();
                    panic!("Codex local validation timed out");
                }
                thread::sleep(Duration::from_millis(30));
            }
            let output = child.wait_with_output().unwrap();
            assert!(!output.status.success());
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            if skip {
                assert!(!text.contains("Not inside a trusted directory"), "{text}");
                assert!(
                    text.contains("SUPER_AGENTS_MISSING_TEST_CREDENTIAL"),
                    "{text}"
                );
            } else {
                assert!(text.contains("Not inside a trusted directory"), "{text}");
            }
        }
    }

    fn collect_until_terminal(rx: &mpsc::Receiver<RuntimeEvent>) -> Vec<RuntimeEvent> {
        let mut events = Vec::new();
        loop {
            let event = rx
                .recv_timeout(Duration::from_secs(5))
                .expect("Fixture process terminal event");
            let terminal = matches!(event.kind.as_str(), "completed" | "failed" | "stopped");
            events.push(event);
            if terminal {
                return events;
            }
        }
    }

    // The process refuses to write its second chunk or exit until the test has
    // observed its first chunk. This proves live delivery without depending on a
    // sleep duration or treating an EOF flush as successful streaming.
    fn assert_gated_stream(
        before: &str,
        after: &str,
        channel: &str,
        first_text: &str,
        complete_text: &str,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let storage = Arc::new(Storage::new(directory.path().join("data")).unwrap());
        let manager = RuntimeManager::new(storage.clone());
        let gate = directory.path().join("continue");
        let script = format!("{before}; while [ ! -f \"$2\" ]; do sleep 0.01; done; {after}");
        let mut request = request(directory.path(), &script);
        request
            .runtime
            .args
            .push(gate.to_string_lossy().into_owned());
        let (tx, rx) = mpsc::channel();
        manager
            .start(
                request,
                Arc::new(move |event| {
                    let _ = tx.send(event);
                }),
            )
            .unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap().kind,
            "started"
        );
        let first = rx.recv_timeout(Duration::from_secs(2));
        // Release even on failure so a failing assertion leaves no fixture child.
        std::fs::write(&gate, b"continue").unwrap();
        let remaining = collect_until_terminal(&rx);
        manager.shutdown();
        let first = first
            .expect("the first output chunk must arrive while the process is blocked before EOF");
        assert_eq!(first.kind, channel);
        assert_eq!(first.text, first_text);
        assert_eq!(remaining.last().unwrap().kind, "completed");
        let combined: String = std::iter::once(&first)
            .chain(remaining.iter())
            .filter(|event| event.kind == channel)
            .map(|event| event.text.as_str())
            .collect();
        assert_eq!(combined, complete_text);
        let saved =
            std::fs::read_to_string(storage.trace_path("task-1", "run-1", "member-1").unwrap())
                .unwrap();
        let saved: Vec<RuntimeEvent> = saved
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(saved.last().unwrap().kind, "completed");
        assert_eq!(
            saved
                .iter()
                .filter(|event| event.kind == channel)
                .map(|event| event.text.as_str())
                .collect::<String>(),
            complete_text
        );
    }

    #[test]
    fn short_output_without_newline_is_delivered_before_process_exit() {
        assert_gated_stream(
            "printf first",
            "printf second",
            "stdout",
            "first",
            "firstsecond",
        );
        assert_gated_stream(
            "printf first >&2",
            "printf second >&2",
            "stderr",
            "first",
            "firstsecond",
        );
    }

    #[test]
    fn json_fragments_are_delivered_live_and_preserved_in_trace() {
        assert_gated_stream(
            "printf '%s' '{\"type\":\"assistant\",\"content\":\"'",
            "printf '%s\\n' '中文\"}'",
            "stdout",
            "{\"type\":\"assistant\",\"content\":\"",
            "{\"type\":\"assistant\",\"content\":\"中文\"}\n",
        );
    }

    #[test]
    fn split_utf8_flushes_preceding_text_without_corrupting_the_character() {
        assert_gated_stream(
            "printf 'A\\344'",
            "printf '\\270\\255B'",
            "stdout",
            "A",
            "A中B",
        );
    }

    #[test]
    fn incomplete_utf8_at_eof_is_flushed_before_terminal_event() {
        let directory = tempfile::tempdir().unwrap();
        let manager = RuntimeManager::new(Arc::new(
            Storage::new(directory.path().join("data")).unwrap(),
        ));
        let (tx, rx) = mpsc::channel();
        manager
            .start(
                request(directory.path(), "printf 'A\\344'"),
                Arc::new(move |event| {
                    let _ = tx.send(event);
                }),
            )
            .unwrap();
        let events = collect_until_terminal(&rx);
        manager.shutdown();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "stdout")
                .map(|event| event.text.as_str())
                .collect::<String>(),
            "A�"
        );
        assert_eq!(events.last().unwrap().kind, "completed");
    }

    #[test]
    fn fixture_streams_both_channels_and_persists_terminal_status() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Arc::new(Storage::new(directory.path().join("data")).unwrap());
        let manager = RuntimeManager::new(storage.clone());
        let (tx, rx) = mpsc::channel();
        manager
            .start(
                request(
                    directory.path(),
                    "printf '%s\\n' \"$1\"; printf 'warning\\n' >&2; exit 7",
                ),
                Arc::new(move |e| {
                    let _ = tx.send(e);
                }),
            )
            .unwrap();
        let events = collect_until_terminal(&rx);
        assert_eq!(events.first().unwrap().kind, "started");
        assert!(events
            .iter()
            .any(|e| e.kind == "stdout" && e.text.contains("$(unsafe)")));
        assert!(events
            .iter()
            .any(|e| e.kind == "stderr" && e.text == "warning\n"));
        let last = events.last().unwrap();
        assert_eq!(last.kind, "failed");
        assert_eq!(last.exit_code, Some(7));
        let persisted =
            std::fs::read_to_string(storage.trace_path("task-1", "run-1", "member-1").unwrap())
                .unwrap();
        let persisted: Vec<RuntimeEvent> = persisted
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(persisted.len(), events.len());
        assert_eq!(persisted.last().unwrap().id, last.id);
        manager.shutdown();
    }

    #[test]
    fn stop_reaps_process_group() {
        let directory = tempfile::tempdir().unwrap();
        let manager = RuntimeManager::new(Arc::new(
            Storage::new(directory.path().join("data")).unwrap(),
        ));
        let (tx, rx) = mpsc::channel();
        let child_pid_file = directory.path().join("child.pid");
        let script = format!("sleep 30 & echo $! > '{}'; wait", child_pid_file.display());
        manager
            .start(
                request(directory.path(), &script),
                Arc::new(move |e| {
                    let _ = tx.send(e);
                }),
            )
            .unwrap();
        // Creation precedes the shell's write; wait for a complete PID rather
        // than racing an existing but still empty file under parallel tests.
        let child_pid: i32 = (0..100)
            .find_map(|_| {
                let pid = std::fs::read_to_string(&child_pid_file)
                    .ok()
                    .and_then(|text| text.trim().parse().ok());
                if pid.is_none() {
                    thread::sleep(Duration::from_millis(10));
                }
                pid
            })
            .expect("fixture child PID was not written");
        manager.stop("run-1", Some("member-1")).unwrap();
        let events = collect_until_terminal(&rx);
        assert_eq!(events.last().unwrap().kind, "stopped");
        // A briefly orphaned zombie can still exist until launchd reaps it; no running child should remain.
        let output = Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", &child_pid.to_string()])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&output.stdout);
        assert!(
            state.trim().is_empty() || state.trim().starts_with('Z'),
            "surviving process state {state}"
        );
        manager.shutdown();
        assert!(manager.processes.lock().unwrap().is_empty());
    }

    #[test]
    fn output_beyond_legacy_byte_limit_is_delivered_persisted_and_recovered() {
        let directory = tempfile::tempdir().unwrap();
        let manager = RuntimeManager::new(Arc::new(
            Storage::new(directory.path().join("data")).unwrap(),
        ));
        let (tx, rx) = mpsc::channel();
        manager
            .start(
                request(directory.path(), "head -c 100000 /dev/zero | tr '\\0' x"),
                Arc::new(move |e| {
                    let _ = tx.send(e);
                }),
            )
            .unwrap();
        let events = collect_until_terminal(&rx);
        assert_eq!(
            events
                .iter()
                .filter(|e| e.kind == "stdout")
                .map(|e| e.text.len())
                .sum::<usize>(),
            100000
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| e.text.contains("Output limit reached"))
                .count(),
            0
        );
        assert_eq!(events.last().unwrap().kind, "completed");
        let recovered = manager
            .storage
            .load_trace_events(&[crate::types::TraceRef {
                task_id: "task-1".into(),
                run_id: "run-1".into(),
                member_id: "member-1".into(),
            }])
            .unwrap();
        assert_eq!(
            serde_json::to_value(&recovered).unwrap(),
            serde_json::to_value(&events).unwrap()
        );
        manager.shutdown();
    }

    #[test]
    fn output_beyond_legacy_record_limit_keeps_both_channels_and_the_tail() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::new(directory.path().join("data")).unwrap();
        let path = storage.trace_path("task-1", "run-1", "member-1").unwrap();
        let (tx, rx) = mpsc::channel();
        let sink = EventSink {
            request: request(directory.path(), "unused"),
            file: Mutex::new(private_file(&path, true).unwrap()),
            output_lock: Mutex::new(()),
            disk_failed: AtomicBool::new(false),
            callback: Arc::new(move |event| {
                tx.send(event).unwrap();
            }),
        };
        for index in 0..6000 {
            sink.output(
                if index % 2 == 0 { "stdout" } else { "stderr" },
                format!("第 {index} 条完整输出\n").as_bytes(),
            );
        }
        sink.output("stdout", "最后的中文回答🙂\n".as_bytes());
        sink.event("completed", "finished".into(), Some(0));
        let events: Vec<_> = rx.try_iter().collect();
        assert_eq!(events.len(), 6002);
        assert_eq!(events[5999].text, "第 5999 条完整输出\n");
        assert_eq!(events[6000].text, "最后的中文回答🙂\n");
        assert_eq!(events[6001].kind, "completed");
        let recovered = storage
            .load_trace_events(&[crate::types::TraceRef {
                task_id: "task-1".into(),
                run_id: "run-1".into(),
                member_id: "member-1".into(),
            }])
            .unwrap();
        assert_eq!(
            serde_json::to_value(&recovered).unwrap(),
            serde_json::to_value(&events).unwrap()
        );
        assert!(!sink.disk_failed.load(Ordering::SeqCst));
    }

    #[test]
    fn stopping_one_member_keeps_other_members_alive_and_shutdown_reaps_all() {
        let directory = tempfile::tempdir().unwrap();
        let manager = RuntimeManager::new(Arc::new(
            Storage::new(directory.path().join("data")).unwrap(),
        ));
        let first = request(directory.path(), "sleep 30");
        let mut second = first.clone();
        second.member_id = "member-2".into();
        let (tx1, rx1) = mpsc::channel();
        let (tx2, rx2) = mpsc::channel();
        manager
            .start(
                first.clone(),
                Arc::new(move |e| {
                    let _ = tx1.send(e);
                }),
            )
            .unwrap();
        assert!(manager
            .start(first, Arc::new(|_| {}))
            .unwrap_err()
            .contains("already"));
        manager
            .start(
                second,
                Arc::new(move |e| {
                    let _ = tx2.send(e);
                }),
            )
            .unwrap();
        manager.stop("run-1", Some("member-1")).unwrap();
        assert_eq!(collect_until_terminal(&rx1).last().unwrap().kind, "stopped");
        {
            let processes = manager.processes.lock().unwrap();
            let remaining = processes.get("run-1:member-2").unwrap();
            assert!(!remaining.stop.load(Ordering::SeqCst));
            #[cfg(unix)]
            assert_eq!(
                unsafe { libc::kill(remaining.pid.expect("live process PID") as i32, 0) },
                0
            );
        }
        manager.shutdown();
        assert_eq!(collect_until_terminal(&rx2).last().unwrap().kind, "stopped");
        assert!(manager.processes.lock().unwrap().is_empty());
    }

    #[test]
    fn utf8_remains_intact_across_output_chunk_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let manager = RuntimeManager::new(Arc::new(
            Storage::new(directory.path().join("data")).unwrap(),
        ));
        let (tx, rx) = mpsc::channel();
        manager
            .start(
                request(
                    directory.path(),
                    "head -c 8191 /dev/zero | tr '\\0' x; printf '中文\\n'",
                ),
                Arc::new(move |e| {
                    let _ = tx.send(e);
                }),
            )
            .unwrap();
        let events = collect_until_terminal(&rx);
        let text: String = events
            .iter()
            .filter(|e| e.kind == "stdout")
            .map(|e| e.text.as_str())
            .collect();
        assert_eq!(text, format!("{}中文\n", "x".repeat(8191)));
        manager.shutdown();
    }
}

#[cfg(all(test, unix))]
mod pending_start_tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, sync::mpsc};

    #[test]
    fn shutdown_cancels_reserved_generic_start_and_refuses_late_registration() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("generic-pending-fixture");
        fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s' \"$$\" > launched-pid\nwhile :; do sleep 1; done\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let request:StartRequest=serde_json::from_value(serde_json::json!({"taskId":"pending-task","runId":"pending-run","memberId":"pending-member","runtime":{"id":"generic-fixture","name":"Pending generic","executable":executable,"adapter":"generic","enabled":true,"args":["{prompt}"]},"model":"","directory":directory.path(),"prompt":"must not launch"})).unwrap();
        let manager = RuntimeManager::new(Arc::new(
            Storage::new(directory.path().join("data")).unwrap(),
        ));
        let pending = manager.prepare_start(&request).unwrap();
        let waiting_manager = manager.clone();
        let waiting_request = request.clone();
        let (go_tx, go_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            ready_tx.send(()).unwrap();
            go_rx.recv().unwrap();
            waiting_manager.start_prepared(
                waiting_request,
                Arc::new(move |event| {
                    let _ = event_tx.send(event);
                }),
                pending,
            )
        });
        ready_rx.recv().unwrap();
        let ending_manager = manager.clone();
        let shutdown = thread::spawn(move || ending_manager.shutdown());
        let until = Instant::now() + Duration::from_secs(2);
        while !manager.shutting_down.load(Ordering::SeqCst) {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(5));
        }
        assert!(
            manager.prepare_start(&request).is_err(),
            "Shutdown must prevent registrations after its control snapshot"
        );
        go_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_ok());
        shutdown.join().unwrap();
        let event = event_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(event.kind, "stopped");
        assert!(event_rx.try_recv().is_err());
        assert!(!directory.path().join("launched-pid").exists());
        assert!(manager.active_turns().unwrap().is_empty());
    }
}

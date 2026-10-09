mod kimi;
#[cfg(all(test, unix))]
mod kimi_tests;
mod pi;
#[cfg(all(test, unix))]
mod pi_tests;
use crate::{
    discovery::{resolve, runtime_path, signal_group},
    permission, reasoning,
    storage::{private_file, validate_id, Storage},
    types::{RuntimeEvent, StartRequest},
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

struct Running {
    pid: u32,
    stop: AtomicBool,
    done: (Mutex<bool>, Condvar),
    kimi: Mutex<Option<Arc<kimi::KimiSession>>>,
}

#[derive(Clone)]
pub struct RuntimeManager {
    storage: Arc<Storage>,
    processes: Arc<Mutex<HashMap<String, Arc<Running>>>>,
}

struct EventSink {
    request: StartRequest,
    file: Mutex<File>,
    output_lock: Mutex<()>,
    disk_failed: AtomicBool,
    callback: EventCallback,
    pi_outcome: Mutex<pi::Outcome>,
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
        if kind == "stdout" && self.request.runtime.adapter == "pi" {
            self.pi_outcome
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .feed(bytes);
        }
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
    // Directory-global --last/--continue can attach another task's conversation.
    for arg in &request.runtime.args {
        let flag = arg.split('=').next().unwrap_or(arg);
        let conflict = match request.runtime.adapter.as_str() {
            "codex" => matches!(flag, "resume" | "fork" | "--last" | "--all" | "--ephemeral"),
            "claude" => matches!(
                flag,
                "--resume"
                    | "-r"
                    | "--continue"
                    | "-c"
                    | "--session-id"
                    | "--fork-session"
                    | "--no-session-persistence"
            ),
            _ => false,
        };
        if conflict {
            return Err(format!(
                "额外启动参数 {flag} 与任务会话复用冲突；请移除该参数"
            ));
        }
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
    let reasoning_args = reasoning::arguments(
        &request.runtime.adapter,
        request.reasoning_effort.as_deref(),
        &extra,
    )?;
    match request.runtime.adapter.as_str() {
        "codex" => {
            let mut args = vec![
                "exec".into(),
                "--json".into(),
                "--color".into(),
                "never".into(),
                "--skip-git-repo-check".into(),
            ];
            if !model.is_empty() {
                args.extend(["--model".into(), model.into()]);
            }
            args.extend(extra);
            args.extend(permission_args);
            args.extend(reasoning_args);
            if let Some(id) = &request.session_id {
                args.extend(["resume".into(), "--".into(), id.clone(), "-".into()]);
                return Ok(args);
            }
            args.push("--".into());
            args.push("-".into());
            Ok(args)
        }
        "claude" => {
            let mut args = vec![
                "--print".into(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
                "--include-partial-messages".into(),
            ];
            if !model.is_empty() {
                args.extend(["--model".into(), model.into()]);
            }
            if let Some(id) = &request.session_id {
                args.extend(["--resume".into(), id.clone()]);
            }
            args.extend(extra);
            args.extend(permission_args);
            args.extend(reasoning_args);
            args.push("--".into());
            Ok(args)
        }
        "pi" => {
            // Only permit options whose arity is known. Positional arguments and
            // protocol/model/session overrides can silently change the target.
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
                            "Pi 适配器不支持额外参数 {}；模型、会话和协议由应用管理",
                            extra[index]
                        ))
                    }
                }
            }
            let mut args = vec!["--print".into(), "--mode".into(), "json".into()];
            if !model.is_empty() {
                let Some((provider, id)) = model.split_once('/') else {
                    return Err("Pi 模型必须使用 provider/model 格式".into());
                };
                if provider.is_empty()
                    || id.is_empty()
                    || provider.starts_with('-')
                    || id.starts_with('-')
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
            args.extend(extra);
            Ok(args)
        }
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
        }
    }

    pub fn start(&self, request: StartRequest, callback: EventCallback) -> Result<(), String> {
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
        let path = resolve(&request.runtime.executable)?;
        let args = build_arguments(&request)?;
        let key = format!("{}:{}", request.run_id, request.member_id);
        let mut processes = self
            .processes
            .lock()
            .map_err(|_| "Process manager unavailable")?;
        if processes.contains_key(&key) {
            return Err("This member already has an active process for the run".into());
        }
        if processes.len() >= 16 {
            return Err("Maximum of 16 active runtime processes reached".into());
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
            pid: child.id(),
            stop: AtomicBool::new(false),
            done: (Mutex::new(false), Condvar::new()),
            kimi: Mutex::new(None),
        });
        processes.insert(key.clone(), control.clone());
        drop(processes);
        let sink = Arc::new(EventSink {
            request,
            file: Mutex::new(file),
            output_lock: Mutex::new(()),
            disk_failed: AtomicBool::new(false),
            callback,
            pi_outcome: Mutex::new(pi::Outcome::default()),
        });
        sink.event(
            "started",
            format!("{} process started", sink.request.runtime.name),
            None,
        );
        let (kimi_session, prompt_writer) = if sink.request.runtime.adapter == "kimi" {
            (
                child
                    .stdin
                    .take()
                    .map(|input| kimi::KimiSession::new(input, sink.clone(), self.storage.clone())),
                None,
            )
        } else {
            let prompt = sink.request.prompt.clone();
            // Full legacy transcripts can exceed the OS argument-size limit.
            // Feed native text adapters through stdin, preserving every byte.
            (
                None,
                child
                    .stdin
                    .take()
                    .map(|mut input| thread::spawn(move || input.write_all(prompt.as_bytes()))),
            )
        };
        *control
            .kimi
            .lock()
            .map_err(|_| "Kimi protocol state unavailable")? = kimi_session.clone();
        let processes = self.processes.clone();
        thread::spawn(move || {
            let stdout_reader = if let Some(session) = &kimi_session {
                session.begin(stdout)
            } else {
                stream(stdout, sink.clone(), "stdout")
            };
            let stderr_reader = stream(stderr, sink.clone(), "stderr");
            let mut stopping_since = None;
            let status = loop {
                let stopped =
                    control.stop.load(Ordering::SeqCst) || sink.disk_failed.load(Ordering::SeqCst);
                let stopping = stopped
                    || kimi_session
                        .as_ref()
                        .and_then(|session| session.outcome())
                        .is_some();
                if stopping && stopping_since.is_none() {
                    if let Some(session) = &kimi_session {
                        session.cancel();
                    }
                    if kimi_session.is_none() || !stopped {
                        signal_group(control.pid, libc::SIGTERM);
                    }
                    stopping_since = Some(Instant::now());
                }
                if kimi_session.is_some()
                    && stopping_since
                        .is_some_and(|start| start.elapsed() > Duration::from_millis(300))
                {
                    signal_group(control.pid, libc::SIGTERM);
                }
                if stopping_since.is_some_and(|start| start.elapsed() > Duration::from_millis(900))
                {
                    signal_group(control.pid, libc::SIGKILL);
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
            // Runtime ownership includes its child processes, including a background child left after normal exit.
            signal_group(control.pid, libc::SIGKILL);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            let prompt_failed =
                prompt_writer.is_some_and(|writer| !matches!(writer.join(), Ok(Ok(()))));
            let exit_code = status.as_ref().ok().and_then(|s| s.code());
            let (kind, text) = if sink.disk_failed.load(Ordering::SeqCst) {
                (
                    "failed",
                    "Runtime stopped because its trace could not be saved".into(),
                )
            } else if control.stop.load(Ordering::SeqCst) {
                ("stopped", "Runtime stopped".into())
            } else if prompt_failed {
                ("failed", "无法完整发送对话上下文；本次执行未完成".into())
            } else if let Some(session) = &kimi_session {
                match session.outcome() {
                    Some(Ok(())) => ("completed", "Kimi ACP prompt completed".into()),
                    Some(Err(error)) => ("failed", error),
                    None => (
                        "failed",
                        "Kimi ACP exited without a completed prompt".into(),
                    ),
                }
            } else {
                match status {
                    Ok(status) if status.success() && sink.request.runtime.adapter == "pi" => {
                        match sink
                            .pi_outcome
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .finish(sink.request.session_id.as_deref())
                        {
                            Ok(()) => ("completed", "Pi Agent turn completed".into()),
                            Err(error) => ("failed", error),
                        }
                    }
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

    pub fn stop(&self, run_id: &str, member_id: Option<&str>) -> Result<(), String> {
        validate_id(run_id)?;
        if let Some(member_id) = member_id {
            validate_id(member_id)?;
        }
        let processes = self
            .processes
            .lock()
            .map_err(|_| "Process manager unavailable")?;
        for (key, control) in processes.iter() {
            if key.starts_with(&format!("{run_id}:"))
                && member_id.is_none_or(|id| key == &format!("{run_id}:{id}"))
            {
                control.stop.store(true, Ordering::SeqCst);
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
        let session = control
            .kimi
            .lock()
            .map_err(|_| "Kimi protocol state unavailable")?
            .clone()
            .ok_or("This runtime does not support permission responses")?;
        drop(processes);
        session.respond(request_id, option_id)
    }

    pub fn shutdown(&self) {
        let controls: Vec<Arc<Running>> = self
            .processes
            .lock()
            .map(|p| p.values().cloned().collect())
            .unwrap_or_default();
        for control in &controls {
            control.stop.store(true, Ordering::SeqCst);
            if let Ok(session) = control.kimi.lock() {
                if let Some(session) = &*session {
                    session.cancel();
                }
            }
            signal_group(control.pid, libc::SIGTERM);
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
            directory: directory.to_string_lossy().into_owned(),
            prompt: "literal prompt $(unsafe) ' quoted".into(),
        }
    }

    #[test]
    fn native_text_adapters_receive_full_large_context_via_stdin() {
        use std::os::unix::fs::PermissionsExt;
        for adapter in ["codex", "claude"] {
            let directory = tempfile::tempdir().unwrap();
            let executable = directory.path().join("stdin-fixture");
            std::fs::write(
                &executable,
                "#!/bin/sh\ncat > received.txt\nprintf 'complete\\n'\n",
            )
            .unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            let mut request = request(directory.path(), "unused");
            request.runtime.adapter = adapter.into();
            request.runtime.executable = executable.to_string_lossy().into();
            request.runtime.args.clear();
            request.session_id = Some("native-session".into());
            request.prompt = "历史记录-中文\n".repeat(20000);
            let expected = request.prompt.clone();
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
            assert_eq!(events.last().unwrap().kind, "completed");
            assert_eq!(
                std::fs::read_to_string(directory.path().join("received.txt")).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn native_resume_uses_exact_id_and_retains_managed_permissions() {
        let mut request = request(std::path::Path::new("/tmp"), "unused");
        request.runtime.args.clear();
        request.runtime.adapter = "codex".into();
        request.session_id = Some("native-session".into());
        request.runtime.permissions = Some(serde_json::from_value(serde_json::json!({"codex":{"sandbox":"read-only","network":"inherit","additionalDirectories":[]}})).unwrap());
        let args = build_arguments(&request).unwrap();
        let resume = args.iter().position(|arg| arg == "resume").unwrap();
        assert!(args[..resume]
            .windows(2)
            .any(|pair| pair == ["--sandbox", "read-only"]));
        assert_eq!(&args[resume..], &["resume", "--", "native-session", "-"]);
        request.runtime.adapter = "claude".into();
        request.runtime.permissions = None;
        let args = build_arguments(&request).unwrap();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--resume", "native-session"]));
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
        assert_eq!(
            arguments,
            vec![
                "exec",
                "--json",
                "--color",
                "never",
                "--skip-git-repo-check",
                "--model",
                "test-model",
                "--sandbox",
                "danger-full-access",
                "-c",
                "approval_policy=\"never\"",
                "--",
                "-"
            ]
        );
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
        let args = build_arguments(&request).unwrap();
        assert_eq!(
            &args[args.len() - 4..],
            &["--sandbox", "read-only", "--", "-"]
        );
        assert!(args.contains(&"--skip-git-repo-check".into()));
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
        assert_eq!(
            &args[args.len() - 4..],
            &["-c", "model_reasoning_effort=\"high\"", "--", "-"]
        );
        request.runtime.adapter = "claude".into();
        let args = build_arguments(&request).unwrap();
        assert_eq!(&args[args.len() - 3..], &["--effort", "high", "--"]);
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
        let args = build_arguments(&request).unwrap();
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
            pi_outcome: Mutex::new(pi::Outcome::default()),
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
            assert_eq!(unsafe { libc::kill(remaining.pid as i32, 0) }, 0);
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

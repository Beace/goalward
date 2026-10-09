use std::path::Path;

const QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

/// Query the CLI without surfacing stderr, which may contain authentication details.
pub(super) fn query_models(
    executable: &Path,
    args: &[String],
    home: &Path,
) -> Result<String, String> {
    #[cfg(unix)]
    {
        query_with_limits(executable, args, home, QUERY_TIMEOUT, MAX_OUTPUT_BYTES)
    }
    #[cfg(not(unix))]
    {
        let _ = (executable, args, home);
        Err("当前平台暂不支持 Pi 模型查询".into())
    }
}

#[cfg(unix)]
fn query_with_limits(
    executable: &Path,
    args: &[String],
    home: &Path,
    timeout: std::time::Duration,
    max_output: usize,
) -> Result<String, String> {
    use std::{
        io::{ErrorKind, Read},
        os::{fd::AsRawFd, unix::process::CommandExt},
        process::{Child, Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    struct QueryProcess {
        child: Child,
        group_stopped: bool,
    }

    impl QueryProcess {
        fn stop_group(&mut self) {
            if !self.group_stopped {
                crate::discovery::signal_group(self.child.id(), libc::SIGKILL);
                self.group_stopped = true;
            }
        }
    }

    impl Drop for QueryProcess {
        fn drop(&mut self) {
            self.stop_group();
            // Also kill the direct child if it moved out of the original group.
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    let child = Command::new(executable)
        .args(args)
        .current_dir(std::env::temp_dir())
        .env("PI_CODING_AGENT_DIR", home)
        .env("PI_OFFLINE", "1")
        .env("NO_COLOR", "1")
        .env("PATH", crate::discovery::runtime_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|_| "无法启动 Pi 模型查询".to_string())?;
    let mut process = QueryProcess {
        child,
        group_stopped: false,
    };
    let mut stdout = process
        .child
        .stdout
        .take()
        .ok_or_else(|| "无法读取 Pi 模型查询结果".to_string())?;
    let fd = stdout.as_raw_fd();
    // Nonblocking reads keep both the byte limit and deadline enforceable even
    // when a descendant inherits stdout and outlives the main CLI process.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err("无法读取 Pi 模型查询结果".into());
    }

    let started = Instant::now();
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut exited = false;
    loop {
        if started.elapsed() >= timeout {
            return Err("Pi 模型查询超时".into());
        }
        if !exited {
            match process.child.try_wait() {
                Ok(Some(status)) => {
                    process.stop_group();
                    if !status.success() {
                        return Err("Pi 模型查询未成功完成".into());
                    }
                    exited = true;
                }
                Ok(None) => {}
                Err(_) => return Err("无法获取 Pi 模型查询状态".into()),
            }
        }

        match stdout.read(&mut buffer) {
            Ok(0) if exited => break,
            Ok(0) => {}
            Ok(size) => {
                if size > max_output.saturating_sub(output.len()) {
                    return Err("Pi 模型查询结果超过大小限制".into());
                }
                output.extend_from_slice(&buffer[..size]);
                continue;
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                // All bytes already emitted by the exited CLI have been read.
                // Do not wait for EOF from a detached descendant holding the fd.
                if exited {
                    break;
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Err("无法读取 Pi 模型查询结果".into()),
        }
        thread::sleep(Duration::from_millis(10).min(timeout.saturating_sub(started.elapsed())));
    }

    String::from_utf8(output).map_err(|_| "Pi 模型查询结果不是有效的 UTF-8 文本".into())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, time::Duration};

    fn fixture(script: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path().canonicalize().unwrap();
        let executable = home.join("fixture-traex");
        fs::write(&executable, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        (directory, executable, home)
    }

    #[test]
    fn query_preserves_arguments_and_sets_environment_and_working_directory() {
        let (_directory, executable, home) = fixture(
            "printf '%s\\n' \"$#\" \"$1\" \"$2\" \"$3\" \"$PI_CODING_AGENT_DIR\" \"$PWD\" \"$PATH\"\nif read -r line; then exit 7; fi",
        );
        let args = vec!["models".into(), "two words".into(), "$(literal)".into()];
        let result = query_models(&executable, &args, &home).unwrap();
        let expected = format!(
            "3\nmodels\ntwo words\n$(literal)\n{}\n{}\n{}\n",
            home.display(),
            std::env::temp_dir().canonicalize().unwrap().display(),
            crate::discovery::runtime_path().to_string_lossy(),
        );
        assert_eq!(result, expected);
    }

    #[test]
    fn query_returns_only_a_fixed_error_on_failure() {
        let (_directory, executable, home) =
            fixture("printf 'sensitive stdout'\nprintf 'sensitive stderr' >&2\nexit 4");
        assert_eq!(
            query_models(&executable, &[], &home),
            Err("Pi 模型查询未成功完成".into())
        );
    }

    #[test]
    fn query_times_out_and_stops_a_process_holding_stdout() {
        let (_directory, executable, home) = fixture("sleep 30");
        let started = std::time::Instant::now();
        assert_eq!(
            query_with_limits(&executable, &[], &home, Duration::from_millis(80), 1024),
            Err("Pi 模型查询超时".into())
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn query_rejects_oversized_output_without_waiting_for_exit() {
        let (_directory, executable, home) =
            fixture("while :; do printf '01234567890123456789012345678901'; done");
        let started = std::time::Instant::now();
        assert_eq!(
            query_with_limits(&executable, &[], &home, Duration::from_secs(2), 1024),
            Err("Pi 模型查询结果超过大小限制".into())
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn query_allows_output_exactly_at_the_limit() {
        let (_directory, executable, home) = fixture("printf '12345678'");
        assert_eq!(
            query_with_limits(&executable, &[], &home, Duration::from_secs(2), 8),
            Ok("12345678".into())
        );
    }

    #[test]
    fn query_does_not_wait_for_descendant_stdout_after_cli_exits() {
        let (_directory, executable, home) = fixture("sleep 30 &\nprintf '[]'\nexit 0");
        let started = std::time::Instant::now();
        assert_eq!(
            query_with_limits(&executable, &[], &home, Duration::from_secs(2), 1024),
            Ok("[]".into())
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn query_rejects_invalid_utf8() {
        let (_directory, executable, home) = fixture("printf '\\377'");
        assert_eq!(
            query_models(&executable, &[], &home),
            Err("Pi 模型查询结果不是有效的 UTF-8 文本".into())
        );
    }
}

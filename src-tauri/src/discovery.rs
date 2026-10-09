use crate::types::ProbeResult;
#[cfg(unix)]
use std::os::unix::{fs::PermissionsExt, process::CommandExt};
use std::{
    env,
    ffi::OsString,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub fn runtime_path() -> OsString {
    let mut directories: Vec<PathBuf> =
        env::split_paths(&env::var_os("PATH").unwrap_or_default()).collect();
    let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    for relative in [
        ".local/bin",
        ".kimi-code/bin",
        ".cargo/bin",
        ".volta/bin",
        ".bun/bin",
        "Library/pnpm",
        ".fnm/current/bin",
    ] {
        directories.push(home.join(relative));
    }
    for path in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        directories.push(PathBuf::from(path));
    }
    for relative in [
        ".nvm/versions/node",
        ".local/share/fnm/node-versions",
        ".local/share/mise/installs/node",
    ] {
        if let Ok(entries) = fs::read_dir(home.join(relative)) {
            let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            versions.sort_by(|a, b| b.cmp(a));
            for path in versions {
                directories.push(path.join(if relative.contains("fnm") {
                    "installation/bin"
                } else {
                    "bin"
                }));
            }
        }
    }
    let mut unique = Vec::new();
    for directory in directories {
        if !unique.contains(&directory) {
            unique.push(directory);
        }
    }
    env::join_paths(unique).unwrap_or_default()
}

fn executable(path: &Path) -> bool {
    fs::metadata(path)
        .map(|m| {
            #[cfg(unix)]
            {
                m.is_file() && m.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                m.is_file()
            }
        })
        .unwrap_or(false)
}

pub fn resolve(name: &str) -> Result<PathBuf, String> {
    let name = name.trim();
    if name.is_empty() || name.contains('\0') {
        return Err("Runtime executable is empty or invalid".into());
    }
    let expanded = name
        .strip_prefix("~/")
        .and_then(|p| env::var_os("HOME").map(|h| PathBuf::from(h).join(p)))
        .unwrap_or_else(|| PathBuf::from(name));
    if expanded.is_absolute() || name.contains('/') {
        if executable(&expanded) {
            return Ok(expanded);
        }
        return Err(format!(
            "Runtime executable not found or not executable: {name}"
        ));
    }
    env::split_paths(&runtime_path())
        .map(|p| p.join(name))
        .find(|p| executable(p))
        .ok_or_else(|| format!("Runtime executable not found: {name}"))
}

pub fn signal_group(pid: u32, signal: i32) {
    #[cfg(unix)]
    if pid > 1 {
        unsafe {
            libc::kill(-(pid as i32), signal);
        }
    }
}

pub fn probe(name: &str) -> ProbeResult {
    let path = match resolve(name) {
        Ok(path) => path,
        Err(error) => {
            return ProbeResult {
                found: false,
                path: String::new(),
                version: String::new(),
                error: Some(error),
            }
        }
    };
    let mut command = Command::new(&path);
    command
        .arg("--version")
        .env("PATH", runtime_path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    let result = (|| -> Result<String, String> {
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let pid = child.id();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        fn collect(reader: impl Read + Send + 'static) -> thread::JoinHandle<String> {
            thread::spawn(move || {
                let mut data = Vec::new();
                let _ = reader.take(4096).read_to_end(&mut data);
                String::from_utf8_lossy(&data).trim().to_string()
            })
        }
        let out = collect(stdout);
        let err = collect(stderr);
        let start = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break Some(status);
            }
            if start.elapsed() > Duration::from_secs(5) {
                signal_group(pid, libc::SIGKILL);
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            thread::sleep(Duration::from_millis(25));
        };
        signal_group(pid, libc::SIGKILL);
        let output = out.join().unwrap_or_default();
        let error = err.join().unwrap_or_default();
        match status {
            Some(status) if status.success() => Ok(if output.is_empty() { error } else { output }),
            Some(status) => Err(format!("Version probe exited with {status}")),
            None => Err("Version probe timed out after 5 seconds".into()),
        }
    })();
    let (version, error) = match result {
        Ok(version) => (
            version
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap_or_default()
                .chars()
                .filter(|character| !character.is_control())
                .take(160)
                .collect(),
            None,
        ),
        Err(error) => (String::new(), Some(error)),
    };
    ProbeResult {
        found: true,
        path: path.to_string_lossy().into_owned(),
        version,
        error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_and_nonexecutable_runtimes_are_reported() {
        assert!(!probe("goalward-nonexistent-fixture-binary").found);
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("not-executable");
        fs::write(&file, "text").unwrap();
        assert!(!probe(&file.to_string_lossy()).found);
    }

    #[test]
    fn fixture_version_probe_uses_explicit_path() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("fixture-runtime");
        fs::write(&file, "#!/bin/sh\nprintf 'Fixture Runtime 1.2.3\\n'\n").unwrap();
        #[cfg(unix)]
        fs::set_permissions(&file, fs::Permissions::from_mode(0o700)).unwrap();
        let result = probe(&file.to_string_lossy());
        assert!(result.found);
        assert_eq!(result.version, "Fixture Runtime 1.2.3");
        assert!(result.error.is_none());
        assert_eq!(result.path, file.to_string_lossy());
    }
}

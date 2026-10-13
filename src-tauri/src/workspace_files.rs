//! Bounded metadata-only search for composer references. Never reads file content
//! or follows symlinks out of the user-selected working directories.
use serde::Serialize;
use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MAX_VISITED: usize = 30_000;
const MAX_RESULTS: usize = 60;
const MAX_DEPTH: usize = 24;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub root: String,
    pub kind: &'static str,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub entries: Vec<WorkspaceEntry>,
    pub truncated: bool,
}

fn ignored(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | ".next" | ".cache" | ".venv" | "__pycache__"
    )
}

pub fn search(directories: &[String], query: &str) -> Result<SearchResult, String> {
    if directories.is_empty() || directories.len() > 32 {
        return Err("Choose between 1 and 32 working directories".into());
    }
    if query.len() > 1024 {
        return Err("File search query is too long".into());
    }
    let query = query.trim().replace('\\', "/").to_lowercase();
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    for directory in directories {
        if !Path::new(directory).is_absolute() {
            return Err("Working directories must be absolute paths".into());
        }
        let root = Path::new(directory)
            .canonicalize()
            .map_err(|e| format!("Cannot open working directory {directory}: {e}"))?;
        if !root.is_dir() {
            return Err(format!("Working directory is not a folder: {directory}"));
        }
        if seen.insert(root.clone()) {
            roots.push(root);
        }
    }
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut queue: VecDeque<(PathBuf, PathBuf, usize)> = roots
        .into_iter()
        .map(|root| (root.clone(), root, 0))
        .collect();
    let mut candidates = Vec::new();
    let mut paths = HashSet::new();
    // Working roots themselves are folders the user can reference, too.
    for (root, _, _) in &queue {
        let path = root.to_string_lossy().into_owned();
        let name = root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        if query.is_empty() || path.to_lowercase().contains(&query) {
            paths.insert(root.clone());
            candidates.push(WorkspaceEntry {
                name,
                path: path.clone(),
                relative_path: ".".into(),
                root: path,
                kind: "folder",
            });
        }
    }
    let mut visited = 0;
    let mut truncated = false;
    while let Some((root, directory, depth)) = queue.pop_front() {
        if Instant::now() > deadline || visited >= MAX_VISITED {
            truncated = true;
            break;
        }
        let entries = match directory.read_dir() {
            Ok(entries) => entries,
            Err(e) if directory == root => {
                return Err(format!("Cannot list {}: {e}", root.display()))
            }
            Err(_) => {
                truncated = true;
                continue;
            }
        };
        let mut entries = entries
            .take(MAX_VISITED - visited + 1)
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            visited += 1;
            if visited > MAX_VISITED || Instant::now() > deadline {
                truncated = true;
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if ignored(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            // Avoid out-of-root links and recursive cycles, including folder links.
            if kind.is_symlink() || (!kind.is_dir() && !kind.is_file()) {
                continue;
            }
            let path = entry.path();
            let relative = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            if (query.is_empty()
                || relative.to_lowercase().contains(&query)
                || path.to_string_lossy().to_lowercase().contains(&query))
                && paths.insert(path.clone())
            {
                candidates.push(WorkspaceEntry {
                    name,
                    path: path.to_string_lossy().into_owned(),
                    relative_path: relative,
                    root: root.to_string_lossy().into_owned(),
                    kind: if kind.is_dir() { "folder" } else { "file" },
                });
            }
            if kind.is_dir() && depth < MAX_DEPTH {
                queue.push_back((root.clone(), path, depth + 1));
            } else if kind.is_dir() {
                truncated = true;
            }
        }
    }
    candidates.sort_by_key(|entry| {
        let name = entry.name.to_lowercase();
        (
            if name == query {
                0
            } else if name.starts_with(&query) {
                1
            } else {
                2
            },
            entry.kind != "folder",
            name,
            entry.path.clone(),
        )
    });
    truncated |= candidates.len() > MAX_RESULTS;
    candidates.truncate(MAX_RESULTS);
    Ok(SearchResult {
        entries: candidates,
        truncated,
    })
}

#[tauri::command]
pub async fn search_workspace_entries(
    directories: Vec<String>,
    query: String,
) -> Result<SearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || search(&directories, &query))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn searches_multiple_roots_with_unicode_spaces_and_literal_symbols() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        std::fs::create_dir(first.path().join("资料 中文")).unwrap();
        std::fs::write(
            first.path().join("资料 中文").join("报告 $(echo).md"),
            "private content",
        )
        .unwrap();
        std::fs::write(second.path().join("报告.txt"), "other content").unwrap();
        let roots = vec![
            first.path().to_string_lossy().into_owned(),
            second.path().to_string_lossy().into_owned(),
        ];
        let result = search(&roots, "报告").unwrap();
        assert_eq!(result.entries.len(), 2);
        assert!(result.entries.iter().all(|entry| entry.kind == "file"));
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("private content"));
        assert_eq!(search(&roots, "资料").unwrap().entries[0].kind, "folder");
    }
    #[test]
    fn bounds_search_and_excludes_generated_directories() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("node_modules/hidden.md"), "").unwrap();
        for n in 0..70 {
            std::fs::write(dir.path().join(format!("file-{n}.md")), "").unwrap();
        }
        let result = search(&[dir.path().to_string_lossy().into_owned()], "").unwrap();
        assert_eq!(result.entries.len(), MAX_RESULTS);
        assert!(result.truncated);
        assert!(result
            .entries
            .iter()
            .all(|entry| !entry.path.contains("node_modules")));
        assert!(search(&["relative".into()], "").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn does_not_follow_outside_symlinks_or_cycles() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.md"), "").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("outside")).unwrap();
        std::os::unix::fs::symlink(dir.path(), dir.path().join("cycle")).unwrap();
        let result = search(&[dir.path().to_string_lossy().into_owned()], "").unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0].relative_path, ".");
    }
}

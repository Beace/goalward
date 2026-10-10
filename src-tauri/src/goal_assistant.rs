use crate::storage::{private_directory, validate_id, Storage};
use std::{fs, path::Path};

fn owned_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("Goal assistant workspace must be a directory, not a symlink".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => private_directory(path)?,
        Err(error) => return Err(format!("Cannot inspect goal assistant workspace: {error}")),
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect goal assistant workspace: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Goal assistant workspace must be a directory, not a symlink".into());
    }
    Ok(())
}

/// No user path is accepted. A goal owns one private conversation workspace.
pub fn directory(storage: &Storage, goal_id: &str) -> Result<String, String> {
    validate_id(goal_id)?;
    let root = storage
        .root
        .canonicalize()
        .map_err(|error| format!("Cannot resolve app storage: {error}"))?;
    let workspaces = root.join("goal-assistant-workspaces");
    owned_directory(&workspaces)?;
    let directory = workspaces.join(goal_id);
    owned_directory(&directory)?;
    let canonical = directory
        .canonicalize()
        .map_err(|error| format!("Cannot resolve goal assistant workspace: {error}"))?;
    if canonical.parent() != Some(workspaces.as_path()) {
        return Err("Goal assistant workspace escaped app storage".into());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_one_private_absolute_workspace_and_preserves_existing_files() {
        let root = tempfile::tempdir().unwrap();
        let storage = Storage::new(root.path().join("app-data")).unwrap();
        let first = directory(&storage, "goal-a").unwrap();
        assert!(Path::new(&first).is_absolute());
        assert!(Path::new(&first).starts_with(storage.root.canonicalize().unwrap()));
        fs::write(Path::new(&first).join("notes.txt"), "keep").unwrap();
        assert_eq!(directory(&storage, "goal-a").unwrap(), first);
        assert_eq!(
            fs::read_to_string(Path::new(&first).join("notes.txt")).unwrap(),
            "keep"
        );
        assert_ne!(directory(&storage, "goal-b").unwrap(), first);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&first).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[test]
    fn rejects_path_traversal_and_non_directory_targets() {
        let root = tempfile::tempdir().unwrap();
        let storage = Storage::new(root.path().join("app-data")).unwrap();
        for id in ["", "..", "../project", "/tmp/project", "goal/a"] {
            assert!(directory(&storage, id).is_err());
        }
        let base = storage.root.join("goal-assistant-workspaces");
        private_directory(&base).unwrap();
        fs::write(base.join("goal-file"), "keep").unwrap();
        assert!(directory(&storage, "goal-file").is_err());
    }

    #[test]
    fn additive_assistant_metadata_survives_native_projection_and_delta_saves() {
        let root = tempfile::tempdir().unwrap();
        let storage = Storage::new(root.path().join("app-data")).unwrap();
        let state = serde_json::json!({
            "version": 2,
            "goalExplorationInput": "unsent idea",
            "goals": [{"id": "goal-a", "assistant": {"taskId": "assistant-a", "confirmedVersion": 2, "draft": {"title": "keep draft"}}}],
            "tasks": [{"id": "assistant-a", "kind": "goal_assistant", "deadline": "2026-10-30", "delivery": "draft", "requirementsVersion": 2, "messages": [{"id":"message-a","text":"keep conversation"}], "runs": [{"id":"run-a","context":{"goal":{"version":1,"title":"old definition"}}}], "events": [], "results": [{"summary":"old evidence","verdict":"accepted"}]}]
        });
        storage.save(&state).unwrap();
        let mut summary = storage.summary().unwrap().unwrap();
        assert_eq!(summary["goalExplorationInput"], "unsent idea");
        assert_eq!(summary["goals"], state["goals"]);
        assert_eq!(summary["tasks"][0]["kind"], "goal_assistant");
        assert_eq!(summary["tasks"][0]["runs"], state["tasks"][0]["runs"]);
        summary["goals"][0]["assistant"]["input"] = serde_json::json!("edited input");
        storage.save_delta(&summary).unwrap();
        let restored = storage.load().unwrap().unwrap();
        assert_eq!(
            restored["tasks"][0]["messages"],
            state["tasks"][0]["messages"]
        );
        assert_eq!(restored["tasks"][0]["runs"], state["tasks"][0]["runs"]);
        assert_eq!(
            restored["tasks"][0]["results"],
            state["tasks"][0]["results"]
        );
        assert_eq!(restored["tasks"][0]["requirementsVersion"], 2);
        assert_eq!(restored["goals"][0]["assistant"]["input"], "edited input");
        assert_eq!(restored["goalExplorationInput"], "unsent idea");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_goal_or_workspace_parent() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let storage = Storage::new(root.path().join("app-data")).unwrap();
        let outside = root.path().join("project");
        private_directory(&outside).unwrap();
        let base = storage.root.join("goal-assistant-workspaces");
        symlink(&outside, &base).unwrap();
        assert!(directory(&storage, "goal-a").is_err());
        fs::remove_file(&base).unwrap();
        private_directory(&base).unwrap();
        symlink(&outside, base.join("goal-a")).unwrap();
        assert!(directory(&storage, "goal-a").is_err());
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
    }
}

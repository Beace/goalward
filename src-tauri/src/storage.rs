use crate::types::{RuntimeEvent, StorageInfo, TraceRef};
use serde_json::Value;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

#[path = "storage/brand_migration.rs"]
mod brand_migration;
#[path = "storage/workspace.rs"]
mod workspace;

#[allow(unused_imports)]
// Profiling examples include this module without starting the Tauri app.
pub(crate) use brand_migration::migrate_legacy_data;

pub struct Storage {
    pub root: PathBuf,
    workspace: Mutex<Option<workspace::WorkspaceDb>>,
}

pub fn private_directory(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder
        .create(path)
        .map_err(|e| format!("Cannot create data directory: {e}"))
}

pub fn private_file(path: &Path, append: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append);
    #[cfg(unix)]
    options.mode(0o600);
    options
        .open(path)
        .map_err(|e| format!("Cannot open data file: {e}"))
}

pub fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Invalid task, run or member identifier".into());
    }
    Ok(())
}

impl Storage {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        private_directory(&root)?;
        Ok(Self {
            root,
            workspace: Mutex::new(None),
        })
    }

    /// Read-only legacy access, also used by the startup comparison tool.
    #[allow(dead_code)] // Used by the read-only profiling example.
    pub fn load_legacy(&self) -> Result<Option<Value>, String> {
        match fs::read(self.root.join("state.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| format!("Saved state is invalid; file preserved: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("Cannot read saved state: {e}")),
        }
    }

    fn with_workspace<T>(
        &self,
        operation: impl FnOnce(
            &mut workspace::WorkspaceDb,
        ) -> Result<T, Box<dyn std::error::Error + Send + Sync>>,
    ) -> Result<T, String> {
        let mut guard = self
            .workspace
            .lock()
            .map_err(|_| "Storage lock unavailable")?;
        if guard.is_none() {
            *guard = Some(workspace::WorkspaceDb::open(&self.root).map_err(|e| e.to_string())?);
        }
        operation(guard.as_mut().ok_or("Storage unavailable")?).map_err(|e| e.to_string())
    }

    pub fn load(&self) -> Result<Option<Value>, String> {
        self.with_workspace(|db| db.load())
    }

    pub fn summary(&self) -> Result<Option<Value>, String> {
        self.with_workspace(|db| db.summary())
    }

    pub fn event_page(
        &self,
        task_id: &str,
        after: i64,
        through: Option<i64>,
    ) -> Result<Value, String> {
        self.with_workspace(|db| db.event_page(task_id, after, through))
    }

    pub fn save(&self, state: &Value) -> Result<(), String> {
        self.with_workspace(|db| db.save(state, false))
    }

    /// Metadata is a complete projection; events are immutable append-only deltas.
    pub fn save_delta(&self, state: &Value) -> Result<(), String> {
        self.with_workspace(|db| db.save(state, true))
    }

    pub fn trace_path(
        &self,
        task_id: &str,
        run_id: &str,
        member_id: &str,
    ) -> Result<PathBuf, String> {
        for id in [task_id, run_id, member_id] {
            validate_id(id)?;
        }
        let directory = self.root.join("traces").join(task_id).join(run_id);
        private_directory(&directory)?;
        Ok(directory.join(format!("{member_id}.jsonl")))
    }

    pub fn export(&self, task: &Value) -> Result<String, String> {
        let task_id = task
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Task has no identifier")?;
        validate_id(task_id)?;
        let directory = self.root.join("exports");
        private_directory(&directory)?;
        let path = directory.join(format!("{task_id}-{}.json", uuid::Uuid::new_v4()));
        let mut file = private_file(&path, false)?;
        let bytes = serde_json::to_vec_pretty(task).map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("Export failed: {e}"))?;
        Ok(path.to_string_lossy().into_owned())
    }

    #[cfg(test)]
    pub fn load_trace_events(&self, refs: &[TraceRef]) -> Result<Vec<RuntimeEvent>, String> {
        self.load_trace_events_except(refs, &std::collections::HashMap::new())
    }

    /// Validate every journal record, but only send the missing tail across IPC.
    /// IDs are scoped by task, matching the frontend reducer's deduplication.
    pub fn load_trace_events_except(
        &self,
        refs: &[TraceRef],
        known_event_ids: &std::collections::HashMap<String, std::collections::HashSet<String>>,
    ) -> Result<Vec<RuntimeEvent>, String> {
        const MAX_LINE_BYTES: u64 = 64 * 1024;
        if refs.len() > 10_000 {
            return Err("Trace recovery is limited to 10000 member runs per load".into());
        }
        let mut events = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for reference in refs {
            for id in [&reference.task_id, &reference.run_id, &reference.member_id] {
                validate_id(id)?;
            }
            let key = format!(
                "{}:{}:{}",
                reference.task_id, reference.run_id, reference.member_id
            );
            if !seen.insert(key) {
                continue;
            }
            // Construct only known member paths; a read operation must not create missing directories.
            let path = self
                .root
                .join("traces")
                .join(&reference.task_id)
                .join(&reference.run_id)
                .join(format!("{}.jsonl", reference.member_id));
            let file = match File::open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!("Cannot recover trace {}: {error}", path.display()))
                }
            };
            let mut reader = BufReader::new(file);
            let mut line_number = 0;
            loop {
                let mut line = Vec::new();
                let count = reader
                    .by_ref()
                    .take(MAX_LINE_BYTES + 1)
                    .read_until(b'\n', &mut line)
                    .map_err(|e| format!("Cannot read trace {}: {e}", path.display()))?;
                if count == 0 {
                    break;
                }
                line_number += 1;
                // Native output is emitted in bounded chunks; cap a malformed
                // individual record, never the accumulated execution history.
                if count as u64 > MAX_LINE_BYTES {
                    return Err(format!(
                        "Trace recovery limit exceeded at {}; original files preserved",
                        path.display()
                    ));
                }
                let event: RuntimeEvent = serde_json::from_slice(&line).map_err(|e| {
                    format!(
                        "Corrupt trace {} line {line_number}: {e}; original file preserved",
                        path.display()
                    )
                })?;
                if event.task_id != reference.task_id
                    || event.run_id != reference.run_id
                    || event.member_id != reference.member_id
                {
                    return Err(format!(
                        "Trace identity mismatch at {} line {line_number}; original file preserved",
                        path.display()
                    ));
                }
                if !matches!(
                    event.kind.as_str(),
                    "started" | "stdout" | "stderr" | "completed" | "failed" | "stopped"
                ) {
                    return Err(format!(
                        "Unknown trace event at {} line {line_number}; original file preserved",
                        path.display()
                    ));
                }
                if !known_event_ids
                    .get(&reference.task_id)
                    .is_some_and(|ids| ids.contains(&event.id))
                {
                    events.push(event);
                }
            }
        }
        // Stable sort preserves each file's write order when multiple records share one millisecond.
        events.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
        Ok(events)
    }

    pub fn info(&self) -> Result<StorageInfo, String> {
        fn size(path: &Path) -> std::io::Result<u64> {
            let mut bytes = 0;
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                let metadata = entry.metadata()?;
                if entry.file_type()?.is_symlink() {
                    continue;
                }
                bytes += if metadata.is_dir() {
                    size(&entry.path())?
                } else {
                    metadata.len()
                };
            }
            Ok(bytes)
        }
        Ok(StorageInfo {
            path: self.root.to_string_lossy().into_owned(),
            bytes: size(&self.root).map_err(|e| e.to_string())?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_state_can_be_saved_reloaded_and_exported() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::new(directory.path().into()).unwrap();
        let state = serde_json::json!({"id":"task-large", "version":2, "text":"x".repeat(64 * 1024 * 1024 + 1)});
        storage.save(&state).unwrap();
        assert_eq!(storage.load().unwrap().as_ref(), Some(&state));
        let exported = storage.export(&state).unwrap();
        let exported: Value = serde_json::from_reader(File::open(exported).unwrap()).unwrap();
        assert_eq!(exported, state);
    }

    #[test]
    fn state_round_trip_is_atomic_and_invalid_legacy_json_is_not_discarded() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        fs::write(&path, "broken").unwrap();
        let storage = Storage::new(directory.path().into()).unwrap();
        assert!(storage.load().unwrap_err().contains("preserved"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "broken");
        let expected = serde_json::json!({"version":1,"tasks":[{"id":"task-1","text":"中文"}]});
        fs::write(&path, serde_json::to_vec(&expected).unwrap()).unwrap();
        assert_eq!(storage.load().unwrap(), Some(expected));
    }

    #[test]
    fn migration_preserves_original_and_reopens_database_without_reimporting() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        let original = br#"{"version":1,"tasks":[{"id":"history"}]}"#;
        fs::write(&path, original).unwrap();
        let storage = Storage::new(directory.path().into()).unwrap();
        assert_eq!(storage.load().unwrap().unwrap()["version"], 1);
        let updated = serde_json::json!({"version":2,"tasks":[],"goals":[1]});
        storage.save(&updated).unwrap();
        drop(storage);
        assert_eq!(fs::read(&path).unwrap(), original);
        // Legacy files are rollback inputs, never a competing source after migration.
        fs::write(&path, "unreadable legacy changed by an old app").unwrap();
        let storage = Storage::new(directory.path().into()).unwrap();
        assert_eq!(storage.load().unwrap(), Some(updated));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory.path().join("workspace.sqlite3"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    fn sample_state() -> Value {
        serde_json::json!({"version":2,"settings":{"theme":"dark"},"tasks":[{
            "id":"task", "title":"中文", "messages":[{"id":"message","text":"hello"}],
            "runs":[{"id":"run"}],"artifacts":[], "events":[
                {"id":"event-1","taskId":"task","runId":"run","memberId":"member","timestamp":"same","kind":"stdout","text":"first"},
                {"id":"event-2","taskId":"task","runId":"run","memberId":"member","timestamp":"same","kind":"stdout","text":"second"}
            ]
        }]})
    }

    #[test]
    fn summary_preserves_metadata_and_delta_save_does_not_erase_deferred_history() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::new(directory.path().into()).unwrap();
        let original = sample_state();
        storage.save(&original).unwrap();
        let mut summary = storage.summary().unwrap().unwrap();
        let mut expected = original.clone();
        expected["tasks"][0]["events"] = serde_json::json!([]);
        expected["tasks"][0]["historyPending"] = true.into();
        assert_eq!(summary, expected);
        summary["tasks"][0]["title"] = "edited before loading history".into();
        storage.save_delta(&summary).unwrap();
        let mut expected = original;
        expected["tasks"][0]["title"] = summary["tasks"][0]["title"].clone();
        assert_eq!(storage.load().unwrap(), Some(expected));
    }

    #[test]
    fn event_pages_are_bounded_ordered_and_exclude_appends_after_the_first_page() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::new(directory.path().into()).unwrap();
        let mut state = sample_state();
        let template = state["tasks"][0]["events"][0].clone();
        let history: Vec<Value> = (0..600)
            .map(|index| {
                let mut event = template.clone();
                event["id"] = format!("event-{index}").into();
                event["text"] = "x".repeat(4096).into();
                event
            })
            .collect();
        state["tasks"][0]["events"] = serde_json::json!(history);
        storage.save(&state).unwrap();
        let first = storage.event_page("task", -1, None).unwrap();
        assert_eq!(first["through"], 599);
        let mut appended = template;
        appended["id"] = "appended".into();
        state["tasks"][0]["events"] = serde_json::json!([appended]);
        storage.save_delta(&state).unwrap();
        let mut page = first;
        let mut restored = Vec::new();
        loop {
            let events = page["events"].as_array().unwrap();
            assert!(events.len() <= 256);
            assert!(
                events
                    .iter()
                    .map(|event| serde_json::to_vec(event).unwrap().len())
                    .sum::<usize>()
                    <= 512 * 1024
            );
            restored.extend(events.iter().cloned());
            let Some(next) = page["next"].as_i64() else {
                break;
            };
            page = storage.event_page("task", next, Some(599)).unwrap();
        }
        assert_eq!(restored, history);
        let tail = storage.event_page("task", 599, None).unwrap();
        assert_eq!(tail["events"][0]["id"], "appended");
        assert!(tail["next"].is_null());
        assert!(storage.event_page("../escape", -1, None).is_err());
        assert!(storage.event_page("task", -2, None).is_err());
        assert!(storage.event_page("task", -1, Some(-2)).is_err());
    }

    #[test]
    fn empty_projection_with_runs_still_requires_journal_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::new(directory.path().into()).unwrap();
        let mut state = sample_state();
        state["tasks"][0]["events"] = serde_json::json!([]);
        storage.save(&state).unwrap();
        assert_eq!(
            storage.summary().unwrap().unwrap()["tasks"][0]["historyPending"],
            true
        );
        let page = storage.event_page("task", -1, None).unwrap();
        assert_eq!(page["events"], serde_json::json!([]));
        assert!(page["next"].is_null());
        state["tasks"][0]["runs"] = serde_json::json!([]);
        storage.save(&state).unwrap();
        assert!(storage.summary().unwrap().unwrap()["tasks"][0]
            .get("historyPending")
            .is_none());
    }

    #[test]
    fn append_is_idempotent_ordered_and_metadata_updates_never_touch_history() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::new(directory.path().into()).unwrap();
        let original = sample_state();
        storage.save(&original).unwrap();
        let mut delta = original.clone();
        delta["tasks"][0]["events"] = serde_json::json!([]);
        delta["settings"]["theme"] = "changed".into();
        let connection =
            rusqlite::Connection::open(directory.path().join("workspace.sqlite3")).unwrap();
        connection.execute_batch("CREATE TRIGGER no_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'history rewritten'); END;
            CREATE TRIGGER no_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'history deleted'); END;").unwrap();
        storage.save_delta(&delta).unwrap();
        let loaded = storage.load().unwrap().unwrap();
        assert_eq!(loaded["tasks"], original["tasks"]);
        assert_eq!(loaded["settings"]["theme"], "changed");
        // A committed request whose reply was lost can be retried safely.
        storage.save_delta(&original).unwrap();
        assert_eq!(storage.load().unwrap(), Some(original.clone()));
        let mut event = original["tasks"][0]["events"][0].clone();
        event["id"] = "event-3".into();
        delta["tasks"][0]["events"] = serde_json::json!([event]);
        storage.save_delta(&delta).unwrap();
        storage.save_delta(&delta).unwrap();
        let loaded = storage.load().unwrap().unwrap();
        assert_eq!(
            loaded["tasks"][0]["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["event-1", "event-2", "event-3"]
        );
    }

    #[test]
    fn failed_delta_rolls_back_metadata_and_all_prior_inserts() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::new(directory.path().into()).unwrap();
        let original = sample_state();
        storage.save(&original).unwrap();
        let mut delta = original.clone();
        delta["settings"]["theme"] = "must roll back".into();
        delta["tasks"][0]["events"][0]["id"] = "new-event".into();
        delta["tasks"][0]["events"][1]["text"] = "conflicts with immutable record".into();
        assert!(storage
            .save_delta(&delta)
            .unwrap_err()
            .contains("Conflicting"));
        let mut duplicate = original.clone();
        duplicate["tasks"][0]["events"]
            .as_array_mut()
            .unwrap()
            .push(original["tasks"][0]["events"][0].clone());
        assert!(storage
            .save(&duplicate)
            .unwrap_err()
            .contains("Duplicate event"));
        drop(storage);
        assert_eq!(
            Storage::new(directory.path().into())
                .unwrap()
                .load()
                .unwrap(),
            Some(original)
        );
    }

    #[test]
    fn incomplete_migration_retries_and_task_deletion_cascades() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::new(directory.path().into()).unwrap();
        let original = sample_state();
        let mut invalid = original.clone();
        invalid["tasks"][0]["events"][1]["taskId"] = "wrong-task".into();
        let path = directory.path().join("state.json");
        let bytes = serde_json::to_vec(&invalid).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(storage.load().is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let db = rusqlite::Connection::open(directory.path().join("workspace.sqlite3")).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM events", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
        assert_eq!(storage.load().unwrap(), Some(original));
        storage
            .save_delta(&serde_json::json!({"version":2,"tasks":[]}))
            .unwrap();
        for table in ["tasks", "task_collections", "events"] {
            assert_eq!(
                db.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn newer_or_corrupt_database_never_falls_back_to_stale_legacy() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("state.json"),
            serde_json::to_vec(&sample_state()).unwrap(),
        )
        .unwrap();
        let path = directory.path().join("workspace.sqlite3");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.pragma_update(None, "user_version", 99).unwrap();
        drop(db);
        let storage = Storage::new(directory.path().into()).unwrap();
        assert!(storage.load().unwrap_err().contains("newer"));
        fs::write(&path, b"invalid database").unwrap();
        assert!(storage.load().is_err());
        assert_eq!(fs::read(&path).unwrap(), b"invalid database");
    }

    #[test]
    fn paths_cannot_escape_storage() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::new(directory.path().into()).unwrap();
        assert!(storage.trace_path("../outside", "run", "member").is_err());
        assert!(storage
            .export(&serde_json::json!({"id":"../../outside"}))
            .is_err());
    }

    #[test]
    fn journal_tail_recovers_into_database_once_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::new(directory.path().into()).unwrap();
        let original = sample_state();
        storage.save(&original).unwrap();
        let path = storage.trace_path("task", "run", "member").unwrap();
        let event = serde_json::json!({"id":"tail","taskId":"task","runId":"run","memberId":"member","timestamp":"2026-09-17T00:00:00Z","kind":"completed","text":"done","exitCode":0});
        let mut journal = private_file(&path, true).unwrap();
        writeln!(journal, "{event}").unwrap();
        journal.sync_all().unwrap();
        drop(storage);
        let storage = Storage::new(directory.path().into()).unwrap();
        let refs = [TraceRef {
            task_id: "task".into(),
            run_id: "run".into(),
            member_id: "member".into(),
        }];
        let mut known = std::collections::HashMap::from([(
            "task".into(),
            std::collections::HashSet::from(["event-1".into(), "event-2".into()]),
        )]);
        let tail = storage.load_trace_events_except(&refs, &known).unwrap();
        assert_eq!(tail.len(), 1);
        let mut delta = original.clone();
        delta["tasks"][0]["events"] = serde_json::to_value(&tail).unwrap();
        storage.save_delta(&delta).unwrap();
        drop(storage);
        let storage = Storage::new(directory.path().into()).unwrap();
        let loaded = storage.load().unwrap().unwrap();
        let events = loaded["tasks"][0]["events"].as_array().unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[2]["id"], "tail");
        known.get_mut("task").unwrap().insert("tail".into());
        assert!(storage
            .load_trace_events_except(&refs, &known)
            .unwrap()
            .is_empty());
        assert_eq!(fs::read_to_string(path).unwrap(), format!("{event}\n"));
    }

    #[test]
    fn recovery_reads_missing_state_tail_and_preserves_terminal_order() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Storage::new(directory.path().into()).unwrap();
        let refs = vec![TraceRef {
            task_id: "task-1".into(),
            run_id: "run-1".into(),
            member_id: "member-1".into(),
        }];
        let path = storage.trace_path("task-1", "run-1", "member-1").unwrap();
        let mut file = private_file(&path, true).unwrap();
        for (index, kind) in ["started", "stdout", "stopped"].into_iter().enumerate() {
            let event = RuntimeEvent {
                id: index.to_string(),
                task_id: "task-1".into(),
                run_id: "run-1".into(),
                member_id: "member-1".into(),
                timestamp: "2026-09-15T10:00:00.000Z".into(),
                kind: kind.into(),
                text: "actual output".into(),
                exit_code: None,
            };
            serde_json::to_writer(&mut file, &event).unwrap();
            file.write_all(b"\n").unwrap();
        }
        file.sync_all().unwrap();
        let recovered = storage.load_trace_events(&refs).unwrap();
        let known = std::collections::HashMap::from([(
            "task-1".to_string(),
            std::collections::HashSet::from(["0".to_string(), "1".to_string()]),
        )]);
        let missing = storage.load_trace_events_except(&refs, &known).unwrap();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].kind, "stopped");
        let other_task = std::collections::HashMap::from([(
            "other-task".to_string(),
            std::collections::HashSet::from(["0".to_string(), "1".to_string()]),
        )]);
        assert_eq!(
            storage
                .load_trace_events_except(&refs, &other_task)
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            recovered
                .iter()
                .map(|e| e.kind.as_str())
                .collect::<Vec<_>>(),
            ["started", "stdout", "stopped"]
        );
        assert_eq!(
            storage
                .load_trace_events(&[refs[0].clone(), refs[0].clone()])
                .unwrap()
                .len(),
            3
        );
        assert!(storage
            .load_trace_events(&[TraceRef {
                member_id: "absent".into(),
                ..refs[0].clone()
            }])
            .unwrap()
            .is_empty());
        let original = fs::read(&path).unwrap();
        file.write_all(b"{broken partial").unwrap();
        file.sync_all().unwrap();
        assert!(storage
            .load_trace_events_except(&refs, &known)
            .unwrap_err()
            .contains("original file preserved"));
        assert!(storage
            .load_trace_events(&refs)
            .unwrap_err()
            .contains("original file preserved"));
        assert_eq!(fs::read(&path).unwrap().len(), original.len() + 15);
        assert!(storage
            .load_trace_events(&[TraceRef {
                task_id: "../escape".into(),
                ..refs[0].clone()
            }])
            .is_err());
    }
}

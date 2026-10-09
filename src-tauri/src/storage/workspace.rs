//! Transactional workspace projection. Native JSONL journals remain the durable
//! write-ahead source for runtime events that have not reached this projection.
use super::private_file;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{Map, Value};
use std::{collections::HashSet, path::Path, time::Duration};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub(super) struct WorkspaceDb {
    connection: Connection,
}

impl WorkspaceDb {
    pub(super) fn open(root: &Path) -> Result<Self> {
        let path = root.join("workspace.sqlite3");
        // SQLite inherits these permissions for its rollback journal as well.
        drop(private_file(&path, true)?);
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
        let version: u32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > 1 {
            return Err("Workspace database is newer than this application; preserved".into());
        }
        connection.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE IF NOT EXISTS storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS workspace_fields (key TEXT PRIMARY KEY, json TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, position INTEGER NOT NULL, json TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS task_collections (
               task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
               field TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(task_id,field));
             CREATE TABLE IF NOT EXISTS events (
               task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
               event_id TEXT NOT NULL, position INTEGER NOT NULL,
               run_id TEXT NOT NULL, member_id TEXT NOT NULL, json TEXT NOT NULL,
               PRIMARY KEY(task_id,event_id));
             CREATE INDEX IF NOT EXISTS events_task_order ON events(task_id,position);
             CREATE INDEX IF NOT EXISTS events_run_order ON events(task_id,run_id,position);
             PRAGMA user_version=1;
             COMMIT;",
        )?;
        let initialized = Self::initialized(&connection)?;
        if !initialized {
            match std::fs::read(root.join("state.json")) {
                Ok(bytes) => {
                    let state: Value = serde_json::from_slice(&bytes)
                        .map_err(|e| format!("Saved state is invalid; file preserved: {e}"))?;
                    // Import and the completion marker share one transaction. A
                    // failed/interrupted import is retried; the source is never changed.
                    let transaction =
                        connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                    // Another process may have completed the import while this
                    // connection waited for the writer lock.
                    if !Self::initialized(&transaction)? {
                        Self::write(&transaction, &state, false)?;
                    }
                    transaction.commit()?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(format!("Cannot read migration source; preserved: {e}").into())
                }
            }
        }
        Ok(Self { connection })
    }

    fn initialized(connection: &Connection) -> Result<bool> {
        Ok(connection
            .query_row(
                "SELECT value FROM storage_meta WHERE key='initialized'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .is_some())
    }

    pub(super) fn load(&self) -> Result<Option<Value>> {
        self.read_state(true)
    }

    pub(super) fn summary(&self) -> Result<Option<Value>> {
        self.read_state(false)
    }

    fn read_state(&self, include_events: bool) -> Result<Option<Value>> {
        if !Self::initialized(&self.connection)? {
            return Ok(None);
        }
        // A single read transaction prevents another process committing between
        // the metadata and history reads.
        let transaction = self.connection.unchecked_transaction()?;
        let mut state = Map::new();
        {
            let mut statement = transaction.prepare("SELECT key,json FROM workspace_fields")?;
            for row in statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })? {
                let (key, json) = row?;
                state.insert(key, serde_json::from_str(&json)?);
            }
        }
        if state.contains_key("tasks") {
            let mut tasks = Vec::new();
            let mut statement =
                transaction.prepare("SELECT id,json FROM tasks ORDER BY position")?;
            let mut collections =
                transaction.prepare("SELECT field,json FROM task_collections WHERE task_id=?1")?;
            let mut events = transaction
                .prepare("SELECT json FROM events WHERE task_id=?1 ORDER BY position")?;
            for row in statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })? {
                let (id, json) = row?;
                let mut task: Value = serde_json::from_str(&json)?;
                for row in collections.query_map([&id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })? {
                    let (field, json) = row?;
                    task[&field] = serde_json::from_str(&json)?;
                }
                if include_events && task.get("events").is_some() {
                    let mut history = Vec::new();
                    for row in events.query_map([&id], |row| row.get::<_, String>(0))? {
                        history.push(serde_json::from_str(&row?)?);
                    }
                    task["events"] = Value::Array(history);
                } else if !include_events {
                    task["events"] = serde_json::json!([]);
                    // Even an empty projection may have a journal tail after a crash.
                    let has_events: bool = transaction.query_row(
                        "SELECT EXISTS(SELECT 1 FROM events WHERE task_id=?1)",
                        [&id],
                        |row| row.get(0),
                    )?;
                    let has_runs = task["runs"].as_array().is_some_and(|runs| !runs.is_empty());
                    if has_events || has_runs {
                        task["historyPending"] = Value::Bool(true);
                    }
                }
                tasks.push(task);
            }
            state.insert("tasks".into(), Value::Array(tasks));
        }
        transaction.commit()?;
        Ok(Some(Value::Object(state)))
    }

    /// Bounded IPC pages, with a stable upper position captured on the first page.
    pub(super) fn event_page(
        &self,
        task_id: &str,
        after: i64,
        through: Option<i64>,
    ) -> Result<Value> {
        super::validate_id(task_id)?;
        if after < -1 {
            return Err("Invalid history cursor".into());
        }
        let transaction = self.connection.unchecked_transaction()?;
        let through = match through {
            Some(value) if value >= -1 => value,
            Some(_) => return Err("Invalid history boundary".into()),
            None => transaction.query_row(
                "SELECT COALESCE(MAX(position),-1) FROM events WHERE task_id=?1",
                [task_id],
                |row| row.get(0),
            )?,
        };
        let mut statement = transaction.prepare("SELECT position,json FROM events WHERE task_id=?1 AND position>?2 AND position<=?3 ORDER BY position LIMIT 256")?;
        let mut rows = statement.query(params![task_id, after, through])?;
        let mut events = Vec::new();
        let mut bytes = 0;
        let mut cursor = after;
        while let Some(row) = rows.next()? {
            let json: String = row.get(1)?;
            if !events.is_empty() && bytes + json.len() > 512 * 1024 {
                break;
            }
            // A single legacy record may exceed the target; never truncate it.
            bytes += json.len();
            cursor = row.get(0)?;
            events.push(serde_json::from_str::<Value>(&json)?);
        }
        Ok(
            serde_json::json!({"events": events, "through": through, "next": if cursor < through && cursor > after { Some(cursor) } else { None }}),
        )
    }

    pub(super) fn save(&mut self, state: &Value, append_events: bool) -> Result<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::write(&transaction, state, append_events)?;
        transaction.commit()?;
        Ok(())
    }

    fn write(transaction: &Transaction<'_>, state: &Value, append_events: bool) -> Result<()> {
        let fields = state.as_object().ok_or("Workspace must be an object")?;
        let existing: Vec<String> = transaction
            .prepare("SELECT key FROM workspace_fields")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for key in existing {
            if !fields.contains_key(&key) {
                transaction.execute("DELETE FROM workspace_fields WHERE key=?1", [&key])?;
            }
        }
        for (key, value) in fields {
            let json = if key == "tasks" {
                "[]".into()
            } else {
                serde_json::to_string(value)?
            };
            transaction.execute("INSERT INTO workspace_fields(key,json) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET json=excluded.json WHERE json<>excluded.json", params![key,json])?;
        }
        let tasks = match state.get("tasks") {
            Some(value) => value
                .as_array()
                .ok_or("Workspace tasks must be an array")?
                .as_slice(),
            None => &[],
        };
        let mut ids = HashSet::new();
        let mut insert_event = transaction.prepare("INSERT INTO events(task_id,event_id,position,run_id,member_id,json) VALUES(?1,?2,?3,?4,?5,?6)")?;
        let mut existing_event =
            transaction.prepare("SELECT json FROM events WHERE task_id=?1 AND event_id=?2")?;
        for (position, task) in tasks.iter().enumerate() {
            let mut metadata: Map<String, Value> = task
                .as_object()
                .ok_or("Task must be an object")?
                .iter()
                .filter(|(key, _)| {
                    !matches!(
                        key.as_str(),
                        "events" | "messages" | "runs" | "artifacts" | "historyPending"
                    )
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            let id = task["id"].as_str().ok_or("Task has no identifier")?;
            super::validate_id(id)?;
            if !ids.insert(id) {
                return Err("Duplicate task identifier".into());
            }
            let history = task.get("events");
            if history.is_some() {
                metadata.insert("events".into(), Value::Array(Vec::new()));
            }
            let collections: Vec<_> = ["messages", "runs", "artifacts"]
                .into_iter()
                .filter_map(|field| task.get(field).map(|value| (field, value)))
                .collect();
            transaction.execute("INSERT INTO tasks(id,position,json) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET position=excluded.position,json=excluded.json WHERE position<>excluded.position OR json<>excluded.json", params![id,i64::try_from(position)?,serde_json::to_string(&metadata)?])?;
            for field in ["messages", "runs", "artifacts"] {
                match collections.iter().find(|(key, _)| *key == field) {
                    Some((_, value)) => {
                        transaction.execute("INSERT INTO task_collections(task_id,field,json) VALUES(?1,?2,?3) ON CONFLICT(task_id,field) DO UPDATE SET json=excluded.json WHERE json<>excluded.json",params![id,field,serde_json::to_string(value)?])?;
                    }
                    None => {
                        transaction.execute(
                            "DELETE FROM task_collections WHERE task_id=?1 AND field=?2",
                            params![id, field],
                        )?;
                    }
                }
            }
            if !append_events {
                transaction.execute("DELETE FROM events WHERE task_id=?1", [id])?;
            }
            if let Some(history) = history {
                let history = history.as_array().ok_or("Task events must be an array")?;
                if history.is_empty() {
                    continue;
                }
                let mut sequence: i64 = transaction.query_row(
                    "SELECT COALESCE(MAX(position),-1)+1 FROM events WHERE task_id=?1",
                    [id],
                    |row| row.get(0),
                )?;
                for event in history {
                    let event_id = event["id"].as_str().ok_or("Event has no identifier")?;
                    if event["taskId"].as_str() != Some(id) {
                        return Err("Event does not belong to its task".into());
                    }
                    let run_id = event["runId"].as_str().ok_or("Event has no run")?;
                    let member_id = event["memberId"].as_str().ok_or("Event has no member")?;
                    let json = serde_json::to_string(event)?;
                    if let Some(previous) = existing_event
                        .query_row(params![id, event_id], |row| row.get::<_, String>(0))
                        .optional()?
                    {
                        if !append_events {
                            return Err(
                                "Duplicate event identifier in snapshot; source preserved".into()
                            );
                        }
                        if previous != json {
                            return Err(
                                "Conflicting immutable event; existing history preserved".into()
                            );
                        }
                        continue;
                    }
                    insert_event
                        .execute(params![id, event_id, sequence, run_id, member_id, json])?;
                    sequence += 1;
                }
            }
        }
        let existing: Vec<String> = transaction
            .prepare("SELECT id FROM tasks")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for id in existing {
            if !ids.contains(id.as_str()) {
                transaction.execute("DELETE FROM tasks WHERE id=?1", [id])?;
            }
        }
        transaction.execute(
            "INSERT OR IGNORE INTO storage_meta(key,value) VALUES('initialized','1')",
            [],
        )?;
        Ok(())
    }
}

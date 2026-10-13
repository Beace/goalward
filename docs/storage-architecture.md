# Layered local storage and incremental persistence

Implemented on 2026-09-17. Desktop storage uses SQLite schema 1; the application data structure remains AppState v2, and task JSON exports remain compatible.

## Contents of the original state.json

The read-only local sample contains 6 tasks, 12 Runs, 32 conversation messages, and 21,711 events, including example data. The complete file is 84,398,262 bytes. Task events arrays total 84,343,001 bytes, or 99.9345% of the file.

| Category | Contents | Sample serialized size |
| --- | --- | ---: |
| Configuration | Runtimes, models, providers, execution defaults | 6,861 bytes |
| Onboarding | Completion state, local discovery results, etc. | 7,807 bytes |
| Goals | Goals, context, plans, reviews, and links | 2,459 bytes |
| Agent profiles | Reusable Agent configuration | 2 bytes (empty list) |
| Tasks | Titles, directories, members, business states, dependencies, acceptance, etc. | 84,380,953 bytes including the collections below |
| Conversations | User, Agent, and system messages | 18,474 bytes |
| Run snapshots | Invocation prompts, member and Runtime / model configuration, execution states | 16,254 bytes |
| Raw events | Start/stop events, stdout, stderr, tool-protocol inputs and outputs | 84,343,001 bytes |
| Workspace selection | activeGoalId, activeTaskId, version | Very small |

The task row includes its child collections and must not be added to them again. Sizes use compact UTF-8 JSON.

The previous implementation serialized all historical events in JS, transferred them across Tauri IPC, parsed them in Rust, wrote the full snapshot, and ran fsync on every state change. Task selection, setting changes, and each streaming fragment could incur this cost. Native JSONL also held the same events for recovery.

## Implemented structure

```text
app_data_dir/
├── workspace.sqlite3                         # Active workspace database
├── workspace.sqlite3-journal                 # May exist during SQLite transactions
├── state.json                                # Original legacy file, retained as a pre-migration backup
├── state.v1.backup.json                       # Retained if an older version already created it
├── traces/<taskId>/<runId>/<memberId>.jsonl    # Native execution logs and recovery source
└── exports/<taskId>-<exportId>.json           # Complete task exports
```

Separate storage uses independent tables and records rather than overwriting several JSON files without a shared transaction:

| Table | Granularity | Update method |
| --- | --- | --- |
| workspace_fields | One row per top-level field: settings, goals, agents, onboarding, activeTaskId, etc. | UPDATE only when the value changes |
| tasks | Lightweight metadata and list order for each task | UPDATE only when metadata or order changes |
| task_collections | One row for each task's messages / runs / artifacts collection | UPDATE only when that collection changes |
| events | One row per raw event, uniquely identified by task_id + event_id | Incremental append with idempotent deduplication and preserved insertion order |
| storage_meta | Initialization commit marker | Committed together with migration data |

events has task + position and task + run + position indexes. Records sharing a timestamp are reconstructed in their original array order, never reordered solely by timestamp. Complete event JSON preserves the original fields and payloads. Unknown workspace / task fields also survive round trips.

SQLite uses foreign keys, synchronous commits, and its default rollback journal; WAL is not enabled here. Metadata, conversations, Run snapshots, and the event batch commit together, preventing mismatches between tasks and history after interruption between separate file writes. Task deletion cascades to its database collections and events within the same transaction. The previous behavior of retaining native logs, exports, and working-directory files remains; no disk cleanup is performed.

## Frontend persistence protocol

`StatePersistence` remembers the last immutable state confirmed as persisted:

1. `load_workspace_summary` returns configuration, task metadata, and saved conversation / Run / artifact collections while omitting historical events. Tasks with history or Runs receive the frontend-only `historyPending` marker. The home page opens first; opening a task reads its history through `load_task_event_page`. The original `load_state` retains full compatibility reads.
2. Saving retains lightweight tasks, conversations, and configuration; events includes only events added since the last acknowledgement.
3. `save_state_delta({state})` commits in a Rust database transaction. Empty events means no new events, not deletion of history. A separate command prevents an older native app from interpreting new frontend data as a full snapshot. Unsupported commands report persistence failure rather than falling back to full replacement.
4. The frontend checkpoint advances only after a successful IPC response. Retry retains every unacknowledged event. If the transaction committed but the response was lost, the database deduplicates by event ID.
5. The bridge serializes saves and computes the next delta only after the preceding transaction completes. The hook's existing streaming-save coalescing and “persist before starting a Run” requirements still apply.
6. Persisted event IDs read through pagination enter a separate checkpoint so saves after history loading do not upload them again. New tails recovered from native logs still commit incrementally. `historyPending` is not stored in the database.

The Runtime writes and synchronizes native events to JSONL before sending them to the frontend. The frontend stores the complete queryable workspace projection. JSONL verification after reopening is deferred by task: opening, sending, orchestration startup, and export first load that task's history, then validate its Run logs, recover missing tails, and save them. Potentially interrupted Runs recover automatically after the home page appears. New events arriving during loading are buffered until the historical protocol prefix is complete, then merged while preserving saved conversations and metadata edits made during loading. Both layers are temporarily retained to avoid replacing the Runtime's crash-recovery mechanism during this migration. They do not share a cross-file transaction. Consistency relies on writing native logs first, persisting projections later, and recovering by ID.

## Migration and failure handling

- On the first launch of the new version, read and import legacy state.json into the new database. Data and the initialized marker commit in the same transaction. The original JSON file is never rewritten or deleted; it is itself the pre-migration backup.
- Corrupt source files, invalid data, and database-write failures abort without returning an empty workspace or overwriting the original file. Failed transactions roll back without a completion marker so the next launch can retry.
- After migration completes, the database is the only workspace source. The new version no longer updates state.json, and subsequent changes to it by an older app are not merged automatically.
- A corrupt database or a schema newer than the current version produces an error rather than silently falling back to stale JSON. Close the old version before migration to prevent different versions from editing separate states.
- New database files use permissions 0600 and data directories 0700; old files are retained as-is. No encryption is added, and local-file access boundaries remain unchanged.
- Before reverting to an old app, quit the new version and back up the entire data directory. The old app understands only the state.json captured at migration. Data added after migration requires a dedicated export/conversion; direct downgrade cannot be claimed to retain new writes.

## Validation and performance

`src-tauri/examples/storage-profile.rs` reads the real state.json, copies it into a temporary directory, then performs migration, reopening, metadata saves, and task exports. It compares complete JSON field by field and checks that the source file is unchanged. The temporary directory is cleaned up when the process exits. It does not migrate the active desktop data.

```bash
cargo run --manifest-path src-tauri/Cargo.toml --release --example storage-profile -- "$HOME/Library/Application Support/dev.goalward.desktop"
```

Initial Debug measurement, one sample rather than a user-click end-to-end metric:

| Metric | Previous full snapshot | Layered storage |
| --- | ---: | ---: |
| Save payload after changing selection | Approximately 84,398,262 bytes | 55,254 bytes |
| Rust serialization, write and synchronization / DB commit | 1,837 ms | 2.81 ms DB commit + 1.30 ms payload serialization |
| Existing historical events rewritten | Yes | No; only two 4 KB database pages changed |

Initial Debug migration plus reading took approximately 3.49 seconds, with a database of approximately 100 MB. Initial migration is a one-time cost, and retaining old JSON / JSONL increases total disk usage. This optimization neither compresses nor deletes history.

Final isolated Release measurements: old complete snapshot serialization and persistence **84.92 ms**; new payload serialization **0.11 ms** and database commit **1.66 ms**. Initial migration plus reading **525 ms**; database reopening, complete reads, and field-by-field comparison **107 ms**. These are single local native-storage measurements and exclude WebView IPC, JS serialization, rendering, and real app cold startup. They are not UI end-to-end metrics. Full metrics are saved in `test-results/storage/profile-release.json`.

Validation results: in isolated copies, complete JSON for all 6 tasks matched the old data field by field after migration, reopening, and metadata saves. All 6 task exports also matched. The full frontend regression suite and production build passed; the full Rust regression suite and new log-tail recovery cases passed, as did Clippy and formatting checks. Vite still reports the existing main bundle over 500 KB.

Actual development instance: after the development server restarted automatically with source changes, initial migration of the real data directory completed at 18:22. A final read-only check confirmed database schema 1, initialized=1, 6 tasks, and 21,711 events. The complete AppState reconstructed from all tables matched the old state.json field by field, and the old file's modification time remained 18:00:57. The running native process held workspace.sqlite3. The validation script itself always used temporary copies; no manual migration or overwrite of old data was performed. The release `.app` had not yet been rebuilt.

Automatic regressions cover complete large-data round trips, preservation of v1 / v2 original files, corrupt-data protection, partial-import rollback and retry, idempotent duplicate events, same-timestamp ordering, full-batch rollback on event conflicts, reopening, task-deletion cascades, database-version protection, and frontend retry / consecutive incremental writes / recreation after deletion.

## Current boundaries and future extensions

- Home-page summary reads and per-task history loading were subsequently added: each page contains at most 256 events, targeting 512 KiB of combined event JSON while retaining oversized individual records in full. The initial query fixes a position upper bound so later pages are unaffected by appends. SQL uses the task + position index. See [the subsequent startup-performance fix](startup-performance.md).
- All events within a task still ultimately enter memory. On-demand rendering across Runs, archiving, and compression are not implemented. Initial migration still reads legacy state.json in full as a one-time cost.
- messages / runs are saved as per-task collections; goals / agents as top-level collections. These collections are small in the current sample, so the initial focus was event-write amplification accounting for 99.9% of data. Significant collection growth could justify individual message, Run, and goal records with pagination.
- No automatic log rotation, history truncation, database compression, or backup deletion is performed. Freed database pages are reused by subsequent writes; file size need not shrink immediately after deletion.
- Browser previews retain independent localStorage. SQLite and incremental IPC apply to the desktop app.

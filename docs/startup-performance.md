# Home-page startup performance fix (2026-09-17)

## Local loading feedback (subsequent interaction adjustment)

- Removed the full-screen branded loading page during initial reads. `WorkspaceLayout` and workspace navigation mount before data arrives and retain the same navigation instance. The goal column shows “Reading goals…” in place; the right side uses static placeholders only.
- The default home `GoalsPage` is directly imported instead of a full Suspense replacement with “Opening goals…”. Switching loaded goals updates details immediately without additional requests, artificial waits, or motion delays.
- Unknown counts do not display 0. Before reading data, the UI does not claim “Saved” or “No running processes”. Creation, search, and settings stay disabled until the initial read completes. Read errors remain within the goal-list area with data-protection guidance.
- Applied `apple-design` and `animate` principles for immediate response and restrained frequent interactions: static Skeletons do not pulse or wait for entry/exit. Reduced-motion mode also uses static updates.
- A controlled slow-read browser fixture (`test-results/inline-loading/preview.mjs`) checked 1536×960 and 1280×720, pending/completed/failed reads, rapid goal changes, and Enter selection. Both sizes had no horizontal overflow. Failures occupied only the goal list, and no full-screen `.app-loading` appeared. This validates UI behavior; the fixture does not read real native data.
- Added regressions for preserved layout during initial reads, in-place filling, and local errors. All 406 frontend cases passed. Production frontend and Debug macOS Bundle builds passed. This interaction change does not alter the previous SQLite pagination or persistence protocol.

## Subsequent fix: separate the initial screen from historical events (validated at 21:47)

After duplicate Trace transfer and full-snapshot saves were reduced, desktop startup still waited for `load_state` to return approximately 84 MB of complete state and for all historical-log validation and message recovery. Faster SQLite reads do not eliminate full JSON transfer between processes or WebView parsing. This round therefore separates the initial-screen read path. Statements below about unverified native cold startup and full-state reads are historical conclusions from the preceding stage.

- The initial screen calls `load_workspace_summary`, reading configuration, task summaries, and saved messages / runs / artifacts without scanning events or JSONL. Tasks with history carry only the in-memory `historyPending` marker.
- Opening a task calls `load_task_event_page`. Each page contains at most 256 records and targets 512 KiB of combined event JSON. Oversized individual records are returned in full; response envelopes and commas are excluded from the target. Queries use the task + position index. The home page and saved conversations do not wait for pagination to finish.
- Only that task's log tail is recovered. Live events are buffered and deduplicated while task edits made during loading are retained. Repeated opening shares one request. Unmount cancels later pages, and asynchronous results cannot resurrect deleted tasks. Historical failures show local errors and retry.
- Sending, orchestration startup, and export wait for task recovery and persistence first. Already persisted historical-page events are not uploaded again. Ordinary summary-state saves do not delete database history.
- Potentially interrupted Runs recover automatically after the home page appears. Completed tasks load only when needed. No artificial waits or loading animation were added.

Release measurements using isolated temporary copies of 6 real tasks and 21,711 events:

| Metric | Result |
| --- | ---: |
| Original full state | 84,398,262 bytes |
| Initial-screen summary, including temporary markers | 55,405 bytes, a 99.934% reduction |
| Database reopening and summary read | 2.76 ms |
| Summary JSON serialization | 0.057 ms |
| Complete historical-pagination validation | 169 pages; every task matched field by field |
| Largest IPC historical page, including response envelope | 524,401 bytes |
| Complete migration, exports, and original-file preservation | All passed |

Data: `test-results/lazy-startup/storage-profile.json`; script: `src-tauri/examples/storage-profile.rs`. These native measurements exclude WebView rendering and are not total home-page load times.

Real `.app` validation: after building and signing with `npm run tauri -- build --debug --bundles app`, the old Debug Bundle with no active tasks was quit and the updated Bundle opened with real app data and Tauri IPC, without browser mocks. The first native UI inspection already showed workspace navigation; opening plus inspection took 755 ms. A subsequent screenshot confirmed the complete goal home page. Clicking Open task from the goal entered a real historical Kimi task. Within the 919 ms click-and-inspection interval, saved conversation and a local history-loading hint appeared. Later screenshots confirmed the complete execution inspector with 18 merged records and normal task state and conversation. These are tool-observation upper bounds, not precise first-frame timing or P95. Other Release/installed-directory copies were not rebuilt.

Validation: 35 frontend files / 404 cases passed; Rust 82 passed / 4 opt-in ignored; TypeScript + Vite builds and all-target Rust Clippy passed. New coverage includes summary saves preserving history, tail recovery for Runs without events, paginated byte limits / ordering / fixed bounds, initial display before history completion, live-event buffering, edits / deletion during loading, failure retries, and no duplicate historical uploads.

Boundaries: initial legacy-JSON migration still needs one full read. Complete task history still ultimately enters memory, and messages / Run collections are not paginated. Files are neither compressed nor truncated. The existing main JS bundle warning above 500 KB remains.

## Problem and evidence

The screenshot's “Reading local tasks and configuration…” came from the `useAppState` initialization gate. The old path read state, read all linked Trace, invoked the live-event reducer one event at a time, recovered messages/terminal states, registered listeners, saved complete state, and only then displayed the workspace. Runtime scanning happened after state loading, outside this wait path.

Read-only local sample: `state.json` was 84,398,262 bytes, with 6 tasks including 1 example and 21,707 native Trace records. Every Trace event ID already existed in the state snapshot. The old implementation still transferred another 84,341,705 bytes of Trace and scanned the task's existing event list for every duplicate. `App` also called `getTaskArtifacts` early on the goal home page, parsing the current task's complete tool Trace.

## Changes

- Native `load_trace_events` accepts per-task `knownEventIds`, still validates each log record's format and identity, and returns only events missing from the snapshot. Omitting the argument preserves old behavior. No history-count / cumulative-byte truncation or log deletion was added.
- Startup recovery merges events using batch indexes and derives messages once, preserving exact task/run/member routing, per-task ID deduplication, same-millisecond record ordering, and first-terminal-state semantics.
- Migration, recovery, and step reconciliation retain references when unchanged. Clean reopening skips full-state IPC upload and atomic disk writes. Migration, missing log tails, or legacy execution-state repairs still save before displaying the home page. Save failure continues to block initialization.
- Artifact indexing occurs only on the workbench page and no longer blocks the goal home page, settings, or other pages.

The `apple-design` and `animate` skills and project design system were read. Loading completion uses immediate state changes without additional displacement, entry sequencing, or artificial delays. Existing component feedback remains unchanged.

## Measurements

### Frontend comparison with the same sample

Local Chrome + Playwright in Vite development mode compared saved pre-change source with updated source. An isolated HTTP fixture simulated Tauri IPC and loaded the same real state and Trace. `save_state` serialized JSON only in memory without writing real storage. Timing covered page navigation until workspace-navigation DOM appeared, with a separate assertion that home content was visible. Development StrictMode produced two `load_state` calls consistently in both groups.

| Scenario | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| 1536 × 960, normal motion | 7552 ms | 1253 ms | 83.4% |
| 1280 × 720, reduced motion | 6989 ms | 994 ms | 85.8% |

These are frontend samples from two fixed scenarios, not statistical percentiles or complete process cold-start times for the installed macOS App. They exclude real Tauri IPC, window creation, and disk fsync. Raw results: `test-results/startup/browser-results.json`; read-only comparison script: `test-results/startup/browser-profile.mjs`. The script uses pre-change source retained in `test-results/startup/original/`.

In the Node/Vite module benchmark, complete merging of 21,707 historical events fell from 1151.5 ms to 20.5 ms. Artifact parsing previously performed early on the home page took 2278.2 ms. The script still measures artifact parsing separately; the actual home page now skips it.

### Native storage reads

The Release Rust benchmark calls real Storage methods, reads existing files only, and performs no save:

| Operation | Time / size |
| --- | ---: |
| State read and parse | 81.2 ms |
| Previous complete Trace read and parse | 94.3 ms |
| Previous Trace response serialization | 62.0 ms |
| Updated Trace validation and filtering | 82.6 ms |
| Previous Trace response | 84,341,705 bytes |
| Updated missing-event response | 2 bytes (`[]`) |

Filesystem reads were not the main bottleneck in this sample. Improvements came from reducing duplicate transfer, frontend scanning, hidden-page computation, and unchanged-state writes.

Read-only reproduction command, using an existing data directory and printing only durations and counts:

```sh
cargo run --manifest-path src-tauri/Cargo.toml --example startup-profile --release -- "$HOME/Library/Application Support/dev.goalward.desktop"
```

## Validation and boundaries

- The complete frontend suite passed 34 files and 388 cases. Subsequently added home-page deferred-artifact and Kimi batch-recovery cases passed separately, bringing the final count to 390.
- Rust passed 74 tests; 4 explicit opt-in tests remained ignored.
- TypeScript / Vite production builds and Rust Clippy `--all-targets -- -D warnings` passed.
- Added/adjusted regressions cover batch recovery matching event-by-event replay for four adapters, split protocol frames, deduplication, wrong routing, first terminal state, clean reopening without writes, no early artifact extraction, and continued corrupt-log validation after filtering.
- Browser checks covered both desktop sizes, normal/reduced motion, entering/leaving settings, the example-task workbench, global search, and Escape dismissal. There were no page errors or viewport overflow. Screenshots are at `test-results/startup/home-1536.png` and `home-1280.png`.
- This round did not change motion implementation and does not claim renewed validation of every drag, animation reversal, or streaming Run. The open desktop App was not replaced, and native cold startup after updating that installed version was not measured.
- State was still read in full and Trace fully validated at this stage. Sharded storage / per-task loading for growing histories was outside this change. First entry into a large task workbench still needed artifact/Trace display computation.

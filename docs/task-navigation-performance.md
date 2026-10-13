# Goal-to-task navigation performance (2026-09-17)

## Causes

The previous round moved artifact extraction off the goal home page, but task entry still extracted artifacts and displayed Trace. Read-only measurements of the largest local task, with 21,513 raw events, found:

1. `getTraceDisplayEntries` used `records.some` to scan existing records and recreated the complete `sourceIds` set and array while merging every update for the same tool call. Thousands of updates repeatedly scanned and copied data. `register` was the main CPU-profile hotspot. One display projection took approximately 2.45 seconds.
2. Artifact extraction, the inspector, and historical batches separately invoked projections, repeatedly reading, reorganizing, and parsing the same history. Re-entering the task repeated this work.
3. Repeated `JSON.parse` attempts on incomplete large JSON fragments created many failed parses and exceptions.
4. Clicking an already selected task still submitted a new state object, triggering full serialization and persistence of approximately 84.4 MB.

## Fixes

- Tool records use one deduplication Set per call and append in first-seen order, avoiding complete-array reconstruction for each update. All raw records and source IDs are preserved.
- Trace projections use a WeakMap cache keyed by event arrays. Artifacts, inspector, and run batches reuse the computation. Changes to events, member routing, adapters, or execution states invalidate the cache. Old caches do not prevent historical objects from being garbage collected.
- Artifact indexes cache immutable Task snapshots and reuse results on repeated entry and React rerender. App task updates create new snapshots; changes to messages, Trace, or saved file references rebuild indexes.
- If a JSON object/array's closing bracket has clearly not arrived, it stays pending without a parse attempt. Other content still undergoes full `JSON.parse` validation; the bracket check is not treated as a successful parse.
- `selectTask` / `openGoal` return the original state for already selected IDs, eliminating redundant disk writes. Actual task changes retain existing persistence behavior.

No new loading animation, artificial wait, or placeholder delay was added. Existing buttons, keyboard behavior, scrolling, and workbench layout retain their behavior.

## Performance evidence

The same local state snapshot tested the actual Goal → Open task button through Vite development mode and Chrome / Playwright. Timing starts at click capture and ends two requestAnimationFrames after the task title mounts. Title, workbench, Trace, and artifact contents are checked afterward. Tauri IPC uses an isolated fixture; saves serialize JSON in memory without changing real data.

| Scenario | Before | After |
| --- | ---: | ---: |
| 1536 × 960, normal motion, first entry into a large task | 6701 ms | 408 ms |
| 1280 × 720, reduced motion, first entry into a large task | 6797 ms | 385 ms |
| Re-entry into the same task, four visits across both sizes | Not measured | 27–65 ms |

First-entry wait fell by approximately 94%. A separate check including historical-batch and task-switch interactions measured first entries at 387 / 396 ms.

Node module CPU profile: full Trace display projection fell from 2447 ms to 183 ms. Cached same-task / single-Run views took approximately 0.01 / 0.04 ms. These are fixed-sample measurements, not statistical percentiles or native WebKit performance guarantees.

All raw materials are under `test-results/task-navigation/`:

- `before-browser-results.json`, `after-browser-results.json`: click timing and invocation records.
- `interaction-results.json`: re-entry, historical-batch switching, artifacts, and switching to other tasks.
- `before-modules.json`, `after-modules.json`: module durations.
- `before-cpu.json`, `after-cpu.json`: CPU profiles.
- `parity-results.json`: SHA-256 comparisons of raw-event displays, merged Trace, artifacts, and each Run's display for all 6 tasks before and after optimization; all matched.
- `before-task-*.png`, `after-task-*.png`: workbench screenshots.
- `original/`, `browser-profile.mjs`, `profile.mjs`, `parity.mjs`, `interactions.mjs`: pre-change code and read-only reproduction scripts.

## Validation

- All 34 frontend test files and 394 cases passed.
- TypeScript checks and the Vite production build passed. The existing main-bundle size warning remains.
- New regressions cover cache reuse, appended events, terminal-state recovery, adapter/member changes, complete records across 6,000 tool updates, artifact-snapshot changes, and unchanged navigation without saving.
- Actual goal-to-task navigation, re-entry, historical-batch changes, artifacts, other-task navigation, and return were checked at both desktop sizes with normal/reduced motion. There were no page errors or viewport overflow.
- This round changed frontend code only. The packaged desktop app was not replaced, Rust tests were not rerun, and native WebKit was not measured. Development builds can reload the changes; release builds require repackaging.

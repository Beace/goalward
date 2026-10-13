# Goalward — Goal-driven workbench design

> Goals guide the product through tasks, execution, artifacts and evidence, and review to complete the loop; Coding Agent proxying and collaboration provide execution capabilities. Primary navigation includes Goals, Agents, Tasks, and Running, while retaining Runtime / model settings and the execution workbench described here. The following includes the early task-centered design and planned capabilities. Refer to README and the capability matrix in the [product proposal](../docs/goal-driven-product-proposal.md) for current actual capabilities.

## Design scope

The first version designs a desktop application with a dense, IDE-like split layout. The formal application supports Chinese and English UI, initially following the system language and falling back to English for other languages. The theme follows the operating system by default, with Dark and Light available under Settings → Appearance. Theme, font, and language take effect immediately and save automatically; historical canvases use Chinese dark-mode examples. The target users are developers managing multiple Agent execution environments. The first canvas shows a task being executed collaboratively by three Agents. Runs, models, traces, usage, and file content on historical canvases are design examples; README defines actual integration capabilities.

## Product objects

- Workspace: associates local projects, reference materials, and tasks.
- Task: stores the user's goal, conversation, constraints, execution history, and artifacts.
- Run: an execution batch with a fixed record of member configuration, input, process, and result.
- Agent member: an execution instance with its own session and state; one runtime can create multiple members.
- Runtime: the executable that starts and drives an Agent, such as DeepSeek Harness, Codex, Claude Code, or Pi.
- Model: the model a member uses; the runtime's adapter and configuration supply available options.

Basic relationship: a task has multiple runs; a run contains one or more Agent members; each member is bound to a runtime and the actual model used in that run.

## Main workbench

The recommended baseline viewport is 1536 × 960, with usability at least at 1280 × 800.

### Desktop frame

- A 40 px native-feeling title bar contains window controls, workspace context, and global command search.
- A 224 px task navigation pane on the left.
- A flexible central task workspace, preferably at least 760 px wide.
- A 336 px execution inspector on the right, collapsible and resizable.
- A 24 px bottom status bar shows local execution-service status and running activity.
- Each pane scrolls independently; the message composer stays fixed at the bottom of the central pane.

### Left task navigation

- Project / workspace switching.
- New task and task search.
- Running and recent tasks; each row shows title, status, and participating member count.
- A bottom runtime-management entry shows the available count.
- A fixed "Settings" text entry at the bottom opens the independent global settings page, which can return to the current workbench.

### Global settings

- Runtimes: manage registered runtimes, executable paths, authentication sources, default models, adapter detection results, and advanced launch configuration.
- Models & providers: distinguish the model catalog, provider connections, and bindings of available models to runtimes. Use runtime-owned login and shared provider credentials according to supported capabilities.
- Appearance: theme supports System (default), Dark, and Light; the same category contains UI font and language settings. All three apply globally on selection, save separately and automatically, and persist across restarts after successful saving. System mode responds to operating-system theme changes. Appearance saves do not submit configuration drafts from other categories.
- Execution defaults: new-task mode, default runtime, and member-count limit.
- History & storage: chat / trace storage location, retention policy, and export.
- App updates: check public GitHub Releases at startup and periodically; allow manual download, install, and restart. Installation requires successful update-package and version-signature verification. Active Agents or unsaved settings block installation and restart.
- Global defaults apply to newly created members. Existing members retain configuration snapshots and update only after explicitly restoring defaults. Saving settings does not automatically restart running instances.
- See settings-design.md in the same directory for detailed fields and interactions.

### Central task workspace

1. Header: task title, working directory, run number, and status.
2. Execution controls: Single Agent / Collaboration segmented selector and Stop. Show Pause only when the adapter reports support.
3. Member configuration: do not occupy a large card region above the conversation. Runtime, model, and reasoning effort belong in the bottom composer. Single Agent uses a compact row; multiple Agents use an independent member selector to choose which configuration to edit, while the message recipient remains separate.
4. Add member: open a runtime selector on the same page, showing readiness and connection actions for DeepSeek Harness / Codex / Claude Code / Pi.
5. Work views: Task conversation / Member sessions / Artifacts, retaining the same task context.
6. Collaboration assignments: who implements, tests, and reviews; which subtasks run in parallel and which wait for dependencies.
7. Task conversation: user instructions, coordinator plan, member result summaries, validation, and final summary.
8. Composer: recipient selector, input, compact member configuration, and Send. During execution, continuously show actual status, elapsed time, the latest public activity, and Stop nearby.

### Artifact list

Each file in the Artifacts Tab uses one 40 px row: file icon, name, gray path, and fixed right-aligned copy and preview buttons. The path fills the remaining space and truncates when long; the copy button retrieves the full path. Omit a redundant "Task artifacts" heading, type badges, and generic footer instructions. Hovering or keyboard-focusing a name exposes its full name, path, source member, and execution batch. Web pages display and copy links; documents embedded in replies display "Reply content" and copy the content. Acceptance results also use one-line summaries with necessary status, exposing evidence on demand while retaining complete source records.

### Right execution inspector

- Tabs: Execution / Members / Files.
- Filter traces by member, tool, time, or failure state.
- Tree events show time, owner, tool / action, duration, and execution status.
- Expanded events show parameters, standard output, errors, related files, and parent / child events.
- Navigate both ways with chat: "View execution" locates an event; "Related conversation" returns to the corresponding message.
- Run records preserve members, runtimes, and actual models; later configuration changes must not rewrite them.
- Show unavailable token, cost, context-window, and similar values as unavailable. Do not present zero or estimates as measured values.

## Core interactions

### New task

Enter a goal → Choose a working directory → Choose Single Agent / Collaboration → Configure members → Start execution.

Collaboration may offer an "Implementation + Testing + Review" preset, with each member's runtime, model, and role adjustable.

### Selection and switching

- Select a member: view its session or trace without replacing the executor.
- Change model: list only configured options supported by that runtime; mark changes during a run as applying to the next run.
- Pending configuration: clearly identify editable "Next run" settings in the composer and retain a summary of the current run's actual runtime / model / reasoning effort. New selections must not replace current-run information.
- Change runtime: create a new session and hand off the goal, constraints, progress, files, and next action, with a handoff preview.
- Change immediately: use an explicit "Stop current run and hand off" action, preserving the old run and original session records.
- Collaboration to Single Agent: select the member that will continue; handle existing member states during an active run before starting a new batch.
- Single Agent to Collaboration: add members and roles while preserving the task goal and confirmed outcomes.
- Add / remove members or change execution mode during a run: first show the pending member plan. Continuing the current run and ending the current batch to continue with the new plan are distinct explicit actions. Do not simply hide active members.

### Message routing

- Send to the coordinator by default, for assignment and aggregation.
- Direct a specific member with an @mention; keep the current recipient visible in the composer.
- Allow explicit messages to all members, clearly showing recipient count before sending.
- Viewing a member's history must not silently change the recipient.
- Immediate injection of additional instructions during a run depends on adapter capability. If unsupported, clearly show that instructions are queued for the next turn.

### Parallel collaboration

- One member coordinates, but coordination is a role rather than a binding to a specific vendor.
- Each member has a visible role, current subtask, and dependency state.
- For code-editing tasks, show each member's independent working copy / branch, with changes awaiting aggregation in Artifacts.
- The coordinator aggregates results; overlapping modifications expose conflicts and a review entry.
- A member failure does not mean the entire task failed. Allow retry, handoff, or ending that member's work.

### Trace and chat

- Chat stores instructions, explanations, and conclusions.
- Trace stores events actually exposed by the runtime: model-request metadata, tool calls, parameters, output, file changes, retries, errors, and waiting.
- Do not promise to record inaccessible internal model reasoning; show coverage gaps for events the runtime does not expose.
- The conversation updates public runtime text and search / tool activity in real time, marking waiting and terminal states. Codex exec JSONL currently exposes only complete text segments, so do not fabricate character-by-character output; Claude stream-json uses public text delta events.
- Automatically follow streaming content only while the user remains near the bottom. Preserve position when the user reads earlier content and provide an entry to return to the latest content. Growth of any member's message must trigger correct following when appropriate.
- Bind every event to task / run / member / session and its parent event, supporting filtering, navigation, and export.

## Page states

| State | Page focus |
| --- | --- |
| New task | Goal, directory, execution mode, and member configuration |
| Single Agent running | One member, conversation, current action, and Stop |
| Collaboration running | Multiple members, roles, dependencies, coordinator summary, and trace |
| Waiting for user action | Identify the member, requested action, and relevant context |
| Member failed | Local impact, failed event, retry, or handoff |
| Task complete | Summary, artifacts, validation results, and continued execution |
| History review | Select a run and view its original configuration and events |
| Runtime management | Installation / connection / path / account / model configuration / start and stop |

## First-draft example content

- Project: goalward.
- Task: Add a global command palette to the workbench.
- Codex member: Coordination / Implementation, integrating the command palette; illustrative model GPT-6-Astra.
- Claude Code member: Testing, adding tests for shortcuts and search behavior; show "Default configuration" for its model.
- Pi member: Review, waiting for implementation changes before reviewing focus management; show "Default configuration" for its model.
- DeepSeek Harness: available through Add member or runtime management.
- Example files: CommandPalette.tsx, useCommandSearch.ts, command-palette.spec.ts.
- Expand one file-read or test-command event on the right, clearly showing member ownership and result.
- Bottom recipient: Coordinator · Codex.

## Recommended first-version scope

Prioritize unified tasks, member configuration, runtime startup and shutdown, streaming sessions, traceable tool events, collaboration message routing, and artifact aggregation. Extend runtime installation guidance, remote execution environments, complex visual DAG orchestration, long-term memory management, and automation scheduling after the core workflow is confirmed.

Validate runtime integration capabilities individually. A unified design entry does not imply that runtimes support the same models, resume, pause, message injection, usage reporting, or trace-event protocols.


### Conversation content format

Render public Agent replies as Markdown / GFM, including headings, emphasis, quotations, nested lists, tables, task lists, code blocks, and footnotes. Keep the current theme's compact typography, warm sand links, and fine borders, using shared tokens for dark / light switching. Code blocks offer copy and independent horizontal scrolling; wide tables scroll only within their own region. Streaming updates the existing message without entry animation; incomplete code blocks can be completed incrementally. Existing historical messages use the new renderer directly, while persistence continues to store raw text. Preserve user input and execution traces verbatim. Clicking HTTP / HTTPS links, local file links, inline code paths, and recognizable bare paths in Markdown opens them in the right artifact preview. Remote pages support refresh, copy link, and opening in the system browser. Sites that prohibit embedding or require login can use the system-browser entry. Resolve local relative paths against the message's Run directory; resolve relative links in Markdown files against the file's directory. Native reads still respect execution-directory boundaries. HTML is not executable chat content; view images through explicit links.


### Execution event classification (2026-09-16)

The execution inspector reads runtime protocol event types and displays categories such as Web search, Response generation, Command execution, File changes, Tool calls, and Session. Compact labels indicate Started, In progress, Completed, or Failed, accompanied by type icons and short query / command summaries. Completing a tool step does not complete the entire task; only the actual process terminal state marks execution end. Ordinary stderr is diagnostic output; structured errors and process failures appear in the error filter. Merge a tool call's start, update, and end using its execution batch, member, and protocol call ID. Show status, start / end times, and known duration in one row; do not guess relationships for events without call IDs. Expanded details distinguish inputs and outputs, displaying JSON with two-space indentation, hierarchy guides, and type highlighting while retaining plain text verbatim. Show loading during execution; reduced motion retains a static icon and status text. Update in place when tool results arrive without replaying whole-block entry animation. Do not keep showing loading for missing tool terminal states after stopping or ending the run. Keep raw protocol records collapsed; raw-record copy retrieves the original text, and inputs and outputs can be copied separately. Reassemble JSON fragments across reads by run, member, and output channel. Do not discard unknown types or imply they are supported events. Only change the display projection; historical data requires no migration.


Kimi CLI is included in the runtime selection of the second-round Goal and Agent prototypes. Formal application adaptation, model-capability discovery, and permission callbacks remain part of the integration implementation phase.

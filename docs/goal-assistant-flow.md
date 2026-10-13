# Goal assistant flow

Goalward turns a direction into a saved goal, proposed actions, and independently accepted task results. This document describes the current React / Tauri implementation; a design prototype does not establish Runtime behavior. The real-model end-to-end flow has not yet been verified.

## Using the flow

1. **Start something.** Describe what you want to move forward in your own words. The app saves an initial goal and opens its goal assistant. You can find it again in the goal list. You can start and edit manually without configuring a Runtime.
2. **Clarify with the assistant.** In the macOS app, select a configured Runtime and send context or constraints. The conversation uses the existing local CLI execution, session, history, approval, and stop mechanisms. Its instructions ask the most useful next question and leave unknown facts explicit. Until enough is known, a reply may contain no goal draft. A configured executable does not establish that CLI login, model access, or connectivity works.
3. **Edit the definition.** Review the goal name, expected outcome, scope, current context, and optional target date. Each success criterion needs a concrete success standard and a verification method; its baseline is optional. A standard can describe a deliverable, capability, observation, or numeric threshold. Numbers are optional. Dates use `YYYY-MM-DD` or remain empty.
4. **Confirm goal and plan tasks.** Confirmation saves the definition before showing a celebration and switching to the goal's Tasks tab. The celebration means the goal has been clarified and saved. It does not mean the goal has been achieved. In the desktop app, with a selected Runtime, the assistant then requests task proposals. If planning fails, the confirmed goal remains available; retry planning or add tasks manually.
5. **Review and adopt proposals.** Proposals are suggestions until you choose **Adopt** or **Adopt all**. Edit their titles, deliverables, acceptance requirements, optional dates, and dependencies first. Adoption creates real linked tasks in the pending business state; it does not start execution. Adopt prerequisite tasks first or together. A task deadline cannot exceed the goal deadline, and a dependent task cannot be due before its prerequisite. You can also dismiss proposals or add your own tasks.
6. **Open the task workspace.** Opening a task activates the global Tasks module and shows the task list and its own conversation, artifacts, and execution inspector. Opening from a goal preserves that goal's list filter. Use the owner link in the task toolbar to return to the goal, or its progress icon to open the goal overview. The goal assistant holds goal-level and cross-task planning discussions; each task retains its own execution conversation. Global Tasks opens the full task list.

## Two kinds of progress

| Measure | What counts | What remains pending |
| --- | --- | --- |
| Task completion | Business state `done`, the latest result is `accepted`, its requirements version matches the current task, and its evidence or acceptance note is nonempty. | Process completion, an older accepted result followed by a newer submission, or acceptance against superseded requirements. |
| Goal verification | A success criterion is marked satisfied or unsatisfied with nonempty evidence. | Criteria without evidence, regardless of saved status; task completion does not verify goal criteria. |

The task denominator excludes examples, internal goal-assistant conversations, and cancelled tasks. The goal chart counts criteria separately. A missing denominator displays `—`; neither chart invents an overall goal-completion percentage. Review the evidence for each criterion and explicitly mark the goal achieved when all its criteria are satisfied. Goal and task target dates organize expectations; passing a date does not establish acceptance.

## Runtime scope

**Browser preview:** manual goal definition, task creation, and recorded evidence are available. It cannot start or detect local Runtimes, generate model replies, or manufacture proposals. Real conversations use the macOS app.

**Native workspace:** the app creates `goal-assistant-workspaces/<goal-id>/` under its data directory, rather than asking for a project directory during clarification. The Rust command accepts a validated goal ID, rejects traversal and symlink targets, and creates new Unix directories privately (`0700`). This directory organizes the conversation; it is not a guarantee that every CLI can access only this directory.

The app restricts a cloned Runtime configuration for each assistant request. Shared settings and historical Run snapshots are preserved.

| Adapter | Assistant configuration |
| --- | --- |
| `codex` | App-server stdio with public text deltas; `read-only` sandbox and `never` approval policy, no sandbox network access or extra writable directories, cleared extra arguments. |
| `claude` | Plan mode; deny `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and `Bash`; no added directories or extra arguments. |
| `pi` | Disable tools, extensions, skills, prompt templates, and context files. |
| `kimi` | Manual approval mode with cleared extra arguments. Approval requests use the existing approval UI. |
| `generic` | Rejected for goal-assistant conversations; ordinary task execution remains a separate capability. |

Assistant instructions limit clarification and planning to the conversation and explicitly supplied material; they prohibit project changes, implementation commands, installs, and executing proposed tasks. These are app-generated instructions and CLI configuration, not proof of a complete operating-system sandbox.

### Streaming and pending replies

The conversation shows a pending reply immediately on send, then distinguishes waiting for public text from an ongoing reply. It updates the same Markdown message as text arrives; streaming does not replay message entry animations or move keyboard focus. The shared Spinner rotates normally and remains static with reduced motion. Scrolling up pauses automatic following; **Jump to latest** resumes it. Completion, failure, and stop all clear loading while retaining received text.

Codex goal conversations use `codex app-server --listen stdio://`: `initialize`, `thread/start` or exact `thread/resume`, and `turn/start`. Each `item/agentMessage/delta` is persisted once and appended to the current public message; the trace does not repeat the growing full response for every delta. Only a matching successful `turn/completed` completes the run; process exit alone does not. The app validates read-only permissions before sending the prompt and rejects server capability/approval requests. An incompatible CLI fails with a readable error rather than silently reverting to buffered output. Business-task Codex execution also uses native app-server sessions. Idle connections are reused; stopping interrupts the turn and preserves its conversation. See [native sessions and workspaces](native-agent-sessions.md).

The internal `goalward` action block stays hidden, including a partially streamed opening fence. Goal drafts and task proposals are processed only after the run completes successfully; partial, failed, or stopped replies do not publish suggestions.

### Task proposal invocation details

The Tasks tab shows the planning run's live phase, saved Runtime/model selection, elapsed time, and latest public activity. **Invocation details** expands the selected run's metadata, server-confirmed model/provider when provided, native session and turn IDs, latest reported and conversation token usage, app-recorded instructions, readable streamed reply, and the existing execution inspector. Public reasoning summaries, tool input/output, and raw records are available through the inspector. Details load when opened and retain a stable message/trace identity during streaming; the shared disclosure spring respects reduced motion.

The requested turn reasoning setting and the server's thread-default reasoning setting are labeled separately. Missing model/usage fields stay unspecified; public Runtime records are not a complete inventory of provider HTTP requests. The task pane picks the latest assistant run before checking its captured planning phase, so a newer clarification cannot reveal an older planning run as current progress. Required tool approval stays outside the collapsed details. History recovery blocks adoption/retry until it succeeds, with a visible recovery retry on failure. Model completion and validation/publication of task proposals remain separate states.

## Developer notes

| Source | Responsibility |
| --- | --- |
| [GoalsPage.tsx](../src/components/GoalsPage.tsx), [GoalAssistant.tsx](../src/components/GoalAssistant.tsx) | Save the initial idea, edit and confirm definitions, celebrate only after persistence, show planning and adoption. |
| [goal-assistant.ts](../src/lib/goal-assistant.ts) | Runtime clones, prompts, strict response parsing, version/date/dependency validation, proposal adoption, persistence rollback. |
| [App.tsx](../src/App.tsx) | Native dispatch, completed-run processing, independent Task navigation and owner return. |
| [goal_assistant.rs](../src-tauri/src/goal_assistant.rs), [permission.rs](../src-tauri/src/permission.rs), [runtime/codex.rs](../src-tauri/src/runtime/codex.rs) | App-managed directories, native CLI permission arguments, and restricted Codex app-server streaming. |
| [goal-progress.ts](../src/lib/goal-progress.ts), [GoalProgress.tsx](../src/components/GoalProgress.tsx) | Separate evidence-backed task and goal-criteria counts. |
| [workspace.ts](../src/lib/workspace.ts), [goals.ts](../src/lib/goals.ts) | Submit/review results, track requirements versions, record criterion evidence and goal achievement. |

An internal `Task` with `kind: 'goal_assistant'` stores the goal conversation through the existing durable Run protocol. Exclude it from business task lists and progress; include its actual running members in Runtime concurrency limits. Replies must contain one final `goalward` JSON block and match the requested phase and goal version. Clarification may return `draft: null`; malformed or stale replies do not authorize confirmation or adoption.

Run focused checks with:

```bash
npm test -- src/lib/goal-assistant.test.ts src/lib/goal-progress.test.ts src/components/GoalAssistant.test.tsx src/components/GoalProgress.test.tsx src/components/GoalsPage.test.tsx src/components/DashboardPage.test.tsx
npm run build
cargo test --manifest-path src-tauri/Cargo.toml goal_assistant
cargo test --manifest-path src-tauri/Cargo.toml codex
# With Vite running; uses isolated synthetic Runtime events and real UI components:
node scripts/goal-assistant-stream-smoke.mjs
# Opt-in local Codex/model test, temporary workspace and synthetic prose only:
cargo test --manifest-path src-tauri/Cargo.toml installed_codex_goal_assistant_streams_real_model_and_resumes -- --ignored --nocapture
```

These checks cover domain logic, rendered controls, build integrity, and native directory/storage behavior. They do not establish successful CLI authentication, a real remote-model clarification-to-adoption conversation, or end-to-end enforcement of each Runtime's restrictions. Real-model E2E is still unverified.

Token usage follows the public app-server fields: `last` is the latest reported increment, while `total` is the cumulative thread snapshot. It is not labeled as the aggregate usage of every model response within a user turn. See [OpenAI token accounting documentation](https://github.com/openai/symphony/blob/main/elixir/docs/token_accounting.md).

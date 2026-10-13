# Native Agent sessions and goal workspaces

Goalward uses the original Agent executables and their native conversation protocols. The application owns the client connection and presents messages, tool progress, approvals and execution history; each Agent still owns its model/tool loop, authentication and native session storage.

## Connections, conversations and turns

The native Runtime manager keeps a connection separately from the active Run. A task member can reuse its idle connection for subsequent turns. Each turn has a new Run ID, trace and immutable configuration/working-directory snapshot. Native thread/session IDs remain persisted in the Run member so the exact conversation can be resumed after the connection closes. Generic CLI adapters remain single-invocation adapters.

Connection reuse is scoped to the task and member, executable, Runtime configuration and permissions, primary/additional directories, model and effort. Changing the configuration closes the old idle connection before a new connection starts. Changing directory or permission scope starts a fresh native conversation with the saved public context. There is no directory-wide `--last` or automatic replay of an interrupted input. A disconnect fails the affected turn and preserves its received output.

| Runtime | Native transport | Input while running | Approval surface |
| --- | --- | --- | --- |
| Codex | `app-server --listen stdio://` | Correlated `turn/steer` | Command and file-change approval requests |
| Claude Code | Native bidirectional streaming-input transport used by Agent SDK | Follow-up queue; the current work continues | `can_use_tool` permission round trips |
| Kimi | ACP | Not advertised by the currently supported protocol | ACP `session/request_permission` options |
| Pi | `--mode rpc` | Native `steer` | Extension confirmation requests; no invented generic tool permission system |

The input controls use capabilities announced by the actual connection for this Run. Missing/unsupported input capabilities keep the draft until the turn finishes. Codex and Pi steering wait for a matching native success response before clearing the draft. Claude's queue is labelled as a queue rather than presented as steering; submitting a follow-up does not claim an immediate native acceptance ACK. Approval requests remain pending until the native response is accepted; a failed response stays visible and can be retried. Unhandled native server requests are explicitly declined rather than left hanging.

Stopping normally interrupts the current turn and keeps the conversation/connection. Claude's already submitted follow-ups cannot reliably be cleared by an interrupt: stopping that queue closes the connection, retains the native session ID and resumes that exact session on the next request. Pi clears its queue before aborting. An interrupt that never settles closes the unresponsive connection; the input is not replayed. Idle connections do not count as active work for the updater and are closed/reaped before install or restart. Shutdown closes native connections, including ACP's advertised graceful close.

Real-time text and publicly exposed reasoning summaries/tool events append to stable message/Trace records. A completed turn is an execution result, separate from business-task acceptance and goal evidence. Goal/task proposals still publish only after successful completion and schema validation. A queued follow-up can produce several full replies within one Run: only the final reply supplies the structured goal/task suggestion, while earlier replies remain readable. An invalid final reply never falls back to an earlier suggestion.

The goal assistant invocation details show the saved request alongside native evidence: Codex's confirmed thread model/provider and correlated turn usage, Claude's init/assistant model and result usage, and Pi's session model/thinking level and assistant-message usage. Missing values remain explicitly unavailable; Claude/Pi message usage is not labelled as a cumulative conversation total.

Reloading the webview does not restart the native Runtime manager. Startup and deferred history loading reconcile against its actual active turns before declaring an execution interrupted. Unreadable native status leaves recovery visibly incomplete instead of assuming the work stopped. A fresh application process with no active native turns preserves the existing interruption/retry behavior; it does not replay unfinished inputs.

## One workspace definition per goal

The goal header contains **Working directories**. The first directory is the primary `cwd`; additional entries are ordered extra roots. Add a folder, set it as primary or remove its reference there. One primary directory is retained; removing a reference never removes files. Linked tasks, adopted suggestions, duplicates and subtasks inherit the goal's directories, so the new-task dialog has no directory field.

An unconfigured goal receives a fixed app-managed directory when created or first used in the desktop app. Standalone tasks use the settings default or their own fixed app-managed directory. Browser previews do not create local folders. Legacy goals retain an ordered union of their linked task roots; historic Runs retain their original roots. Legacy unscoped artifact links retain their original base directory.

Changes apply to future turns. A running turn and its `@` search use the original Run snapshot. Codex and Claude receive extra directories through their native workspace options. Kimi and Pi have one native `cwd`, so additional roots are explicitly included in their input context; this does not invent a new permission model or change their native access policy. Goal assistant Runtime snapshots retain their restricted tools/permissions and remain separate from business-task connections.

## File and folder references

Type `@` in the task or goal-assistant composer and continue with a file name or relative path. The desktop app searches metadata under the current working roots. Arrow keys select a result; Enter or Tab inserts it; Escape dismisses the results while retaining the draft. The textarea keeps focus, supports ordinary multiline input and Command/Ctrl+Enter, and does not consume IME confirmation as a selection.

Inserted references use `@"/absolute/path"` with JSON quoting to preserve spaces, Chinese, quotes and literal shell characters. The original Agent resolves/reads the reference through its own available tools and permission policy. Goalward does not automatically load file contents into the composer. Search skips symlinks and common generated directories (`.git`, `node_modules`, `target`, `.next`, `.cache`, `.venv`, `__pycache__`), limits traversal depth/time/entry count and displays a partial-result hint when bounded. Narrow the query if a file is not in the initial result set.

## Validation and supported versions

Protocol/lifecycle regression tests cover multiple turns in one process, exact session continuity, Run isolation, public streaming, tool progress, steering/queuing, approvals, cancellation, changed scopes, idle updates and disconnects without replay. Workspace tests cover migration, inheritance, creation/edit/adoption, unchanged historical snapshots and legacy artifact bases. Reference tests cover keyboard/pointer/IME input, stale search results, inaccessible directories and quoted paths.

The browser smoke uses the real App/shared components with synthetic IPC, events and filesystem metadata. It checks 1536 × 960 and 1280 × 720, light/dark themes and normal/reduced motion. It does not establish native filesystem, login, model inference or packaged WebKit behavior.

Installed-CLI checks and their precise boundaries are described in [Claude/Pi validation](claude-pi-native-sessions.md). CLI protocol support depends on the installed executable; incompatible native protocols fail visibly instead of silently falling back to `exec`/print-only behavior. No Agent executable or credentials are installed or rewritten by this change.

## Primary protocol references

- [Codex app-server](https://developers.openai.com/codex/app-server): native thread/turn, events and bidirectional control.
- [Claude Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode): continuous native input and permission callbacks.
- [Kimi ACP capabilities](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp.html): advertised ACP session/control capabilities.
- [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md): session, message, steering and abort commands.

## 中文使用说明

目标统一保存工作目录：第一项为主目录，可继续添加多个目录；关联任务、建议采用、复制和子任务自动继承。新建任务不再填写目录。空目标和独立任务在桌面应用中自动获得固定目录，已有文件不会搬迁或删除，历史执行保留原目录。运行中修改目标目录只影响后续执行。

输入框输入 `@` 搜索当前工作目录里的文件或文件夹，用上下键、Enter/Tab 或鼠标插入完整引用，Escape 收起候选列表。当前执行期间使用当时的目录范围，不提前使用下轮新增目录。文件内容仍由原 Agent 按其真实工具与权限读取。

Codex、Claude、Kimi、Pi 优先使用原生会话协议，连接跨轮复用，每轮结果与 Trace 单独保存。运行中追加只开放已确认能力：Codex/Pi 原生 steering，Claude 排队追加，Kimi 未支持时保留草稿。普通停止保留会话；Claude 已排队消息的停止会回收连接后精确续接。工具审批展示真实请求和可用选项，不伪造各家没有的权限能力。

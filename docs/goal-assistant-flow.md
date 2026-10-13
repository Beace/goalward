# Goal assistant flow / 目标助手流程

Goalward turns a direction into a saved goal, proposed actions, and independently accepted task results. This document describes the current React / Tauri implementation; a design prototype does not establish Runtime behavior. The real-model end-to-end flow has not yet been verified.

## English

### Using the flow

1. **Start something.** Describe what you want to move forward in your own words. The app saves an initial goal and opens its goal assistant. You can find it again in the goal list. You can start and edit manually without configuring a Runtime.
2. **Clarify with the assistant.** In the macOS app, select a configured Runtime and send context or constraints. The conversation uses the existing local CLI execution, session, history, approval, and stop mechanisms. Its instructions ask the most useful next question and leave unknown facts explicit. Until enough is known, a reply may contain no goal draft. A configured executable does not establish that CLI login, model access, or connectivity works.
3. **Edit the definition.** Review the goal name, expected outcome, scope, current context, and optional target date. Each success criterion needs a concrete success standard and a verification method; its baseline is optional. A standard can describe a deliverable, capability, observation, or numeric threshold. Numbers are optional. Dates use `YYYY-MM-DD` or remain empty.
4. **Confirm goal and plan tasks.** Confirmation saves the definition before showing a celebration and switching to the goal's Tasks tab. The celebration means the goal has been clarified and saved. It does not mean the goal has been achieved. In the desktop app, with a selected Runtime, the assistant then requests task proposals. If planning fails, the confirmed goal remains available; retry planning or add tasks manually.
5. **Review and adopt proposals.** Proposals are suggestions until you choose **Adopt** or **Adopt all**. Edit their titles, deliverables, acceptance requirements, optional dates, and dependencies first. Adoption creates real linked tasks in the pending business state; it does not start execution. Adopt prerequisite tasks first or together. A task deadline cannot exceed the goal deadline, and a dependent task cannot be due before its prerequisite. You can also dismiss proposals or add your own tasks.
6. **Open the task workspace.** Opening a task activates the global Tasks module and shows the task list and its own conversation, artifacts, and execution inspector. Opening from a goal preserves that goal's list filter. Use the owner link in the task toolbar to return to the goal, or its progress icon to open the goal overview. The goal assistant holds goal-level and cross-task planning discussions; each task retains its own execution conversation. Global Tasks opens the full task list.

### Two kinds of progress

| Measure | What counts | What remains pending |
| --- | --- | --- |
| Task completion | Business state `done`, the latest result is `accepted`, its requirements version matches the current task, and its evidence or acceptance note is nonempty. | Process completion, an older accepted result followed by a newer submission, or acceptance against superseded requirements. |
| Goal verification | A success criterion is marked satisfied or unsatisfied with nonempty evidence. | Criteria without evidence, regardless of saved status; task completion does not verify goal criteria. |

The task denominator excludes examples, internal goal-assistant conversations, and cancelled tasks. The goal chart counts criteria separately. A missing denominator displays `—`; neither chart invents an overall goal-completion percentage. Review the evidence for each criterion and explicitly mark the goal achieved when all its criteria are satisfied. Goal and task target dates organize expectations; passing a date does not establish acceptance.

## 中文

### 使用流程

1. **开始一件事。** 用自己的话描述想推进的方向。应用保存一个初始目标并打开目标助手，之后可以从目标列表找回。不配置 Runtime 也能先记录和手动编辑。
2. **与助手澄清。** 在 macOS 应用里选择已配置的 Runtime，补充现状、资料或约束。对话复用本机 CLI 的执行、会话、历史、审批和停止能力。助手指令要求优先询问最影响下一步的问题，并明确保留未知；信息不足时，可以只继续对话而不生成草案。配置了可执行文件不代表登录、模型权限和网络已经可用。
3. **编辑目标定义。** 核对名称、预期结果、范围、当前现状和可选的目标 DDL。每条成功条件都要有明确的达成标准和检验方法，基线可留空。标准可以是产物、能力、观察结果或数值，不强制量化。日期采用 `YYYY-MM-DD`，没有日期要求时可留空。
4. **确认目标并安排任务。** 目标定义保存成功后，首次确认显示全局庆祝并进入该目标的任务列表。庆祝表示“目标已明确并保存”，不表示目标已经达成。桌面应用选有 Runtime 时，助手随后主动请求任务建议；拆分失败仍保留已确认目标，可重试或手动补充。
5. **核对并采用建议。** AI 建议在点击“采用”或“采用全部”前仍是建议。可先调整名称、产物、验收要求、可选日期和依赖；采用后才创建真实关联任务，初始业务状态为待开始，不自动执行。先采用前置任务，或一起采用计划。任务日期不能晚于目标 DDL，后续任务日期不能早于前置任务；也可以不采纳建议或自行补充任务。
6. **进入独立任务工作区。** 打开具体任务会激活全局任务模块，显示任务列表、该任务的对话、产物和执行检查器。从目标打开时保留该目标的列表筛选；工具栏中的所属目标链接可返回目标，进度图标可回到目标概览。目标助手讨论目标和跨任务计划，具体执行对话保留在各任务内；点击全局任务入口则查看全部任务。

### 区分任务完成与目标验收

| 进度 | 计入条件 | 不直接计入的情况 |
| --- | --- | --- |
| 任务完成 | 业务状态为 `done`，最新结果已接受，结果要求版本与当前任务一致，且结果依据或验收说明非空。 | Runtime 结束、旧结果已接受但又提交新结果、旧要求下的验收。 |
| 目标验收 | 每条成功条件有非空依据后，记录为已满足或未满足。 | 没有依据时保持待验证；完成关联任务不会自动验收目标标准。 |

任务分母排除示例、内置目标助手对话和已取消任务。目标标准单独计数，空分母显示 `—`，不生成一个混合的目标完成度。逐项检查成功条件及证据后，再显式确认目标达成。目标和任务 DDL 用于安排期望，日期到期本身不代表完成或验收通过。

## Runtime scope / Runtime 范围

**Browser preview / 浏览器预览：** manual goal definition, task creation, and recorded evidence are available. It cannot start or detect local Runtimes, generate model replies, or manufacture proposals. Real conversations use the macOS app. 浏览器可以手动整理目标、创建任务和记录证据，不启动或检测本机 Runtime，也不模拟模型回复或编造 AI 建议；真实对话需在 macOS 应用中运行。

**Native workspace / 原生工作目录：** the app creates `goal-assistant-workspaces/<goal-id>/` under its data directory, rather than asking for a project directory during clarification. The Rust command accepts a validated goal ID, rejects traversal and symlink targets, and creates new Unix directories privately (`0700`). This directory organizes the conversation; it is not a guarantee that every CLI can access only this directory. 原生助手使用应用数据目录中的专属对话目录；Rust 命令校验目标 ID、拒绝路径穿越和符号链接，新建 Unix 目录使用 `0700`。对话目录用于组织上下文，不等同于对所有 CLI 的完整文件系统隔离。

The app restricts a cloned Runtime configuration for each assistant request. Shared settings and historical Run snapshots are preserved. 当前按请求复制 Runtime 配置并施加限制，不改写共享配置或历史执行快照：

| Adapter | Assistant configuration / 助手配置 |
| --- | --- |
| `codex` | App-server stdio with public text deltas; `read-only` sandbox and `never` approval policy, no sandbox network access or extra writable directories, cleared extra arguments. / 使用 app-server stdio 接收公开文本增量；只读沙箱、不自动授权工具、不允许沙箱命令访问网络、无额外可写目录，清空额外启动参数。 |
| `claude` | Plan mode; deny `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and `Bash`; no added directories or extra arguments. / 计划模式，禁止上述写入与命令工具，不附加目录或额外启动参数。 |
| `pi` | Disable tools, extensions, skills, prompt templates, and context files. / 禁用工具、扩展、技能、提示词模板和上下文文件。 |
| `kimi` | Manual approval mode with cleared extra arguments. Approval requests use the existing approval UI. / 手动审批模式并清空额外启动参数，请求沿用现有审批界面。 |
| `generic` | Rejected for goal-assistant conversations; ordinary task execution remains a separate capability. / 目标助手暂不接受通用 CLI，普通任务执行能力另行保留。 |

Assistant instructions limit clarification and planning to the conversation and explicitly supplied material; they prohibit project changes, implementation commands, installs, and executing proposed tasks. These are app-generated instructions and CLI configuration, not proof of a complete operating-system sandbox. 助手指令要求基于对话和明确提供的资料整理建议，不修改项目、不运行实现命令、不安装程序、不执行建议任务；指令与 CLI 配置不能作为完整操作系统沙箱已验证的证据。

### Streaming and pending replies / 流式回复与等待反馈

The conversation shows a pending reply immediately on send, then distinguishes waiting for public text from an ongoing reply. It updates the same Markdown message as text arrives; streaming does not replay message entry animations or move keyboard focus. The shared Spinner rotates normally and remains static with reduced motion. Scrolling up pauses automatic following; **Jump to latest** resumes it. Completion, failure, and stop all clear loading while retaining received text. / 发送后立即在对话流里显示等待反馈，运行中区分“正在思考”和“正在回复”。文字到达时原位更新同一条 Markdown 消息，不重播入场动画、不移动键盘焦点。共享 Spinner 在正常模式旋转，减少动态效果时保持静态。向上阅读暂停自动跟随，点击“回到最新”恢复；完成、失败或停止后清除 loading，保留已收到的文字。

Codex goal conversations use `codex app-server --listen stdio://`: `initialize`, `thread/start` or exact `thread/resume`, and `turn/start`. Each `item/agentMessage/delta` is persisted once and appended to the current public message; the trace does not repeat the growing full response for every delta. Only a matching successful `turn/completed` completes the run; process exit alone does not. The app validates read-only permissions before sending the prompt and rejects server capability/approval requests. An incompatible CLI fails with a readable error rather than silently reverting to buffered output. Business-task Codex execution also uses native app-server sessions. Idle connections are reused; stopping interrupts the turn and preserves its conversation. See [native sessions and workspaces](native-agent-sessions.md). / Codex 目标对话通过 app-server 初始化、创建或精确续接会话，再启动本轮消息；每个公开文本增量只持久化一次，并追加到当前消息；不会每次重复保存不断增长的完整回复。只有对应本轮的成功完成事件才算完成，不能仅凭进程退出判定。发送前核对只读权限，拒绝服务端工具授权和未支持能力请求。不兼容的 CLI 显示可读错误，不静默退回整段输出；普通业务任务也使用原生 app-server 会话；空闲连接跨轮复用，停止中断当前轮并保留会话。详见 [原生会话与工作目录](native-agent-sessions.md)。

The internal `goalward` action block stays hidden, including a partially streamed opening fence. Goal drafts and task proposals are processed only after the run completes successfully; partial, failed, or stopped replies do not publish suggestions. / 内部结构化建议保持隐藏，包括分片到达的代码块开头。目标草案与任务建议只在本轮成功结束后解析，部分输出、失败或停止均不发布建议。

### Task proposal invocation details / 任务建议的调用详情

The Tasks tab shows the planning run's live phase, saved Runtime/model selection, elapsed time, and latest public activity. **Invocation details** expands the selected run's metadata, server-confirmed model/provider when provided, native session and turn IDs, latest reported and conversation token usage, app-recorded instructions, readable streamed reply, and the existing execution inspector. Public reasoning summaries, tool input/output, and raw records are available through the inspector. Details load when opened and retain a stable message/trace identity during streaming; the shared disclosure spring respects reduced motion. / 任务页在生成建议时显示本轮实时阶段、Runtime 与模型、耗时和最近公开活动。点击“调用详情”可展开执行快照、Runtime 回报的模型与供应商、会话与轮次 ID、最近一次回报与会话累计 Token 用量、应用记录的本轮指令、流式可读回复及既有执行检查器。检查器可查看公开思考摘要、工具入参与出参，以及原始记录。详情按展开加载，流式更新保留消息与事件身份，折叠动效复用共享弹簧并响应减少动态效果。

The requested turn reasoning setting and the server's thread-default reasoning setting are labeled separately. Missing model/usage fields stay unspecified; public Runtime records are not a complete inventory of provider HTTP requests. The task pane picks the latest assistant run before checking its captured planning phase, so a newer clarification cannot reveal an older planning run as current progress. Required tool approval stays outside the collapsed details. History recovery blocks adoption/retry until it succeeds, with a visible recovery retry on failure. Model completion and validation/publication of task proposals remain separate states. / 本轮请求的思考强度与 Runtime 会话默认强度分别标注。未回报的模型或用量显示未提供；Runtime 公开记录不能代表全部供应商 HTTP 请求。任务页先选择最新助手执行，再核对其快照中的规划阶段，避免在新的澄清对话期间把旧规划展示成当前进度。待用户处理的工具授权保持可见；历史恢复期间暂停采用和再次提议，恢复失败可重试。模型回复结束与任务建议解析、发布分别呈现。

## Developer notes / 开发说明

| Source | Responsibility / 职责 |
| --- | --- |
| [GoalsPage.tsx](../src/components/GoalsPage.tsx), [GoalAssistant.tsx](../src/components/GoalAssistant.tsx) | Save the initial idea, edit and confirm definitions, celebrate only after persistence, show planning and adoption. / 保存想法、编辑确认、持久化后庆祝、展示任务建议与采用。 |
| [goal-assistant.ts](../src/lib/goal-assistant.ts) | Runtime clones, prompts, strict response parsing, version/date/dependency validation, proposal adoption, persistence rollback. / 受限配置、提示词、严格回复解析、版本日期依赖校验、采用与失败回滚。 |
| [App.tsx](../src/App.tsx) | Native dispatch, completed-run processing, independent Task navigation and owner return. / 原生执行调度、终态回复处理、独立任务导航与目标返回。 |
| [goal_assistant.rs](../src-tauri/src/goal_assistant.rs), [permission.rs](../src-tauri/src/permission.rs), [runtime/codex.rs](../src-tauri/src/runtime/codex.rs) | App-managed directories, native CLI permission arguments, and restricted Codex app-server streaming. / 应用管理目录、原生 CLI 权限参数与受限 Codex app-server 流式协议。 |
| [goal-progress.ts](../src/lib/goal-progress.ts), [GoalProgress.tsx](../src/components/GoalProgress.tsx) | Separate evidence-backed task and goal-criteria counts. / 分别计算有依据的任务与目标标准进度。 |
| [workspace.ts](../src/lib/workspace.ts), [goals.ts](../src/lib/goals.ts) | Submit/review results, track requirements versions, record criterion evidence and goal achievement. / 提交验收结果、要求版本、标准依据与目标达成。 |

An internal `Task` with `kind: 'goal_assistant'` stores the goal conversation through the existing durable Run protocol. Exclude it from business task lists and progress; include its actual running members in Runtime concurrency limits. Replies must contain one final `goalward` JSON block and match the requested phase and goal version. Clarification may return `draft: null`; malformed or stale replies do not authorize confirmation or adoption. / 内置对话通过既有 Run 协议持久化，排除业务任务统计，但真实运行成员仍占并行额度。回复必须包含唯一的末尾 `goalward` JSON，匹配阶段和目标版本；澄清阶段允许 `draft: null`，无效或过期回复不能授权确认、采用。

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

These checks cover domain logic, rendered controls, build integrity, and native directory/storage behavior. They do not establish successful CLI authentication, a real remote-model clarification-to-adoption conversation, or end-to-end enforcement of each Runtime's restrictions. Real-model E2E is still unverified. / 这些检查验证领域逻辑、组件、构建和原生目录存储，不证明真实 CLI 登录、远端模型完成澄清到采用的完整对话或各 Runtime 权限限制的端到端执行效果；真实模型 E2E 仍未验证。

Token usage follows the public app-server fields: `last` is the latest reported increment, while `total` is the cumulative thread snapshot. It is not labeled as the aggregate usage of every model response within a user turn. See [OpenAI token accounting documentation](https://github.com/openai/symphony/blob/main/elixir/docs/token_accounting.md). / 用量沿用 Runtime 的公开口径：`last` 为最近一次回报的增量，`total` 为会话累计快照，不将前者误标为本轮全部模型响应的总量。

# Goalward product proposal: from a vague direction to results that can be reviewed

Date: 2026-09-16
Status: Final Proposal v1, for this round of prototype design and subsequent implementation breakdown. The product direction and initial prototype scope follow the user's requirements. New capabilities still require implementation; see the capability matrix for completion status.

## Implementation progress, 2026-09-17

This proposal is being implemented in the production React / Tauri application. The first basic feedback loop and explicit execution plans are implemented. README and code define currently available capabilities. “Existing / missing” statements in sections 10 and 12 retain the baseline at the start of design on 2026-09-16.

| Designed capability | Current production implementation |
| --- | --- |
| General goals, context, success criteria, stages, and history | Implemented; creation requires neither a Runtime nor metrics |
| Agent profiles, versions, goal assignments, and member overrides | Implemented; new configuration does not rewrite historical executions |
| Task ownership, subtasks, dependencies, and independent acceptance | Implemented; legacy tasks remain compatible |
| Results and evidence, adoption of context changes | Manual submission / acceptance and source links implemented; context is appended after review |
| Cross-task active-run view, chat, Trace, and stopping | Connected to real execution state |
| Serial/parallel plans, human gates, failure policies, and retries | Explicit user-configured step scheduling implemented, subject to persistence and concurrency limits |
| Weekly reviews | In-app periodic snapshots, catch-up, and deduplication implemented; users confirm progress judgments |
| Kimi CLI | Kimi Code CLI ACP integration, model selection, approvals, streaming, and cancellation implemented |
| Automatic breakdown, external query connectors, model-generated weekly reports, background services, automatic isolation and merging | Future extensions; the UI does not describe them as connected |

## 1. Product positioning and abstraction boundaries

**Goalward helps users without a clear goal, or with only an abstract direction, clarify what they want to move forward, turn it into tasks, organize people and Coding Agents to execute, and use artifacts and evidence to review results and adjust their next actions.**

Goals are the product's organizing thread, and Agent management is its core execution capability. Tasks and executions connect them. Goals organize direction, context, and outcomes; Agent management organizes execution roles, configuration, and activity. Users can start work from a goal or start an independent task from an Agent and associate it with a goal later.

Users manage something they want to move forward and its complete context. A goal may last hours, weeks, or be maintained long-term. It may deliver something, solve a problem, form a judgment, develop a skill, or improve a condition.

The core mechanism is:

```text
Define the goal and expected state
    → Understand the current state and gap
    → Create or adjust the plan
    → Create tasks and subtasks
    → Organize people and Agents to execute
    → Inspect results and update the current state
    → Review and choose the next step
    → Continue, confirm achievement, enter maintenance, or end the goal
```

Improving online user feedback is one practical scenario for testing this mechanism. Feedback rates, numerators/denominators, query interfaces, fix releases, and business-observation windows belong to that scenario; they must not become mandatory fields or fixed processes for all goals. See [the feedback-improvement scenario](scenarios/feedback-improvement.md).

The general product does not require every goal to have numeric metrics, external data sources, a code directory, a persistent Agent, or a fixed deadline. Missing information affects some judgments but does not prevent users from recording a goal and starting exploration.

## 2. General objects and responsibilities

| Object | Question it answers | General contents |
| --- | --- | --- |
| Goal | Why do this, and what state should be reached? | Intent, expected state, scope, constraints, success criteria, and versions |
| State | What is known, already available, and still missing? | Known facts, existing deliverables, decisions, unknowns, obstacles, and sources |
| Plan | How should work proceed next? | Stages, action directions, priorities, dependencies, and adjustment rationale |
| Task | What exactly happens in this step, and how is completion judged? | Inputs, expected results, acceptance methods, executors, subtasks, and business states |
| Agent profile | Who can be reused for execution, and how should they work by default? | Name, role instructions, Runtime / model preferences, and versions; a new capability |
| Runtime / Model | Which execution environments and models are available? | Local detection, launch arguments, permissions, model catalogs, and compatibility; reuse existing capabilities |
| Run | How was this invocation actually executed? | Context at execution time, Agent / Runtime / model, process, artifacts, and terminal execution state |
| Results and evidence | What was obtained, and what supports that judgment? | Artifacts, findings, validation, user confirmation, failure information, and linked sources |
| Review | Which changes helped, is the direction appropriate, and what comes next? | Before/after states, achievement, plan deviations, supporting evidence, and next actions |

These divide responsibilities; they do not require a separate page or database table for every concept. The initial Plan can organize stages and tasks within a goal. Results and evidence can link to file paths, file-change events, and user-supplied artifacts in existing execution records to avoid duplicate modeling.

A goal owns ongoing context, a task acts toward it, and a Run is one actual execution. Tasks may run repeatedly. One goal can include tasks in different directories, using different tools and executors.

Initially, a task may stand alone or belong to one goal; subtasks inherit their parent's ownership. Independent tasks can be associated later. Legacy tasks retain an independent entry point. Recursive subgoals and complex cross-goal dependencies are excluded initially.

## 3. Goals and success criteria

Creation asks only what the user wants to do. Brief guidance or Agent conversation then clarifies:

- What result or change should ultimately occur?
- What is the current situation, and what information and deliverables already exist?
- How will success be judged?
- What constraints and time requirements apply?

Success criteria can combine these forms:

| Criterion form | Example | Possible checks |
| --- | --- | --- |
| Deliverable | Deliver a desktop app suitable for trial use | Actual artifact, functional verification, user acceptance |
| Established fact or capability | Independently complete a specified exercise | Demonstration, inspection records, self-assessment, or external assessment |
| Evidence-supported judgment | Reach an actionable selection among several options | Comparison materials, experiments, known limitations, and decision confirmation |
| Numeric requirement | Bring a metric into the user-agreed range | Comparable observations and an explicit threshold |
| Sustained condition | Maintain a condition over an agreed period | Continuous observations or periodic checks |

These forms combine success criteria rather than force all goals into mutually exclusive categories. A goal may include deliverables, quality requirements, and numeric conditions together.

An exploratory goal can have incomplete criteria. The system records unknowns and helps clarify them. Changes to goals, criteria, or constraints save a version; historical executions and reviews retain their original version references.

Goal creation requires neither a Runtime nor a working directory. Add execution resources when tasks need them.

## 4. Current state and context

Current state is a traceable description of the situation, supporting text, structured facts, existing artifacts, decisions, obstacles, and optional metrics. The home page displays available content without adding empty charts to goals that have no data.

Current state can come from:

- Direct user descriptions or revisions, retaining a user-provided source.
- Documents, files, code, notes, and existing artifacts.
- Deliverables, findings, and validation records from task execution.
- External information from tools, connectors, or queries.
- Work completed outside the application by users or other participants.

Users can begin with brief context and add sources later. Information that needs repeated retrieval can have a retrieval method configured; structured metric queries are one extension.

Agent interpretations, unverified hypotheses, and accepted facts are recorded separately. Acceptance may use user confirmation, specified check rules, or an agreed acceptance process. Non-numeric conclusions are not automatically invalid.

Each update records the change, source, time, and linked task, retaining revision history. Conflicting or outdated content displays its differences and evidence. The latest Agent summary cannot unconditionally overwrite the entire current state.

## 5. Plans, tasks, and execution orchestration

Users can create tasks directly or ask an Agent to suggest them from the goal and context. Suggestions should explain what the action will deliver, which unknown it resolves, or which success criterion it advances.

Tasks support stages, subtasks, priorities, and dependencies. A task can use one Agent, multiple collaborating Agents, people, or steps waiting for external results. Non-Agent steps can also change state and submit results.

Orchestration selects roles, Runtimes, models, input context, serial/parallel relationships, and retries or handoffs after failure. Roles follow task needs, such as research, writing, implementation, testing, or review, rather than fixed scenario-specific jobs.

Task states are independent of Runs: pending, in progress, blocked, awaiting acceptance, done, and cancelled. Dependencies are initially planning information. Automatic waiting or task startup can be claimed only after corresponding scheduling logic exists.

A Run retains the goal version, context snapshot, task requirements, and actual member configuration at execution time. Later goal edits or model changes do not rewrite history.

A goal can have a progress assistant that helps understand gaps, suggest plans, organize results, and review. It executes on demand or on an agreed schedule, while the product stores ongoing context.

## 6. How results update current state

```text
Execution ends or the user submits results
    → Organize artifacts, findings, and evidence
    → Check or confirm against task requirements
    → Update task state
    → Incorporate applicable changes into the goal's current state
    → Recheck success criteria and remaining questions
    → Propose continuing, adjusting the plan, or confirming achievement
```

Updates depend on the goal. Delivery tasks can add deliverables; research tasks can rule out hypotheses or reduce unknowns; learning tasks can add capability-validation records; metric-based goals can add observations.

A normally exited execution does not establish task acceptance, and a completed task does not automatically establish goal achievement. Valuable negative results can clarify context, such as an experiment disproving the original approach and prompting a revised plan.

Some results can be verified immediately; others need later checks or external feedback. The product can record “delivered, impact awaiting verification” without requiring a business-metric observation period for every task.

User revisions, external information, and periodic checks can also update context. Duplicate events do not count deliverables twice, and invalid sources cannot reset known state to zero or empty.

## 7. Progress and reviews

Present three related but distinct views:

- **Goal progress:** satisfied success criteria, remaining gaps, and areas that cannot be judged.
- **Action progress:** completed, active, blocked, and awaiting-acceptance tasks.
- **Knowledge changes:** new findings, ruled-out hypotheses, and changed decisions.

Presentation follows the criteria: checklists, stage states, deliverable lists, conclusions and remaining questions, or metric trends. Show no overall percentage without a reasonable calculation, and do not infer goal achievement from task completion rates.

Reviews address the same questions: what changed, which changes helped the goal, whether the original plan remains appropriate, and what comes next. Users can trigger reviews manually, by stage, or periodically; weekly review is one periodic configuration.

Judging whether progress meets expectations requires corresponding standards. Deadlines or milestones allow time comparisons; exploration can compare planned research questions with obtained results. Missing conditions must be identified without inventing progress ratings.

Reviews retain the goal, before/after context, and evidence at that time. Suggestions can become tasks; automatic creation and startup belong to a separately configured user execution policy.

Goals can be awaiting clarification, active, paused, achieved, or ended. Goals requiring sustained conditions can explicitly enter maintenance. One successful observation does not automatically end them, while completed one-time delivery goals should not continue indefinitely.

Scheduled desktop execution must explain its actual operating conditions. Initially, reviews can run while the application is running, catch up missed periods when reopened, and display actual execution times. Timely execution after exit needs a background service or remote capability. Deduplicate by goal and period to prevent repeated reviews.

## 8. General page structure

Retain Tauri 2, React, TypeScript, shared shadcn/ui components, and the current dense column layout. The theme follows the OS by default; users can choose dark or light in Settings → Appearance. Theme, font, and language changes apply immediately and save automatically. Automatic saves include only appearance fields; Runtime / model / execution settings retain manual saving. Theme changes use the same semantic tokens without changing layout or the component system. Future UI and motion implementation follows AGENTS.md and the design system.

Primary left navigation contains Goals, Agents, Tasks, and Running, with Runtime & models and Settings at the bottom. Goals open Overview by default and can switch to Tasks, Progress records, and Reviews. The overview always includes a compact participating-Agents area and management entry point.

Agents use a list/detail layout. Running aggregates actual execution instances and shows goal, task, member, Runtime, model, current action, elapsed time, and last activity. Tasks retains cross-goal and independent tasks.

```text
Goal name                                      [Update context] [Create task]
Expected-result summary · Current stage · Items requiring attention

Overview | Tasks | Progress records | Reviews

Expected state and success criteria
Current state: deliverables, known facts, unknowns, obstacles, and applicable metrics
Plan: stages, next actions, dependencies, and decisions
Participating Agents: roles, linked tasks, active execution counts, and configuration
Recent changes: results, findings, revisions, and reviews
```

Information density follows the goal's contents. Numeric scenarios can show trends; delivery scenarios show deliverables and acceptance; exploration shows questions and conclusions. Navigation and task execution remain consistent.

Task workspaces reuse existing conversations, member configuration, Runtime / model selection, execution history, and Trace inspector, retaining a return path to the goal.

## 9. Test one product with different scenarios

These test the abstraction; they do not establish four product positions or require four dedicated modes:

| Scenario | Expected state | Example current state | Actions and tasks | Progress checks |
| --- | --- | --- | --- | --- |
| Deliver a desktop tool | Trial installation package meeting agreed requirements | Prototype exists; implementation and validation are missing | Implement, test, package, gather trial feedback | Artifacts and acceptance criteria |
| Research a technical choice | Evidence-supported selection among candidates | Candidates exist; critical limitations remain unclear | Read, experiment, compare, decide | Key questions answered and decisions supported |
| Learn a skill | Independently complete an agreed practice | Fundamentals known; complete practice missing | Plan learning, practice, assess, fill gaps | Practical results and capability assessment |
| Improve online feedback | Feedback rate meets user-defined criteria | Current observations exist; some causes remain unconfirmed | Analyze, improve, validate, observe | Observations and evidence under agreed definitions |

The first three can complete the feedback loop without invented business metrics. The fourth uses metrics and data-source extensions. Every scenario allows tasks to update context, revise plans, and trigger reviews.

## 10. Existing implementation and minimum delivery scope

The production application currently has Task, Run, member configuration, Runtime processes, conversations, and public Trace. Task display states mostly follow the latest Run. Manual division of work and parallel sends exist; automatic breakdown, dependency scheduling, and automatic summarization do not yet exist.

First add these general capabilities:

1. Goal: description, expected state, success criteria, constraints, and versions.
2. State / StateUpdate: current situation and source-linked historical changes, supporting text, deliverables, and structured content.
3. Task extensions: goal ownership, subtasks, dependencies, executors, acceptance requirements, and independent business state.
4. Result / Evidence: results and supporting evidence, linking wherever possible to execution file paths, file-change events, and user-supplied artifacts and confirmations.
5. Review: state comparison, judgment, and next steps for a stage or period.

Metrics, data queries, automatic retrieval, and specific business workflows are optional extensions. Query sources can reuse Agent or connector capabilities. Building a BI platform is not a prerequisite for the general feedback loop.

The first deliverable version should support both paths:

- From a goal: create any goal → establish context → choose an Agent and create a task → execute and accept → update context → review.
- From an Agent: create or select a profile → create an independent task or join a goal → configure and execute → inspect current activity and history → associate results with a goal.

The first phase includes reusable Agent profiles, per-task configuration, and cross-task execution visibility. Periodic triggers, automatic information retrieval, and stronger orchestration follow later.

Legacy tasks and historical Runs remain intact and initially await goal association. Successful legacy execution is not migrated into accepted business status. Data changes include explicit migrations and legacy-state compatibility.

Acceptance must cover delivery and exploration scenarios, with feedback improvement testing metric extensions. Every scenario verifies separate terminal execution and business states, traceable results, user-editable context, adjustable plans, and retries/recovery without duplicate deliverables.

## 11. Full responsibilities of Agent management

### Object boundaries

```text
Agent profile (reusable role and default configuration)
    → Role assignment within a goal team (optional)
    → Task member (source-profile version + task overrides, or temporary member)
    → RunMember (immutable configuration snapshot for one actual execution)
    → Runtime / Model / public events / results
```

- AgentProfile is a configuration asset, not a persistent process or a Runtime alias. One Runtime can execute several Agents with different roles.
- GoalAssignment records participation and role without requiring every participant in every task. The initial version retains simple links without a complex team-permission system.
- TaskMember reuses the existing Member. Members may come from profiles or be created temporarily. Conversations remain task-isolated; using one profile does not share all history.
- Run / RunMember represents actual activity. An Agent can have several simultaneous instances, so profile enabled/disabled status is separate from counts such as 2 running and 1 failed.

### Primary Agents page

A compact profile list appears on the left and the selected profile's details on the right. The list shows name, role, default Runtime / model, linked-goal count, and active-execution count. Details contain Configuration, Participating tasks, and Execution history.

Actions include create, edit, duplicate, disable, assign to a goal, and create a task with this Agent. Save as Agent from an existing task member progressively builds reusable profiles.

Configuration fields include name, role instructions, default Runtime, compatible model, reasoning effort, and notes. Initially, display saved Runtime access permissions, model compatibility, and detection results. Display skill/tool inventories only when the Runtime exposes them and the adapter supports reading them. Discovery and synchronization are later capabilities. Permission rules do not establish installed skills or actual tool inventories. The initial version claims neither uniform cross-Runtime tool injection nor per-Agent sandboxes.

Disabling limits new assignments without silently stopping existing executions. Profile edits create new versions. New members use the new version; existing members adopt it through an explicit update while retaining task overrides. Historical Runs remain unchanged. Conversation or task parameter edits do not automatically rewrite global profiles.

### Agent management within tasks

Retain single-Agent / collaborative modes, member addition/removal, role assignment, Runtime / model / effort selection, member conversations, recipients, and historical execution selection. Member-structure edits obey the current batch's execution constraints. The prototype must not pretend to hot-swap running processes.

Inspecting members, editing configuration, and choosing message recipients remain independent. Edits during execution are labelled effective next execution. Changing Runtime uses a new execution and context handoff without implying restoration of a vendor-native session.

### Runtime and model management

Retain the settings entry points: local detection/import, executable path, enabled state, adapter, launch arguments, default model, model catalog and Runtime binding, effort, adapter-specific permissions, record export, and storage.

Detected programs, registered configuration, callable models, and running processes are distinct states. The UI displays only evidenced states. Model registration or executable detection cannot be called successful account/model-call validation.

### Primary Running page

Show cross-goal and cross-task current activity, failures, and interruptions by Run / member instance, alongside concurrency limits. Support opening conversations, locating Trace, entering tasks, and stopping specific executions. The stop scope must be visible so a member-row action cannot accidentally stop all tasks.

The current workbench's ordinary stop operates on the task run batch. The initial cross-task view retains the label Stop this execution (N members). The backend already has member-specific stopping; exposing it requires frontend actions, launch-race handling, and acceptance. Pause, queue, resume, and live input injection are not presented as existing capabilities.

## 12. Implementation boundaries based on existing capabilities

Inspected sources: README.md, src/lib/types.ts, src/lib/domain.ts, src/App.tsx, Workbench, MemberConfiguration, SettingsPage, and TracePanel.

| Capability | Existing implementation | Design treatment in this round |
| --- | --- | --- |
| Local Runtime detection, import, registration, configuration | Existing | Retain four Runtimes; prototype adds Kimi CLI with real integration pending |
| Model catalog, binding, effort, and Runtime permissions | Existing | Reuse settings rather than conflate them with Agent capabilities |
| Task members, single/multiple members, recipients | Existing | Retain the full execution page and add profile sources |
| Parallel invocation for selected/all members | Existing | Retain accurately; automatic dependency scheduling is new |
| Real execution, stop, historical snapshots, sessions, Trace | Existing | Retain details/evidence and add cross-task aggregation |
| Global Agent profiles, versions, goal links | Missing | Add initially; renaming Runtimes does not implement it |
| Goals, context, plans, independent acceptance, reviews | Missing | Add general objects and a manual feedback loop initially |
| Automatic artifact lists and result acceptance | Incomplete; real file events exist in Trace | Prototype illustrates planned interactions; implementation first supports manual attachment and Trace links |
| Automatic breakdown, member scheduling, dependency waiting, summarization | Missing | Show suggestions and explainable plans; implement automation in later phases |
| Automatic retrieval and periodic reviews | Missing | Add later, explicitly describing scheduler operating conditions |
| Native-session recovery, pause, input injection during execution | No uniform capability | Do not show universally available controls for all Runtimes |
| Automatic worktrees, isolation, conflict detection, merging | Missing | Shared-directory multi-Agent execution is not safe isolated collaboration |
| Provider credential injection, connection testing, shared secret management | Missing | Retain registration without promising connectivity |

Production implementation has three phases:

1. **Basic goal and Agent-management feedback loop:** goals/context, reusable profiles, task ownership/independent acceptance, existing Runtime execution/cross-task activity, manual reviews.
2. **Ongoing progress:** structured results, refreshed information sources, periodic reviews, state-change suggestions, and stage plans.
3. **Orchestration automation:** dependency scheduling, role collaboration, retries/recovery, isolation/conflict handling; enable each incrementally according to actual Runtime capabilities.

## 13. Prototype scope and acceptance for this round

The first round designs four core screens within one navigation system:

1. **Goal overview:** general goals, success criteria, current state, task plans, participating Agents, and review entry points. The main example delivers a trial desktop app, with technical-choice research as another example. Feedback improvement is only one scenario.
2. **Agent management:** profiles, roles/defaults, participating goals/tasks, historical executions, creation/editing, assignment, and independent task startup.
3. **Task execution:** goal/task location, acceptance criteria, member collaboration, conversation, recipients, Runtime/model/effort, artifacts, and execution inspector.
4. **Running:** cross-goal instances, member ownership, concurrency limits, failures/interruptions, conversation/Trace location, and clearly scoped stops.

Provide the minimum interaction chain: switch primary entry → create a task from a goal and choose an Agent → enter the workbench → inspect member configuration and Trace → demonstrate result submission and context update. Tasks can also start from Agents. Goal creation, profile editing, and Runtime/model selection use compact dialogs/forms. The prototype prominently identifies sample data; execution and persistence are local demonstrations.

Retain 1536 × 960 and 1280 × 720 desktop acceptance sizes, independent scrolling, and fixed composers. Apply apple-design for immediate feedback, interruptible toggles, focus restoration, and reduced motion. Implement actual motion with animate and shared parameters. Frequent navigation updates immediately without whole-page entry or token animations.

Prototype completion verifies primary navigation, creation/configuration, independent recipients, stop scope, state updates, normal/reduced motion, and focus. A prototype without real Runtimes cannot establish completed execution, automatic scheduling, or production UI-component migration.

### Second-round prototype refinement

Refine the workbench, Agent management, and orchestration in parallel. Four pages share one browser-demonstration state:

- The workbench orders expected results, success criteria, confirmed facts, pending changes, and tasks clearly. Reviews include conclusions, evidence gaps, and actionable next steps that can become tasks. Periodic settings are explicitly demonstration preferences.
- Agent management adds search/filtering, participating goals/tasks/executions, and version differences. Tasks use saved profiles; version updates remain separate from historical snapshots.
- Orchestration shows step dependencies, serial/parallel relationships, responsible members, inputs/outputs, failure policies, human confirmations, and retries. It is an interactive local plan simulation; real scheduling retains the phased implementation boundaries above.
- Task, execution, acceptance, and goal facts change separately. Stops, activity counts, and state changes use one shared source. The Running page accurately locates research tasks and member Trace.

Historical prototype deliveries and acceptance records remain local and are excluded from the public repository. Generated pages and local simulations do not change section 12's conclusions about existing production capabilities.

### Kimi CLI Runtime

Kimi CLI is a Runtime alongside Codex, Claude Code, Pi, and DeepSeek Harness. It can be an Agent profile's default environment or a task member's next-execution configuration. Model, effort, and permissions follow that Runtime's actual exposed capabilities. Unread configuration inherits defaults without inventing universal effort levels. Tasks and Runs retain their execution-time Runtime snapshots.

This design round covers the sidebar, settings, Agent creation/editing, task-member selection, execution lists, and Trace identity. The production app still retains four existing integrations; Kimi's real detection, authentication states, approval, and cancellation protocols require separate implementation. Current Kimi Code CLI supports ACP. Legacy kimi-cli and newer kimi-code must not share command templates without version checks.

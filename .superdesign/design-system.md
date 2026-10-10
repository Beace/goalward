# Goalward — Desktop Design System

## Mandatory project constraints

Read and follow [AGENTS.md](../AGENTS.md). The project uses **shadcn/ui** as its common UI component foundation. Preserve the current dark desktop visual direction through shared theme tokens and component variants. New or changed motion must use the actual **apple-design** skill from its installed `SKILL.md`. Apply its motion and accessibility guidance within the existing visual system.

The exported HTML drafts remain design references. This requirement governs subsequent implementation; it does not mean the existing HTML is already a shadcn/ui application.

## Product and intended outcome

A native-feeling, goal-driven desktop workbench that helps users turn a broad direction into goals and tasks, carry out work with people and local coding agents, collect artifacts and evidence, and review the next action. Coding Agent proxying, solo and collaborative runs, runtime/model configuration, persistent conversations, and execution traces support that loop. For product scope, follow docs/goal-driven-product-proposal.md; the existing task workbench remains the execution surface. Primary language: Simplified Chinese, with runtime names and familiar technical identifiers in English.

The first draft is the main workbench during a three-agent collaboration. It must communicate an operational product through actual controls and realistic information hierarchy. Task, runtime, model, member, and trace are distinct concepts. See product-design.md for precise interactions and boundaries.

## Primary visual source

The current workbench and settings designs are the visual baseline. Preserve their near-black neutral foundation, restrained warm sand/bronze accent, precise UI typography, compact controls, and fine light borders. shadcn/ui supplies the component foundation; its default theme does not replace these project visuals.

Historical inspiration: Superdesign library style `neural-noir-interface-style` (Neural Noir Interface Style).

The user selected a dark professional IDE-like split view. Therefore editorial typefaces, hero sections, decorative network diagrams, gradients, dot-grid decoration, floating marketing cards, glow effects, glass cards, large radii, and promotional page structures from the source do not apply. The complete allowed system is below; it overrides the source's unsuitable marketing components.

## Typography

- UI: Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif.
- Code and metadata: "SFMono-Regular", "JetBrains Mono", Consolas, monospace.
- Task heading: 14 px / 20 px, weight 600; single-line ellipsis with the full title available on hover or focus. The workbench header uses two compact rows: title, status and icon actions; then directory, execution mode and run history. Goal navigation is a labeled icon beside the directory. Narrow panes may wrap the second row to preserve controls.
- Section heading: 13 px / 20 px, weight 600.
- Body and chat: 13 px / 21 px; chat can use 14 px / 23 px where needed.
- Controls: 12 px / 18 px; minimum 28 px control height.
- Supporting labels: 11 px / 16 px; avoid excessive low-contrast text.
- English metadata can use modest tracking; Chinese text uses normal tracking.

## Colors

- Window background: #101111.
- Title bar and sidebar: #141515.
- Main workspace: #191A1A.
- Raised panel / menu: #202222.
- Hover / selected neutral: #292B2B.
- Inset code / input: #151717.
- Subtle divider: #2E3231.
- Strong border: #454B47.
- Primary text: #EAECE8.
- Secondary text: #B1B7AE.
- Muted text: #90998E.
- Warm sand accent: #C9B8A0; selected subdued background #302C27.
- Hover accent: #E8D5B7.
- Primary button: #D9C8B1 with #171817 text.
- Running / success: #89B99A, muted surface #23342A.
- Waiting / needs attention: #D7B778, muted surface #342D20.
- Failure: #D58D83, muted surface #362624.
- Secondary member indicator: #98ADB5; third member indicator: #B6AC96.
- Window controls only: close #DE7770, minimize #DBBC75, maximize #83AF87.

Use neutral monochrome for most of the interface. Accent is sparse and purposeful: active mode, selected agent, primary action. Status must pair a color with a text label or icon. No blue/purple gradient aesthetic.

## Spacing and components

- Spacing steps: 4, 8, 12, 16, 20, 24, 32 px.
- Border radius: 4 px small controls, 6 px menus, 8 px member panels and composer. Larger pills only for compact status badges.
- Borders: mostly 1 px. Prefer flat separated regions to floating cards.
- Shadows: only menus / overlays, 0 12px 32px rgba(0,0,0,.3).
- Button heights: 28 / 32 / 36 px. Small icon buttons need accessible labels.
- Icons: consistent 16 px simple outline functional icons, stroke 1.5 px; no emoji avatars or invented vendor logos. Runtime identities use locally bundled official logo assets beside their text labels (16–20 px, up to 24 px in detail headers), preserving their original proportions and published dark-compatible colors. This small brand-color exception does not change the neutral/sand interface theme. Source records live in `assets/branding/runtime-source-*.md`; unknown custom runtimes retain a neutral terminal icon.
- Identity: use Goalward as the app title and the current app icon documented in `assets/branding/README.md`. Historical S-mark assets are not the Goalward icon. The brand update does not change interface colors, dimensions, motion, or vendor runtime identities.

## 信息密度与渐进展示

- 工作台以用户内容为主，工具栏和文件列表项默认一行；工具栏 / 产物行基准 40 px，Tabs item 32 px，图标按钮至少 28 × 28 px。使用既有字体和间距 token，不通过缩小文字或点击区域挤内容。
- 产物行采用「文件图标 · 文件名 · 灰色路径 · 右对齐的复制 / 预览按钮」。名称优先展示，路径使用 `muted-foreground` 填充同一行剩余空间，过长省略；名称最多占行宽的 45%，长名称也可省略，按钮保持完整可见。完整名称、路径、成员与执行来源在悬停或键盘聚焦时查看。未落盘内容显示“回复内容”并使用“复制内容”，网页显示 URL 并使用“复制链接”，避免虚构文件路径。
- 文件类型图标统一复用 `src/components/FileIcon.tsx`，列表和预览标题保持一致。HTML 使用橙色代码文件图标，Markdown 使用蓝色 M 与向下箭头，CSS / 样式文件使用紫色画笔；代码、配置、图片、表格、压缩包、音视频等按扩展名识别，未知类型回退为灰色通用文件。保持 16 px 细线与固定占位，颜色辅助识别，不替代图形与文件名；类型图标不代表该格式一定支持内嵌预览。
- 文件类型色是中性色工作台的局部例外，仅用于类型图标。颜色在 `src/index.css` 的 `--file-icon-*` token 中集中管理：橙 `#E6A071`、蓝 `#83B4E8`、紫 `#B59CDE`、青 `#78C6D6`、黄 `#D7BE78`、绿 `#89B99A`、红 `#DF9294`。文件名、灰色路径和操作按钮沿用原有主题，不用类型色表示运行状态。
- 上级 Tab 已表达当前视图时省略重复标题。扩展名已说明文件类型时省略重复徽标；来源、实现方式、刷新时间和一般性帮助不单独占行，移入提示或详情。验收状态、错误和待操作事项保留明确反馈。
- 常见操作使用共享图标按钮，设置 accessible name 与悬停说明；复制成功在原按钮显示勾选并通过 live region 宣告，失败提供可读、可重试的反馈。高频切换即时响应，反馈不推动列表或预览内容位移。
- Tab 图标、文字和关闭按钮共享同一 item 的背景 / 边框；关闭图标和点击区域均须包含在其边界内，不拼成独立的额外列。
- 在 1536 × 960、1280 × 720 及拖窄分栏时检查：列表行高、长名称省略、按钮完整可见、无横向页面溢出；键盘可查看完整信息、复制并打开文件。精简展示不删减持久化的来源数据。

## shadcn/ui implementation contract

- Use the official shadcn/ui components and maintain their source in one shared project UI directory. Compose business components from that foundation.
- Use CSS-variable theming with semantic tokens. Define the visual values centrally; page-specific code must not replace them with a competing palette.
- Preserve accessibility, keyboard interaction, focus management, and disabled/error semantics when customizing appearance.
- Use shared component variants for compact desktop control sizes. Avoid per-page copies of buttons, selects, menus, dialogs, and tables.
- Match the exact visual colors below even if the implementation stores them in another CSS color notation. This mapping is a project decision based on the current design, using the official theme mechanism.

| Semantic theme token | Project value / role |
| --- | --- |
| `background` / `foreground` | #191A1A / #EAECE8 |
| `card` / `card-foreground` | #202222 / #EAECE8 |
| `popover` / `popover-foreground` | #202222 / #EAECE8 |
| `primary` / `primary-foreground` | #D9C8B1 / #171817 |
| `secondary` / `secondary-foreground` | #292B2B / #EAECE8 |
| `muted` / `muted-foreground` | #202222 / #90998E |
| `accent` / `accent-foreground` | #302C27 / #C9B8A0 |
| `border` / `input` | #2E3231; use #454B47 for the existing stronger border variant |
| `ring` | #C9B8A0 |
| `sidebar` / `sidebar-foreground` | #141515 / #B1B7AE |
| `sidebar-accent` / `sidebar-accent-foreground` | #302C27 / #C9B8A0 |
| `sidebar-border` / `sidebar-ring` | #2E3231 / #C9B8A0 |
| `destructive` | #D58D83; choose paired text / fill treatment to retain contrast |
| Project-specific surface and status tokens | Preserve #101111 window, #151717 inset input surface, and the status colors listed above |

Set the radius scale to the existing 4 / 6 / 8 px small / medium / large values. Do not accept different generated defaults merely because a shadcn preset supplies them. The exact CSS declaration format follows the installed shadcn/ui and Tailwind versions.

Official references: [component source model](https://ui.shadcn.com/docs), [component catalog](https://ui.shadcn.com/docs/components), [theme tokens](https://ui.shadcn.com/docs/theming).

## Layout

- Target 1536 × 960; render an actual edge-to-edge desktop app, with no browser chrome or exterior marketing scene.
- 40 px title bar: macOS-style window controls on the left, workspace context, compact command search / keyboard hint.
- 224 px left navigation: new task button, project name, running/recent task groups, bottom runtime and settings entries.
- 336 px right inspector: trace header, filters, event list, one expanded tool event and detail output.
- Flexible central pane: task heading and controls, member roster, view tabs, task conversation, fixed composer.
- 24 px footer status bar.
- Pane dividers visually suggest resizability. Each pane scrolls independently. No horizontal overflow at target size.
- Below 1280 px, inspector collapses to an explicit reopen button; never squash all columns into unreadable fragments.
- Central content uses available width, not a narrow marketing max-width container.

## Existing task workbench content (retained execution reference)

- Project: goalward; task: 为工作台增加全局命令面板.
- Mode switch: 单 Agent / 协作 (协作 active).
- Keep the conversation prominent. Runtime, model, and reasoning selectors live in the composer footer, without a large member-card roster above the conversation. Multi-agent configuration uses an independent compact member selector; viewing or editing a member never changes the message recipient.
- Member one: 协调 / 实现, Codex, GPT-6-Astra (illustrative configuration), implementing command search.
- Member two: 测试, Claude Code, 默认配置, running keyboard interaction tests.
- Member three: 审查, Pi, 默认配置, waiting for implementation changes.
- 添加成员 opens a local panel listing Codex, Claude Code, Pi, DeepSeek Harness, Kimi CLI and their illustrative connection state. All five runtime names must be discoverable on the first page, with DeepSeek Harness visible in the runtime availability list or menu.
- Separate runtime and model controls; selecting an agent never silently changes message recipient.
- Tabs: 任务对话 / 成员会话 / 产物 3.
- User request is compact; coordinator answer shows a three-item assignment list; a member result shows linked files; running activity uses a small compact block.
- Composer has explicit target 发给：协调者 · Codex, attachment action, contextual chips, and send action.
- Right trace shows nested actionable event rows, readable timestamps and duration, ownership, one expanded tool call with command or params and result. Include an actual trace identifier in small monospace text.
- Bottom status includes 本地服务已连接 and 2 运行中 · 1 等待. Clearly mark the prototype as 示例数据 in a small global label.
- Historical execution menu: 第 2 次执行, opens earlier run entries.
- Sidebar runtime availability includes all five names with small official identity logos and separate compact ready / unconfigured indicators. A brand logo communicates runtime identity, not connection status; historical execution identities come from the saved runtime snapshot.

## Interaction fidelity

Implement lightweight prototype interactions if the draft environment supports them: solo/collaboration toggle, select member, runtime and model dropdowns, add-member menu, conversation/artifact tabs, trace expansion/filter, recipient selector, and inspector collapse. These operate on mock data and must never imply a real runtime was launched.

Runtime/model controls changed during a run show 下次执行生效. Runtime handoff explicitly previews the context and creates a new session. A compact persistent run indicator near the composer shows elapsed time and the latest public activity; the conversation also displays current search/tool/waiting feedback. Trace contains only publicly exposed runtime events, not inaccessible private model reasoning. Unknown model/use/cost values must remain unknown rather than invented numbers.

## Motion and accessibility

- **Motion authority: `apple-design`.** Read the current installed skill before designing or implementing motion. The following rules derive from its response, interruptibility, spring, gesture, spatial-consistency, and accessibility guidance. Resolve the installation path again on another machine.
- **Default development workflow:** Every interactive UI change follows the [default motion workflow in AGENTS.md](../AGENTS.md#前端交互动效的默认开发流程). Proactively implement purposeful feedback with `apple-design` and `animate`; use `find-animation-opportunities` for a read-only discovery pass when filling gaps in existing pages, then implement within the authorized scope. Reuse the shared shadcn/ui components, `src/lib/motion.ts`, and centralized CSS motion parameters. Verify generated animation styles, entry/exit behavior, and the applicable interaction checks below; audit-only requests remain read-only. The project rules and `apple-design` take precedence over supplemental skill examples.
- **Immediate response:** show pressed feedback on pointer-down; commit actions through the normal click / keyboard activation behavior. No artificial delay or waiting for a transition before processing input.
- **Continuous interruption:** retarget from the current on-screen value, preserving velocity continuity. Never lock input while an animation runs or restart from a stale logical target.
- **Restrained springs:** the skill's design reference is damping ratio `1.0` with response `0.3–0.4 s` for default UI motion. Use slight bounce (ratio around `0.8`) only for genuine momentum-driven releases. Response is not fixed duration; damping ratio is not the animation library's physical `damping` coefficient. Map these concepts to the selected library's actual API through shared presets; do not blindly configure `damping: 1`.
- **Direct manipulation:** draggable content follows the pointer 1:1 with its original grab offset, capture, and cancellation handling. Gesture-driven motion needs interruptible springs / motion values rather than fixed CSS transitions or keyframes. Transfer release velocity and project a snap destination only for interactions that actually support momentum and snapping.
- **Spatial consistency:** enter and exit along the same path; anchor menus and popovers to their trigger. Small, non-gesture opacity / color feedback may use CSS transitions. The old blanket `120–180 ms ease-out` rule is superseded by these interaction-specific requirements.
- Apply motion through shared presets or variants; reconcile shadcn component animations so the same properties are not animated twice. Prefer `transform` / `opacity` for animated effects; actual pane resizing remains direct layout manipulation.
- **Accessibility:** `prefers-reduced-motion: reduce` replaces slides, scale, and springs with short cross-fades or static updates, without bounce. Keep meaningful feedback. Existing translucent surfaces respond to `prefers-reduced-transparency: reduce` with solid or more opaque fills; `prefers-contrast: more` uses defined contrasting boundaries. Preserve the dark palette in every fallback.
- The skill's material and typography examples do not change the chosen static style. Do not introduce glass surfaces, bright backgrounds, or different fonts as a side effect of applying its motion guidance.

### Motion in this product

These are project-specific applications of the skill, rather than additional claims about its contents.

| Interaction | Required behavior |
| --- | --- |
| Buttons, switches, runtime / model selectors | Immediate pressed / selected feedback; preserve standard activation semantics; no decorative bounce |
| Pointer hover on buttons, tabs, selectors and menu / list items | Existing background, text and border colors use the shared `--motion-feedback-duration` / `--motion-feedback-ease` transition (120 ms) in `src/index.css`, on both enter and leave. Gate hover transitions to a fine pointer with hover capability. Press, keyboard highlight changes and reduced motion stay immediate; do not add a new hover color merely to animate it. |
| Popover, command menu, dialog, inspector | Origin matches the trigger or pane edge; symmetric enter / exit; interruption and focus restoration work during rapid open / close |
| Task, agent, settings category switching | Update the selected state immediately; use restrained continuity where useful; no whole-page staged entrance |
| Tool details, raw records, advanced settings | Shared measured-height spring with a rotating indicator; retain current height/velocity on reversal, hide closed content from keyboard/accessibility immediately, use static updates for reduced motion. Once open, streaming and nested content use natural layout without replaying the parent animation. |
| Resizable panes | Track the pointer immediately, respect size bounds, retain the released size; no inertial drift or delayed spring-follow during resize |
| Chat tokens and trace events | Incremental content updates; preserve user scroll position; no repeated whole-view or per-token entrance animations |
| Start, pause, stop, send, save | Dispatch the real operation immediately; feedback reflects pending / success / error state; animation never gates the operation or claims early success |

- Avoid continuous decorative animations and entry sequences. Functional running feedback remains compact and must have a reduced-motion equivalent.
- Verify with interactive examples: normal and reduced motion, mid-animation reversal, repeated switching, pointer cancellation, keyboard navigation, and streaming content. Review in slow motion when needed to catch position or velocity jumps.
- Clear keyboard focus rings in warm sand; readable contrast; semantic button labels and titles for icon-only actions.
- Suggested shortcuts: Cmd+K global command, Cmd+N new task, Cmd+Enter send, Esc close overlay. These are product design proposals.

## Strict fidelity

Use ONLY the fonts, colors, spacing, and component styles defined in this design system. Do not introduce any fonts, colors, or visual styles not in the design system.

## Global toast notifications

- Every floating toast is centered against the full window at `top: 56px` (40 px title bar plus 16 px gap). Never position it at the bottom or center it against only the conversation pane.
- Use the raised neutral surface `#202222`, strong neutral border `#454B47`, primary text `#EAECE8`, 6 px corners, and the existing overlay shadow. Keep compact 13 px / 21 px text, a 16 px semantic icon, and a 28 px labeled close control. Maximum width is 560 px, constrained to the viewport minus 32 px; long text wraps.
- Success uses a green `#89B99A` circle-check icon. Information uses a neutral `#B1B7AE` info icon. Error uses a red `#D58D83` circle-alert icon. The surface stays neutral across these states. Warm sand is for selection and actions, never the default successful toast fill.
- Type is supplied explicitly by the action result. Do not infer success from arbitrary text, and never render caught errors with a success icon. “任务已更新” is success; “下次执行生效” is information; failed saves are errors.
- Render one latest notification in the shared host. Retriggers update the current content and timeout, preserving the current opacity instead of replaying an entrance. Toasts never delay the operation or move focus on appearance.
- This occasional feedback uses the shared short opacity transition only, with the same entrance/exit path and no positional movement or bounce. Preserve the node through exit so closing/reopening reverses from its current opacity. Reduced motion updates statically. Solid surfaces already satisfy reduced transparency; increased contrast strengthens the border.
- Prototype duration: success/info 5 seconds, errors 8 seconds; pause dismissal while hovered or keyboard-focused. Closing by keyboard returns focus to the triggering control if it still exists. A labeled close button is always present. Announce ordinary results politely and errors assertively; hidden notifications are inert.
- Inline validation and persistent save-bar status remain in their original context. They are not floating toast notifications.
- Shared interactive prototype source: `components/toast.html`; current integrated previews and verification are in `tmp/toast-refresh/`. This is a design artifact; formal application integration is a separate step.

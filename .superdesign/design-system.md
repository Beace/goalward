# Goalward — Desktop Design System

## Mandatory project constraints

Read and follow [AGENTS.md](../AGENTS.md). The project uses **shadcn/ui** as its common UI component foundation. Preserve the current compact desktop visual direction through shared theme tokens and component variants in all themes. New or changed motion must use the actual **apple-design** skill from its installed `SKILL.md`. Apply its motion and accessibility guidance within the existing visual system.

The exported HTML drafts remain design references. This requirement governs subsequent implementation; it does not mean the existing HTML is already a shadcn/ui application.

## Product and intended outcome

A native-feeling, goal-driven desktop workbench that helps users turn a broad direction into goals and tasks, carry out work with people and local coding agents, collect artifacts and evidence, and review the next action. Coding Agent proxying, solo and collaborative runs, runtime/model configuration, persistent conversations, and execution traces support that loop. For product scope, follow docs/goal-driven-product-proposal.md; the existing task workbench remains the execution surface. UI languages: Simplified Chinese and English, initially selected from the system language, with other system languages falling back to English. Runtime names and familiar technical identifiers retain their original spelling.

The first draft is the main workbench during a three-agent collaboration. It must communicate an operational product through actual controls and realistic information hierarchy. Task, runtime, model, member, and trace are distinct concepts. See product-design.md for precise interactions and boundaries.

## Primary visual source

The current workbench and settings designs are the visual baseline. Preserve their layered neutral surfaces, restrained warm sand/bronze accent, precise UI typography, compact controls, and fine borders. The dark palette keeps the existing near-black values; the light palette translates the same hierarchy to warm off-white surfaces. The explicitly selected Cobalt2 palette uses the blue surfaces and yellow accent documented below. shadcn/ui supplies the component foundation; its default theme does not replace these project visuals.

Historical inspiration: Superdesign library style `neural-noir-interface-style` (Neural Noir Interface Style).

The user selected a professional IDE-like split view, available in dark, light, and Cobalt2 themes. Editorial typefaces, hero sections, decorative network diagrams, gradients, dot-grid decoration, floating marketing cards, glow effects, glass cards, large radii, and promotional page structures from the source do not apply. The complete allowed system is below; it overrides the source's unsuitable marketing components.

## Theme behavior

- **Settings → Appearance → Theme** offers System, Dark, Light, and Cobalt2. System is the default, including older settings with no theme field.
- Theme, UI font, language, background image, and background opacity selections apply throughout the app immediately and save automatically. Appearance saves contain only these appearance preferences; they do not submit runtime, model, provider, execution, or storage edits from another settings category.
- Runtime and other operational configuration retain the explicit Save Changes / Revert workflow. Revert and leaving with unsaved changes affect those configuration drafts, while persisted appearance preferences remain in effect.
- Automatic saves use the latest appearance choices when changes arrive rapidly. Expose saving, saved, and failed states without claiming success before persistence completes; a failed save retains a recoverable choice and offers retry.
- System follows operating-system appearance changes while the app is open. An explicit Dark, Light, or Cobalt2 choice remains fixed until the user selects another choice. The selected mode persists across restarts after automatic saving succeeds. Cobalt2 resolves to a distinct palette while native window controls, form controls, and dark component variants use dark appearance.
- Language offers System, Simplified Chinese, and English. The System choice follows the current system-language rule without rewriting goals, task content, messages, runtime names, or paths.
- Apply the resolved palette through shared semantic tokens to the workbench, settings, chat and trace, menus, dialogs, focus and error states, toast notifications, and artifact-preview chrome. Preserve layout, fonts, spacing, radii, and interaction behavior across all themes.
- HTML, images, and remote web artifacts retain their own content design. Theme the enclosing application controls without modifying artifact content.
- Theme selection updates colors without a staged entrance, positional movement, or business-operation delay. Preserve meaningful selected and pressed feedback through the shared controls.

### Global background image

- Settings → Appearance offers one local image for the entire app, Choose / Replace / Remove actions, and separate Background image opacity / Interface background opacity controls. Both use a shared shadcn/ui Slider plus percentage Input, with 0–100% bounds and keyboard support. Image opacity defaults to 100%, surface opacity to 85%; no selected image preserves the original opaque interface.
- Use one fixed, center/cover image behind the whole application. Main workbench, navigation, settings, goal, agent, setup, and Trace surfaces reveal this same image through centralized `--app-*` aliases. Split wrappers remain transparent so they do not compound several tint layers. Layout, typography, borders and sizes remain unchanged.
- Image opacity affects only image pixels. Surface opacity affects only main region background colors. Never apply opacity to the full app, a text container, buttons, or icons. Shared controls, menus, dialogs, and artifact content retain their authored colors and opacity; embedded HTML, remote pages, and images keep their own design.
- While the image is enabled, supporting text uses the current palette's existing contrast variants. Reduced transparency and increased contrast hide the decorative image and restore solid app surfaces without discarding the saved preference.
- Sliders follow pointer and keyboard input immediately, including during theme switching, with no interpolation that lags behind the pointer. Loading/import feedback and failure/retry states remain visible and use shared control feedback. Background images have no entrance movement or decorative animation.
- Store only a managed `{name, path}` image reference in appearance settings. Native image bytes live separately in private app storage; browser preview bytes live separately in IndexedDB. Keep prior assets so a failed settings save can restore the earlier image. The latest read/selection owns the visible result; replacement, removal and unmount ignore stale completions and release obsolete Blob URLs.

## Typography

- UI: Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif.
- Code and metadata: "SFMono-Regular", "JetBrains Mono", Consolas, monospace.
- Task heading: 14 px / 20 px, weight 600; single-line ellipsis with the full title available on hover or focus. The workbench header uses two compact rows: title, status and icon actions; then directory, execution mode and run history. Goal navigation is a labeled icon beside the directory. Narrow panes may wrap the second row to preserve controls.
- Section heading: 13 px / 20 px, weight 600.
- Body and chat: 13 px / 21 px; chat can use 14 px / 23 px where needed.
- Controls: 12 px / 18 px; minimum 28 px control height.
- Supporting labels: 11 px / 16 px; avoid excessive low-contrast text.
- English metadata can use modest tracking; Chinese text uses normal tracking.

## Colors — dark baseline

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

## Colors — light palette

- Window background: #E9EDE7.
- Title bar and sidebar: #F0F2ED.
- Main workspace: #F7F8F5.
- Raised panel / menu: #FFFFFF.
- Hover / selected neutral: #E8ECE5.
- Inset code / input: #EEF1EB; code-block surface: #EDF1E9.
- Subtle divider: #D8DDD5.
- Strong border: #BDC6B9.
- Primary text: #252A27.
- Secondary text: #535B53.
- Muted text: #646E63.
- Warm sand / bronze accent: #6E5A3F; selected subdued background #E9E3D9.
- Primary button: #826E53 with #FFFFFF text.
- Focus ring: #8A7152.
- Running / success: #35744C, muted surface #E0EEE3.
- Waiting / needs attention: #8C661E, muted surface #F2EAD6.
- Failure: #B14E43, muted surface #F5E4E0.
- Secondary member indicator: #466C7A; third member indicator: #786749.
- Text selection: #DDCEB8.
- Window control colors remain the dark baseline values.

The lighter surface hierarchy uses the same semantic roles as dark mode. Status text and file icons use darker values to retain contrast against the light backgrounds. All implementation values, including supporting surfaces, contrast fallbacks, overlays, and syntax colors, are centralized in `src/index.css`.

## Colors — Cobalt2 palette

This additional theme follows [Cobalt2 Theme Official by Wes Bos](https://marketplace.visualstudio.com/items?itemName=wesbos.theme-cobalt2), using the [official theme source at c4e9574](https://github.com/wesbos/cobalt2-vscode/blob/c4e9574372b85afad1682ed0fdd1ac0411c62512/theme/cobalt2.json) for the blue surface hierarchy and yellow accent. It is an explicitly selected palette; the neutral/sand defaults remain the System, Dark, and Light choices.

- Window, menu, input, and code surfaces: #122738.
- Title bar, sidebar, and inspector: #15232D.
- Main workspace: #193549.
- Hover surface: #1F4662; selected surface: #0D3A58; selected border: #234E6D.
- Primary text: #FFFFFF; chat text: #E1EFFF.
- Secondary text: #D5E3EE; muted text: #B7C9D8; faint metadata: #A5BED1.
- Primary action, active accent, and focus ring: #FFC600; primary-action text: #122738.
- Text selection: #0050A4.
- Subtle divider: #0D3A58; interactive strong border and scrollbar: #51758C.
- Running / success: #3AD900 on #173E35; waiting: #FFC600 on #3B3A27; failure: #FFA0BC on #492C43.
- File and member indicators reuse the official orange, cyan, green, and pink family, with brighter blue/red variants where needed for compact labels.

Supporting text, strong borders, and error colors are adapted for readability instead of copying low-contrast upstream values. Destructive buttons and badges use opaque pink with dark text to retain contrast; pointer hover uses a subtle shared-token tint. All values live in the `:root[data-theme="cobalt2"]` block in `src/index.css`; shadcn/ui primitives and authored CSS consume the same semantic roles. Cobalt2 keeps the existing spacing, fonts, density, control sizes, and motion. Theme changes use the shared interruptible color feedback; reduced motion updates statically.

## Spacing and components

- Spacing steps: 4, 8, 12, 16, 20, 24, 32 px.
- Border radius: 4 px small controls, 6 px menus, 8 px member panels and composer. Larger pills only for compact status badges.
- Borders: mostly 1 px. Prefer flat separated regions to floating cards.
- Shadows: only menus / overlays; dark uses 0 12px 32px rgba(0,0,0,.3), light uses 0 12px 32px rgba(32,41,29,.16).
- Button heights: 28 / 32 / 36 px. Small icon buttons need accessible labels.
- Icons: consistent 16 px simple outline functional icons, stroke 1.5 px; no emoji avatars or invented vendor logos. Runtime identities use locally bundled official logo assets beside their text labels (16–20 px, up to 24 px in detail headers), preserving their original proportions and published colors. Ensure fixed white assets remain distinguishable on light surfaces through a shared neutral backing treatment; do not alter original asset bytes. This small brand-color exception does not change the neutral/sand interface theme. Source records live in `assets/branding/runtime-source-*.md`; unknown custom runtimes retain a neutral terminal icon.
- Identity: use Goalward as the app title and the current app icon documented in `assets/branding/README.md`. Historical S-mark assets are not the Goalward icon. The brand update does not change interface colors, dimensions, motion, or vendor runtime identities.

## Information density and progressive disclosure

- Prioritize user content in the workbench. Toolbars and file-list items use a single row by default. The baseline height for toolbar / artifact rows is 40 px, Tab items are 32 px, and icon buttons are at least 28 × 28 px. Use existing font and spacing tokens instead of shrinking text or hit areas to squeeze in content.
- Artifact rows use "File icon · File name · Gray path · Right-aligned copy / preview buttons". Prioritize the name; the path uses `muted-foreground` to fill remaining space on the same row and truncates when long. Names use at most 45% of the row width and may also truncate, while buttons remain fully visible. Expose the full name, path, member, and execution source on hover or keyboard focus. Content that has not been written to disk shows "Reply content" with "Copy content"; web pages show a URL with "Copy link", avoiding invented file paths.
- Reuse `src/components/FileIcon.tsx` for file-type icons consistently in lists and preview titles. HTML uses an orange code-file icon; Markdown uses a blue M with a downward arrow; CSS / style files use a purple paintbrush. Identify code, configuration, images, spreadsheets, archives, audio, video, and similar files by extension, falling back to a gray generic file for unknown types. Keep 16 px fine-line icons and fixed reserved space. Color assists recognition without replacing shape or file names; a type icon does not guarantee embedded-preview support.
- File-type colors are a local exception to the neutral workbench palette, used only for type icons. Centralize them in `src/index.css` as `--file-icon-*` tokens. Dark / light values respectively: orange `#E6A071` / `#A45A22`, blue `#83B4E8` / `#386DA6`, purple `#B59CDE` / `#7955AC`, cyan `#78C6D6` / `#237385`, yellow `#D7BE78` / `#826821`, green `#89B99A` / `#35744C`, and red `#DF9294` / `#AD4D56`. File names, gray paths, and action buttons retain the current theme; do not use file-type colors for execution status.
- Omit repeated headings when a parent Tab already identifies the current view. Omit redundant badges when the extension identifies the file type. Source, implementation method, refresh time, and general help belong in tooltips or details instead of separate rows. Keep clear feedback for acceptance status, errors, and required actions.
- Use shared icon buttons for common actions, with accessible names and hover descriptions. Copy success shows a check on the original button and is announced through a live region; failure provides readable feedback and retry. Frequent switches respond immediately, and feedback does not shift list or preview content.
- Tab icons, text, and close buttons share the same item's background / border. Both the close icon and its hit area must remain inside that boundary, rather than forming an extra independent column.
- At 1536 × 960, 1280 × 720, and with narrowed panes, check row height, long-name truncation, fully visible buttons, and absence of horizontal page overflow. Keyboard users must be able to inspect complete information, copy, and open files. Compact presentation must not delete persisted source data.

## shadcn/ui implementation contract

- Use the official shadcn/ui components and maintain their source in one shared project UI directory. Compose business components from that foundation.
- Use CSS-variable theming with semantic tokens. Define the visual values centrally; page-specific code must not replace them with a competing palette.
- Preserve accessibility, keyboard interaction, focus management, and disabled/error semantics when customizing appearance.
- Use shared component variants for compact desktop control sizes. Avoid per-page copies of buttons, selects, menus, dialogs, and tables.
- Match the exact visual colors for the resolved theme even if the implementation stores them in another CSS color notation. The table below preserves the dark baseline and maps the light palette to the same semantic names. These mappings are project decisions based on the current design, using the official theme mechanism.

| Semantic theme token | Dark value / role | Light value / role |
| --- | --- | --- |
| `background` / `foreground` | #191A1A / #EAECE8 | #F7F8F5 / #252A27 |
| `card` / `card-foreground` | #202222 / #EAECE8 | #FFFFFF / #252A27 |
| `popover` / `popover-foreground` | #202222 / #EAECE8 | #FFFFFF / #252A27 |
| `primary` / `primary-foreground` | #D9C8B1 / #171817 | #826E53 / #FFFFFF |
| `secondary` / `secondary-foreground` | #292B2B / #EAECE8 | #E8ECE5 / #252A27 |
| `muted` / `muted-foreground` | #202222 / #90998E | #FFFFFF / #646E63 |
| `accent` / `accent-foreground` | #302C27 / #C9B8A0 | #E9E3D9 / #6E5A3F |
| `border` / `input` | #2E3231; stronger border #454B47 | #D8DDD5; stronger border #BDC6B9 |
| `ring` | #C9B8A0 | #8A7152 |
| `sidebar` / `sidebar-foreground` | #141515 / #B1B7AE | #F0F2ED / #535B53 |
| `sidebar-accent` / `sidebar-accent-foreground` | #302C27 / #C9B8A0 | #E9E3D9 / #6E5A3F |
| `sidebar-border` / `sidebar-ring` | #2E3231 / #C9B8A0 | #D8DDD5 / #8A7152 |
| `destructive` / `destructive-foreground` | #D58D83 / #FFFFFF | #B14E43 / #FFFFFF |
| Project-specific surface and status tokens | #101111 window, #151717 inset input, dark status values above | #E9EDE7 window, #EEF1EB inset input, light status values above |

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

- Project: goalward; task: Add a global command palette to the workbench.
- Mode switch: Single Agent / Collaboration (Collaboration active).
- Keep the conversation prominent. Runtime, model, and reasoning selectors live in the composer footer, without a large member-card roster above the conversation. Multi-agent configuration uses an independent compact member selector; viewing or editing a member never changes the message recipient.
- Member one: Coordination / Implementation, Codex, GPT-6-Astra (illustrative configuration), implementing command search.
- Member two: Testing, Claude Code, Default configuration, running keyboard interaction tests.
- Member three: Review, Pi, Default configuration, waiting for implementation changes.
- Add member opens a local panel listing Codex, Claude Code, Pi, DeepSeek Harness, Kimi CLI and their illustrative connection state. All five runtime names must be discoverable on the first page, with DeepSeek Harness visible in the runtime availability list or menu.
- Separate runtime and model controls; selecting an agent never silently changes message recipient.
- Tabs: Task conversation / Member sessions / Artifacts 3.
- User request is compact; coordinator answer shows a three-item assignment list; a member result shows linked files; running activity uses a small compact block.
- Composer has explicit target Send to: Coordinator · Codex, attachment action, contextual chips, and send action.
- Right trace shows nested actionable event rows, readable timestamps and duration, ownership, one expanded tool call with command or params and result. Include an actual trace identifier in small monospace text.
- Bottom status includes Local service connected and 2 running · 1 waiting. Clearly mark the prototype as Example data in a small global label.
- Historical execution menu: Run 2, opens earlier run entries.
- Sidebar runtime availability includes all five names with small official identity logos and separate compact ready / unconfigured indicators. A brand logo communicates runtime identity, not connection status; historical execution identities come from the saved runtime snapshot.

## Interaction fidelity

Implement lightweight prototype interactions if the draft environment supports them: solo/collaboration toggle, select member, runtime and model dropdowns, add-member menu, conversation/artifact tabs, trace expansion/filter, recipient selector, and inspector collapse. These operate on mock data and must never imply a real runtime was launched.

Runtime/model controls changed during a run show Applies to the next run. Runtime handoff explicitly previews the context and creates a new session. A compact persistent run indicator near the composer shows elapsed time and the latest public activity; the conversation also displays current search/tool/waiting feedback. Trace contains only publicly exposed runtime events, not inaccessible private model reasoning. Unknown model/use/cost values must remain unknown rather than invented numbers.

## Motion and accessibility

- Numeric data uses `src/components/ui/animated-number.tsx`: on its first visible appearance, count from zero to the actual value using the shared critically damped `numericSpring` in `src/lib/motion.ts`. Reserve the final text width, keep units and surrounding content stable, and expose the actual target to assistive technology throughout. Unknown data stays unknown. IDs, versions, ordinals, timestamps, editable inputs and user-authored content retain their literal values.
- Progress bars and segmented goal charts fill from zero when first visible through the shared `Progress` and `AnimatedFill` components. Animate only the contained fill transform; controls keep their full hit area and are immediately usable. Subsequent numeric changes retarget from the current presentation and velocity without replaying the entrance. Clocks, streaming counters and download text use `animateUpdates={false}` to follow frequent source updates immediately after entry.
- Offscreen data starts when it enters the viewport. A rerender does not replay a completed entrance. Live `prefers-reduced-motion` changes immediately settle the current presentation at the real value and remove counting/fill movement; turning motion back on does not replay a visible entrance. Data animation never delays requests, changes stored values or announces fabricated completion.

- **Motion authority: `apple-design`.** Read the current installed skill before designing or implementing motion. The following rules derive from its response, interruptibility, spring, gesture, spatial-consistency, and accessibility guidance. Resolve the installation path again on another machine.
- **Default development workflow:** Every interactive UI change follows the [default motion workflow in AGENTS.md](../AGENTS.md#default-development-workflow-for-frontend-interaction-motion). Proactively implement purposeful feedback with `apple-design` and `animate`; use `find-animation-opportunities` for a read-only discovery pass when filling gaps in existing pages, then implement within the authorized scope. Reuse the shared shadcn/ui components, `src/lib/motion.ts`, and centralized CSS motion parameters. Verify generated animation styles, entry/exit behavior, and the applicable interaction checks below; audit-only requests remain read-only. The project rules and `apple-design` take precedence over supplemental skill examples.
- **Immediate response:** show pressed feedback on pointer-down; commit actions through the normal click / keyboard activation behavior. No artificial delay or waiting for a transition before processing input.
- **Continuous interruption:** retarget from the current on-screen value, preserving velocity continuity. Never lock input while an animation runs or restart from a stale logical target.
- **Restrained springs:** the skill's design reference is damping ratio `1.0` with response `0.3–0.4 s` for default UI motion. Use slight bounce (ratio around `0.8`) only for genuine momentum-driven releases. Response is not fixed duration; damping ratio is not the animation library's physical `damping` coefficient. Map these concepts to the selected library's actual API through shared presets; do not blindly configure `damping: 1`.
- **Direct manipulation:** draggable content follows the pointer 1:1 with its original grab offset, capture, and cancellation handling. Gesture-driven motion needs interruptible springs / motion values rather than fixed CSS transitions or keyframes. Transfer release velocity and project a snap destination only for interactions that actually support momentum and snapping.
- **Spatial consistency:** enter and exit along the same path; anchor menus and popovers to their trigger. Small, non-gesture opacity / color feedback may use CSS transitions. The old blanket `120–180 ms ease-out` rule is superseded by these interaction-specific requirements.
- Apply motion through shared presets or variants; reconcile shadcn component animations so the same properties are not animated twice. Prefer `transform` / `opacity` for animated effects; actual pane resizing remains direct layout manipulation.
- **Accessibility:** `prefers-reduced-motion: reduce` replaces slides, scale, and springs with short cross-fades or static updates, without bounce. Keep meaningful feedback. Existing translucent surfaces respond to `prefers-reduced-transparency: reduce` with solid or more opaque fills; `prefers-contrast: more` uses defined contrasting boundaries. Preserve the user's resolved palette in every fallback.
- The skill's material and typography examples do not change the chosen static style. Do not introduce glass surfaces, a competing palette, or different fonts as a side effect of applying its motion guidance.

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
- Clear keyboard focus rings in the current theme's accent; readable contrast; semantic button labels and titles for icon-only actions.
- Suggested shortcuts: Cmd+K global command, Cmd+N new task, Cmd+Enter send, Esc close overlay. These are product design proposals.

## Strict fidelity

Use ONLY the fonts, colors, spacing, and component styles defined in this design system. Do not introduce any fonts, colors, or visual styles not in the design system.

## Global toast notifications

- Every floating toast is centered against the full window at `top: 56px` (40 px title bar plus 16 px gap). Never position it at the bottom or center it against only the conversation pane.
- Use the current theme's raised neutral surface, strong neutral border, primary text, 6 px corners, and the shared overlay shadow. In dark mode these remain `#202222`, `#454B47`, and `#EAECE8`. Keep compact 13 px / 21 px text, a 16 px semantic icon, and a 28 px labeled close control. Maximum width is 560 px, constrained to the viewport minus 32 px; long text wraps.
- Success uses the current theme's green circle-check icon; information uses secondary text for its info icon; error uses the failure color for its circle-alert icon. Dark values remain `#89B99A`, `#B1B7AE`, and `#D58D83`. The surface stays neutral across these states. Warm sand is for selection and actions, never the default successful toast fill.
- Type is supplied explicitly by the action result. Do not infer success from arbitrary text, and never render caught errors with a success icon. "Task updated" is success; "Applies to the next run" is information; failed saves are errors.
- Render one latest notification in the shared host. Retriggers update the current content and timeout, preserving the current opacity instead of replaying an entrance. Toasts never delay the operation or move focus on appearance.
- This occasional feedback uses the shared short opacity transition only, with the same entrance/exit path and no positional movement or bounce. Preserve the node through exit so closing/reopening reverses from its current opacity. Reduced motion updates statically. Solid surfaces already satisfy reduced transparency; increased contrast strengthens the border.
- Prototype duration: success/info 5 seconds, errors 8 seconds; pause dismissal while hovered or keyboard-focused. Closing by keyboard returns focus to the triggering control if it still exists. A labeled close button is always present. Announce ordinary results politely and errors assertively; hidden notifications are inert.
- Inline validation and persistent save-bar status remain in their original context. They are not floating toast notifications.
- Shared interactive prototype source: `components/toast.html`; current integrated previews and verification are in `tmp/toast-refresh/`. This is a design artifact; formal application integration is a separate step.

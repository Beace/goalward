# Goalward project constraints

This file applies to the entire project, including the workbench, settings, future pages, shared components, and interaction motion. All subsequent design and development must follow these requirements.

## Working language (mandatory)

- **Write GitHub Pull Request titles and descriptions in English.** This includes headings, change summaries, implementation details, validation results, risks, and limitations. Do not add a parallel non-English description.
- **Write code comments and docstrings in English**, including existing comments and comments added or edited in production code, tests, scripts, and configuration files.
- **Write unit test suite and case descriptions in English**, including names passed to `describe`, `it`, and `test`, test helper documentation, and authored assertion or failure messages.
- **Write development process documents in English**, including existing documents, implementation plans, progress notes, investigation notes, validation reports, and handoff notes. This applies to intermediate drafts and final engineering notes, whether committed to the repository or saved as task artifacts.
- Preserve normal product i18n copy and translation keys, plus the exact selectors, inputs, and expected values needed to verify localized text or compatibility with previously saved localized data. Use English for other synthetic test data, retaining Unicode coverage with suitable multibyte characters. Write the surrounding developer explanation in English. User-facing conversation follows the user's requested language.
- These requirements apply to all existing and newly authored developer-facing prose. Before committing or creating/updating a PR, review comments, test descriptions, process documents, and PR text for compliance. Use the repository's [Pull Request template](.github/pull_request_template.md).

## 1. Product and design foundations

- **The desktop application uses Tauri 2, with macOS as the first delivery platform.** The current frontend is React + TypeScript + Vite, with shadcn/ui as its component foundation. Do not replace the desktop framework in subsequent development without a requirements change.
- Local process startup and shutdown, executable detection, and file persistence use Rust / Tauri commands. Browser previews do not execute local runtimes. [README.md](README.md) is the authority for actual capabilities and development commands.
- The product is goal-driven: help users turn a broad direction into goals and tasks, organize people and Coding Agents to execute them, collect artifacts and evidence, and review results to decide the next action. Single-agent / multi-agent proxying, runtime / model configuration, chat history, and execution traces support this loop.
- The current workbench and settings are the visual baseline: a dense, IDE-like split layout, following the system theme by default and supporting dark and light themes.
- Before UI work, read [.superdesign/design-system.md](.superdesign/design-system.md). For page behavior, refer to [.superdesign/product-design.md](.superdesign/product-design.md) and [.superdesign/settings-design.md](.superdesign/settings-design.md).
- Historical canvas mappings and prototype drafts remain local references. They do not prove that the current brand or formal application implementation has been synchronized.

## 2. Use shadcn/ui throughout the UI

- **The entire project uses [shadcn/ui](https://ui.shadcn.com/) as its common UI component foundation.** New and refactored formal application interfaces must follow this requirement.
- Import maintainable component source using the official approach, and manage and extend it centrally within the project. Do not assume that an `@shadcn/ui` package exists from which every component can be imported.
- Keep foundational components in one shared UI directory. When initializing the frontend, use `src/components/ui/` by default; if the actual project structure has another convention, use an equivalent centralized directory.
- Business pages reuse these components. Build and extend business-specific Agent member panels, trace event trees, execution details, and similar UI by composing shared components.
- Prefer the corresponding shadcn/ui components for buttons, form controls, menus, overlays, labels, tables, and other provided controls. Do not repeatedly handwrite parallel versions on individual pages.
- Do not introduce another parallel general-purpose UI component system. When a capability is missing, first compose or extend the existing components to keep theming, interaction, and accessibility consistent.
- Follow the official components' logic and accessibility behavior; adapt their appearance to the project through theme variables, component variants, and shared styles.

### Common UI needs and components

| UI need | Preferred shadcn/ui components |
| --- | --- |
| Actions, enabled state, input, and settings forms | Button, Input, Textarea, Field, Label, Switch, Checkbox |
| Runtime / model selection and searchable selection | Select, Combobox, Command, Popover |
| Settings categories and conversation / member / artifact views | Sidebar, Tabs, Separator |
| Resizable panes and independent scrolling regions | Resizable, Scroll Area |
| Menus, detail panels, and actions requiring confirmation | Dropdown Menu, Context Menu, Dialog, Sheet, Alert Dialog |
| Model catalogs, status, loading, and error feedback | Table / Data Table, Badge, Tooltip, Skeleton, Progress, Alert |
| Collapsible trace events and advanced settings | Collapsible, Accordion, composed with the project's business content |

These mappings constrain implementation. They do not require adding controls that a page did not otherwise need merely to use a component.

## 3. Preserve the current visual style

- **Adopting shadcn/ui does not change the established visual style.** Default component themes or official example appearances must not override this project's design system.
- Follow the operating-system theme by default; Appearance supports Dark, Light, and System. Dark mode retains layered near-black / dark-gray backgrounds; light mode uses the design system's neutral light surface hierarchy. Both themes share restrained warm sand accents, fine dividers, small corners, and compact forms.
- Use `.superdesign/design-system.md` as the single source for colors, fonts, dimensions, spacing, radii, and shadows. Do not invent a separate token system on business pages.
- Map the current palette through shadcn/ui semantic theme variables such as `background`, `foreground`, `card`, `popover`, `primary`, `accent`, `border`, `ring`, and `sidebar`.
- Settings and the workbench use the same theme and foundational components. Keep buttons, selectors, tables, focus states, error states, and empty states consistent.
- Retain Inter / system Chinese fonts and monospace fonts in code areas, the 4 / 6 / 8 px radius scale, and the 28 / 32 / 36 px control-height scale. See the design system for complete values.
- Preserve the desktop workbench's panes, collapsible inspector, independent scrolling, and fixed input / save regions. Use responsive dimensions; avoid hardcoded window widths and heights that clip content.
- Use consistent fine-line functional icons. Do not introduce decorative gradients, glow effects, oversized cards, or unrelated brand graphics.

### Information density and progressive disclosure (mandatory)

- **Prioritize content; list items and toolbars use a single row by default.** File / artifact rows have a 40 px baseline height, with action controls at least 28 px. If a Tab already labels the current context, do not consume vertical space with another large heading, explanatory paragraph, or decorative icon.
- **Only keep information needed to identify the object, judge its state, and perform the main action permanently visible.** After the file name, display its path or URL in gray text using the remaining space on the same row, truncating long values. Align copy, preview, and similar actions to the right. Expose the complete value on hover or through one-click copy instead of a second row. Show the source member and execution batch on hover / keyboard focus or in details on demand. When the extension already expresses the file type, generally omit a redundant type badge.
- Use shared icon buttons for common actions, with an explicit accessible name and hover description. Show copy success in place instead of adding a permanent status row. Compact presentation must not hide errors, states requiring user action, or information that affects a decision.
- Truncate long names to one line while keeping the complete value accessible. In narrow panes, compress names first and retain primary actions. Tab text, icons, close buttons, and their hit areas must stay within the same item boundary.
- Reuse shadcn/ui components and design tokens. Do not achieve density through tiny fonts, tiny hit areas, or clipped controls. Acceptance checks cover long names, multiple records, narrow panes, keyboard focus, copy feedback, and error states, verifying row heights and button boundaries.
- See "Information density and progressive disclosure" in [.superdesign/design-system.md](.superdesign/design-system.md) for specific dimensions and examples. This constraint applies to all subsequently added or modified workbench, list, and inspector interfaces.

## 4. Motion must use the apple-design skill

- **Before adding, changing, or reviewing motion, locate, read, and use the user-specified `apple-design` skill.** This includes page transitions, overlays, sidebars, expand / collapse, selection indicators, list states, and loading feedback.
- Determine movement, timing, easing / springs, entry / exit, and interruption behavior from the actual `SKILL.md` requirements. Do not infer an "Apple style" from the name and claim that the skill has been used.
- `apple-design` governs motion in this project. Static colors, typography, component dimensions, and desktop layout remain governed by the current design system.
- After integrating shadcn/ui, reconcile built-in component entry / exit animations with project motion so multiple animation systems do not drive the same property.
- Manage motion parameters centrally. Individual pages must not arbitrarily introduce their own durations, easing, or spring parameters.
- The historical prototype rule `120–180 ms ease-out` is not a global motion standard. Calibrate implementation using the following rules and the skill.

### Default development workflow for frontend interaction motion

- **Whenever adding or modifying interactive UI, proactively inspect and implement the feedback the feature needs; the user does not need to ask separately for animation.** Inspect pressed feedback, selected states, expand / collapse, menu / overlay entry and exit, and asynchronous state transitions. Deliver motion that helps communicate feedback or spatial relationships alongside the feature. Judge it by the interaction's purpose and frequency; keep immediate updates where appropriate, without requiring every component to move or scale.
- **Use `apple-design` to determine motion behavior and `animate` to write the implementation.** Read the actual corresponding `SKILL.md` files before implementation. Project constraints and `apple-design` motion requirements take precedence over other skills' example parameters and component-library advice. Keep the restrained, interruptible defaults; do not create a separate rule set based on example bounce or fixed durations.
- When systematically filling motion gaps in existing pages, first use `find-animation-opportunities` for a read-only pass to identify priorities, then use `animate` to implement changes within the authorized scope. For implementation requests, finish the necessary motion and verification. For audit or suggestion requests, deliver findings without expanding into code changes.
- Implement motion through shared shadcn/ui components in `src/components/ui/` and composed business components, retaining keyboard interaction, focus management, and disabled semantics. Reuse `src/lib/motion.ts`. Centralize necessary CSS motion parameters in `src/index.css`, with other styles referencing shared values. Simple color / opacity feedback may use CSS transitions; springs and gestures reuse existing Motion capabilities, avoiding duplicate drivers for the same property.
- **Verify that animation styles and mount lifecycles actually work.** When using classes such as `animate-in`, `animate-out`, and `fade-*`, check the dependency, CSS import, and style definitions in the build output. Run the UI with normal motion enabled and verify the intended entry / exit effects, ensuring immediate unmounting does not erase closing animations. Class names, dependency declarations, or motion configuration alone do not prove implementation is complete.
- Frequent keyboard operations, chat tokens, and streaming trace updates remain immediate. Do not repeatedly animate the entire content into view, disturb scroll position, or delay business requests through animation. See "Product-specific applications" below for details.
- Before delivery, actually verify the affected interactions as required by section 5. Report implemented feedback, applicable checks, and unverified behavior; do not claim that unrun checks passed. For an explicit motion-review request, use `review-animations`, while keeping project and `apple-design` requirements authoritative.

### Skill sources

- A common local installation path for `apple-design` is `~/.agents/skills/apple-design/SKILL.md`. Reread the actual file for every motion task.
- The motion requirements below derive from the skill's Response, Direct manipulation, Interruptibility, Springs, Velocity handoff, Spatial consistency, and Reduced motion sections. Future sessions must read the actual skill; resolve its installation path again after an environment change.
- Use `animate` for implementation, `find-animation-opportunities` for discovering missing motion, and `review-animations` for explicit motion reviews. This division of responsibilities and the default development workflow are project additions, rather than quotations from `apple-design`; locate the skills again after an environment change.

### apple-design motion requirements

- **Immediate feedback:** Show feedback on press, retaining normal click / keyboard activation semantics. Do not execute actions that require a completed click at pointer-down. Do not delay business operations through artificial waits or animation-completion callbacks.
- **Interruptible and reversible:** Do not lock input during animation. When the target changes, continue from the current on-screen value while preserving velocity continuity; do not jump from the previous logical target to the new target.
- **Restrained default springs:** UI position changes use critically damped behavior without bounce by default. The skill's reference is damping ratio `1.0` with response `0.3–0.4 s`. Consider slight bounce (ratio around `0.8`) only for genuine momentum-driven interactions such as flinging or drag release. Do not add decorative bounce to menu clicks, model changes, or settings-category changes.
- **Accurate parameter semantics:** Response is not a fixed animation duration, and damping ratio is not the animation library's physical `damping` coefficient. Adapt to the selected library; do not configure `damping: 1` as if it meant critical damping. Shared configuration must distinguish design parameters from library parameters.
- **Direct manipulation:** Dragged panels and dividers follow the pointer 1:1, retaining the grab offset and correctly handling pointer capture / cancel. Do not add lagging easing during a drag. Gesture-driven motion uses interruptible springs / motion values, rather than fixed CSS transitions or keyframes.
- **Momentum handoff:** For flingable or snapping panels, pass release velocity and select the snap point from the projected destination. Ordinary pane resizing follows directly and retains its final size without manufactured inertia.
- **Spatial consistency:** Entry and exit follow the same path; menus and overlays originate at their trigger. Preserve position continuity during rapid toggles or switches, and restore focus correctly after closing.
- **Performance and accessibility:** Prefer `transform` / `opacity` for animated effects; actual pane layout changes remain immediate. Reduced motion replaces movement, scale, springs, and bounce with short fades or static updates while retaining required state feedback. Existing translucent surfaces respond to reduced-transparency preferences; increased-contrast preferences provide clear boundaries. These adaptations retain the selected theme's palette.

### Product-specific applications

The following are project additions, rather than a restatement of `apple-design`:

- Start, pause, stop, and send operations enter the real request flow immediately. Motion only reflects actual state; it neither delays a request nor announces completion early.
- Chat tokens and streaming trace updates must not repeatedly animate whole blocks into view or disturb the user's scroll position.
- Draggable panes and live execution status must not lag because of decorative animation. Motion must help communicate state or spatial relationships.
- Do not automatically introduce glass surfaces, bright backgrounds, additional shadows, or different fonts based on the skill's material or typography examples. The agreed skill scope is motion and its accessibility behavior.

## 5. Implementation and acceptance boundaries

- `.superdesign/*.html` files are design-reference prototypes. They do not prove that the formal application uses shadcn/ui or has integrated a real runtime.
- When implementing designs as formal UI, verify that foundational controls actually come from the shared shadcn/ui directory and that the theme actually uses project tokens.
- Visual checks cover the workbench, settings, menus / overlays, focus / disabled / error states, and desktop sizes of 1536 × 960 and 1280 × 720.
- Motion checks cover normal / reduced motion, mid-animation reversal, rapid switching, drag cancellation, keyboard / focus restoration, and streaming updates. Provide interactive verification when delivering, inspect in slow motion where necessary for jumps, and report the `apple-design` source and actual check results.
- Documentation-only constraint updates do not imply dependency installation, frontend initialization, remote canvas changes, or migration of existing prototypes.

## 6. Git development and release workflow (mandatory)

- Start each task on a new independent branch from the latest `origin/main`; Codex branches use `codex/<task-name>`. Push changes only to that task branch and open a Pull Request. Never commit or push directly to `main`, and do not let automation bypass PRs to modify `main`. GitHub requires PRs for `main` and allows only squash merges.
- The PR title becomes the squash commit title on `main` and must use Conventional Commit syntax, such as `feat: ...`, `fix: ...`, or `docs: ...`. Mark incompatible changes with `feat!: ...` or `BREAKING CHANGE:` in the commit body. Titles must independently describe the user-visible change. Check CI before merging. PR CI runs only frontend, Rust, and release-tool unit tests; it does not build the App, DMG, or ZIP.
- Merging a PR into `main` **does not publish immediately**. The local Codex daily afternoon release automation triggers the GitHub Actions release workflow from `main` at **14:00 Asia/Shanghai** every day. The workflow itself has no GitHub cron trigger; maintainers may also trigger it manually in GitHub Actions. Treat the `main` commit selected at runtime as the snapshot and compare it with the latest public GitHub Release and its verified version tag. Use the 0.1.1 baseline in `.github/release-baseline.json` for the first release. Leave the existing untagged `v0.1.1` draft unchanged and exclude it from public versions. Skip building and publishing if there are no new commits or a newer version already covers the selected commit.
- Determine SemVer from all squash commits actually merged between the two versions: a breaking change increments major, `feat` increments minor, and other changes increment patch; a missing conventional prefix also increments patch. **Increment the version once for the entire batch, using its highest change level**, rather than releasing each PR separately. Calculate versions and change records only from merged Git commits and public Releases / tags, not PR drafts or local files. Scheduled and manual releases must run serially; repeated triggers must not create the same version twice or overwrite mismatched drafts and artifacts.
- GitHub Release notes are the changelog for subsequent versions. Use a "What's Changed" list containing each commit title, author, and PR in the batch, with a Full Changelog comparison link from the previous public version to the new version. In an isolated build workspace, synchronize the calculated version into npm, Tauri, and Cargo version files. After a successful build and revalidation of the universal installer, explicitly create a version tag pointing to the selected `main` commit; verify the remote tag before creating and publishing the prerelease. Never create a version tag from a PR branch or write the version back to `main`. Source version fields are only development-build baselines; formal downloads use the Release version and the packaged version.
- Current macOS release packages use only ad hoc signing and have not been notarized by Apple. Automatic prereleases must disclose this accurately. Do not call a release a notarized production version before Developer ID signing, notarization, and installation verification are complete. See [docs/releasing.md](docs/releasing.md) for the release workflow and failure recovery.

## Official references

- [shadcn/ui introduction](https://ui.shadcn.com/docs)
- [Component catalog](https://ui.shadcn.com/docs/components)
- [Theming and CSS variables](https://ui.shadcn.com/docs/theming)

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->

# Goalward — Global settings page

## Requirements for this iteration

The user requested a settings page to configure and manage runtimes, models, and related options. Add an independent desktop settings page using the existing workbench's dense design and shared theme. The formal application supports System, Dark, Light, and Cobalt2 themes, defaulting to System; historical prototypes retain their dark examples. A "Settings" text entry remains visible at the workbench's bottom left. A fixed "Back to workbench" entry sits at the bottom of the settings navigation, below the instance-status explanation and close to the position used to enter settings. Keep automatic detection at the top right.

## Information structure

Settings replaces the workspace while retaining the same native title bar and status bar. The first draft opens Runtime settings by default, with three columns:

1. A 200 px left settings navigation: Runtimes, Models & providers, Appearance, Execution defaults, History & storage, and App updates.
2. A 264 px middle runtime list: search, Add runtime, and five entries for Codex / Claude Code / Pi / DeepSeek Harness / Kimi CLI.
3. Flexible right details: current runtime status, connection configuration, default model and capabilities, and launch configuration. Use compact grouped forms without large data cards.

Target viewport: 1536 × 960, remaining usable at 1280 × 720. Page dimensions follow the window; each column scrolls independently, with the bottom save region fixed.

## Runtime management

### List

- Each row shows runtime name, enabled state, and configuration readiness.
- Show application-level registered configuration. Active instance count may appear, but enabling configuration must not be equated with launching a process.
- Codex selected, Claude Code ready, Pi ready, and DeepSeek Harness / Kimi CLI awaiting configuration are all example states.
- Add runtime supports registering installed CLI / Harness programs and local executable paths.

### Selected runtime details

- Name: Codex.
- Description: Agent execution environment available to task members.
- Enabled: controls availability in the runtime list for new tasks.
- Executable: example ~/bin/codex, with file selection and automatic detection entries.
- Installation / version detection: show example detection status and recheck; do not invent a real version.
- Authentication source: use the runtime's own login state and provide connection-status viewing. Show provider-credential binding only when custom providers are supported.
- Connection checks: clearly distinguish executable detection from authentication / model-availability checks.
- Default model: illustrative GPT-6-Astra, labeled as an example user-configured value.
- Available models: choose models identified by the adapter or configured by the user. Allow management through "Models & providers" without implying that any model can be assigned to any runtime.
- Capability summary: session resume, streaming events, tool events, and instructions added during execution. Attribute detection to the adapter; show unknown capabilities as awaiting detection. Do not promise Pause for every runtime.
- Launch parameters: collapsible advanced settings, argument list, environment key-value pairs (masked secrets only), and default source for working directories. Examples must not contain real keys, accounts, or host paths.
- Footer: Appearance shows automatic-save status and failure retry; other categories show unsaved-change feedback, Revert, and Save changes.
- Configuration effect: global defaults apply to new members. Existing members retain their configuration snapshots and change only after explicitly choosing "Restore defaults". Running sessions retain launch-time configuration. Saving does not restart instances automatically.
- When disabling or removing a registration that has associated instances, show the count and impact. Do not silently stop current tasks.

## Models and providers

Switch categories within the same settings page without introducing a separate visual system.

### Model catalog

Table columns: Display name, Model ID, Provider connection, Available runtimes, and Enabled. Do not conflate a model ID with the user's custom display name.

- Add, edit, disable, and set a model as a specific runtime's default.
- Support runtime filtering and Model ID search.
- Clearly label unverified models as "Unverified", rather than ready.
- Only enabled models compatible with the current runtime appear in the task selector.

### Provider connections

- Apply to runtimes supporting this connection method; not every runtime must use a shared API Key.
- Configuration name, provider / protocol type, Base URL (where applicable), credential source, and Test connection.
- Display credentials only as masked values and explain their management by the system credential store. Design previews do not save real credentials.
- Adapter detection / user configuration establishes model capabilities and runtime compatibility; do not infer them from vendor names.

## Execution defaults

- Default mode for new tasks: Single Agent / Collaboration.
- Default runtime and model, and coordinator defaults.
- Maximum number of simultaneously executing members.
- Default working-directory source: inherit the task directory; code collaboration may use independent working copies.
- Changing defaults during execution does not rewrite existing Run configurations.

## Appearance

- Theme precedes UI font and uses the shared shadcn/ui Select, matching other compact settings forms.
- Options are "System", "Dark", "Light", and "Cobalt2". Default to "System", including older configuration without a theme field. Cobalt2 follows Wes Bos's Cobalt2 Theme Official, using the deep blue backgrounds and yellow accent in design-system.md.
- Theme, UI font, language, background image, and both opacity values apply globally immediately on selection and save automatically; Appearance requires no "Save changes" click. Keep controls usable while saving. Rapid changes retain the latest selection without allowing older responses to overwrite it.
- Appearance saves submit only appearance preferences (theme, font, language, background image, and both opacity values), merging with the latest saved configuration. Unsaved runtime, model, provider, execution, and storage drafts remain and are not submitted with appearance changes.
- Show saving, saved, and failed states. A failed save retains a recoverable choice and offers retry, without claiming persistence succeeded. Other settings retain "Revert" and "Save changes"; saving or reverting them must not overwrite already saved appearance values.
- "System" responds to operating-system appearance changes while the application runs. A saved "Dark", "Light", or "Cobalt2" choice is not overridden by system changes. Native windows and form controls use dark appearance for Cobalt2, while the interface retains its distinct palette.
- The workbench, settings, chat, trace, shared menus / overlays, notifications, and artifact-preview chrome use the same semantic tokens. HTML, image, and remote web artifacts retain their own designs without forced rewriting.
- All themes share layout, fonts, control heights, and interaction semantics. Dark and Light use warm sand accents; Cobalt2 uses a yellow accent. All palettes follow design-system.md without a separate component system.
- Below the theme selector, provide one global App background image: show its filename, Choose / Replace, and Remove actions on one row. Truncate long filenames and reveal the full name on hover. The main background regions of the workbench, settings, goals, agents, and Trace show the same centered image covering the whole application window.
- Background image opacity and Interface background opacity each use only the shared Slider, with a 0–100% range. Retain help text and keyboard adjustment, with no numeric input or visible percentage readout beside the slider. Expose the actual value through `aria-valuenow` and `aria-valuetext`. Image opacity defaults to 100%, interface opacity to 85%. For the image, 0% hides it and 100% shows the original; for interface surfaces, 100% is solid and 0% is transparent. Text, buttons, forms, menus, and dialogs retain their own appearance rather than inheriting container opacity. Disable adjustment when no image is selected; removing it restores the original solid interface.
- Background images and both opacity values apply globally immediately and save automatically, independently of other settings drafts. Importing and reading images show real pending states; failure retains the original selection or stored reference and provides Retry / Replace / Remove. While reading a replacement, do not pair the previous image with the new filename. The desktop app saves a private image copy; browser previews save a separate image resource. Do not write image bytes into every workspace snapshot.
- Sliders follow input immediately, without interpolation that lags behind the pointer during theme transitions. Reduced transparency and increased contrast use solid surfaces; reduced motion retains static feedback. Acceptance also covers image selection, replacement, removal, reload restoration, rapid read reversals, real pointer cancellation, keyboard adjustment, save rollback / retry, and isolation from unsaved Runtime drafts.
- Font selection provides search over locally available fonts, updating the whole UI and preview on selection. Code and execution logs retain monospace fonts.
- Language supports "System", "Simplified Chinese", and "English". Initially choose Chinese or English from the system language; other system languages fall back to English. An explicit choice immediately updates labels and saves automatically, without rewriting user content, runtime names, or paths.
- Acceptance covers first launch / older-configuration defaults, restart after automatic saving, live System-mode changes, fixed-theme isolation, rapid successive changes, failure retry, and workbench / settings / menu / error / focus states. Also verify changing Appearance with an unsaved runtime draft: persist only appearance values while retaining the draft. Subsequent manual save, revert, or discard must not overwrite the latest appearance preferences.

## History and storage

- Local storage location for chat history and public runtime events.
- Retention policy, chat / trace export, and storage usage.
- Truncation and retention settings for large tool output.
- Do not treat private model reasoning as data that can necessarily be stored.

## App updates

- Check public GitHub Releases automatically after desktop startup finishes loading and every six hours, supporting the current prerelease distribution. Exclude drafts and historical versions without an update manifest.
- Show current version, available version, and release notes, with manual Check, Download, Install, and Restart. Show progress and failures in place, allowing retry of the failed stage.
- When automatic checking finds an update, provide a notification opening this category. Do not repeatedly notify for the same version. Show network failures on the update page without repeated notifications.
- Installation and restart require idle Agents and settings drafts saved or reverted; Rust also checks actual process state. Do not stop tasks for updates or discard drafts on the user's behalf. Update download-success and installation-success states independently from actual results.
- Reuse shared buttons, Spinner, and theme tokens. Frequent progress updates remain immediate; reduced motion replaces spinning feedback with a static icon and status text.
- Browser previews explain that updates require the desktop application; development builds cannot install updates. Update signing and Apple signing / notarization are distinct verification layers.

## Global and task configuration

Global configuration is a default template. Creating an execution member copies it into a configuration snapshot; tasks may override supported fields. Each Run records the actual configuration it used. Settings changes do not rewrite historical records.

## Prototype requirements

- Generate only one settings page, opening runtime management by default.
- Where feasible, support local demonstrations of category switching, selection among five runtimes, form editing, default-model dropdowns, and save / revert.
- Historical remote previews are older drafts, not acceptance evidence for the current Goalward application or brand. The formal page uses in-app navigation to return to the workbench.
- Label all connections, models, authentication, and execution results as example data. Save only demonstrates UI state, without calling a local execution environment or sending entered credentials.
- Point the workbench's settings entry to the new page's actual return URL; do not guess a draft ID.

## Visual constraints

Reuse the current theme's layered backgrounds, accent, Inter / system Chinese fonts, 13 px body text, fine borders, and small radii from design-system.md. Dark mode retains the near-black palette, light mode uses the light mappings of the same semantic tokens, and Cobalt2 uses deep blue backgrounds with a yellow accent. Dark and Light retain their warm sand accents. Clearly identify the selected settings category and runtime. Prohibit marketing-page structures, gradients, fabricated vendor identities, and large images.

Use ONLY the fonts, colors, spacing, and component styles defined in the design system. Do not introduce any fonts, colors, or visual styles not in the design system.


## Kimi CLI prototype addition (2026-09-16)

Kimi CLI is an independent runtime with internal identifier `kimi`, alongside the existing four runtimes. The settings entry supports `#runtime=kimi` to select it. Show it as unconfigured and disabled by default; detecting a program on the local machine does not mean the preview user has authenticated. Inherit the default model and reasoning effort from Kimi CLI configuration; do not invent fixed levels before discovering actual model capabilities. The permission explanation is "Determined by Kimi CLI configuration; real approvals are not integrated yet". This iteration changes only the interactive prototype; saving and detection remain demonstrations.

The current official Kimi Code CLI differs from the older Python kimi-cli in protocol and configuration paths, so identify the version before formal adaptation. Consider official ACP for permission callbacks, cancellation, and public tool events. Do not present noninteractive mode as supporting per-action approvals. The prototype does not launch or install the CLI or read credentials.

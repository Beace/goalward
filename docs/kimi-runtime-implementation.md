# Native Kimi CLI integration

2026-09-17. The fifth Runtime has moved from reference prototype to a React / Tauri adapter. It uses a Kimi Code CLI `kimi acp` subprocess and exchanges ACP JSON-RPC over stdin / stdout, avoiding any claim that non-interactive `-p` automatic permissions provide manual approval.

## Behavior

- Executable detection includes `~/.kimi-code/bin` and retains the existing bounded `--version` check. Automatic detection reads model aliases, display names, and the default model from `KIMI_CODE_HOME/config.toml` or `~/.kimi-code/config.toml`. It neither imports Provider keys nor executes configuration hooks. Model IDs remain aliases rather than being replaced by underlying Provider wire IDs.
- Execution negotiates ACP v1, confirms `agentInfo.name = Kimi Code CLI`, and creates a session in the goal working directory. It defaults to the Runtime's actually exposed `yolo` automatic approval mode. Versions without `yolo` use `default`, with the application selecting `allow_always` / `allow_once` from each request automatically. Manual mode can be selected explicitly in settings. An explicitly selected model alias is set through `session/set_config_option`. Mode or model-setting failures stop before prompt submission.
- An empty model inherits the Runtime default. Detection imports reasoning levels from each model's `support_efforts`, prioritizing `overrides.support_efforts`, including an empty array. Missing or unrecognized levels expose inheritance only. Reimport updates existing model capabilities while preserving the user's default effort, display name, and enabled state. Kimi's `default_effort` and global `thinking` are not copied into explicit app defaults.
- Model settings, Agent profiles, and task members share the effort selector. After model selection, explicit effort is validated against current ACP `configOptions`, then set as `thinking` through `session/set_config_option`. Prompt submission occurs only after checking the returned `currentValue`. Lost capabilities, rejected settings, and mismatched values stop without silent downgrading. Inheritance sends no effort override. The ACP adapter does not accept arbitrary extra CLI arguments.
- Public `agent_message_chunk` events update chat in real time. Tool start / update / end events aggregate into Trace by call ID. Hidden thought chunks are neither forwarded to the frontend nor saved in raw Trace. Handshake authMethods metadata is not written to Trace.
- Manual Runtime permission requests are answered through workbench controls. The native layer maps requests to opaque one-time IDs and validates the Run, member, and currently allowed options. Automatic mode selects only protocol allow options; unknown or deny-only options still go to the user. After manual `allow_always`, the app persists session authorization and handles already queued and later allow requests automatically. It remains valid across process resumption of the same native session, but is never reused across tasks, members, Runtime configurations, or working directories. The Runtime's own static allow / deny rules still apply, and previously allowed tools may stop issuing requests.
- Stopping sends `session/cancel` before reclaiming the entire subprocess group after a bounded grace period. App shutdown also cancels and reclaims. Process startup or exit 0 alone is not success. Only a `session/prompt` `end_turn` result marks completion. Interruptions, missing terminal states, protocol errors, context limits, and other failures retain explicit failed / stopped states.
- Browser previews manage only the UI and local preview data; they do not execute Runtimes.

This adapter requires the **Kimi Code CLI** ACP protocol. The older Python **kimi-cli** is explicitly rejected during identity negotiation. User Kimi configuration is not rewritten, old CLI data is not migrated, and login is not automated.

## Validation

The validation artifact paths below refer to historical local validation outputs that are not committed to this repository.

- Rust fixtures cover protocol negotiation, manual mode, model selection, permission waits and option validation, duplicate-response rejection, public text, hidden-thought exclusion, completion detection, cancellation during permission waits, errors versus exit 0, old-CLI rejection, and rejection of extra arguments.
- Frontend tests cover fragmented JSON recovery, streaming text, merged tool calls and inputs/outputs, permission prompts and retries after asynchronous failure, no actionable approvals for historical / interrupted Runs, inherited and per-model effort levels, capability refresh preserving user choices, settings persistence, member overrides and native request parameters, isolation of historical Run snapshots, and initial-detection regressions.
- Installed **Kimi Code CLI 0.39.1** ran initialize → session/new → set_mode → set_config_option → prompt → text stream → end_turn with temporary isolated configuration and a local loopback HTTP model fixture. It made one fixture request to `127.0.0.1` without user credentials or paid model services. Historical validation record: `test-results/kimi-implementation/installed-acp-smoke.json`.
- Additional effort validation used installed **Kimi Code CLI 0.43.1**. The app's native `RuntimeManager` tested `low / high / max` through ACP. The loopback model service received `thinking.effort` matching each requested level, and every run returned a public reply and `completed`. Temporary configuration cleared inherited environment and used no user credentials, hooks, or real remote inference. Historical native routing record: `test-results/kimi-reasoning/native-runtime-smoke.json`; ACP responses: `test-results/kimi-reasoning/installed-acp-smoke.json`.
- This regression passed 332 frontend tests and 71 Rust tests, Clippy, formatting, and macOS App build / signature checks. Native UI validation used an acceptance app with the same source and an independent data directory at 1536 × 960 and 1280 × 720, checking K3 `low / high / max`, persistence, keyboard selection, menu focus restoration, explicit-effort clearing after switching to Highspeed, and compact-window settings dialogs. Shared selectors and immediate state feedback were reused. No new motion was added; system reduced-motion preferences were not toggled, and no slow-motion audit was performed. Historical complete acceptance record: `test-results/kimi-reasoning/verification.json`.
- Real account login and remote-model availability still depend on the user's local Kimi configuration. No real remote inference was requested.

Permission prompts use the shared shadcn/ui Alert / Button components, project theme, and shared press / disabled / focus feedback. Approval and streaming states update immediately without new layout movement or response delays. The project-required apple-design and animate SKILL.md files were read before implementation.

## Official references

- [Kimi Code CLI ACP](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)
- [Commands and non-interactive permission behavior](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)
- [Model aliases and configuration](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files)

The published `.superdesign` prototype is a reference only. This document describes the production implementation in `src` and `src-tauri`.

## Permission defaults and session-approval fix, 2026-09-17

- Root cause: every `session/load` forced a switch back to `default`; the client only forwarded approval options without recording session-level authorization.
- Automatic approval is now the default. Manual-mode session authorization is stored privately in `permissions/<task>/<member>/<session>.json` without rewriting global Runtime configuration.
- Native regression with local Kimi Code CLI 0.43.1: each low / high / max effort ran two turns against an isolated loopback service. Two processes resumed the same session. Every turn's Bash tool appended to a temporary file, and both writes were verified. No user credentials or real remote inference were used.
- Browser interaction regression script: `node scripts/runtime-permissions-smoke.mjs`, covering defaults, manual/automatic switching, save/reload, keyboard focus, 1536 × 960 / 1280 × 720, and normal/reduced motion. The shared Select's entry/exit and press feedback were reused; approval requests are not delayed by motion.

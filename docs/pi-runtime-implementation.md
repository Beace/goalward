# Pi Runtime integration

Pi is integrated as an independent Runtime for local discovery, model catalogs, execution, session recovery, public output, and Trace. The application uses Pi's native persistent RPC mode and public JSON events rather than guessing structured events from ordinary terminal text. See [Claude and Pi native sessions](claude-pi-native-sessions.md) for the complete integration, compatibility, and acceptance boundaries.

## Local discovery and model identity

- Automatic discovery reads the default Provider / model from `settings.json` in the Pi Agent directory and explicitly registered models from `models.json`.
- When the executable is available, it also runs `pi --offline --no-extensions --list-models`. Discovery does not load extensions; models registered by extensions must be added manually.
- Model identities retain the `provider/model` form to avoid merging identically named models from different Providers.
- Discovery exports only fields needed to identify models, excluding API keys, base URLs, and other credentials.
- A thinking marker in the model list establishes that reasoning is available, but does not establish the supported levels. Reasoning effort therefore inherits Pi's setting by default.

## Execution and sessions

- The Pi Runtime uses a persistent `pi --mode rpc` subprocess. It validates the exact native session ID with `get_state`, then sends `prompt` through stdin JSONL. Public replies, activity states, and tool events are projected into the conversation and Trace separately. [Official RPC documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- Original public events are preserved so history can be projected again. The UI presentation does not replace protocol records.
- The same task member reuses its connection and native session while Runtime configuration and working directories remain unchanged. Each invocation is still saved as an independent Run. A disconnect does not resend input automatically; the exact session resumes only on the next explicit request.
- Completion follows native settled/idle status and the final reply state. Neither a `prompt` acknowledgement nor low-level `agent_end` independently establishes completion. Exit code 0 does not prove execution success or business acceptance. [Official event lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)
- Input during execution uses native `steer`. Stopping sends `clear_queue` before `abort` and preserves the idle session after a normal stop. Unresponsive connections, disconnects, and App shutdown still reclaim the native process group and preserve received output. [Official command documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)

## Argument and permission boundaries

- The adapter manages model selection, sessions, the RPC protocol, and message input. User arguments cannot override these critical settings.
- Optional launch arguments are validated before saving and launching. Conflicting arguments produce an error rather than silently switching execution modes.
- Pi has no uniform native per-tool approval capability. Native extension `confirm` requests can be confirmed/cancelled; unsupported `input/select/editor` requests are explicitly cancelled and recorded in Trace. Pi's own configuration continues to determine tool, extension, and project-access policies. The goal assistant exposes only `read,grep,find,ls` and disables extensions and MCP, allowing referenced files to be read while excluding command/write tools. [Official extension UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md)
- Local discovery, model listing, and configuration reads do not verify authentication, remote inference, or account permissions.

## Validation

Standard regression checks:

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Browser-side Pi projection check:

```bash
node scripts/pi-runtime-smoke.mjs
```

The real persistent-protocol check for installed Claude/Pi uses temporary directories and a controlled localhost provider without making real supplier calls:

```bash
python3 scripts/native-session-protocol-smoke.py
```

The native two-turn session check requires an existing working Pi login and model configuration. It is explicitly ignored by default and does not automatically make remote calls during ordinary tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml pi_live_native_two_turn_session -- --ignored --nocapture
```

Passing browser simulations verifies frontend event projection. It does not replace end-to-end acceptance of real Tauri processes, account authentication, remote models, or tool execution.

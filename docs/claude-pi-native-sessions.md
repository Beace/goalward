# Claude and Pi native sessions

Goalward manages connection processes, native sessions, and per-turn Runs separately. A task member using Claude or Pi can reuse a connection while its configuration and working directories remain unchanged; each turn's output is still saved to its own Trace. A disconnected connection never automatically replays input. The saved exact native session ID resumes only on the next explicit request.

## Claude Code

The Rust adapter connects directly to Claude Code's bidirectional JSONL transport using `--input-format stream-json --output-format stream-json --include-partial-messages --permission-prompt-tool stdio`. This is the native subprocess protocol used by the official Agent SDK. The application introduces no SDK npm package, Node sidecar, or custom model/tool loop. The original CLI still manages account authentication, context, and tool execution. [Official SDK transport source](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/transport/subprocess_cli.py)

Initialization uses `control_request/initialize`; input uses `user` records; public replies and tool activity continue to arrive on stdout. Users allow once or deny `can_use_tool` requests, and an allow response returns the original tool arguments. Unsupported client control requests fail explicitly. Stopping uses native `interrupt`. An approval token can be answered only once within the current Run; expired or non-current requests are rejected. [Official control-protocol implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)

Input added during execution is a **follow-up queue**, not Codex/Pi-style steering. The application waits for native results from all submitted user messages before completing the Run. Successful stdio writes record only that a follow-up was submitted. Local measurement showed that `--replay-user-messages` UUID echoes arrive when processing of that message starts, so they cannot serve as immediate queue-acceptance acknowledgements. Later failures and disconnects remain in Trace. [Official continuous-input documentation](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)

Claude's native `interrupt` has no clear-queue interface and can immediately advance to subsequent queued input. When input is already queued, stopping therefore reclaims the connection directly without first sending interrupt or waiting for a normal-shutdown grace period, preventing the CLI from processing queued work after the UI stops. The known native session ID is retained and resumes through `--resume=<exact-id>` on the next turn. A single turn without queued input can retain its connection after normal interruption. A failed result in a queue also reclaims a connection that still holds unprocessed input, preventing old results from entering the next Run.

The goal assistant's plan configuration additionally limits tools to `Read,Grep,Glob`, uses `--restricted` and an empty strict MCP configuration, and denies tool requests that require client approval. Goal working directories are passed through cwd and `--add-dir`. The app's `manual` permission mode maps to the CLI's `default`; other existing native permission modes continue to apply.

## Pi

Execution uses `pi --mode rpc` without `--print`. It first obtains and validates the native session ID through `get_state`, then sends `prompt`. Message and tool start/progress/end events follow the native JSON events. Launch arguments cannot override the app-managed protocol, model, or session selection. [Official RPC mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)

A successful `prompt` response means only that input was accepted. Retries, compaction recovery, or queue processing can still occur after low-level `agent_end`. Completion follows `agent_settled`. For compatible event sequences without settled, the app queries native idle state, requires no streaming, no compaction, and no pending messages, and verifies that the final assistant message stopped normally. [Official event lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)

Input during execution uses native `steer`. Acceptance is confirmed only after a successful acknowledgement with the matching request ID. Explicit rejection, disconnect, and cancellation return errors while preserving input. If acceptance remains unconfirmed after five seconds, the connection is reclaimed without replaying input whose outcome is unknown. Stopping sends `clear_queue` before `abort`, preventing queued messages from continuing after abort alone. Normal stopping can preserve the same idle session. Pi's actual thinking level is displayed from `get_state`; explicit effort overrides remain disabled until the model catalog can validate the supported range. [Official RPC commands](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)

For compatible event streams without `agent_settled`, if get-state remains busy after `agent_end`, idle polling continues every 250 ms rather than depending on another notification to finish. Each post-end idle-confirmation window is bounded to 120 seconds. Failure to confirm produces a failed state while preserving partial output and native history, without replaying input.

Pi does not provide uniform per-tool permissions, so the app does not advertise it as an approvals capability. Native extension `confirm` dialogs can be confirmed or cancelled in Goalward. Unsupported `input/select/editor` requests are explicitly cancelled and recorded in Trace rather than leaving extensions hanging. [Official extension UI protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-extension-ui.md)

The goal assistant exposes only built-in `read,grep,find,ls` tools for referenced files and disables extensions and MCP. A `--tools` allowlist alone still retains MCP tools, so read-only tool configuration automatically adds `--no-mcp`. It does not expose bash/edit/write/powershell. Pi has no Claude-style `--add-dir` access grant. Additional goal working directories are supplied as request context while preserving native Pi tool path semantics. [Official CLI tool selection](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)

## Compatibility and validation

The real protocol checks used **Claude Code 2.1.295 and Pi 1.1.0**. The installed executable's protocol and flags determine compatibility. Older versions missing SDK control, `--restricted`, `--no-mcp`, or other required flags retain the failure and stderr rather than silently falling back to the former single-invocation mode. Users manage upgrades; the app does not modify CLIs, account credentials, or user configuration.

Rust fixtures cover two turns on one connection, public deltas, pre-send rejection of mismatched explicit sessions, one-time approval responses, follow-up queues, stopping, Claude queued-stop reclamation and resumption, approximately 500 KiB user messages, and Pi retry after low-level completion. They also cover compatibility polling from busy to idle without another notification, accepted/rejected/disconnected/timed-out steer acknowledgements, and exit 0 without completion. Repeatable installed-CLI checks use a local provider:

```bash
python3 scripts/native-session-protocol-smoke.py
```

This script uses temporary configuration/session directories and a controlled Anthropic-compatible localhost provider without original account credentials. It passed Claude two-turn context, streaming, denied Bash writes, two queued results, and exact resumption after queued-stop reclamation. Pi passed two-turn context, its four built-in read-only tools, read-tool activity/results, steer, clear-queue/abort, and preservation of the same session after stopping. Together with Rust fixtures, this verifies CLI protocols and app routing. **Real provider authentication, remote networking, and packaged desktop UI end-to-end behavior remain unverified.**

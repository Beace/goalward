# Runtime session continuity

## Corrected behavior

A Run still represents one invocation, its configuration snapshot, and Trace. The same member of the same task reuses its native session. Subsequent invocations use the saved native session ID while the working directory, Runtime ID, adapter, executable, and advanced launch arguments remain unchanged. Model, reasoning effort, and permissions follow the new invocation's configuration.

- Codex: record the session from `thread.started.thread_id` and use `exec resume` with an explicit ID.
- Claude: record the session from top-level `system/init` or `result` `session_id`, then use `--resume`.
- Kimi: save `sessionId` from the ACP creation response, negotiate `loadSession` when resuming, and call `session/load`. Old-message replay during loading is not appended again to the new Run. After successful completion, wait for `session/close` acknowledgement when supported before exiting the process.

Session IDs remain in RunMember snapshots and raw Trace, and can be recovered from existing Codex/Claude traces. New Runs do not rewrite older Runs. Tasks, members, Runtimes, and working directories do not share sessions implicitly through `--last` or `--continue`. Recovery failures produce errors; retry uses the same ID without automatically creating an empty session.

## Legacy records and generic adapters

The original implementation created a new session for every invocation, handed off only the last 8 messages with at most 1,200 characters each, and truncated user instructions to 12,000 characters. Legacy records without a native ID, changes of execution environment, and Generic adapters now receive the complete saved public conversation and full user instructions. Native hidden state, never-saved data, and data already truncated by older versions cannot be reconstructed.

Codex / Claude receive content through stdin to avoid operating-system argv length limits for long histories. Native requests exceeding 1 MiB are rejected before launch with a visible error; history is not silently truncated. Generic adapters retain their custom argument protocol and have no uniform native-session recovery guarantee.

## Validation (2026-09-17)

- `npm run build`: passed.
- `npm test`: 36 files and 418 tests passed, covering fragmented session-ID parsing, persistence/reload, second-turn sending in App, Runtime / directory / member isolation, legacy-record backfill, complete handoff, and retry after recovery failure.
- Full Rust suite: 85 passed and 4 opt-in checks ignored by default. Two subsequent targeted tests for complete large stdin text and Kimi close acknowledgement also passed, bringing the standard total to 87.
- Kimi 0.43.1: used the real RuntimeManager and local CLI with isolated configuration/environment and a loopback HTTP service replacing the remote model. Each low / high / max effort ran two turns, closing the process and recreating RuntimeManager between them. The second provider request explicitly contained the first user message, first reply, and new user message. The native session ID stayed the same, and the new Run received only one new reply.
- All three Kimi effort-resumption checks passed across 3 repetitions. Logs are at `test-results/runtime-session/installed-kimi-{1,2,3}.log`.
- Validation reproduced an empty next-turn context when the process exited immediately after `end_turn`. Repeated checks passed after waiting for close acknowledgement, and a deterministic close-ordering test was added.
- Codex resume argument nesting was checked against local CLI help. Tests cover Codex / Claude native arguments, permission preservation, complete stdin content, and frontend send correlation. No real remote model service was invoked; this does not establish cloud-model E2E success.
- The user's desktop database was not modified, and installation packages were not rebuilt.

## Protocol sources

- [Kimi ACP: session loading, replay, and closing](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)
- [Claude non-interactive invocation, stdin, and exact-session resumption](https://code.claude.com/docs/en/headless)
- Codex: local `codex exec --help`, `codex exec resume --help`, and the local official source `codex-rs/exec/src/cli.rs`.

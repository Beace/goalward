# Native integration fixtures

These scripts test the real desktop process path without network access, model API calls, or changes to the task workspace. They are ordinary executables, not application test modes.

In the macOS application's Runtime settings, add or configure a Generic runtime:

- Executable: the absolute path to `fast-runtime.sh` or `slow-runtime.sh` in this directory.
- Adapter: Generic.
- Arguments: `["{prompt}"]`.
- Model: leave empty.
- Enabled: on.

Both scripts support the application's `--version` probe and require the prompt to arrive as one argument. Run a real task with any existing working directory and select the fixture runtime.

## Fast fixture

Expected: `started`, stdout containing `Fixture begin`, one controlled stderr line, a Chinese text line, stdout containing `Fixture end`, and `completed` with exit code `0`. After reopening the app, the conversation and trace should remain available.

## Slow fixture

Expected: one progress line per second, for 30 seconds. Press **Stop** before completion. The manager should terminate the runtime's process group, retain the terminal `stopped` event, and leave no active fixture process. The script handles TERM/INT with a controlled diagnostic line; that line may be absent when the OS kills the group before the shell flushes it. It is not required for asserting stop completion.

For a parallel-isolation check, run two slow-fixture members and use a member-specific stop through the application's native command where supported. Stopping one member must not stop the other; closing the app must clean up remaining members. Automated Rust tests cover this path.

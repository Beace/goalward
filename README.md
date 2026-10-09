# Goalward

Goalward helps turn a vague ambition into work you can finish and review. Shape a direction into a goal, break it into tasks, use local coding agents to do the work, and decide what to do next from the results.

**Goal → Tasks → Execution → Artifacts and evidence → Review → Next actions**

Goalward is also a desktop proxy for coding agents: run them individually or together, route work to the right agent, and follow each execution trace without losing the goal behind it.

**Supported agents:** Codex · Claude Code · Kimi CLI · Pi · DeepSeek Harness · Custom CLI runtimes

![Goalward English workbench preview](screenshots/goalward-workbench-en.png)

## Download

Goalward 0.1.1 is built for Apple Silicon and Intel Macs running macOS 13.3 or later. The macOS download is a universal app that includes both architectures.

[View macOS downloads (DMG or ZIP)](https://github.com/Beace/goalward/releases) · [Read the changelog](CHANGELOG.md)

Downloads appear on the Releases page after a release is published. Check the SHA-256 checksums listed with its downloads.

The app does not include agent CLIs, model weights, subscriptions, or API credentials. Install and sign in to at least one supported agent before using it.

## Install on macOS

Open the DMG, drag **Goalward.app** into **Applications**, and launch it. If you use the ZIP, extract it and move the app into **Applications**. The release is not notarized; if macOS blocks the first launch, review the warning in **System Settings → Privacy & Security**.

## Get started

1. **Connect an agent.** On first launch, review the detected runtimes, import one, and choose a default. If yours is missing, install and sign in to it, scan again, or set its executable path in **Settings → Runtimes**.
2. **Make a goal concrete.** Start with the direction you have, even if it is still broad. Describe the outcome, constraints, and what would count as progress; then add a first task with an acceptance criterion. Choose a working directory if the task will use local files.
3. **Do the work.** Pick an agent or a collaborating group, review its permissions, and send an instruction. Goalward keeps the conversation and execution trace with the task.
4. **Review and continue.** Check the output, artifacts, and evidence before accepting the task. Record what changed and create the next task, revise the goal, or mark it achieved when its criteria are met.

A finished agent process does not automatically mean a task is accepted. You can also create goals and tasks for work you will do manually.

## Data

Goalward stores workspace data locally in `~/Library/Application Support/dev.goalward.desktop/`. Quit the previous app before the first launch. Goalward preserves its data directory and attempts a non-destructive migration; do not remove the old directory while existing attachments may still refer to it.

## Build from source

On a Mac with macOS 13.3 or later, install Node.js `^20.19.0`, `^22.12.0`, or `>=24.0.0`, npm, Rust stable, Cargo, and Xcode Command Line Tools. Then run:

```bash
npm install
npm run mac:dev
```

Build a local app with `npm run mac:build`. Run checks with `npm run build`, `npm test`, and `cargo test --manifest-path src-tauri/Cargo.toml`. On an Apple Silicon Mac, create the universal DMG, ZIP, checksums, and build metadata with `npm run mac:dist` (Python 3.10 or later required).

## License

This repository does not currently contain a license. Until one is added, copyright law reserves reuse and redistribution rights to the copyright holder.

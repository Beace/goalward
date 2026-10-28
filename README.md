# Goalward

[![CI](https://github.com/Beace/goalward/actions/workflows/ci.yml/badge.svg)](https://github.com/Beace/goalward/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/Beace/goalward?include_prereleases&label=release)](https://github.com/Beace/goalward/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS%2013.3%2B-lightgrey)](https://github.com/Beace/goalward/releases)

**[English](README.md) | [中文](README.zh-CN.md)**

> A desktop app that turns vague ambitions into goals, tasks, and evidence — powered by your local coding agents.

## Why Goalward?

Modern coding agents (Codex, Claude Code, Kimi CLI, etc.) are powerful but isolated. Each has its own interface, session history, and workspace. When you're working toward a larger objective — shipping a feature, learning a framework, refactoring a codebase — you end up context-switching between tools and losing track of the bigger picture.

Goalward bridges this gap:

- **Goal-driven workflow**: Start with a direction, not a command. Goalward helps you clarify outcomes, success criteria, and break work into verifiable tasks.
- **Unified agent proxy**: Run multiple coding agents from one place. Native protocol support means streamed replies, tool progress, and approvals work as the agent intends.
- **Evidence-based review**: Every execution is traced. Artifacts, conversations, and results stay linked to their task. You decide what counts as done.
- **Your agents, your machine**: Goalward manages agent processes locally. No cloud relay — your code and credentials stay where they are.

## Features

- **Goal Assistant**: Describe a broad direction; a restricted local agent helps clarify outcome, scope, and success criteria, then proposes tasks.
- **Task Management**: Create, edit, and track tasks linked to goals. Set deadlines, acceptance criteria, and dependencies.
- **Multi-Runtime Execution**: Run Codex, Claude Code, Kimi CLI, Pi, DeepSeek Harness, or custom CLI tools. Switch agents per task or combine them.
- **Native Sessions**: Conversations persist across turns. Connections are reused; session IDs are preserved for exact resumption.
- **Streaming & Approvals**: Watch agent replies arrive in real time. Handle tool approvals, file changes, and permission requests through the native UI.
- **Execution Traces**: Every run is recorded — input, output, tool calls, reasoning summaries, token usage, and timing.
- **Artifact Preview**: Review HTML, Markdown, images, PDFs, and web pages directly in the inspector panel.
- **Themes & Appearance**: System, Dark, Light, or Cobalt2 themes. Background images with adjustable opacity. Respects reduced motion and transparency preferences.
- **In-App Updates**: Check for updates, download signed packages, and install without leaving the app.

## Supported Agents

| Agent | Protocol | Streaming | Session Continuity | Input While Running |
|-------|----------|-----------|-------------------|---------------------|
| **Codex** | `app-server stdio://` | ✓ | ✓ Thread resume | ✓ Steer |
| **Claude Code** | Agent SDK bidirectional | ✓ | ✓ Session resume | ✓ Follow-up queue |
| **Kimi CLI** | ACP | ✓ | ✓ Session resume | Draft retained |
| **Pi** | RPC mode | ✓ | ✓ Session resume | ✓ Steer |
| **DeepSeek Harness** | CLI | ✓ | — | — |
| **Custom CLI** | Configurable | Varies | — | — |

Goalward uses the original agent executables. You install and authenticate them yourself; Goalward manages the process lifecycle and protocol integration.

## Screenshots

**Goal overview with task delivery progress, success criteria, and working directories:**

![Goalward goal overview](screenshots/goalward-goals-en.png)

**Tasks workspace with conversation, execution inspector, and artifact preview:**

![Goalward Tasks workspace](screenshots/goalward-workbench-en.png)

**Appearance settings with theme, background, and language controls:**

![Goalward Appearance settings](screenshots/goalward-appearance-en.png)

<!-- TODO: Add a demo GIF here showing the goal → task → execution flow -->

*Screenshots show the current frontend at 1536 × 960 with sample data. They do not show live agent execution.*

## Download

Goalward runs on Apple Silicon and Intel Macs with macOS 13.3 or later. Each download is a universal app (arm64 + x86_64).

<!-- download-link:start -->
**[Download for macOS →](https://releases.goalward.dev/v0.8.1/Goalward_0.8.1_macos-universal.dmg)**

Every version remains on [GitHub Releases](https://github.com/Beace/goalward/releases).
<!-- download-link:end -->

Automatic updates read [https://releases.goalward.dev/latest.json](https://releases.goalward.dev/latest.json) first and fall back to the GitHub Release if that manifest is unavailable. Releases include SHA-256 checksums. The app uses ad-hoc signing and is not Apple-notarized; macOS will prompt on first launch. See the [installation guide](docs/install-macos-trial.txt) for details on bypassing Gatekeeper.

## Quick Start

1. **Download and install.** Open the DMG, drag Goalward.app to Applications, and launch it. If macOS blocks the app, go to System Settings → Privacy & Security and click "Open Anyway."

2. **Connect an agent.** On first launch, Goalward detects installed runtimes. Import a detected agent or configure one manually in Settings → Runtimes. Make sure your agent CLI is installed and authenticated.

3. **Create a goal.** Click "Start something" and describe what you want to accomplish. The goal assistant helps clarify the outcome and success criteria, then proposes tasks.

4. **Execute tasks.** Open a task, select an agent and model, and send instructions. Use `@` to reference files. Watch the streamed response, handle approvals, and review artifacts.

5. **Review and continue.** Check execution traces and artifacts. Accept the task when criteria are met, or iterate. Mark the goal achieved when all success criteria have evidence.

## Build from Source

**Prerequisites:** macOS 13.3+, Node.js (20.19+, 22.12+, or 24+), Rust stable, Xcode Command Line Tools.

```bash
git clone https://github.com/Beace/goalward.git
cd goalward
npm ci --registry=https://registry.npmjs.org
npm run mac:dev    # Start development app with hot reload
```

**Other commands:**
- `npm run mac:build` — Build the app bundle
- `npm run build` — TypeScript + Vite build
- `npm test` — Run frontend tests
- `cargo test --manifest-path src-tauri/Cargo.toml` — Run Rust tests

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development setup and PR workflow.

## How Goalward Differs

Goalward is designed around a specific workflow: **Goal → Tasks → Agent Execution → Evidence → Review**.

- **Goal-first, not chat-first.** You start with an outcome and success criteria, not an open-ended conversation. The structure helps you stay oriented.
- **Multi-agent by design.** Different agents excel at different tasks. Goalward lets you pick the right tool for each task without switching apps.
- **Verification is explicit.** Task acceptance and goal verification are separate from process completion. You review evidence and decide what counts as done.
- **Local execution only.** Goalward is a desktop app that runs agents on your machine. There's no hosted backend, no cloud sync, no intermediary.

## Roadmap

Planned improvements (not in priority order):

- [ ] **Web demo**: Browser-based preview with sample data on GitHub Pages
- [ ] **Automatic retrospectives**: Generate summaries and next-step suggestions from execution results
- [ ] **Parallel execution**: Run multiple agents on the same task using git worktrees
- [ ] **Additional platforms**: Windows and Linux builds
- [ ] **Plugin system**: Custom runtime adapters and integrations

See the [product proposal](docs/goal-driven-product-proposal.md) for more context on future directions.

## Data

Workspace data is stored locally:
```
~/Library/Application Support/dev.goalward.desktop/
```

Goalward does not send data externally. Your agent credentials and code stay on your machine.

## Contributing

Contributions are welcome! Please read:

- [CONTRIBUTING.md](CONTRIBUTING.md) — Development setup and PR workflow
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Community guidelines
- [SECURITY.md](SECURITY.md) — Reporting vulnerabilities

## License

[MIT](LICENSE) © 2026 Beace

---

Built with [Tauri 2](https://tauri.app/), [React](https://react.dev/), and [shadcn/ui](https://ui.shadcn.com/).

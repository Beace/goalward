# Changelog

## [0.1.1] - 2026-10-09

This is the first GitHub release recorded in this repository. There is no earlier version tag here, so these notes describe the 0.1.1 release rather than a measured change from 0.1.0.

### Release delivery

- Added a GitHub Actions workflow for a universal macOS build that includes Apple Silicon and Intel.
- Added DMG and ZIP packaging with SHA-256 checksums for the release downloads.
- Locked npm dependencies to the public registry and added npm and Rust dependency caches to CI.
- Updated the README to link to GitHub Releases so downloads do not depend on a versioned filename.

### Application included

- Turn directions into goals and tasks, run local coding agents individually or together, and review their traces, artifacts, and evidence before deciding the next action.
- Connect Codex, Claude Code, Kimi CLI, Pi, DeepSeek Harness, or a custom CLI runtime installed on the Mac.

The app does not bundle agent CLIs, model access, or credentials. This release is not notarized.

# Releasing Goalward for macOS

The 0.1.1 workflow builds a universal macOS app for Apple Silicon and Intel. It creates a draft prerelease for review; it does not publish a public download.

## Prepare a version

1. Use the same `X.Y.Z` version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the `goalward` package entry in `src-tauri/Cargo.lock`. Regenerate the lockfile with Cargo after editing the manifest, then check the resulting diff.
2. Add one nonempty section to `CHANGELOG.md` headed `## [X.Y.Z] - YYYY-MM-DD`. The release workflow uses that section as its GitHub Release notes.
3. Commit and push the version changes to `main`. Wait for **macOS universal CI** on `main` to pass. The CI artifact is a build preview, not a GitHub Release.

Keep the four `@tauri-apps/*` npm packages pinned to exact versions aligned with the Rust crates in `Cargo.lock`: the core API and CLI need the same major/minor as `tauri`, and each plugin needs the same full version on both sides. CI checks these before the costly Rust build.

Commit `package-lock.json` with each dependency change. Generate it from the public `https://registry.npmjs.org` registry in a clean dependency tree, and check that every `resolved` URL uses that host. CI uses `npm ci` with this lockfile and caches npm downloads and Rust dependency builds; a changed lockfile or Rust toolchain can make the next build cold again.

The Actions build pins Rust 1.99.0. Change that toolchain version deliberately when validating a later release; a newer Clippy can introduce new warnings that fail the release gate.

## Create and review the draft

In GitHub Actions, run **Draft macOS universal release** from `main` and enter the version without `v` (for example, `0.1.1`). The workflow checks all four version locations and the changelog, rebuilds and verifies the universal app, then creates a draft prerelease tagged `vX.Y.Z`.

Review the draft's DMG, ZIP, `SHA256SUMS.txt`, `BUILD-INFO.json`, and `INSTALL.zh-CN.txt` guide. Download the assets together and run `shasum -a 256 -c SHA256SUMS.txt`; inspect the build metadata for the expected version, `arm64` and `x86_64` architectures, and signing/notarization status. Test installation and launch on both Mac architectures before approving distribution.

The current workflow produces an ad-hoc signed, unnotarized trial build. Keep it as a draft prerelease until Apple Developer ID signing, notarization, and stapling are implemented and verified. Publish only after an explicit release decision. The README links to the Releases page, which lists download assets once a release is published.

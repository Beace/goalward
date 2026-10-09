# Releasing Goalward for macOS

The 0.1.1 workflow builds a universal macOS app for Apple Silicon and Intel. It creates a draft prerelease for review; it does not publish a public download.

## Prepare a version

1. Use the same `X.Y.Z` version in `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and the `goalward` package entry in `src-tauri/Cargo.lock`. Regenerate the lockfile with Cargo after editing the manifest, then check the resulting diff.
2. Add one nonempty section to `CHANGELOG.md` headed `## [X.Y.Z] - YYYY-MM-DD`. The release workflow uses that section as its GitHub Release notes.
3. Commit and push the version changes to `main`. Wait for **macOS universal CI** on `main` to pass. The CI artifact is a build preview, not a GitHub Release.

The repository intentionally has no `package-lock.json`. CI uses `npm install --no-package-lock`; dependency resolution is therefore not fully reproducible. Do not describe this build as reproducible or switch to `npm ci` without adopting a reviewed lockfile strategy.

## Create and review the draft

In GitHub Actions, run **Draft macOS universal release** from `main` and enter the version without `v` (for example, `0.1.1`). The workflow checks all four version locations and the changelog, rebuilds and verifies the universal app, then creates a draft prerelease tagged `vX.Y.Z`.

Review the draft's DMG, ZIP, `SHA256SUMS.txt`, `BUILD-INFO.json`, and installation guide. Download the assets together and run `shasum -a 256 -c SHA256SUMS.txt`; inspect the build metadata for the expected version, `arm64` and `x86_64` architectures, and signing/notarization status. Test installation and launch on both Mac architectures before approving distribution.

The current workflow produces an ad-hoc signed, unnotarized trial build. Keep it as a draft prerelease until Apple Developer ID signing, notarization, and stapling are implemented and verified. Publish only after an explicit release decision. For a public stable release, clear the prerelease status and mark it as the latest release so the README's `/releases/latest` download link resolves.

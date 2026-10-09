# Releasing Goalward for macOS

Goalward publishes one macOS universal prerelease for each task Pull Request merged into `main`. The GitHub Release version and its Git commit are the release source of truth. No person or workflow pushes changes directly to `main`.

## Develop through a Pull Request

1. Fetch the latest `main`, create a fresh task branch (Codex uses `codex/<task-name>`), and make the change there.
2. Give the PR a Conventional Commit title that accurately describes its effect: `feat:` for a feature, `fix:` for a fix, or another readable type such as `docs:`, `ci:`, or `chore:`. Mark incompatible changes with `!` (for example, `feat!:`) or `BREAKING CHANGE:` in the squash commit body.
3. Push only the task branch, open a PR, check its CI, and squash-merge it. GitHub's `main` ruleset requires a PR, and the repository only allows squash merges. The squash commit on `main` is the input to versioning and release notes.

## Automatic version and changelog

The version calculation starts from the recorded 0.1.1 baseline commit in `.github/release-baseline.json`. For every subsequent squash commit on `main`, a breaking change increments the major version, `feat:` increments the minor version, and any other commit increments the patch version. Each merged PR therefore receives a deterministic version, even if another release run is still building. An unrecognized commit title is treated as a patch rather than silently skipped.

The release workflow runs after a task PR is merged, checks out that exact commit, computes its version, builds a universal app for Apple Silicon and Intel, verifies the DMG, ZIP, metadata, and SHA-256 checksums, and only then publishes a GitHub prerelease. Its “What's Changed” list comes from the merged Git commit title and includes the PR author and number. “Full Changelog” links the previous version's tag (or commit, if its release did not complete) to the new tag. [GitHub Releases](https://github.com/Beace/goalward/releases) is the changelog for versions after 0.1.1; the repository's `CHANGELOG.md` retains the pre-automation 0.1.1 entry.

The version fields in `package.json`, `package-lock.json`, Tauri configuration, `Cargo.toml`, and `Cargo.lock` are a development-build baseline on `main`. The release job deterministically stamps its calculated version into those files **only in the checked-out build workspace**, checks they agree, and records the original Git SHA in `BUILD-INFO.json`. A release tag points to the merged source commit, not to a version-bump commit. To reproduce its app version from a tag, check out the tag, use Python 3.11 or later to run `python3 scripts/release.py stamp X.Y.Z` with the tag's version, install from the public npm registry with `npm ci --registry=https://registry.npmjs.org`, then build on an Apple Silicon Mac with `npm run mac:dist`. Do not claim that an unstamped checkout of the tag already contains its release version.

The existing `v0.1.1` draft prerelease has no Git tag and is kept as the baseline; the new workflow does not overwrite or publish it. For the first automatic release, the Full Changelog comparison starts at that recorded baseline commit.

## Publish and recover

The workflow first creates a draft, uploads the five distribution assets without overwriting existing files, and reads their digests and sizes back from GitHub. It publishes the prerelease only when the complete set matches the verified build. A rerun can safely continue a matching draft; an existing release with a different source commit or asset content stops for inspection. No DMG, ZIP, or other release binary is committed to Git.

Each public prerelease is currently ad-hoc signed and **not Apple-notarized**. The README and installation guide disclose this limitation. Developer ID signing, notarization, and stapling remain separate work; do not describe these trial builds as notarized or as a final macOS distribution.

If a release fails, inspect its Actions run and draft before rerunning the same workflow. Do not create a competing tag, delete a draft, or overwrite assets to hide a mismatch. The successful CI build is an Actions artifact for diagnosis; the verified GitHub Release assets are the user downloads.

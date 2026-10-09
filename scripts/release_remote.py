#!/usr/bin/env python3
"""Read and verify the GitHub Release state used by a scheduled release run.

Published Releases are the version source of truth. A draft is deliberately not
an anchor: an interrupted upload must not advance the next version.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


VERSION_RE = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
REPO_RE = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")


class RemoteReleaseError(ValueError):
    """Remote state is invalid or disagrees with the requested release."""


def validate_repo(repo: str) -> str:
    if not REPO_RE.fullmatch(repo) or ".." in repo:
        raise RemoteReleaseError(f"Invalid OWNER/REPO: {repo!r}")
    return repo


def validate_sha(sha: str) -> str:
    if not SHA_RE.fullmatch(sha):
        raise RemoteReleaseError(f"Expected a full lowercase Git SHA: {sha!r}")
    return sha


def version_parts(version: str) -> tuple[int, int, int]:
    match = VERSION_RE.fullmatch(version)
    if not match:
        raise RemoteReleaseError(f"Invalid release version: {version!r}")
    return tuple(int(part) for part in match.groups())


def command(*args: str) -> str:
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RemoteReleaseError(
            f"{' '.join(args)} failed: {result.stderr.strip() or result.stdout.strip()}"
        )
    return result.stdout.strip()


def list_releases(repo: str) -> list[dict]:
    validate_repo(repo)
    releases: list[dict] = []
    for page in range(1, 1001):
        raw = command("gh", "api", f"repos/{repo}/releases?per_page=100&page={page}")
        try:
            entries = json.loads(raw)
        except json.JSONDecodeError as error:
            raise RemoteReleaseError(f"Invalid Release API JSON on page {page}") from error
        if not isinstance(entries, list) or not all(isinstance(item, dict) for item in entries):
            raise RemoteReleaseError(f"Expected a Release list on page {page}")
        releases.extend(entries)
        if len(entries) < 100:
            return releases
    raise RemoteReleaseError("Release list exceeded 1000 pages; refusing a partial result")


def remote_tag_commit(tag: str) -> str | None:
    """Resolve a remote lightweight tag or peel an annotated tag to a commit."""
    if not tag.startswith("v"):
        raise RemoteReleaseError(f"Invalid release tag: {tag!r}")
    version_parts(tag[1:])
    ref = f"refs/tags/{tag}"
    peeled = f"{ref}^{{}}"
    raw = command("git", "ls-remote", "--tags", "origin", ref, peeled)
    refs: dict[str, str] = {}
    for line in raw.splitlines():
        parts = line.split("\t")
        if len(parts) != 2 or parts[1] not in (ref, peeled) or parts[1] in refs:
            raise RemoteReleaseError(f"Unexpected remote tag response for {tag}")
        refs[parts[1]] = validate_sha(parts[0])
    if peeled in refs and ref not in refs:
        raise RemoteReleaseError(f"Peeled tag {tag} has no tag ref")
    sha = refs.get(peeled, refs.get(ref))
    if sha is not None and command("git", "rev-parse", "--verify", f"{sha}^{{commit}}") != sha:
        raise RemoteReleaseError(f"Remote tag {tag} does not peel to a local Git commit")
    return sha


def read_baseline(path: Path) -> dict[str, str | None]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RemoteReleaseError(f"Cannot read release baseline: {error}") from error
    if not isinstance(data, dict) or set(data) != {"version", "sha"}:
        raise RemoteReleaseError("Release baseline must contain exactly version and sha")
    version, sha = data["version"], data["sha"]
    if not isinstance(version, str) or not isinstance(sha, str):
        raise RemoteReleaseError("Release baseline version and sha must be strings")
    version_parts(version)
    validate_sha(sha)
    return {"version": version, "sha": sha, "tag": None}


def release_anchor(repo: str, baseline_path: Path) -> dict[str, str | None]:
    baseline = read_baseline(baseline_path)
    baseline_version = version_parts(baseline["version"])
    candidates: list[tuple[tuple[int, int, int], str, dict]] = []
    for item in list_releases(repo):
        tag = item.get("tag_name")
        if not isinstance(tag, str) or not tag.startswith("v") or not VERSION_RE.fullmatch(tag[1:]):
            continue
        version = version_parts(tag[1:])
        if version < baseline_version:
            continue
        if not isinstance(item.get("draft"), bool):
            raise RemoteReleaseError(f"Release {tag} is missing a valid draft flag")
        if not item["draft"]:
            candidates.append((version, tag, item))
    if not candidates:
        return baseline
    newest = max(version for version, _, _ in candidates)
    matches = [(tag, item) for version, tag, item in candidates if version == newest]
    if len(matches) != 1:
        raise RemoteReleaseError(f"Multiple published Releases claim version {newest}")
    tag, release = matches[0]
    sha = remote_tag_commit(tag)
    if sha is None:
        raise RemoteReleaseError(f"Published Release {tag} has no remote Git tag")
    if newest == baseline_version and sha != baseline["sha"]:
        raise RemoteReleaseError(f"Published baseline Release {tag} tag differs from its baseline SHA")
    # GitHub does not use target_commitish to place a tag that already exists.
    # The verified tag, not Release metadata, identifies the published commit.
    return {"version": tag[1:], "sha": sha, "tag": tag}


def verify_anchor(repo: str, baseline_path: Path, version: str, sha: str) -> dict[str, str | None]:
    version_parts(version)
    validate_sha(sha)
    resolved = release_anchor(repo, baseline_path)
    if (resolved["version"], resolved["sha"]) != (version, sha):
        raise RemoteReleaseError(
            f"Release anchor changed: expected {version} at {sha}, "
            f"found {resolved['version']} at {resolved['sha']}"
        )
    return resolved


def check_candidate(repo: str, tag: str, target: str, anchor_version: str,
                    *, fail_on_assets: bool = False) -> dict[str, str]:
    validate_repo(repo)
    validate_sha(target)
    if not tag.startswith("v"):
        raise RemoteReleaseError(f"Invalid release tag: {tag!r}")
    candidate_version = version_parts(tag[1:])
    anchor_parts = version_parts(anchor_version)
    if candidate_version <= anchor_parts:
        raise RemoteReleaseError(f"Candidate {tag} must be newer than anchor v{anchor_version}")
    releases = list_releases(repo)
    for item in releases:
        draft_tag = item.get("tag_name")
        if (item.get("draft") is True and isinstance(draft_tag, str)
                and draft_tag.startswith("v") and VERSION_RE.fullmatch(draft_tag[1:])
                and version_parts(draft_tag[1:]) > anchor_parts and draft_tag != tag):
            raise RemoteReleaseError(
                f"Unresolved draft Release {draft_tag} is newer than anchor v{anchor_version}; "
                "inspect that draft manually before publishing a new version"
            )
    matches = [item for item in releases if item.get("tag_name") == tag]
    if len(matches) > 1:
        raise RemoteReleaseError(f"Multiple Releases use {tag}")
    remote_sha = remote_tag_commit(tag)
    if not matches:
        if remote_sha is not None:
            if remote_sha != target:
                raise RemoteReleaseError(f"{tag} exists without a Release and targets a different commit")
            return {"tag": tag, "status": "matching-orphan-tag"}
        return {"tag": tag, "status": "available"}
    release = matches[0]
    if release.get("draft") is not True:
        raise RemoteReleaseError(f"{tag} has already been published or has an invalid draft flag")
    if remote_sha is None:
        if release.get("target_commitish") != target:
            raise RemoteReleaseError(f"Draft Release {tag} targets a different commit")
    elif remote_sha != target:
        raise RemoteReleaseError(f"Draft Release {tag} Git tag targets a different commit")
    if fail_on_assets:
        assets = release.get("assets")
        if not isinstance(assets, list):
            raise RemoteReleaseError(f"Draft Release {tag} has no valid asset listing")
        if assets:
            raise RemoteReleaseError(
                f"Draft Release {tag} already has assets; inspect the old draft and original "
                "build artifacts manually before rebuilding"
            )
    return {"tag": tag, "status": "matching-draft"}


def create_tag(repo: str, anchor_version: str, tag: str, target: str) -> dict[str, str]:
    """Create a lightweight release tag only for a verified mainline commit."""
    candidate = check_candidate(repo, tag, target, anchor_version)
    mainline = command("git", "rev-list", "--first-parent", "refs/remotes/origin/main")
    if target not in mainline.splitlines():
        raise RemoteReleaseError(
            f"Release target {target} is not on the fetched origin/main first-parent history"
        )

    existing_sha = remote_tag_commit(tag)
    if existing_sha is not None:
        if existing_sha != target:
            raise RemoteReleaseError(f"Existing tag {tag} does not match the release target")
        status = ("matching-draft-tag" if candidate["status"] == "matching-draft"
                  else "matching-orphan-tag")
        return {"tag": tag, "sha": target, "status": status}

    ref = f"refs/tags/{tag}"
    raw = command("gh", "api", "-X", "POST", f"repos/{repo}/git/refs",
                  "-f", f"ref={ref}", "-f", f"sha={target}")
    try:
        created = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RemoteReleaseError(f"Invalid tag creation response for {tag}") from error
    if (not isinstance(created, dict) or created.get("ref") != ref
            or not isinstance(created.get("object"), dict)
            or created["object"].get("type") != "commit"
            or created["object"].get("sha") != target):
        raise RemoteReleaseError(f"Tag creation response for {tag} differs from the planned commit")
    if remote_tag_commit(tag) != target:
        raise RemoteReleaseError(f"Remote tag {tag} did not resolve to the planned commit")
    return {"tag": tag, "sha": target, "status": "created"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    anchor = subcommands.add_parser("anchor", help="Resolve the last published release")
    anchor.add_argument("--repo", required=True)
    anchor.add_argument("--baseline", type=Path, required=True)
    verify = subcommands.add_parser("verify-anchor", help="Re-check the chosen release anchor")
    verify.add_argument("--repo", required=True)
    verify.add_argument("--baseline", type=Path, required=True)
    verify.add_argument("--version", required=True)
    verify.add_argument("--sha", required=True)
    candidate = subcommands.add_parser("check-candidate", help="Reject a conflicting candidate tag")
    candidate.add_argument("--repo", required=True)
    candidate.add_argument("--tag", required=True)
    candidate.add_argument("--target", required=True)
    candidate.add_argument("--anchor-version", required=True)
    candidate.add_argument("--fail-on-assets", action="store_true")
    create = subcommands.add_parser("create-tag", help="Create a version tag on fetched main history")
    create.add_argument("--repo", required=True)
    create.add_argument("--anchor-version", required=True)
    create.add_argument("--tag", required=True)
    create.add_argument("--target", required=True)
    args = parser.parse_args()
    try:
        if args.command == "anchor":
            result = release_anchor(args.repo, args.baseline)
        elif args.command == "verify-anchor":
            result = verify_anchor(args.repo, args.baseline, args.version, args.sha)
        elif args.command == "check-candidate":
            result = check_candidate(args.repo, args.tag, args.target, args.anchor_version,
                                     fail_on_assets=args.fail_on_assets)
        else:
            result = create_tag(args.repo, args.anchor_version, args.tag, args.target)
        print(json.dumps(result, sort_keys=True))
    except (RemoteReleaseError, OSError) as error:
        print(f"release_remote.py: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

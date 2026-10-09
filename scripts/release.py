#!/usr/bin/env python3
"""Deterministic release planning, version stamping, and GitHub notes.

The checked-in baseline is the last source commit before automated releases.
Each release covers all first-parent commits since the previous release tag.
Release tags point at source commits; the build stamps the tag's version in its
ephemeral checkout. The stamp is deliberately not committed to main.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path


VERSION_RE = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
SHA_RE = re.compile(r"[0-9a-f]{40}\Z")
REPO_RE = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
SUBJECT_RE = re.compile(r"(?P<type>[a-zA-Z]+)(?:\([^)\r\n]+\))?(?P<breaking>!)?: .+\Z")
BREAKING_RE = re.compile(r"^BREAKING[ -]CHANGE:\s*\S", re.MULTILINE)


class ReleaseError(ValueError):
    """An invalid release input or repository state."""


def version_parts(version: str) -> tuple[int, int, int]:
    match = VERSION_RE.fullmatch(version)
    if not match:
        raise ReleaseError(f"Invalid stable release version: {version!r}")
    return tuple(map(int, match.groups()))


def next_version(previous: str, bump: str) -> str:
    major, minor, patch = version_parts(previous)
    if bump == "major":
        return f"{major + 1}.0.0"
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise ReleaseError(f"Invalid version bump: {bump!r}")


def classify_commit(subject: str, body: str = "") -> str:
    """Conventional breaking/feat commits bump major/minor; all others patch."""
    match = SUBJECT_RE.fullmatch(subject)
    if (match and match.group("breaking")) or BREAKING_RE.search(body):
        return "major"
    if match and match.group("type").lower() == "feat":
        return "minor"
    return "patch"


def validate_repo(repo: str) -> str:
    if not REPO_RE.fullmatch(repo) or ".." in repo:
        raise ReleaseError(f"Invalid OWNER/REPO: {repo!r}")
    return repo


def validate_sha(sha: str) -> str:
    if not SHA_RE.fullmatch(sha):
        raise ReleaseError(f"Expected a full lowercase 40-character Git SHA: {sha!r}")
    return sha


def git(root: Path, *args: str, allow_failure: bool = False) -> str | None:
    command = subprocess.run(
        ["git", *args], cwd=root, text=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=False,
    )
    if command.returncode:
        if allow_failure:
            return None
        raise ReleaseError(f"git {' '.join(args)} failed: {command.stderr.strip()}")
    return command.stdout.strip()


def commit_sha(root: Path, ref: str) -> str | None:
    value = git(root, "rev-parse", "--verify", f"{ref}^{{commit}}", allow_failure=True)
    return value if value and SHA_RE.fullmatch(value) else None


def is_ancestor(root: Path, ancestor: str, descendant: str) -> bool:
    return git(root, "merge-base", "--is-ancestor", ancestor, descendant,
               allow_failure=True) is not None


def baseline(root: Path) -> tuple[str, str]:
    path = root / ".github/release-baseline.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"Cannot read release baseline: {error}") from error
    if not isinstance(data, dict) or set(data) != {"version", "sha"}:
        raise ReleaseError("Release baseline must contain exactly version and sha")
    version, sha = data["version"], data["sha"]
    if not isinstance(version, str) or not isinstance(sha, str):
        raise ReleaseError("Release baseline version and sha must be strings")
    version_parts(version)
    validate_sha(sha)
    if commit_sha(root, sha) != sha:
        raise ReleaseError("Release baseline commit is absent from this checkout")
    return version, sha


def main_ref(root: Path) -> str:
    for ref in ("refs/remotes/origin/main", "refs/heads/main"):
        if commit_sha(root, ref):
            return ref
    raise ReleaseError("main ref is unavailable; fetch origin/main before planning")


def first_parent_chain(root: Path, ref: str) -> list[str]:
    value = git(root, "rev-list", "--first-parent", ref)
    return value.splitlines() if value else []


def check_version_tags(root: Path, previous_version: str, previous_sha: str,
                       version: str | None, target_sha: str,
                       unreleased_commits: set[str]) -> None:
    """Reject conflicting or overlooked release tags; tags never choose a bump."""
    previous_tag = f"v{previous_version}"
    next_tag = f"v{version}" if version else None
    for tag in (git(root, "for-each-ref", "--format=%(refname:short)", "refs/tags") or "").splitlines():
        if not tag.startswith("v") or not VERSION_RE.fullmatch(tag[1:]):
            continue
        sha = commit_sha(root, f"refs/tags/{tag}")
        if tag == previous_tag and sha != previous_sha:
            raise ReleaseError(f"Tag {tag} disagrees with the previous release commit")
        if sha in unreleased_commits and (tag != next_tag or sha != target_sha):
            raise ReleaseError(f"Tag {tag} marks an unreleased commit; select the latest release")
        if tag == next_tag and sha != target_sha:
            raise ReleaseError(f"Tag {tag} disagrees with the calculated release commit")


def plan_release(root: Path, target_sha: str, repo: str,
                 previous_version: str, previous_sha: str) -> dict[str, object]:
    validate_repo(repo)
    validate_sha(target_sha)
    validate_sha(previous_sha)
    version_parts(previous_version)
    if commit_sha(root, target_sha) != target_sha:
        raise ReleaseError("Target commit is absent from this checkout")
    if commit_sha(root, previous_sha) != previous_sha:
        raise ReleaseError("Previous release commit is absent from this checkout")
    base_version, base_sha = baseline(root)
    if previous_sha == base_sha:
        if previous_version != base_version:
            raise ReleaseError("Previous version disagrees with the release baseline")
    else:
        if version_parts(previous_version) <= version_parts(base_version):
            raise ReleaseError("Previous version must be newer than the release baseline")
        if commit_sha(root, f"refs/tags/v{previous_version}") != previous_sha:
            raise ReleaseError("Previous release version and SHA need a matching tag")
    if not is_ancestor(root, base_sha, previous_sha):
        raise ReleaseError("Release baseline is not an ancestor of the previous release")
    chain = first_parent_chain(root, main_ref(root))
    if any(sha not in chain for sha in (base_sha, previous_sha, target_sha)):
        raise ReleaseError("Target, previous release, and baseline must be on main's first-parent history")
    if not is_ancestor(root, base_sha, target_sha):
        raise ReleaseError("Release baseline is not an ancestor of the target")
    if is_ancestor(root, target_sha, previous_sha):
        check_version_tags(root, previous_version, previous_sha, None, target_sha, set())
        return {
            "has_changes": False, "version": previous_version,
            "previous_version": previous_version, "previous_sha": previous_sha,
            "target_sha": target_sha, "bump": None, "commits": [],
        }
    if not is_ancestor(root, previous_sha, target_sha):
        raise ReleaseError("Previous release and target have diverged")
    commits = (git(root, "rev-list", "--first-parent", "--reverse",
                   f"{previous_sha}..{target_sha}") or "").splitlines()
    if not commits:
        raise ReleaseError("Expected new commits after the previous release")
    bump_rank = {"patch": 0, "minor": 1, "major": 2}
    bump = "patch"
    entries: list[dict[str, str]] = []
    parent_sha = previous_sha
    for sha in commits:
        parents = (git(root, "rev-list", "--parents", "-n", "1", sha) or "").split()
        if parents != [sha, parent_sha]:
            raise ReleaseError("Every release commit must have one first parent on main")
        subject = git(root, "show", "-s", "--format=%s", sha) or ""
        body = git(root, "show", "-s", "--format=%b", sha) or ""
        if not subject or "\n" in subject or "\r" in subject:
            raise ReleaseError("Release commit has no valid subject")
        candidate = classify_commit(subject, body)
        if bump_rank[candidate] > bump_rank[bump]:
            bump = candidate
        entries.append({"sha": sha, "subject": subject})
        parent_sha = sha
    version = next_version(previous_version, bump)
    check_version_tags(root, previous_version, previous_sha, version, target_sha, set(commits))
    return {
        "has_changes": True,
        "version": version,
        "previous_version": previous_version,
        "previous_sha": previous_sha,
        "target_sha": target_sha,
        "bump": bump,
        "commits": entries,
    }


def checked_json(path: Path) -> dict:
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"Cannot read {path}: {error}") from error
    if not isinstance(result, dict):
        raise ReleaseError(f"Expected a JSON object in {path}")
    return result


def checked_toml(path: Path) -> dict:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise ReleaseError(f"Cannot read {path}: {error}") from error


def validate_public_lock(lock: dict) -> None:
    if lock.get("lockfileVersion") != 3:
        raise ReleaseError("Expected npm package-lock v3")
    packages = lock.get("packages")
    if not isinstance(packages, dict) or not isinstance(packages.get(""), dict):
        raise ReleaseError("npm lockfile root package is missing")
    for value in packages.values():
        if not isinstance(value, dict):
            raise ReleaseError("Invalid npm lockfile package")
        resolved = value.get("resolved")
        if resolved is not None and (not isinstance(resolved, str) or
                                     not resolved.startswith("https://registry.npmjs.org/")):
            raise ReleaseError("npm lockfile contains a non-public registry URL")


def one_substitution(pattern: str, replacement: str, text: str, label: str) -> str:
    result, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        raise ReleaseError(f"Could not update exactly one {label}")
    return result


def stamp_version(root: Path, version: str) -> None:
    """Validate every source before changing any file, then stamp version fields."""
    version_parts(version)
    package_path = root / "package.json"
    npm_lock_path = root / "package-lock.json"
    tauri_path = root / "src-tauri/tauri.conf.json"
    cargo_path = root / "src-tauri/Cargo.toml"
    cargo_lock_path = root / "src-tauri/Cargo.lock"
    package = checked_json(package_path)
    npm_lock = checked_json(npm_lock_path)
    tauri = checked_json(tauri_path)
    cargo = checked_toml(cargo_path)
    cargo_lock = checked_toml(cargo_lock_path)
    validate_public_lock(npm_lock)
    root_package = npm_lock["packages"][""]
    cargo_packages = [item for item in cargo_lock.get("package", [])
                      if isinstance(item, dict) and item.get("name") == "goalward"]
    if len(cargo_packages) != 1 or any(name != "goalward" for name in (
        package.get("name"), npm_lock.get("name"), root_package.get("name"),
        cargo.get("package", {}).get("name"), tauri.get("productName", "").lower())):
        raise ReleaseError("The five version files do not describe Goalward")
    old_versions = (
        package.get("version"), npm_lock.get("version"), root_package.get("version"),
        tauri.get("version"), cargo["package"].get("version"), cargo_packages[0].get("version"),
    )
    if len(set(old_versions)) != 1 or not isinstance(old_versions[0], str):
        raise ReleaseError("Source versions differ before stamping")
    version_parts(old_versions[0])
    package["version"] = npm_lock["version"] = root_package["version"] = tauri["version"] = version
    cargo_text = cargo_path.read_text(encoding="utf-8")
    cargo_lock_text = cargo_lock_path.read_text(encoding="utf-8")
    cargo_text = one_substitution(
        r'(?ms)(^\[package\]\n(?:(?!^\[).)*?^version = ")[^"]+("$)',
        rf'\g<1>{version}\g<2>', cargo_text, "Cargo.toml package version",
    )
    cargo_lock_text = one_substitution(
        r'(?m)(^\[\[package\]\]\nname = "goalward"\nversion = ")[^"]+("$)',
        rf'\g<1>{version}\g<2>', cargo_lock_text, "Cargo.lock goalward version",
    )
    outputs = {
        package_path: json.dumps(package, indent=2, ensure_ascii=False) + "\n",
        npm_lock_path: json.dumps(npm_lock, indent=2, ensure_ascii=False) + "\n",
        tauri_path: json.dumps(tauri, indent=2, ensure_ascii=False) + "\n",
        cargo_path: cargo_text,
        cargo_lock_path: cargo_lock_text,
    }
    for path, content in outputs.items():
        path.write_text(content, encoding="utf-8")


def escape_markdown(value: str) -> str:
    return re.sub(r"([\\`*_\[\]<>])", r"\\\1", value)


def validate_note_entries(entries: object, commits: list[dict[str, str]]) -> list[dict]:
    if not isinstance(entries, list) or len(entries) != len(commits):
        raise ReleaseError("Release note entries must match every planned commit")
    for entry, commit in zip(entries, commits):
        if not isinstance(entry, dict) or set(entry) != {
            "sha", "subject", "pr_number", "pr_author"
        }:
            raise ReleaseError("Each release note entry needs sha, subject, pr_number, and pr_author")
        if entry["sha"] != commit["sha"] or entry["subject"] != commit["subject"]:
            raise ReleaseError("Release note entries disagree with the ordered Git commits")
        number, author = entry["pr_number"], entry["pr_author"]
        if (not isinstance(number, int) or isinstance(number, bool) or number < 1 or
                not isinstance(author, str) or
                not re.fullmatch(r"[A-Za-z0-9-]+(?:\[bot\])?", author)):
            raise ReleaseError("Invalid PR number or GitHub author in release note entries")
    return entries


def render_notes(entries: list[dict], repo: str, version: str, previous_version: str,
                 previous_sha: str, previous_tag_exists: bool) -> str:
    validate_repo(repo)
    version_parts(version)
    version_parts(previous_version)
    validate_sha(previous_sha)
    base = f"v{previous_version}" if previous_tag_exists else previous_sha
    label = f"v{previous_version}" if previous_tag_exists else previous_sha[:7]
    bullets = "\n".join(
        f"* {escape_markdown(entry['subject'])} by @{entry['pr_author']} in #{entry['pr_number']}"
        for entry in entries
    )
    return (
        "## What's Changed\n\n"
        f"{bullets}\n\n"
        f"**Full Changelog**: [{label}...v{version}](https://github.com/{repo}/compare/{base}...v{version})\n\n"
        "> [!WARNING]\n"
        "> This macOS trial build is ad-hoc signed and not notarized by Apple.\n"
    )


def release_notes(root: Path, target_sha: str, repo: str, version: str,
                  previous_version: str, previous_sha: str,
                  entries: object) -> str:
    validate_sha(target_sha)
    validate_sha(previous_sha)
    planned = plan_release(root, target_sha, repo, previous_version, previous_sha)
    if not planned["has_changes"]:
        raise ReleaseError("Cannot write release notes when there are no new commits")
    if (version, previous_version, previous_sha) != (
        planned["version"], planned["previous_version"], planned["previous_sha"]
    ):
        raise ReleaseError("Requested release notes disagree with the commit-derived plan")
    checked_entries = validate_note_entries(entries, planned["commits"])
    previous_tag_exists = commit_sha(root, f"refs/tags/v{previous_version}") == previous_sha
    return render_notes(checked_entries, repo, version, previous_version, previous_sha,
                        previous_tag_exists)


def read_entries_file(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"Cannot read release note entries from {path}: {error}") from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    plan = subcommands.add_parser("plan", help="Plan one release for all new mainline commits")
    plan.add_argument("--sha", required=True)
    plan.add_argument("--repo", required=True)
    plan.add_argument("--previous-version", required=True)
    plan.add_argument("--previous-sha", required=True)
    stamp = subcommands.add_parser("stamp", help="Stamp a build checkout with its release version")
    stamp.add_argument("version")
    notes = subcommands.add_parser("notes", help="Write GitHub Release notes from all planned commits")
    notes.add_argument("--sha", required=True)
    notes.add_argument("--repo", required=True)
    notes.add_argument("--version", required=True)
    notes.add_argument("--previous-version", required=True)
    notes.add_argument("--previous-sha", required=True)
    notes.add_argument("--entries-file", type=Path, required=True)
    notes.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path.cwd()
    try:
        if args.command == "plan":
            print(json.dumps(plan_release(root, args.sha, args.repo,
                                          args.previous_version, args.previous_sha), sort_keys=True))
        elif args.command == "stamp":
            stamp_version(root, args.version)
            print(f"Stamped Goalward {args.version}")
        else:
            text = release_notes(root, args.sha, args.repo, args.version,
                                 args.previous_version, args.previous_sha,
                                 read_entries_file(args.entries_file))
            args.output.write_text(text, encoding="utf-8")
            print(f"Wrote release notes to {args.output}")
    except (ReleaseError, OSError) as error:
        print(f"release.py: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

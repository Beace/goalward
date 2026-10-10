#!/usr/bin/env python3
"""Release tooling tests; all Git commits and version writes stay in temp dirs."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release  # noqa: E402


SOURCE_ROOT = Path(__file__).resolve().parent.parent


def run(root: Path, *args: str) -> str:
    return subprocess.check_output(args, cwd=root, text=True, stderr=subprocess.PIPE).strip()


class ReleaseTests(unittest.TestCase):
    def test_repository_tauri_dependencies_match_locked_rust_versions(self) -> None:
        package = json.loads((SOURCE_ROOT / "package.json").read_text(encoding="utf-8"))
        npm_lock = json.loads((SOURCE_ROOT / "package-lock.json").read_text(encoding="utf-8"))
        cargo_lock = tomllib.loads((SOURCE_ROOT / "src-tauri/Cargo.lock").read_text(encoding="utf-8"))
        rust_versions = {item["name"]: item["version"] for item in cargo_lock["package"]}
        rust_tauri_minor = rust_versions["tauri"].split(".")[:2]

        for name, dependencies in (("api", package["dependencies"]),
                                   ("cli", package["devDependencies"])):
            with self.subTest(package=f"@tauri-apps/{name}"):
                version = dependencies[f"@tauri-apps/{name}"]
                self.assertIsNotNone(re.fullmatch(r"\d+\.\d+\.\d+", version))
                self.assertEqual(version.split(".")[:2], rust_tauri_minor)
                self.assertEqual(
                    npm_lock["packages"][f"node_modules/@tauri-apps/{name}"]["version"], version
                )

        for name in ("dialog", "notification"):
            with self.subTest(package=f"@tauri-apps/plugin-{name}"):
                self.assertEqual(
                    package["dependencies"][f"@tauri-apps/plugin-{name}"],
                    rust_versions[f"tauri-plugin-{name}"],
                )

        for entry in npm_lock["packages"].values():
            if "resolved" in entry:
                self.assertTrue(entry["resolved"].startswith("https://registry.npmjs.org/"))

    def test_conventional_bumps_and_plain_commit(self) -> None:
        self.assertEqual(release.classify_commit("feat: add goals"), "minor")
        self.assertEqual(release.classify_commit("feat(tasks): add queue"), "minor")
        self.assertEqual(release.classify_commit("feat(tasks)!: replace state"), "major")
        self.assertEqual(release.classify_commit("fix: legacy", "BREAKING CHANGE: migration"), "major")
        self.assertEqual(release.classify_commit("fix: legacy", "BREAKING-CHANGE: migration"), "major")
        self.assertEqual(release.classify_commit("Fix desktop launch"), "patch")
        self.assertEqual(release.classify_commit("docs: explain install"), "patch")
        self.assertEqual(release.next_version("0.1.1", "major"), "1.0.0")
        self.assertEqual(release.next_version("0.1.1", "minor"), "0.2.0")
        self.assertEqual(release.next_version("0.1.1", "patch"), "0.1.2")
        with self.assertRaises(release.ReleaseError):
            release.next_version("01.1.1", "patch")

    def make_git_repo(self) -> tuple[tempfile.TemporaryDirectory, Path, str]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        run(root, "git", "init", "-b", "main")
        run(root, "git", "config", "user.name", "Test User")
        run(root, "git", "config", "user.email", "test@example.com")
        run(root, "git", "commit", "--allow-empty", "-m", "baseline")
        baseline = run(root, "git", "rev-parse", "HEAD")
        (root / ".github").mkdir()
        (root / ".github/release-baseline.json").write_text(
            json.dumps({"version": "0.1.1", "sha": baseline}), encoding="utf-8")
        return temporary, root, baseline

    def test_plan_one_squash_commit_and_existing_tag(self) -> None:
        temporary, root, baseline = self.make_git_repo()
        with temporary:
            run(root, "git", "commit", "--allow-empty", "-m", "feat(goals): make plans actionable")
            first = run(root, "git", "rev-parse", "HEAD")
            planned = release.plan_release(root, first, "Beace/goalward", "0.1.1", baseline)
            self.assertEqual(planned, {
                "has_changes": True,
                "version": "0.2.0", "previous_version": "0.1.1", "previous_sha": baseline,
                "target_sha": first, "bump": "minor",
                "commits": [{"sha": first, "subject": "feat(goals): make plans actionable"}],
            })
            run(root, "git", "tag", "v0.2.0", first)
            run(root, "git", "commit", "--allow-empty", "-m", "fix: restore navigation")
            second = run(root, "git", "rev-parse", "HEAD")
            planned = release.plan_release(root, second, "Beace/goalward", "0.2.0", first)
            self.assertEqual(planned["version"], "0.2.1")
            self.assertEqual(planned["previous_sha"], first)
            self.assertEqual(planned["commits"], [{"sha": second, "subject": "fix: restore navigation"}])

    def test_plan_batches_commits_using_highest_bump_once(self) -> None:
        temporary, root, baseline = self.make_git_repo()
        with temporary:
            run(root, "git", "commit", "--allow-empty", "-m", "fix: first")
            first = run(root, "git", "rev-parse", "HEAD")
            run(root, "git", "commit", "--allow-empty", "-m", "docs: second")
            second = run(root, "git", "rev-parse", "HEAD")
            patch_batch = release.plan_release(root, second, "Beace/goalward", "0.1.1", baseline)
            self.assertEqual(patch_batch["version"], "0.1.2")
            self.assertEqual(len(patch_batch["commits"]), 2)
            run(root, "git", "commit", "--allow-empty", "-m", "feat: third")
            third = run(root, "git", "rev-parse", "HEAD")
            planned = release.plan_release(root, third, "Beace/goalward", "0.1.1", baseline)
            self.assertEqual(planned["version"], "0.2.0")
            self.assertEqual(planned["previous_version"], "0.1.1")
            self.assertEqual(planned["previous_sha"], baseline)
            self.assertEqual(planned["bump"], "minor")
            self.assertEqual(planned["commits"], [
                {"sha": first, "subject": "fix: first"},
                {"sha": second, "subject": "docs: second"},
                {"sha": third, "subject": "feat: third"},
            ])
            run(root, "git", "commit", "--allow-empty", "-m", "fix: fourth",
                "-m", "BREAKING CHANGE: old files no longer load")
            fourth = run(root, "git", "rev-parse", "HEAD")
            planned = release.plan_release(root, fourth, "Beace/goalward", "0.1.1", baseline)
            self.assertEqual(planned["version"], "1.0.0")
            self.assertEqual(planned["bump"], "major")
            self.assertEqual(len(planned["commits"]), 4)

    def test_plan_no_changes_or_stale_target_does_not_publish(self) -> None:
        temporary, root, baseline = self.make_git_repo()
        with temporary:
            initial = release.plan_release(root, baseline, "Beace/goalward", "0.1.1", baseline)
            self.assertEqual(initial, {
                "has_changes": False, "version": "0.1.1", "previous_version": "0.1.1",
                "previous_sha": baseline, "target_sha": baseline, "bump": None, "commits": [],
            })
            run(root, "git", "commit", "--allow-empty", "-m", "feat: first")
            first = run(root, "git", "rev-parse", "HEAD")
            run(root, "git", "tag", "v0.2.0", first)
            run(root, "git", "commit", "--allow-empty", "-m", "fix: second")
            second = run(root, "git", "rev-parse", "HEAD")
            run(root, "git", "tag", "v0.2.1", second)
            self.assertFalse(release.plan_release(
                root, second, "Beace/goalward", "0.2.1", second)["has_changes"])
            stale = release.plan_release(root, first, "Beace/goalward", "0.2.1", second)
            self.assertFalse(stale["has_changes"])
            self.assertEqual(stale["version"], "0.2.1")
            self.assertEqual(stale["target_sha"], first)
            self.assertEqual(stale["previous_sha"], second)

    def test_plan_rejects_branch_and_merge_commits(self) -> None:
        temporary, root, baseline = self.make_git_repo()
        with temporary:
            run(root, "git", "switch", "-c", "other", baseline)
            run(root, "git", "commit", "--allow-empty", "-m", "fix: from branch")
            branch = run(root, "git", "rev-parse", "HEAD")
            with self.assertRaisesRegex(release.ReleaseError, "first-parent"):
                release.plan_release(root, branch, "Beace/goalward", "0.1.1", baseline)
            run(root, "git", "switch", "main")
            run(root, "git", "commit", "--allow-empty", "-m", "fix: on main")
            run(root, "git", "merge", "--no-ff", "other", "-m", "merge other")
            merged = run(root, "git", "rev-parse", "HEAD")
            with self.assertRaisesRegex(release.ReleaseError, "one first parent"):
                release.plan_release(root, merged, "Beace/goalward", "0.1.1", baseline)

    def test_plan_rejects_tag_disagreeing_with_commit_history(self) -> None:
        temporary, root, baseline = self.make_git_repo()
        with temporary:
            run(root, "git", "commit", "--allow-empty", "-m", "fix: first")
            target = run(root, "git", "rev-parse", "HEAD")
            run(root, "git", "tag", "v0.1.2", baseline)
            with self.assertRaisesRegex(release.ReleaseError, "disagrees"):
                release.plan_release(root, target, "Beace/goalward", "0.1.1", baseline)

    def test_plan_rejects_missing_previous_tag_and_skipped_release(self) -> None:
        temporary, root, baseline = self.make_git_repo()
        with temporary:
            run(root, "git", "commit", "--allow-empty", "-m", "feat: first")
            first = run(root, "git", "rev-parse", "HEAD")
            run(root, "git", "commit", "--allow-empty", "-m", "fix: second")
            second = run(root, "git", "rev-parse", "HEAD")
            with self.assertRaisesRegex(release.ReleaseError, "matching tag"):
                release.plan_release(root, second, "Beace/goalward", "0.2.0", first)
            run(root, "git", "tag", "v0.2.0", first)
            with self.assertRaisesRegex(release.ReleaseError, "unreleased commit"):
                release.plan_release(root, second, "Beace/goalward", "0.1.1", baseline)
            with self.assertRaisesRegex(release.ReleaseError, "baseline"):
                release.plan_release(root, second, "Beace/goalward", "0.2.0", baseline)

    def test_notes_match_screenshot_with_ordered_commits_and_tag_compare(self) -> None:
        temporary, root, baseline = self.make_git_repo()
        with temporary:
            run(root, "git", "commit", "--allow-empty", "-m", "feat: add [token]")
            first = run(root, "git", "rev-parse", "HEAD")
            run(root, "git", "commit", "--allow-empty", "-m", "fix: retain history")
            target = run(root, "git", "rev-parse", "HEAD")
            entries = [
                {"sha": first, "subject": "feat: add [token]", "pr_number": 7,
                 "pr_author": "Beace"},
                {"sha": target, "subject": "fix: retain history", "pr_number": 8,
                 "pr_author": "dependabot[bot]"},
            ]
            notes = release.release_notes(root, target, "Beace/goalward", "0.2.0",
                                          "0.1.1", baseline, entries)
            self.assertIn("## What's Changed", notes)
            self.assertIn("* feat: add \\[token\\] by @Beace in #7", notes)
            self.assertIn("* fix: retain history by @dependabot[bot] in #8", notes)
            self.assertIn(f"compare/{baseline}...v0.2.0", notes)
            self.assertIn(f"[{baseline[:7]}...v0.2.0]", notes)
            self.assertIn("not notarized", notes)
            run(root, "git", "tag", "v0.1.1", baseline)
            notes = release.release_notes(root, target, "Beace/goalward", "0.2.0",
                                          "0.1.1", baseline, entries)
            self.assertIn("compare/v0.1.1...v0.2.0", notes)
            self.assertIn("[v0.1.1...v0.2.0]", notes)
            with self.assertRaisesRegex(release.ReleaseError, "disagree"):
                release.release_notes(root, target, "Beace/goalward", "0.1.2",
                                      "0.1.1", baseline, entries)
            with self.assertRaisesRegex(release.ReleaseError, "ordered Git commits"):
                release.release_notes(root, target, "Beace/goalward", "0.2.0",
                                      "0.1.1", baseline, list(reversed(entries)))
            with self.assertRaisesRegex(release.ReleaseError, "PR number"):
                release.release_notes(root, target, "Beace/goalward", "0.2.0",
                                      "0.1.1", baseline,
                                      [entries[0], {**entries[1], "pr_number": True}])

    def test_plan_cli_emits_contract_json(self) -> None:
        temporary, root, baseline = self.make_git_repo()
        with temporary:
            run(root, "git", "commit", "--allow-empty", "-m", "fix: update docs")
            target = run(root, "git", "rev-parse", "HEAD")
            output = run(root, sys.executable, str(SOURCE_ROOT / "scripts/release.py"),
                         "plan", "--sha", target, "--repo", "Beace/goalward",
                         "--previous-version", "0.1.1", "--previous-sha", baseline)
            self.assertEqual(json.loads(output), {
                "has_changes": True,
                "version": "0.1.2", "previous_version": "0.1.1", "previous_sha": baseline,
                "target_sha": target, "bump": "patch",
                "commits": [{"sha": target, "subject": "fix: update docs"}],
            })
            entries_file = root / "entries.json"
            entries_file.write_text(json.dumps([{
                "sha": target, "subject": "fix: update docs", "pr_number": 3,
                "pr_author": "Beace",
            }]), encoding="utf-8")
            notes_file = root / "notes.md"
            run(root, sys.executable, str(SOURCE_ROOT / "scripts/release.py"),
                "notes", "--sha", target, "--repo", "Beace/goalward",
                "--version", "0.1.2", "--previous-version", "0.1.1",
                "--previous-sha", baseline, "--entries-file", str(entries_file),
                "--output", str(notes_file))
            self.assertIn("* fix: update docs by @Beace in #3", notes_file.read_text())

    def copy_version_files(self, root: Path) -> None:
        for relative in ("package.json", "package-lock.json", "src-tauri/tauri.conf.json",
                         "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"):
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SOURCE_ROOT / relative, destination)

    def test_stamp_only_temp_files_and_preserves_public_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.copy_version_files(root)
            original = (SOURCE_ROOT / "package.json").read_bytes()
            release.stamp_version(root, "0.1.2")
            self.assertEqual(json.loads((root / "package.json").read_text())["version"], "0.1.2")
            npm_lock = json.loads((root / "package-lock.json").read_text())
            self.assertEqual(npm_lock["version"], "0.1.2")
            self.assertEqual(npm_lock["packages"][""]["version"], "0.1.2")
            self.assertEqual(json.loads((root / "src-tauri/tauri.conf.json").read_text())["version"], "0.1.2")
            self.assertEqual(tomllib.loads((root / "src-tauri/Cargo.toml").read_text())["package"]["version"], "0.1.2")
            cargo_lock = tomllib.loads((root / "src-tauri/Cargo.lock").read_text())
            self.assertEqual(next(item["version"] for item in cargo_lock["package"]
                                  if item["name"] == "goalward"), "0.1.2")
            release.validate_public_lock(npm_lock)
            self.assertEqual((SOURCE_ROOT / "package.json").read_bytes(), original)

    def test_stamp_rejects_private_registry_without_writing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.copy_version_files(root)
            path = root / "package-lock.json"
            npm_lock = json.loads(path.read_text())
            dependency = next(value for value in npm_lock["packages"].values()
                              if value.get("resolved"))
            dependency["resolved"] = "https://bnpm.byted.org/private-package.tgz"
            path.write_text(json.dumps(npm_lock), encoding="utf-8")
            before = {name: (root / name).read_bytes() for name in (
                "package.json", "package-lock.json", "src-tauri/tauri.conf.json",
                "src-tauri/Cargo.toml", "src-tauri/Cargo.lock")}
            with self.assertRaisesRegex(release.ReleaseError, "non-public"):
                release.stamp_version(root, "0.1.2")
            for name, data in before.items():
                self.assertEqual((root / name).read_bytes(), data)


if __name__ == "__main__":
    unittest.main()

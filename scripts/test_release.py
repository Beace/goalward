#!/usr/bin/env python3
"""Release tooling tests; all Git commits and version writes stay in temp dirs."""

from __future__ import annotations

import json
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
            planned = release.plan_release(root, first, "Beace/goalward")
            self.assertEqual(planned, {
                "version": "0.2.0", "previous_version": "0.1.1", "previous_sha": baseline,
                "target_sha": first, "bump": "minor",
                "subject": "feat(goals): make plans actionable",
            })
            run(root, "git", "tag", "v0.2.0", first)
            run(root, "git", "commit", "--allow-empty", "-m", "fix: restore navigation")
            second = run(root, "git", "rev-parse", "HEAD")
            planned = release.plan_release(root, second, "Beace/goalward")
            self.assertEqual(planned["version"], "0.2.1")
            self.assertEqual(planned["previous_sha"], first)
            self.assertEqual(planned["subject"], "fix: restore navigation")

    def test_plan_accumulates_versions_without_waiting_for_tags(self) -> None:
        temporary, root, baseline = self.make_git_repo()
        with temporary:
            run(root, "git", "commit", "--allow-empty", "-m", "fix: first")
            first = run(root, "git", "rev-parse", "HEAD")
            run(root, "git", "commit", "--allow-empty", "-m", "fix: second")
            second = run(root, "git", "rev-parse", "HEAD")
            planned = release.plan_release(root, second, "Beace/goalward")
            self.assertEqual(planned["version"], "0.1.3")
            self.assertEqual(planned["previous_version"], "0.1.2")
            self.assertEqual(planned["previous_sha"], first)
            run(root, "git", "switch", "-c", "other", baseline)
            run(root, "git", "commit", "--allow-empty", "-m", "fix: from branch")
            branch = run(root, "git", "rev-parse", "HEAD")
            with self.assertRaisesRegex(release.ReleaseError, "first-parent"):
                release.plan_release(root, branch, "Beace/goalward")

    def test_plan_rejects_tag_disagreeing_with_commit_history(self) -> None:
        temporary, root, _ = self.make_git_repo()
        with temporary:
            run(root, "git", "commit", "--allow-empty", "-m", "fix: first")
            target = run(root, "git", "rev-parse", "HEAD")
            run(root, "git", "tag", "v0.2.0", target)
            with self.assertRaisesRegex(release.ReleaseError, "disagrees"):
                release.plan_release(root, target, "Beace/goalward")

    def test_notes_match_screenshot_with_commit_or_tag_compare(self) -> None:
        temporary, root, baseline = self.make_git_repo()
        with temporary:
            run(root, "git", "commit", "--allow-empty", "-m", "feat: add token")
            target = run(root, "git", "rev-parse", "HEAD")
            notes = release.release_notes(root, target, "Beace/goalward", "0.2.0",
                                          "0.1.1", baseline, 7, "Beace")
            self.assertIn("## What's Changed", notes)
            self.assertIn("* feat: add token by @Beace in #7", notes)
            self.assertIn(f"compare/{baseline}...v0.2.0", notes)
            self.assertIn(f"[{baseline[:7]}...v0.2.0]", notes)
            self.assertIn("not notarized", notes)
            run(root, "git", "tag", "v0.1.1", baseline)
            notes = release.release_notes(root, target, "Beace/goalward", "0.2.0",
                                          "0.1.1", baseline, 7, "dependabot[bot]")
            self.assertIn("by @dependabot[bot] in #7", notes)
            self.assertIn("compare/v0.1.1...v0.2.0", notes)
            self.assertIn("[v0.1.1...v0.2.0]", notes)
            with self.assertRaisesRegex(release.ReleaseError, "disagree"):
                release.release_notes(root, target, "Beace/goalward", "0.1.2",
                                      "0.1.1", baseline, 7, "Beace")

    def test_plan_cli_emits_contract_json(self) -> None:
        temporary, root, baseline = self.make_git_repo()
        with temporary:
            run(root, "git", "commit", "--allow-empty", "-m", "fix: update docs")
            target = run(root, "git", "rev-parse", "HEAD")
            output = run(root, sys.executable, str(SOURCE_ROOT / "scripts/release.py"),
                         "plan", "--sha", target, "--repo", "Beace/goalward")
            self.assertEqual(json.loads(output), {
                "version": "0.1.2", "previous_version": "0.1.1", "previous_sha": baseline,
                "target_sha": target, "bump": "patch", "subject": "fix: update docs",
            })

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

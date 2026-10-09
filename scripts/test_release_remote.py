"""Offline GitHub/Git subprocess fixtures for scheduled release state checks."""

from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_remote  # noqa: E402


BASE_SHA = "a" * 40
OLD_SHA = "b" * 40
NEW_SHA = "c" * 40
OTHER_SHA = "d" * 40
REPO = "Beace/goalward"


def entry(tag: str, *, draft: bool, target: str = NEW_SHA,
          prerelease: bool = True) -> dict:
    return {
        "tag_name": tag,
        "draft": draft,
        "target_commitish": target,
        "prerelease": prerelease,
    }


class FakeRemote:
    def __init__(self, pages: list[list[dict]], tags: dict[str, tuple[str, str | None]] | None = None,
                 invalid_commit_shas: set[str] | None = None):
        self.pages = pages
        self.tags = tags or {}
        self.invalid_commit_shas = invalid_commit_shas or set()
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, args: tuple[str, ...], **kwargs) -> subprocess.CompletedProcess:
        self.calls.append(args)
        if args[:2] == ("gh", "api"):
            prefix = f"repos/{REPO}/releases?per_page=100&page="
            if len(args) != 3 or not args[2].startswith(prefix):
                raise AssertionError(f"Unexpected GitHub command: {args}")
            page = int(args[2].removeprefix(prefix))
            items = self.pages[page - 1] if page <= len(self.pages) else []
            return subprocess.CompletedProcess(args, 0, json.dumps(items), "")
        if args[:3] == ("git", "ls-remote", "--tags"):
            if len(args) != 6 or args[3] != "origin":
                raise AssertionError(f"Unexpected Git command: {args}")
            ref, peeled = args[4:]
            if peeled != f"{ref}^{{}}":
                raise AssertionError(f"Unexpected tag refs: {args}")
            tag = ref.removeprefix("refs/tags/")
            remote = self.tags.get(tag)
            if remote is None:
                return subprocess.CompletedProcess(args, 0, "", "")
            object_sha, commit_sha = remote
            lines = [f"{object_sha}\t{ref}"]
            if commit_sha is not None:
                lines.append(f"{commit_sha}\t{peeled}")
            return subprocess.CompletedProcess(args, 0, "\n".join(lines) + "\n", "")
        if args[:3] == ("git", "rev-parse", "--verify") and len(args) == 4:
            sha = args[3].removesuffix("^{commit}")
            if args[3] != f"{sha}^{{commit}}":
                raise AssertionError(f"Unexpected Git revision: {args}")
            if sha in self.invalid_commit_shas:
                return subprocess.CompletedProcess(args, 1, "", "not a commit")
            return subprocess.CompletedProcess(args, 0, f"{sha}\n", "")
        raise AssertionError(f"Unexpected command: {args}")


class RemoteReleaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.baseline = Path(self.temporary.name) / "release-baseline.json"
        self.baseline.write_text(
            json.dumps({"version": "0.1.1", "sha": BASE_SHA}), encoding="utf-8"
        )

    def test_draft_is_not_an_anchor(self) -> None:
        fake = FakeRemote([[entry("v0.2.0", draft=True)]])
        with patch.object(release_remote.subprocess, "run", side_effect=fake):
            anchor = release_remote.release_anchor(REPO, self.baseline)
        self.assertEqual(anchor, {"version": "0.1.1", "sha": BASE_SHA, "tag": None})
        self.assertFalse(any(call[0] == "git" for call in fake.calls))

    def test_published_versions_older_than_baseline_are_ignored(self) -> None:
        fake = FakeRemote([[entry("v0.0.9", draft=False, target=OLD_SHA)]])
        with patch.object(release_remote.subprocess, "run", side_effect=fake):
            anchor = release_remote.release_anchor(REPO, self.baseline)
        self.assertEqual(anchor, {"version": "0.1.1", "sha": BASE_SHA, "tag": None})
        self.assertFalse(any(call[0] == "git" for call in fake.calls))

    def test_published_baseline_must_have_matching_tag_sha(self) -> None:
        published = FakeRemote([[entry("v0.1.1", draft=False, target=BASE_SHA)]],
                               {"v0.1.1": (BASE_SHA, None)})
        with patch.object(release_remote.subprocess, "run", side_effect=published):
            self.assertEqual(release_remote.release_anchor(REPO, self.baseline),
                             {"version": "0.1.1", "sha": BASE_SHA, "tag": "v0.1.1"})
        mismatched = FakeRemote([[entry("v0.1.1", draft=False, target=OLD_SHA)]],
                                {"v0.1.1": (OLD_SHA, None)})
        with patch.object(release_remote.subprocess, "run", side_effect=mismatched):
            with self.assertRaisesRegex(release_remote.RemoteReleaseError,
                                        "differs from its baseline SHA"):
                release_remote.release_anchor(REPO, self.baseline)

    def test_highest_published_semver_including_prerelease_across_pages(self) -> None:
        first_page = [entry(f"legacy-{number}", draft=False) for number in range(99)]
        first_page.append(entry("v0.1.2", draft=False, target=OLD_SHA, prerelease=False))
        second_page = [
            entry("v0.9.9", draft=True),
            entry("v0.2.0", draft=False, target=NEW_SHA, prerelease=True),
        ]
        fake = FakeRemote([first_page, second_page], {"v0.2.0": (OTHER_SHA, NEW_SHA)})
        with patch.object(release_remote.subprocess, "run", side_effect=fake):
            anchor = release_remote.release_anchor(REPO, self.baseline)
        self.assertEqual(anchor, {"version": "0.2.0", "sha": NEW_SHA, "tag": "v0.2.0"})
        self.assertEqual(sum(call[:2] == ("gh", "api") for call in fake.calls), 2)
        self.assertIn(("git", "ls-remote", "--tags", "origin",
                       "refs/tags/v0.2.0", "refs/tags/v0.2.0^{}"), fake.calls)

    def test_published_release_without_tag_fails_closed(self) -> None:
        fake = FakeRemote([[entry("v0.2.0", draft=False)]])
        with patch.object(release_remote.subprocess, "run", side_effect=fake):
            with self.assertRaisesRegex(release_remote.RemoteReleaseError, "no remote Git tag"):
                release_remote.release_anchor(REPO, self.baseline)

    def test_published_release_tag_target_mismatch_fails_closed(self) -> None:
        fake = FakeRemote(
            [[entry("v0.2.0", draft=False, target=NEW_SHA)]],
            {"v0.2.0": (OLD_SHA, None)},
        )
        with patch.object(release_remote.subprocess, "run", side_effect=fake):
            with self.assertRaisesRegex(release_remote.RemoteReleaseError, "target differs"):
                release_remote.release_anchor(REPO, self.baseline)

    def test_tag_must_peel_to_a_commit(self) -> None:
        fake = FakeRemote([[entry("v0.2.0", draft=False)]],
                          {"v0.2.0": (OTHER_SHA, NEW_SHA)}, {NEW_SHA})
        with patch.object(release_remote.subprocess, "run", side_effect=fake):
            with self.assertRaisesRegex(release_remote.RemoteReleaseError, "rev-parse"):
                release_remote.release_anchor(REPO, self.baseline)

    def test_verify_anchor_rechecks_remote_state(self) -> None:
        fake = FakeRemote([[entry("v0.2.0", draft=False)]],
                          {"v0.2.0": (NEW_SHA, None)})
        with patch.object(release_remote.subprocess, "run", side_effect=fake):
            self.assertEqual(
                release_remote.verify_anchor(REPO, self.baseline, "0.2.0", NEW_SHA)["sha"],
                NEW_SHA,
            )
            with self.assertRaisesRegex(release_remote.RemoteReleaseError, "anchor changed"):
                release_remote.verify_anchor(REPO, self.baseline, "0.1.1", BASE_SHA)

    def test_candidate_available_but_orphan_tag_is_rejected(self) -> None:
        available = FakeRemote([[]])
        with patch.object(release_remote.subprocess, "run", side_effect=available):
            self.assertEqual(
                release_remote.check_candidate(REPO, "v0.2.0", NEW_SHA, "0.1.1"),
                {"tag": "v0.2.0", "status": "available"},
            )
        orphan = FakeRemote([[]], {"v0.2.0": (NEW_SHA, None)})
        with patch.object(release_remote.subprocess, "run", side_effect=orphan):
            with self.assertRaisesRegex(release_remote.RemoteReleaseError, "without a Release"):
                release_remote.check_candidate(REPO, "v0.2.0", NEW_SHA, "0.1.1")

    def test_only_matching_draft_can_be_reused(self) -> None:
        draft = FakeRemote([[entry("v0.2.0", draft=True, target=NEW_SHA)]],
                           {"v0.2.0": (OTHER_SHA, NEW_SHA)})
        with patch.object(release_remote.subprocess, "run", side_effect=draft):
            self.assertEqual(
                release_remote.check_candidate(REPO, "v0.2.0", NEW_SHA, "0.1.1")["status"],
                "matching-draft",
            )
        wrong_draft = FakeRemote([[entry("v0.2.0", draft=True, target=OLD_SHA)]])
        with patch.object(release_remote.subprocess, "run", side_effect=wrong_draft):
            with self.assertRaisesRegex(release_remote.RemoteReleaseError, "different commit"):
                release_remote.check_candidate(REPO, "v0.2.0", NEW_SHA, "0.1.1")
        wrong_tag = FakeRemote([[entry("v0.2.0", draft=True, target=NEW_SHA)]],
                               {"v0.2.0": (OLD_SHA, None)})
        with patch.object(release_remote.subprocess, "run", side_effect=wrong_tag):
            with self.assertRaisesRegex(release_remote.RemoteReleaseError, "Git tag targets"):
                release_remote.check_candidate(REPO, "v0.2.0", NEW_SHA, "0.1.1")

    def test_unresolved_newer_draft_blocks_a_different_candidate(self) -> None:
        unresolved = FakeRemote([[entry("v0.1.2", draft=True, target=OLD_SHA)]])
        with patch.object(release_remote.subprocess, "run", side_effect=unresolved):
            with self.assertRaisesRegex(release_remote.RemoteReleaseError,
                                        "inspect that draft manually"):
                release_remote.check_candidate(REPO, "v0.2.0", NEW_SHA, "0.1.1")
        # The pre-existing v0.1.1 draft is the baseline, not an interrupted
        # release in the range we are attempting to publish.
        baseline_draft = FakeRemote([[entry("v0.1.1", draft=True, target=BASE_SHA)]])
        with patch.object(release_remote.subprocess, "run", side_effect=baseline_draft):
            self.assertEqual(
                release_remote.check_candidate(REPO, "v0.2.0", NEW_SHA, "0.1.1")["status"],
                "available",
            )

    def test_prebuild_option_rejects_assets_in_matching_draft(self) -> None:
        empty_draft = entry("v0.2.0", draft=True, target=NEW_SHA)
        empty_draft["assets"] = []
        fake = FakeRemote([[empty_draft]])
        with patch.object(release_remote.subprocess, "run", side_effect=fake):
            self.assertEqual(
                release_remote.check_candidate(
                    REPO, "v0.2.0", NEW_SHA, "0.1.1", fail_on_assets=True
                )["status"],
                "matching-draft",
            )
        with_assets = entry("v0.2.0", draft=True, target=NEW_SHA)
        with_assets["assets"] = [{"name": "BUILD-INFO.json"}]
        fake = FakeRemote([[with_assets]])
        with patch.object(release_remote.subprocess, "run", side_effect=fake):
            with self.assertRaisesRegex(release_remote.RemoteReleaseError,
                                        "inspect the old draft and original build artifacts"):
                release_remote.check_candidate(
                    REPO, "v0.2.0", NEW_SHA, "0.1.1", fail_on_assets=True
                )
            # The publish job deliberately keeps the existing asset-verification path.
            self.assertEqual(
                release_remote.check_candidate(REPO, "v0.2.0", NEW_SHA, "0.1.1")["status"],
                "matching-draft",
            )

    def test_published_candidate_is_never_reused(self) -> None:
        published = FakeRemote([[entry("v0.2.0", draft=False, target=NEW_SHA)]],
                               {"v0.2.0": (NEW_SHA, None)})
        with patch.object(release_remote.subprocess, "run", side_effect=published):
            with self.assertRaisesRegex(release_remote.RemoteReleaseError, "already been published"):
                release_remote.check_candidate(REPO, "v0.2.0", NEW_SHA, "0.1.1")

    def test_invalid_or_partial_api_result_fails_closed(self) -> None:
        with patch.object(release_remote.subprocess, "run", return_value=subprocess.CompletedProcess(
            ["gh", "api"], 0, '{"message":"rate limited"}', ""
        )):
            with self.assertRaisesRegex(release_remote.RemoteReleaseError, "Expected a Release list"):
                release_remote.release_anchor(REPO, self.baseline)

    def test_cli_anchor_outputs_machine_readable_json(self) -> None:
        fake = FakeRemote([[]])
        output = io.StringIO()
        with patch.object(release_remote.subprocess, "run", side_effect=fake), \
             patch.object(sys, "argv", ["release_remote.py", "anchor", "--repo", REPO,
                                       "--baseline", str(self.baseline)]), \
             contextlib.redirect_stdout(output):
            self.assertEqual(release_remote.main(), 0)
        self.assertEqual(json.loads(output.getvalue()),
                         {"version": "0.1.1", "sha": BASE_SHA, "tag": None})

    def test_cli_fail_on_assets_switch(self) -> None:
        draft = entry("v0.2.0", draft=True, target=NEW_SHA)
        draft["assets"] = [{"name": "old-build.dmg"}]
        fake = FakeRemote([[draft]])
        errors = io.StringIO()
        with patch.object(release_remote.subprocess, "run", side_effect=fake), \
             patch.object(sys, "argv", ["release_remote.py", "check-candidate", "--repo", REPO,
                                       "--tag", "v0.2.0", "--target", NEW_SHA,
                                       "--anchor-version", "0.1.1", "--fail-on-assets"]), \
             contextlib.redirect_stderr(errors):
            self.assertEqual(release_remote.main(), 1)
        self.assertIn("inspect the old draft", errors.getvalue())


if __name__ == "__main__":
    unittest.main()

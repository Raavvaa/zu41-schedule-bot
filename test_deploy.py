"""Offline setup tests: fake GitHub API, no real keys or network requests."""
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import deploy

VALUES = {
    "TELEGRAM_BOT_TOKEN": "telegram-test-value",
    "TELEGRAM_CHAT_ID": "1234567890",
    "GROQ_API_KEY": "groq-test-value",
}


def prepare(root):
    for name in deploy.PUBLIC_FILES:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("Public test content\n", encoding="utf-8")
    secret = root / "zu41_private.env"
    secret.write_text("\n".join(f"{k}={v}" for k, v in VALUES.items()) + "\n", encoding="utf-8")
    return secret


class FakeCLI:
    instances = []
    existing_paths = {"README.md": "old-blob"}
    fail_dispatch = False
    login_name = deploy.OWNER

    def __init__(self, executable, private_values):
        self.calls = []
        self.repo_exists = False
        self.instances.append(self)

    def login(self):
        self.calls.append(("login",))

    def run(self, args, data=None):
        self.calls.append(("run", args, data))
        if args[:2] == ["repo", "create"]:
            self.repo_exists = True
        if args[:2] == ["workflow", "run"] and self.fail_dispatch:
            raise deploy.ApiError("Dispatch network failure")
        return ""

    def api(self, endpoint, method="GET", payload=None):
        self.calls.append(("api", endpoint, method, payload))
        base = f"repos/{deploy.REPOSITORY}"
        if endpoint == "user":
            return {"login": self.login_name}
        if endpoint == base:
            if not self.repo_exists:
                raise deploy.ApiError("not found", 404)
            return {"private": False, "default_branch": "main", "size": 1}
        if endpoint.endswith("/git/ref/heads/main"):
            return {"object": {"sha": "head"}}
        if endpoint.endswith("/git/commits/head"):
            return {"tree": {"sha": "base-tree"}}
        if endpoint.endswith("/git/trees/base-tree?recursive=1"):
            return {"tree": [{"path": k, "sha": v, "type": "blob"}
                             for k, v in self.existing_paths.items()]}
        if endpoint.endswith("/git/trees") and method == "POST":
            return {"sha": "new-tree"}
        if endpoint.endswith("/git/commits") and method == "POST":
            return {"sha": "new-commit"}
        if endpoint.endswith("/git/refs/heads/main") and method == "PATCH":
            return {}
        if endpoint.endswith("/actions/workflows/schedule.yml"):
            return {"state": "active"}
        raise AssertionError(f"Unexpected API operation: {method} {endpoint}")


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        FakeCLI.instances = []
        FakeCLI.existing_paths = {"README.md": "old-blob"}
        FakeCLI.fail_dispatch = False
        FakeCLI.login_name = deploy.OWNER

    def test_loads_three_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = prepare(Path(tmp))
            self.assertEqual(deploy.load_secrets(path), VALUES)

    def test_rejects_unknown_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = prepare(Path(tmp))
            path.write_text(path.read_text() + "UNRELATED_KEY=do-not-upload\n")
            with self.assertRaises(deploy.SetupError):
                deploy.load_secrets(path)

    def test_rejects_duplicate_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = prepare(Path(tmp))
            path.write_text(path.read_text() + "TELEGRAM_CHAT_ID=another-value\n")
            with self.assertRaises(deploy.SetupError):
                deploy.load_secrets(path)

    def test_private_file_is_never_in_allowlist(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            prepare(root)
            files = deploy.public_contents(root, VALUES)
            self.assertEqual(set(files), set(deploy.PUBLIC_FILES))
            self.assertNotIn("zu41_private.env", files)

    def test_blocks_secret_in_public_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            prepare(root)
            (root / "bot.py").write_text(VALUES["GROQ_API_KEY"])
            with self.assertRaises(deploy.SetupError):
                deploy.public_contents(root, VALUES)

    def test_matches_git_blob_hash(self):
        self.assertEqual(deploy.git_blob_sha(""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")

    def run_fake(self, root, secret):
        with patch.object(deploy, "GitHubCLI", FakeCLI), \
             patch.object(deploy.shutil, "which", return_value="/fake/gh"), \
             redirect_stdout(StringIO()):
            deploy.deployment(root, secret)

    def test_one_atomic_commit_and_separate_secret_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = prepare(root)
            self.run_fake(root, secret)
        calls = FakeCLI.instances[-1].calls
        secret_calls = [c for c in calls if c[0] == "run" and c[1][:2] == ["secret", "set"]]
        self.assertEqual(len(secret_calls), 1)
        self.assertEqual(secret_calls[0][1][-2:], ["--env-file", "-"])
        for value in VALUES.values():
            self.assertIn(value, secret_calls[0][2])
        api_calls = [c for c in calls if c[0] == "api"]
        for value in VALUES.values():
            self.assertNotIn(value, str(api_calls))
        writes = [c for c in api_calls if c[2] == "PATCH"]
        self.assertEqual(len(writes), 1)
        self.assertFalse(writes[0][3]["force"])

    def test_unrelated_repository_is_not_overwritten(self):
        FakeCLI.existing_paths = {"other-project.py": "hash"}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = prepare(root)
            with self.assertRaises(deploy.SetupError):
                self.run_fake(root, secret)
        calls = FakeCLI.instances[-1].calls
        self.assertFalse(any(c[0] == "api" and c[2] != "GET" for c in calls))
        self.assertFalse(any(c[0] == "run" and c[1][:2] == ["secret", "set"] for c in calls))

    def test_dispatch_is_not_retried(self):
        FakeCLI.fail_dispatch = True
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = prepare(root)
            with self.assertRaises(deploy.ApiError):
                self.run_fake(root, secret)
        calls = FakeCLI.instances[-1].calls
        self.assertEqual(sum(c[0] == "run" and c[1][:2] == ["workflow", "run"] for c in calls), 1)

    def test_wrong_account_is_not_modified(self):
        FakeCLI.login_name = "someone-else"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = prepare(root)
            with self.assertRaises(deploy.SetupError):
                self.run_fake(root, secret)
        calls = FakeCLI.instances[-1].calls
        self.assertFalse(any(c[0] == "run" and c[1][:2] == ["repo", "create"] for c in calls))


if __name__ == "__main__":
    unittest.main()

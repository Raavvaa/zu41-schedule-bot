"""Publish this bot and import Secrets using the user's local GitHub CLI login.

Requires Python 3.10+ and GitHub CLI (gh). Git is not required.
No GitHub token is requested in chat, put in source files, or printed.
Default: python deploy.py
Optional: python deploy.py --secrets /path/to/zu41_private.env --update
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from typing import Any
from urllib.parse import quote

OWNER = "Raavvaa"
REPOSITORY = f"{OWNER}/zu41-schedule-bot"
PUBLIC_FILES = (
    "README.md", ".gitignore", "requirements.txt", "bot.py", "test_bot.py",
    ".github/workflows/schedule.yml", "deploy.py", "test_deploy.py",
    "setup-secrets.sh", "START_HERE.md",
)
REQUIRED_SECRETS = ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GROQ_API_KEY")
TOKEN_PATTERN = re.compile(r"(?:gsk_[A-Za-z0-9]{24,}|\b\d{6,14}:[A-Za-z0-9_-]{25,})")


class SetupError(RuntimeError):
    pass


class ApiError(SetupError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def load_secrets(path: Path) -> dict[str, str]:
    """Read data, not shell code. Only the three bot values can be imported."""
    values: dict[str, str] = {}
    for original in path.read_text(encoding="utf-8-sig").splitlines():
        line = original.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise SetupError("Неверный формат файла ключей: нужны строки NAME=value.")
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if key not in REQUIRED_SECRETS:
            raise SetupError("В файле ключей есть неизвестная переменная. Нужны только три ключа бота.")
        if key in values:
            raise SetupError(f"Переменная {key} записана дважды.")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not value or any(c in value for c in ("\n", "\r", "\x00")):
            raise SetupError(f"Переменная {key} пустая или имеет неверный формат.")
        values[key] = value
    if set(values) != set(REQUIRED_SECRETS):
        raise SetupError("В файле нужны TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID и GROQ_API_KEY.")
    return values


def public_contents(root: Path, secrets: dict[str, str]) -> dict[str, str]:
    """Use an explicit allowlist, never upload a whole directory or private .env."""
    result = {}
    for name in PUBLIC_FILES:
        path = root / name
        if not path.is_file() or path.is_symlink() or root.resolve() not in path.resolve().parents:
            raise SetupError(f"Не найден обычный файл проекта: {name}")
        text = path.read_text(encoding="utf-8-sig")
        if TOKEN_PATTERN.search(text) or any(value in text for value in secrets.values()):
            raise SetupError(f"В {name} обнаружены приватные данные. Публикация остановлена.")
        result[name] = text
    return result


def git_blob_sha(text: str) -> str:
    data = text.encode("utf-8")
    return hashlib.sha1(f"blob {len(data)}\0".encode("ascii") + data).hexdigest()


class GitHubCLI:
    def __init__(self, executable: str, private_values: dict[str, str]):
        self.executable = executable
        self.private_values = tuple(private_values.values())
        self.env = dict(os.environ, GH_HOST="github.com", GH_PROMPT_DISABLED="1")

    def redact(self, text: str) -> str:
        for value in self.private_values:
            text = text.replace(value, "[скрыто]")
        return text

    def run(self, args: list[str], data: str | None = None) -> str:
        try:
            completed = subprocess.run(
                [self.executable, *args], input=data, text=True, encoding="utf-8",
                errors="replace", capture_output=True, timeout=90, env=self.env,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SetupError(f"GitHub CLI: {type(error).__name__}. Проверь интернет и установку gh.") from None
        if completed.returncode:
            detail = self.redact(completed.stderr + "\n" + completed.stdout).strip()
            match = re.search(r"HTTP\s+(\d{3})", detail)
            if match:
                status = int(match.group(1))
            else:
                try:
                    status = int(json.loads(completed.stdout).get("status"))
                except (ValueError, TypeError, AttributeError):
                    status = None
            raise ApiError(detail[:1200] or "Команда gh завершилась с ошибкой.", status)
        return completed.stdout.strip()

    def api(self, endpoint: str, method: str = "GET", payload: Any = None) -> Any:
        args = ["api", "--hostname", "github.com", "--method", method, endpoint]
        body = None
        if payload is not None:
            args += ["--input", "-"]
            body = json.dumps(payload, ensure_ascii=True)
        result = self.run(args, body)
        return json.loads(result) if result else None

    def login(self) -> None:
        env = dict(os.environ)
        env.pop("GH_PROMPT_DISABLED", None)
        result = subprocess.run(
            [self.executable, "auth", "login", "--hostname", "github.com", "--web",
             "--git-protocol", "https", "--scopes", "workflow"], env=env,
        )
        if result.returncode:
            raise SetupError("Вход в GitHub не завершён. Никакие файлы ещё не опубликованы.")


def deployment(root: Path, private_path: Path, update: bool = False) -> None:
    secrets = load_secrets(private_path)
    files = public_contents(root, secrets)
    executable = shutil.which("gh")
    if not executable and os.name == "nt":
        candidate = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "GitHub CLI/gh.exe"
        if candidate.is_file():
            executable = str(candidate)
    if not executable:
        raise SetupError(
            "Нужен GitHub CLI. Windows: winget install --id GitHub.cli --exact\n"
            "После установки снова запусти этот скрипт. Другие системы: https://cli.github.com/"
        )
    gh = GitHubCLI(executable, secrets)
    print(f"Цель: {REPOSITORY} (ПУБЛИЧНЫЙ репозиторий).")
    print("Загружаются только файлы кода. Ключи передаются отдельно в GitHub Secrets.")
    try:
        gh.run(["auth", "status", "--hostname", "github.com"])
    except ApiError:
        gh.login()
    profile = gh.api("user")
    if profile["login"].casefold() != OWNER.casefold():
        raise SetupError(
            f"В gh выбран другой аккаунт. Выполни gh auth switch --hostname github.com --user {OWNER}."
        )
    endpoint = f"repos/{REPOSITORY}"
    created = False
    try:
        repo = gh.api(endpoint)
    except ApiError as error:
        if error.status != 404:
            raise
        gh.run([
            "repo", "create", REPOSITORY, "--public", "--add-readme",
            "--description", "Morning timetable for MKGiK ZU-41/23; Telegram and optional Groq",
        ])
        repo = gh.api(endpoint)
        created = True
    if repo.get("private"):
        raise SetupError("Этот репозиторий приватный. Скрипт не меняет его видимость автоматически.")
    if repo.get("archived"):
        raise SetupError("Репозиторий архивирован. Скрипт не меняет чужие настройки.")
    branch = repo["default_branch"]
    branch_path = quote(branch, safe="")
    try:
        head = gh.api(f"{endpoint}/git/ref/heads/{branch_path}")["object"]["sha"]
    except ApiError as error:
        if error.status not in (404, 409) or repo.get("size", 0) != 0:
            raise
        # A previously created empty target repository has no Git objects yet.
        import base64
        initial = base64.b64encode(b"# zu41-schedule-bot\n").decode("ascii")
        gh.api(f"{endpoint}/contents/README.md", "PUT", {
            "message": "Initialize timetable repository", "content": initial, "branch": branch,
        })
        head = gh.api(f"{endpoint}/git/ref/heads/{branch_path}")["object"]["sha"]
    commit = gh.api(f"{endpoint}/git/commits/{head}")
    base_tree = commit["tree"]["sha"]
    tree = gh.api(f"{endpoint}/git/trees/{base_tree}?recursive=1")
    if tree.get("truncated"):
        raise SetupError("Слишком большой существующий репозиторий: публикация остановлена.")
    remote = {item["path"]: item["sha"] for item in tree["tree"] if item["type"] != "tree"}
    unrelated = set(remote) - set(PUBLIC_FILES)
    if unrelated:
        raise SetupError("В целевом репозитории есть посторонние файлы. Они не будут изменены.")
    changed = {name: text for name, text in files.items() if remote.get(name) != git_blob_sha(text)}
    initialized_only = set(remote).issubset({"README.md"})
    if changed and not created and not initialized_only and not update:
        raise SetupError(
            "В репозитории уже есть другая версия бота. Для её осознанного обновления добавь --update."
        )
    # Never send secrets to contents/git APIs; gh encrypts them using the repo key.
    secret_input = "\n".join(f"{name}={secrets[name]}" for name in REQUIRED_SECRETS) + "\n"
    gh.run(["secret", "set", "--repo", REPOSITORY, "--env-file", "-"], secret_input)
    print("Три значения сохранены в GitHub Secrets.")
    if changed:
        tree_result = gh.api(f"{endpoint}/git/trees", "POST", {
            "base_tree": base_tree,
            "tree": [{"path": name, "mode": "100644", "type": "blob", "content": text}
                     for name, text in changed.items()],
        })
        new_commit = gh.api(f"{endpoint}/git/commits", "POST", {
            "message": "Configure ZU-41 morning schedule bot",
            "tree": tree_result["sha"], "parents": [head],
        })
        gh.api(f"{endpoint}/git/refs/heads/{branch_path}", "PATCH", {
            "sha": new_commit["sha"], "force": False,
        })
        print("Код и расписание запуска опубликованы одним коммитом.")
    else:
        print("Файлы уже совпадают; повторный коммит не нужен.")
    workflow_endpoint = f"{endpoint}/actions/workflows/schedule.yml"
    workflow = None
    for attempt in range(10):
        try:
            workflow = gh.api(workflow_endpoint)
            break
        except ApiError as error:
            if error.status != 404:
                raise
            if attempt < 9:
                time.sleep(2)
    if not workflow:
        raise SetupError(
            "Код и Secrets сохранены, но GitHub ещё не обнаружил workflow. Открой Actions и запусти вручную."
        )
    if workflow.get("state") != "active":
        gh.api(workflow_endpoint + "/enable", "PUT")
    # Do not retry dispatch on connection failures: it could send a duplicate message.
    gh.run(["workflow", "run", "schedule.yml", "--repo", REPOSITORY, "--ref", branch])
    print("GitHub принял запрос тестового запуска. Это ещё не подтверждение доставки сообщения.")
    print(f"Результат: https://github.com/{REPOSITORY}/actions")
    print("Дальнейшее расписание: ежедневно 07:07 Europe/Moscow; возможны задержки GitHub.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Настройка бота ЗУ-41 в GitHub Raavvaa")
    parser.add_argument("--secrets", type=Path, help="Путь к приватному zu41_private.env")
    parser.add_argument("--update", action="store_true", help="Разрешить обновление уже существующего кода бота")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    candidates = [args.secrets] if args.secrets else [root / "zu41_private.env", root.parent / "zu41_private.env"]
    private = next((path for path in candidates if path is not None and path.is_file()), None)
    if private is None:
        raise SetupError("Положи zu41_private.env рядом с deploy.py или укажи --secrets ПУТЬ.")
    deployment(root, private, args.update)


if __name__ == "__main__":
    try:
        main()
    except (SetupError, OSError, ValueError, KeyError) as error:
        print(f"ОШИБКА: {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("Остановлено пользователем. Проверь состояние репозитория перед повторным запуском.", file=sys.stderr)
        sys.exit(130)

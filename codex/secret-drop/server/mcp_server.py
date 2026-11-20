#!/usr/bin/env python3
"""Local Codex MCP: secure native macOS multi-secret prompt, status-only results.

MCP stdout is JSON-RPC only. Secret values pass solely from the short-lived
local AppKit child process through a private pipe to the local writer.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
from dataclasses import dataclass
import stat
import unicodedata

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bin"))
from secret_drop import (  # noqa: E402
    NAME, REPO, env_file_parts, open_trusted_root, _walk_parent,
    write_env_batch, verify_env_written, write_github, quote_env,
)

PROTOCOL = "2025-06-18"
TOOL = {
    "name": "request_secret",
    "description": (
        "Ask the human for one OR MULTIPLE credentials in ONE native macOS masked "
        "input window. Use 'secrets': [{name:'OPENAI_API_KEY'}, {name:'SERVICE_TOKEN'}] "
        "for multiple variables, or legacy 'name' for one. Names use a monospaced "
        "font; each value has its own masked input. DO NOT request or supply the "
        "values in chat, shell, or MCP arguments. Store in project_dir/.env or a "
        "safe existing-parent nested .env.* target (0600), and optionally explicitly "
        "human-confirmed GitHub Actions Secrets. The model "
        "receives ONLY variable names and save/skip status. Blank fields are skipped "
        "without cancelling the rest; the native macOS window is separate from Codex."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "For ONE key only; e.g. OPENAI_API_KEY (NOT its value).",
                "pattern": "^[A-Za-z_][A-Za-z0-9_]*$",
            },
            "secrets": {
                "type": "array",
                "minItems": 1,
                "maxItems": 12,
                "description": "For MULTIPLE keys in one dialog. Pass names and optional short non-secret hints only.",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "pattern": "^[A-Za-z_][A-Za-z0-9_]*$"},
                        "hint": {"type": "string", "maxLength": 120},
                    },
                    "required": ["name"],
                    "additionalProperties": False,
                },
            },
            "project_dir": {
                "type": "string",
                "description": "Existing canonical absolute local project directory inside user's home.",
            },
            "destination": {
                "type": "string",
                "enum": ["env", "github", "both"],
                "default": "env",
                "description": "Local .env by default; GitHub Secrets ONLY with explicit user authorization.",
            },
            "github_repo": {
                "type": "string",
                "description": "Required for GitHub destinations, explicit owner/repository.",
            },
            "github_environment": {
                "type": "string",
                "description": "Optional explicit GitHub deployment environment for environment secrets.",
            },
            "env_file": {
                "type": "string",
                "description": "Existing-project relative .env or nested .env.* target; default .env.",
            },
            "reason": {
                "type": "string",
                "description": "Short plain-text reason shown to the human, never a destination authority.",
                "maxLength": 240,
            },
        },
        "required": ["project_dir"],
        "additionalProperties": False,
    },
}


class Cancelled(Exception):
    pass


@dataclass(frozen=True)
class NativeResponse:
    values: dict[str, str]
    destination_confirmed: bool
    github_confirmed: bool


def plain_text(value: object, limit: int) -> str:
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("invalid display text")
    if any(unicodedata.category(char).startswith("C") for char in value):
        raise ValueError("control characters are not allowed")
    return value


def trusted_project(raw_root: object) -> Path:
    raw = plain_text(raw_root, 4096)
    if not raw or not Path(raw).is_absolute():
        raise ValueError("project_dir must be an absolute path")
    given = Path(raw)
    if given.is_symlink() or not given.is_dir() or given.resolve() != given:
        raise ValueError("project_dir must be an existing canonical directory, not a symlink")
    root = given.resolve()
    home = Path.home().resolve()
    if root == home or home not in root.parents:
        raise ValueError("project_dir must be an existing directory within the user's home")
    ancestry = [home]
    current = home
    for component in root.relative_to(home).parts:
        current = current / component
        ancestry.append(current)
    for directory in ancestry:
        try:
            info = directory.lstat()
        except OSError as error:
            raise ValueError("unsafe project directory") from error
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) & (stat.S_IWGRP | stat.S_IWOTH)):
            raise ValueError("unsafe project directory")
    fd = open_trusted_root(root)
    os.close(fd)
    return root


def validate(args: object) -> tuple[list[dict[str, str]], Path, str, str | None, str | None, str, str, str]:
    if not isinstance(args, dict) or set(args) - {
        "name", "secrets", "project_dir", "destination", "github_repo",
        "github_environment", "env_file", "reason",
    }:
        raise ValueError("invalid parameters; do not include secret values")
    if ("name" in args) == ("secrets" in args):
        raise ValueError("provide exactly one of name or secrets")
    raw = ([{"name": args["name"]}] if "name" in args else args["secrets"])
    if not isinstance(raw, list) or not 1 <= len(raw) <= 12:
        raise ValueError("invalid variable count")
    fields: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict) or set(item) - {"name", "hint"}:
            raise ValueError("invalid secret field; values are forbidden")
        name = item.get("name")
        hint = plain_text(item.get("hint", ""), 120)
        if not isinstance(name, str) or not NAME.fullmatch(name) or len(name) > 128:
            raise ValueError("invalid variable name")
        if name in seen:
            raise ValueError("duplicate variable name")
        seen.add(name)
        fields.append({"name": name, "hint": hint})
    destination = args.get("destination", "env")
    repo = args.get("github_repo")
    environment = args.get("github_environment")
    if destination not in ("env", "github", "both"):
        raise ValueError("invalid save destination")
    if destination in ("github", "both"):
        if not isinstance(repo, str) or not REPO.fullmatch(repo):
            raise ValueError("explicit owner/repo is required for GitHub Secrets")
        if environment is not None:
            if not isinstance(environment, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,255}", environment):
                raise ValueError("invalid GitHub environment")
        if any(f["name"].upper().startswith("GITHUB_") for f in fields):
            raise ValueError("GitHub Secrets disallows GITHUB_ prefix")
    elif repo is not None or environment is not None:
        raise ValueError("unexpected GitHub repository")
    root = trusted_project(args.get("project_dir"))
    reason = plain_text(args.get("reason", ""), 240)
    parts = env_file_parts(args.get("env_file", ".env"))
    root_fd = open_trusted_root(root)
    parent_fd = None
    try:
        parent_fd, _ = _walk_parent(root_fd, parts)
    except OSError as error:
        raise ValueError("dotenv parent must already exist and be safe") from error
    finally:
        if parent_fd is not None:
            os.close(parent_fd)
        os.close(root_fd)
    env_target = root.joinpath(*parts)
    if destination in ("env", "both"):
        target_file = env_target
        if target_file.is_symlink() or (target_file.exists() and not target_file.is_file()):
            raise ValueError("unsafe dotenv path")
    if destination == "env":
        target = "Local dotenv file: " + str(env_target)
    elif destination == "github":
        target = "GitHub Actions Secrets: " + repo + (" (environment: " + environment + ")" if environment else "")
    else:
        target = "Local dotenv file: " + str(env_target) + "; GitHub Actions Secrets: " + repo + (" (environment: " + environment + ")" if environment else "")
    return fields, root, destination, repo, environment, "/".join(parts), reason, target


def dialog_binary() -> Path:
    """Compile the audited local Swift source once per source hash; no network."""
    source = Path(__file__).resolve().parent.parent / "gui" / "SecretDropDialog.swift"
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:20]
    cache = Path.home() / ".cache" / "secret-drop-codex-dialog"
    if cache.is_symlink():
        raise RuntimeError("unsafe GUI cache")
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    executable = cache / ("secret-drop-dialog-" + digest)
    if executable.is_file() and not executable.is_symlink() and os.access(executable, os.X_OK):
        return executable
    temp = cache / (".building-" + str(os.getpid()))
    try:
        compiled = subprocess.run(
            ["/usr/bin/swiftc", "-o", str(temp), str(source)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            check=False, timeout=120,
        )
        if compiled.returncode != 0:
            raise RuntimeError("native dialog compilation failed")
        os.chmod(temp, 0o700)
        os.replace(temp, executable)
    finally:
        if temp.exists():
            temp.unlink()
    return executable


def native_dialog(fields: list[dict[str, str]], target: str, reason: str, require_github_confirmation: bool) -> NativeResponse:
    if platform.system() != "Darwin":
        raise RuntimeError("native macOS dialog unavailable")
    executable = dialog_binary()
    try:
        proc = subprocess.run(
            [str(executable)],
            input=json.dumps({"fields": fields, "destination": target, "reason": reason,
                              "requires_github_confirmation": require_github_confirmation}),
            capture_output=True, text=True, check=False, timeout=300,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise Cancelled() from None
    if proc.returncode != 0 or not proc.stdout:
        raise Cancelled()
    try:
        response = json.loads(proc.stdout)
        if response.get("status") != "entered":
            raise Cancelled()
        values = response["values"]
        destination_confirmed = response["destination_confirmed"]
        github_confirmed = response["github_confirmed"]
        expected = {f["name"] for f in fields}
        # Empty fields are intentionally omitted; reject unexpected variable names.
        if not isinstance(values, dict) or not set(values).issubset(expected):
            raise Cancelled()
        if any(not isinstance(v, str) or not v for v in values.values()):
            raise Cancelled()
        if not isinstance(destination_confirmed, bool) or not isinstance(github_confirmed, bool):
            raise Cancelled()
        return NativeResponse(values, destination_confirmed, github_confirmed)
    except (ValueError, KeyError, TypeError):
        raise Cancelled() from None


def result(text: str, error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": text}], "isError": error}


def request_secret(args: object) -> dict:
    values: dict[str, str] | None = None
    try:
        fields, root, destination, repo, environment, env_file, reason, target = validate(args)
    except (ValueError, OSError):
        return result("Secret Drop: invalid or unsafe request. Nothing saved.", True)
    try:
        response = native_dialog(fields, target, reason, destination in ("github", "both"))
    except (Cancelled, RuntimeError, OSError):
        return result("Secret Drop: cancelled or native dialog unavailable. Nothing saved.", True)
    try:
        if not response.destination_confirmed or (destination in ("github", "both") and not response.github_confirmed):
            return result("Secret Drop: destination was not confirmed. Nothing saved.", True)
        values = response.values
        names_requested = [field["name"] for field in fields]
        if (not isinstance(values, dict)
                or not set(values).issubset(names_requested)
                or any(not isinstance(v, str) or not v for v in values.values())):
            return result("Secret Drop: invalid dialog result; nothing saved.", True)

        entered_names = [name for name in names_requested if name in values]
        skipped = [name for name in names_requested if name not in values]
        skipped_note = (
            " Skipped (not entered): " + ", ".join(skipped) + "."
            if skipped else ""
        )
        if not values:
            return result(
                "Secret Drop: No values entered; nothing saved." + skipped_note, True
            )

        # The local helper reads the file *within this process* to check that
        # the exact user-entered bytes survived the atomic write and mode is
        # 0600. It never returns file contents to Codex.
        if destination in ("env", "both"):
            for value in values.values():
                quote_env(value)
            write_env_batch(root, values, env_file)
            verified = verify_env_written(root, values, env_file)
            unverified = [name for name in entered_names if not verified.get(name)]
            if unverified:
                good = [name for name in entered_names if verified.get(name)]
                return result(
                    "Secret Drop: Local write NOT VERIFIED for: " +
                    ", ".join(unverified) + ". Verified locally: " +
                    (", ".join(good) if good else "none") + "." +
                    skipped_note +
                    " Do not assume unverified values are usable; no secret values returned.",
                    True,
                )

        local_note = (
            "Saved and verified locally (exact value, file owner, mode 0600): " +
            ", ".join(entered_names) + " to " + str(root.joinpath(*env_file.split("/"))) + ". "
            if destination in ("env", "both") else ""
        )

        if destination == "env":
            return result("Secret Drop: " + local_note + skipped_note +
                          " No secret values returned to Codex.")

        # GitHub explicitly opted in. A zero exit code confirms gh accepted
        # the write request, but NOT that the credential works with its API.
        succeeded = []
        failed = []
        for name in entered_names:
            if write_github(name, repo, environment, values[name]):
                succeeded.append(name)
            else:
                failed.append(name)
        github_note = (
            "GitHub CLI reported saved: " +
            (", ".join(succeeded) if succeeded else "none") + ". "
            "GitHub CLI failed: " +
            (", ".join(failed) if failed else "none") + "."
        )
        return result(
            "Secret Drop: " + local_note + github_note + skipped_note +
            " Credential validity at external services was NOT tested. "
            "No secret values returned to Codex.",
            bool(failed),
        )
    except (ValueError, OSError, UnicodeError):
        return result("Secret Drop: could not save or verify entered values. No secret values disclosed.", True)
    finally:
        if isinstance(values, dict):
            values.clear()

def handle(request: dict) -> dict | None:
    method = request.get("method")
    msg_id = request.get("id")
    if msg_id is None:
        return None
    if method == "initialize":
        payload = {
            "protocolVersion": PROTOCOL,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "secret-drop-local", "version": "0.6.0"},
            "instructions": (
                "Call request_secret with ONE 'name' or MULTIPLE 'secrets' entries; "
                "a single native masked macOS window collects values. Never ask for, "
                "read, print or pass secret values through agent messages."
            ),
        }
    elif method == "tools/list":
        payload = {"tools": [TOOL]}
    elif method == "tools/call":
        params = request.get("params") or {}
        if params.get("name") != "request_secret":
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": "Unknown tool"}}
        payload = request_secret(params.get("arguments"))
    elif method == "ping":
        payload = {}
    else:
        return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": "Method not found"}}
    return {"jsonrpc": "2.0", "id": msg_id, "result": payload}


def main():
    for raw in sys.stdin.buffer:
        try:
            request = json.loads(raw)
            if not isinstance(request, dict):
                continue
            response = handle(request)
            if response is not None:
                sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
                sys.stdout.flush()
        except (ValueError, TypeError, json.JSONDecodeError):
            # Never echo input, which may contain a sensitive value.
            continue


if __name__ == "__main__":
    main()

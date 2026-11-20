#!/usr/bin/env python3
"""Internal local .env/GitHub writer; values never enter agent-visible output."""
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess

NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
BARE = re.compile(r"[A-Za-z0-9_./:@%+=,-]+\Z")
ENV_COMPONENT = re.compile(r"[A-Za-z0-9_.-]+\Z")
MAX_FILE_BYTES = 1_048_576


def quote_env(value: str) -> str:
    if "\n" in value or "\r" in value or "\0" in value:
        raise ValueError("multiline/NUL values cannot be saved to .env")
    if BARE.fullmatch(value):
        return value
    if "'" in value:
        raise ValueError("complex quoted value: use a secret manager or --no-env --github")
    return "'" + value + "'"


def patched_env(original: str, name: str, value: str) -> str:
    lines = original.splitlines()
    expr = re.compile(r"^(\s*)(export\s+)?(" + re.escape(name) + r")\s*=")
    found = [i for i, line in enumerate(lines) if expr.match(line)]
    if len(found) > 1:
        raise ValueError("duplicate variable definitions; resolve manually")
    representation = quote_env(value)
    if found:
        i = found[0]
        match = expr.match(lines[i])
        lines[i] = match.group(1) + (match.group(2) or "") + name + "=" + representation
    else:
        lines.append(name + "=" + representation)
    return "\n".join(lines) + "\n"


def env_file_parts(env_file: str) -> tuple[str, ...]:
    """Allow only a small project-relative .env or .env.* path."""
    if not isinstance(env_file, str) or not env_file or len(env_file) > 1024:
        raise ValueError("invalid dotenv file")
    path = PurePosixPath(env_file)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError("dotenv file must stay within the project")
    if (not all(ENV_COMPONENT.fullmatch(part) for part in path.parts)
            or any(part == ".git" for part in path.parts)):
        raise ValueError("dotenv file contains unsafe path characters")
    if path.name != ".env" and not path.name.startswith(".env."):
        raise ValueError("dotenv file must be named .env or .env.*")
    return path.parts


def _dir_flags() -> int:
    return os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)


def _file_flags() -> int:
    return os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)


def _check_dir(fd: int) -> None:
    info = os.fstat(fd)
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & (stat.S_IWGRP | stat.S_IWOTH)):
        raise ValueError("unsafe project directory")


def open_trusted_root(root: Path) -> int:
    try:
        fd = os.open(os.fspath(root), _dir_flags())
    except OSError as error:
        raise ValueError("unsafe project directory") from error
    try:
        _check_dir(fd)
        return fd
    except Exception:
        os.close(fd)
        raise


def _walk_parent(root_fd: int, parts: tuple[str, ...]) -> tuple[int, str]:
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, _dir_flags(), dir_fd=fd)
            try:
                _check_dir(next_fd)
            except Exception:
                os.close(next_fd)
                raise
            os.close(fd)
            fd = next_fd
        return fd, parts[-1]
    except Exception:
        os.close(fd)
        raise


def _check_regular(info: os.stat_result, *, require_0600: bool) -> None:
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
            or info.st_size > MAX_FILE_BYTES
            or (require_0600 and stat.S_IMODE(info.st_mode) != 0o600)
            or (not require_0600 and stat.S_IMODE(info.st_mode) & (stat.S_IWGRP | stat.S_IWOTH))):
        raise ValueError("unsafe target file")


def _read_regular_at(parent_fd: int, name: str, *, require_0600: bool) -> tuple[str, bool]:
    """Read only after no-follow fd, type, link, owner and size checks."""
    try:
        fd = os.open(name, _file_flags(), dir_fd=parent_fd)
    except FileNotFoundError:
        return "", False
    except OSError as error:
        raise ValueError("unsafe target file") from error
    try:
        info = os.fstat(fd)
        _check_regular(info, require_0600=require_0600)
        chunks: list[bytes] = []
        left = info.st_size
        while left:
            block = os.read(fd, min(left, 65_536))
            if not block:
                raise ValueError("target changed while reading")
            chunks.append(block)
            left -= len(block)
        after = os.fstat(fd)
        if after.st_ino != info.st_ino or after.st_size != info.st_size:
            raise ValueError("target changed while reading")
        return b"".join(chunks).decode("utf-8"), True
    except (OSError, UnicodeError) as error:
        raise ValueError("unsafe target file") from error
    finally:
        os.close(fd)


def _atomic_replace_at(parent_fd: int, name: str, content: str) -> None:
    temp = ".secret-drop-" + str(os.getpid()) + "-" + str(id(content))
    fd = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        fd = os.open(temp, flags, 0o600, dir_fd=parent_fd)
        payload = content.encode("utf-8")
        while payload:
            written = os.write(fd, payload)
            payload = payload[written:]
        os.fsync(fd)
        os.fchmod(fd, 0o600)
        os.close(fd)
        fd = None
        os.replace(temp, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        try:
            os.fsync(parent_fd)
        except OSError:
            pass
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(temp, dir_fd=parent_fd)
        except FileNotFoundError:
            pass


def git_command(root: Path, *args: str, literal_pathspecs: bool = False) -> subprocess.CompletedProcess:
    prefix = ["git", "--literal-pathspecs"] if literal_pathspecs else ["git"]
    return subprocess.run([*prefix, *args], cwd=root, capture_output=True, text=True, check=False)


def prepare_git(root: Path, root_fd: int, relative_env: str) -> None:
    probe = git_command(root, "rev-parse", "--show-toplevel")
    if probe.returncode != 0:
        return
    if Path(probe.stdout.strip()).resolve() != root:
        raise ValueError("run this helper at the Git repository root")
    if git_command(root, "ls-files", "--error-unmatch", "--", relative_env,
                   literal_pathspecs=True).returncode == 0:
        raise ValueError("dotenv target is tracked by Git: untrack it and rotate old credentials first")
    if git_command(root, "check-ignore", "-q", "--", relative_env).returncode == 0:
        return
    old, _ = _read_regular_at(root_fd, ".gitignore", require_0600=False)
    rule = "/" + relative_env + "\n"
    _atomic_replace_at(root_fd, ".gitignore", old + ("" if not old or old.endswith("\n") else "\n") + rule)
    # Nested .gitignore files can negate a root rule.  Recheck Git's actual
    # decision before allowing the secret file write; command failures fail closed.
    if git_command(root, "check-ignore", "-q", "--", relative_env).returncode != 0:
        raise ValueError("dotenv target is not ignored by Git")


def write_env_batch(root: Path, values: dict[str, str], env_file: str = ".env") -> None:
    if not values:
        raise ValueError("no variables to save")
    parts = env_file_parts(env_file)
    for name, value in values.items():
        if not NAME.fullmatch(name):
            raise ValueError("invalid environment variable name")
        quote_env(value)
    root_fd = open_trusted_root(root)
    parent_fd = None
    try:
        parent_fd, leaf = _walk_parent(root_fd, parts)
        old, _ = _read_regular_at(parent_fd, leaf, require_0600=True)
        updated = old
        for name, value in values.items():
            updated = patched_env(updated, name, value)
        relative = "/".join(parts)
        prepare_git(root, root_fd, relative)
        # Holding the parent fd prevents path swaps. A same-UID process can still
        # race a shared filesystem; this unavoidable boundary is documented.
        _atomic_replace_at(parent_fd, leaf, updated)
    finally:
        if parent_fd is not None:
            os.close(parent_fd)
        os.close(root_fd)


def verify_env_written(root: Path, values: dict[str, str], env_file: str = ".env") -> dict[str, bool]:
    verified = {name: False for name in values}
    if not values:
        return verified
    root_fd = parent_fd = None
    try:
        root_fd = open_trusted_root(root)
        parent_fd, leaf = _walk_parent(root_fd, env_file_parts(env_file))
        content, _ = _read_regular_at(parent_fd, leaf, require_0600=True)
        lines = content.splitlines()
        for name, value in values.items():
            matcher = re.compile(r"^\s*(?:export\s+)?" + re.escape(name) + r"\s*=")
            matches = [line for line in lines if matcher.match(line)]
            verified[name] = len(matches) == 1 and matches[0].split("=", 1)[1] == quote_env(value)
    except (OSError, UnicodeError, ValueError):
        pass
    finally:
        if parent_fd is not None:
            os.close(parent_fd)
        if root_fd is not None:
            os.close(root_fd)
    return verified


def write_env(root: Path, name: str, value: str) -> None:
    write_env_batch(root, {name: value})


def write_github(name: str, repo: str, environment: str | None, value: str) -> bool:
    argv = ["gh", "secret", "set", name, "--repo", repo]
    if environment:
        argv.extend(["--env", environment])
    try:
        result = subprocess.run(argv, input=value, text=True, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=30, check=False)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False

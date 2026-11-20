#!/usr/bin/env python3
"""Codex UserPromptSubmit guard. Does not print, store, or transmit prompt text."""
import json
import re
import sys

# Detection patterns adapted from aislam23/secret-drop/hooks/lib.ts (MIT, a54d43a).
KNOWN = tuple(re.compile(p) for p in (
    r"sk-ant-[A-Za-z0-9_-]{20,}",
    r"sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}",
    r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b",
    r"\bglpat-[A-Za-z0-9_-]{20,}\b",
    r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
    r"\bAIza[0-9A-Za-z_-]{35}\b",
    r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b",
    r"\bsk_[A-Za-z0-9]{24,}\b",
    r"\bgsk_[A-Za-z0-9]{40,}\b",
    r"\bxai-[A-Za-z0-9]{40,}\b",
    r"\bpplx-[A-Za-z0-9]{40,}\b",
    r"\br8_[A-Za-z0-9]{30,}\b",
    r"\bnpm_[A-Za-z0-9]{36}\b",
    r"\b(?:y0_[A-Za-z0-9_-]{40,}|AQVN[A-Za-z0-9_-]{30,})",
    r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b",
    r"\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b",
    r"\bsbp_[a-f0-9]{40}\b",
    r"\bhf_[A-Za-z0-9]{34,}\b",
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
))
LOOSE = re.compile(
    r"(?:api[\s_-]?key|key|token|secret|password|passwd|ключ(?:ик)?|токен|секрет|пароль)"
    r"[^\n]{0,30}?(?:[:=]|->|→|—|–)\s*[\"'\x60«]?"
    r"([A-Za-z0-9][A-Za-z0-9_-]{19,})(?![\w/.@-])",
    re.I,
)


def is_loose_secret(token: str) -> bool:
    return bool(
        re.search(r"[A-Za-z]", token)
        and len(re.findall(r"\d", token)) >= 3
        and not re.fullmatch(r"[0-9a-f]{40}", token, re.I)
        and not re.fullmatch(
            r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", token, re.I
        )
        and not re.fullmatch(r"[A-Z0-9_]+", token)
    )


def contains_secret(prompt: str) -> bool:
    return any(pattern.search(prompt) for pattern in KNOWN) or any(
        is_loose_secret(match.group(1)) for match in LOOSE.finditer(prompt)
    )


def main():
    try:
        payload = json.load(sys.stdin)
        prompt = payload.get("prompt") if isinstance(payload, dict) else None
        if not isinstance(prompt, str):
            raise ValueError("invalid hook payload")
        if contains_secret(prompt):
            print(json.dumps({
                "decision": "block",
                "reason": (
                    "Possible credential detected. Do not paste credentials in chat. "
                    "Use the Secret Drop local helper in your own terminal. "
                    "Nothing was saved by this hook."
                ),
            }))
        else:
            print("{}")
    except (ValueError, TypeError, json.JSONDecodeError):
        print(json.dumps({
            "decision": "block",
            "reason": "Secret Drop could not inspect this prompt. Check the hook installation.",
        }))


if __name__ == "__main__":
    main()

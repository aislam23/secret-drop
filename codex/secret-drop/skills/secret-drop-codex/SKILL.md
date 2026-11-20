---
name: secret-drop-codex
description: Use when one or multiple credentials must be entered securely into a local project .env or explicitly approved GitHub Actions Secrets via Codex on macOS.
---

# Secret Drop for Codex

When autonomous configuration needs a credential, inspect only safe project metadata such as README, `.env.example`, checked-in compose files and configuration templates. Derive the intended missing variable name and, when explicit, a correct existing-project `env_file` (for example `config/.env.local`). **Never read `.env`, another secrets file, process environment, GitHub values or a real credential.** Invoke `secret-drop-local.request_secret` with a single `name`, or multiple `secrets: [{name: "TEST_ONE"}, {name: "TEST_TWO"}]`, canonical existing absolute `project_dir`, optional bounded plain-text `reason`, and the derived `env_file`. Manual invocation uses this exact MCP tool too; do not claim a `/secret` composer command exists.

Never request a secret value through conversation, terminal commands, MCP arguments or another agent. The user gets a compact native macOS AppKit modal with **burgundy monospaced centered variable chips on the left** and **masked fields on the right**. The dialog is separate from Codex's composer. The human must confirm the full locally computed destination before Save; GitHub additionally needs a distinct external-write confirmation with repo/environment. Interpret only returned save/skip/error statuses.

**Partial entry:** only populated fields are saved. Each blank field is reported as `Skipped (not entered)`; existing previous values in the file may still exist and are not touched. All blank or Cancel means no write. Project `.env` writes are atomic with mode `0600`.

**Verification:** after writing `.env`, the trusted local helper reads the file **inside its own process only** to check that the exact entered values persisted and that owner, file type and permissions are correct. The model receives **only per-name saved/verified, skipped and error statuses**, never the secret bytes. `Saved and verified locally` confirms persistence; **it does not mean a remote API key is valid**. If verification returns `NOT VERIFIED`, report this accurately; do not use the credential as ready or ask the user to expose it for diagnosis.

Optional GitHub Secrets output must be explicitly authorized and accompanied by `github_repo` (and explicit `github_environment` where intended); remote CLI write success is separate from remote credential validity and GitHub multi-write may partly fail. Do not treat `Skipped` as proof an existing variable is absent.

The bundled `UserPromptSubmit` guard is a supported hook mechanism but only runs after user trust; installed enablement/interception is not host-E2E-verified and it is not comprehensive DLP, prefill, or draft restore. A running agent with filesystem access might still read `.env`; prohibit that separately. Do not ask the agent to open or print the file. On non-macOS or no MCP tool, report unsupported secure entry rather than requesting a key in chat.

Codex Desktop currently has **no verified supported plugin API to mount this UI next to the composer**. Do not imitate Claude's `AbovePrompt` using Accessibility overlays, private APIs or modifications of Codex. Use only synthetic keys for acceptance.

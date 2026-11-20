// Pattern-based guard adapted from aislam23/secret-drop/hooks/lib.ts (MIT, a54d43a).
// No network calls, persistence or logging. Known-format matches are intentionally conservative.
const KNOWN = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bsk_[A-Za-z0-9]{24,}\b/,
  /\bgsk_[A-Za-z0-9]{40,}\b/,
  /\bxai-[A-Za-z0-9]{40,}\b/,
  /\bpplx-[A-Za-z0-9]{40,}\b/,
  /\br8_[A-Za-z0-9]{30,}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\b(?:y0_[A-Za-z0-9_-]{40,}|AQVN[A-Za-z0-9_-]{30,})/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/,
  /\bsbp_[a-f0-9]{40}\b/,
  /\bhf_[A-Za-z0-9]{34,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/,
];
const LOOSE = /(?:api[\s_-]?key|key|token|secret|password|passwd|ключ(?:ик)?|токен|секрет|пароль)[^\n]{0,30}?(?:[:=]|->|→|—|–)\s*["'\x60«]?([A-Za-z0-9][A-Za-z0-9_-]{19,})(?![\w/.@-])/gi;

function validUnknown(value) {
  return /[A-Za-z]/.test(value) &&
    (value.match(/[0-9]/g)?.length ?? 0) >= 3 &&
    !/^[0-9a-f]{40}$/i.test(value) &&
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) &&
    !/^[A-Z0-9_]+$/.test(value);
}

export function containsSecret(text) {
  if (typeof text !== "string") return false;
  if (KNOWN.some(re => re.test(text))) return true;
  const re = new RegExp(LOOSE.source, LOOSE.flags);
  return [...text.matchAll(re)].some(hit => validUnknown(hit[1]));
}

export const SAFE_REPLACEMENT = "Secret Drop detected a possible credential in the user's message and removed the ENTIRE text before model admission. The key value is not available. Ask the user to enter it locally using a trusted terminal or secret manager, never in chat. This detection is heuristic and may be a false positive.";

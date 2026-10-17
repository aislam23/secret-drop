// Pure helpers: no `$`, so the tests can call them directly.

export const DOT = '•'

/**
 * The Input shows dots, so each edit arrives as dots plus whatever the person
 * typed or pasted. Dots at the head and tail stand for characters kept from
 * the real value; the rest is new text.
 */
export function applyMaskedEdit(real: string, shown: string): string {
  let lead = 0
  while (lead < shown.length && shown[lead] === DOT) lead++
  let trail = 0
  while (trail < shown.length - lead && shown[shown.length - 1 - trail] === DOT) trail++
  lead = Math.min(lead, real.length)
  trail = Math.min(trail, real.length - lead)
  const middle = shown.slice(lead, shown.length - trail).split(DOT).join('')

  return real.slice(0, lead) + middle + real.slice(real.length - trail)
}

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** GitHub refuses names that start with GITHUB_ or a digit. */
export function githubNameProblem(name: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return 'letters, digits and _ only, not starting with a digit'
  if (/^GITHUB_/i.test(name)) return 'must not start with GITHUB_'

  return undefined
}

/**
 * Single quotes are literal for dotenv (node and python) and for `source`,
 * so they are the safe wrapper; a value holding a quote or a newline falls
 * back to double quotes with \n escapes.
 */
export function quoteEnv(value: string): string {
  if (/^[A-Za-z0-9_\-.\/:+@,~%=]*$/.test(value)) return value
  if (!/['\n\r]/.test(value)) return `'${value}'`

  return `"${value.replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`
}

/** Sets each name in a dotenv text: an existing line is replaced in place. */
export function upsertEnv(text: string, values: ReadonlyMap<string, string>): string {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  for (const [name, value] of values) {
    const matcher = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`)
    const index = lines.findIndex(line => matcher.test(line))
    if (index >= 0) {
      const exported = /^\s*export\s+/.test(lines[index] ?? "") ? 'export ' : ''
      lines[index] = `${exported}${name}=${quoteEnv(value)}`
    } else {
      lines.push(`${name}=${quoteEnv(value)}`)
    }
  }

  return lines.join('\n') + '\n'
}

/** Well-known token shapes, tuned to rarely fire on ordinary text. */
const PATTERNS: ReadonlyArray<{ kind: string; name: string; re: RegExp }> = [
  { kind: 'Anthropic', name: 'ANTHROPIC_API_KEY', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'OpenAI', name: 'OPENAI_API_KEY', re: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'GitHub', name: 'GITHUB_TOKEN', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: 'GitLab', name: 'GITLAB_TOKEN', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'AWS', name: 'AWS_ACCESS_KEY_ID', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'Google', name: 'GOOGLE_API_KEY', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'Stripe', name: 'STRIPE_SECRET_KEY', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: 'ElevenLabs', name: 'ELEVENLABS_API_KEY', re: /\bsk_[A-Za-z0-9]{24,}\b/g },
  { kind: 'Groq', name: 'GROQ_API_KEY', re: /\bgsk_[A-Za-z0-9]{40,}\b/g },
  { kind: 'xAI', name: 'XAI_API_KEY', re: /\bxai-[A-Za-z0-9]{40,}\b/g },
  { kind: 'Perplexity', name: 'PERPLEXITY_API_KEY', re: /\bpplx-[A-Za-z0-9]{40,}\b/g },
  { kind: 'Replicate', name: 'REPLICATE_API_TOKEN', re: /\br8_[A-Za-z0-9]{30,}\b/g },
  { kind: 'npm', name: 'NPM_TOKEN', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'Yandex', name: 'YANDEX_TOKEN', re: /\b(?:y0_[A-Za-z0-9_-]{40,}|AQVN[A-Za-z0-9_-]{30,})/g },
  { kind: 'Slack', name: 'SLACK_TOKEN', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'Telegram bot', name: 'TELEGRAM_BOT_TOKEN', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { kind: 'Supabase', name: 'SUPABASE_ACCESS_TOKEN', re: /\bsbp_[a-f0-9]{40}\b/g },
  { kind: 'Hugging Face', name: 'HF_TOKEN', re: /\bhf_[A-Za-z0-9]{34,}\b/g },
  { kind: 'private key', name: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
]

export type Found = { kind: string; name: string; value: string; placeholder: string }

/**
 * A token with no known shape counts only when it is handed over as a value: a word that names a
 * secret, then within 30 characters of the same line a separator, then the token
 * (`ключ: …`, `токен → …`, `api key = …`). A key-like id merely mentioned near such a word is left alone.
 */
const LOOSE_ASSIGNED =
  /(?:api[\s_-]?key|key|token|secret|password|passwd|ключ(?:ик)?|токен|секрет|пароль)[^\n]{0,30}?(?:[:=]|->|→|—|–)\s*["'`«]?([A-Za-z0-9][A-Za-z0-9_-]{19,})(?![\w/.@-])/gi
const isLooseSecret = (s: string) =>
  /[A-Za-z]/.test(s) &&
  (s.match(/[0-9]/g)?.length ?? 0) >= 3 &&
  !/^[0-9a-f]{40}$/i.test(s) &&
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) &&
  !/^[A-Z0-9_]+$/.test(s) // an UPPER_CASE_NAME is a variable name, not its value

/** Finds token-shaped strings and returns the text with each one cut out. */
export function redactSecrets(text: string): { found: Found[]; text: string } {
  const found: Found[] = []
  let out = text
  for (const { kind, name, re } of PATTERNS) {
    out = out.replace(re, value => {
      const placeholder = `[${kind} key removed]`
      found.push({ kind, name, value, placeholder })
      return placeholder
    })
  }
  out = out.replace(LOOSE_ASSIGNED, (match: string, token: string) => {
    if (!isLooseSecret(token)) return match
    found.push({ kind: 'API', name: 'API_KEY', value: token, placeholder: '[key removed]' })
    return match.slice(0, match.lastIndexOf(token)) + '[key removed]'
  })

  return { found, text: out }
}

/** Replaces any occurrence of the values in a text (a tool's stderr, say). */
export function scrub(text: string, values: Iterable<string>): string {
  let out = text
  for (const value of values) if (value.length >= 4) out = out.split(value).join('***')

  return out
}

export type Lang = 'en' | 'ru'

export const STRINGS = {
  en: {
    title: 'Secret',
    asks: 'Claude asks for a key',
    of: (i: number, n: number) => `${i} of ${n}`,
    why: 'Why',
    where: 'Saves to',
    envProject: '.env in the project folder',
    ghTo: (repo: string | undefined, env: string | undefined) =>
      `GitHub Secrets · ${repo ?? 'this repo'}${env ? ` (environment ${env})` : ''}`,
    cue: 'Paste the key',
    placeholder: 'paste here and press Enter',
    value: 'Value',
    next: 'next',
    save: 'save',
    show: 'Show',
    hide: 'Hide',
    skip: 'Skip',
    cancel: 'Cancel',
    close: 'Close',
    footer: 'The value never enters the chat. Claude only learns the name and length.',
    saving: 'Saving…',
    done: 'Done',
    noInput: 'This surface has no text field: open the session in the terminal or the desktop app.',
    bandWaiting: (names: string) => `Claude is waiting for ${names}`,
    bandOpen: 'Enter securely',
    status: (names: string) => `🔐 waiting for ${names}: /secret opens the window`,
    toastNotPlaced: 'secret-drop: widen the window or run /secret to enter the key',
    chars: (n: number) => `${n} chars`,
    savedEnv: (names: string, path: string) => `✓ ${names} → ${path}`,
    savedGh: (name: string, repo: string) => `✓ ${name} → GitHub Secrets (${repo})`,
    failedEnv: (why: string) => `✗ .env not written: ${why}`,
    failedGh: (name: string, why: string) => `✗ ${name} → GitHub: ${why}`,
    gitignored: (rel: string) => `✓ added ${rel} to .gitignore`,
    tracked: (rel: string) => `⚠ ${rel} is already tracked by git: run git rm --cached ${rel}`,
    nothing: 'Nothing entered.',
    leaked: (kinds: string) =>
      `secret-drop: the message held a ${kinds} key, so it was not sent. Save the key in the band above the prompt; the message is back in the box without it.`,
    guardTitle: 'Caught a key in your message',
    guardHint: (kind: string) => `${kind} key, already filled in: check the name and press Enter`,
    nameCue: 'Name',
    keyCue: 'Key',
    dontSave: "Don't save",
    badName: 'secret-drop: a name is letters, digits and _, not starting with a digit',
    savedAs: (name: string, where: string) => `${name} (saved to ${where})`,
  },
  ru: {
    title: 'Секрет',
    asks: 'Claude просит ключ',
    of: (i: number, n: number) => `${i} из ${n}`,
    why: 'Зачем',
    where: 'Куда',
    envProject: '.env в папке проекта',
    ghTo: (repo: string | undefined, env: string | undefined) =>
      `GitHub Secrets · ${repo ?? 'этот репозиторий'}${env ? ` (окружение ${env})` : ''}`,
    cue: 'Вставь ключ',
    placeholder: 'вставь сюда и нажми Enter',
    value: 'Значение',
    next: 'дальше',
    save: 'сохранить',
    show: 'Показать',
    hide: 'Скрыть',
    skip: 'Пропустить',
    cancel: 'Отмена',
    close: 'Закрыть',
    footer: 'Значение не попадёт в чат. Claude узнает только имя и длину.',
    saving: 'Сохраняю…',
    done: 'Готово',
    noInput: 'Здесь нет поля ввода: открой сессию в терминале или в десктопном приложении.',
    bandWaiting: (names: string) => `Claude ждёт ${names}`,
    bandOpen: 'Ввести безопасно',
    status: (names: string) => `🔐 жду ${names}: /secret откроет окно`,
    toastNotPlaced: 'secret-drop: расширь окно или набери /secret, чтобы ввести ключ',
    chars: (n: number) => `${n} симв.`,
    savedEnv: (names: string, path: string) => `✓ ${names} → ${path}`,
    savedGh: (name: string, repo: string) => `✓ ${name} → GitHub Secrets (${repo})`,
    failedEnv: (why: string) => `✗ .env не записан: ${why}`,
    failedGh: (name: string, why: string) => `✗ ${name} → GitHub: ${why}`,
    gitignored: (rel: string) => `✓ добавил ${rel} в .gitignore`,
    tracked: (rel: string) => `⚠ ${rel} уже в git: выполни git rm --cached ${rel}`,
    nothing: 'Ничего не введено.',
    leaked: (kinds: string) =>
      `secret-drop: в сообщении был ключ (${kinds}), я его не отправил. Сохрани ключ в плашке над полем ввода, а сообщение вернулось в поле уже без него.`,
    guardTitle: 'Поймал ключ в сообщении',
    guardHint: (kind: string) => `ключ ${kind} уже подставлен: проверь имя и нажми Enter`,
    nameCue: 'Имя',
    keyCue: 'Ключ',
    dontSave: 'Не сохранять',
    badName: 'secret-drop: имя — латинские буквы, цифры и _, не с цифры',
    savedAs: (name: string, where: string) => `${name} (сохранён в ${where})`,
  },
} satisfies Record<Lang, Record<string, unknown>>

export type Strings = (typeof STRINGS)['en']

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

/** The words of the blocked message around a caught key, so the band can show which string it caught. */
export type Around = { before: string; after: string }

export type Found = {
  kind: string
  name: string
  value: string
  placeholder: string
  /** False when the format is unknown and only the words around it made it look like a key. */
  isKnown: boolean
  around: Around
}

/**
 * Words that say "a secret is next to this", in English and Russian, as whole words:
 * "keyboard", "monkey", "capital" or "ключевой" do not count.
 */
const SECRET_CONTEXT =
  /(?<![\p{L}\p{N}])(?:api|apikey|keys?|tokens?|secrets?|passwords?|passwd|ключ(?!ев)\p{L}*|токен\p{L}*|секрет\p{L}*|парол\p{L}*)(?!\p{L})/iu

const AROUND_BEFORE = 60
const AROUND_AFTER = 40

/** The message text on both sides of a placeholder, on one line; a leading or trailing … marks a cut. */
function aroundOf(text: string, placeholder: string): Around {
  const at = text.indexOf(placeholder)
  if (at < 0) return { before: '', after: '' }
  const flat = (s: string) => s.replace(/\s+/g, ' ')
  const from = Math.max(0, at - AROUND_BEFORE)
  const end = at + placeholder.length
  const to = Math.min(text.length, end + AROUND_AFTER)
  const before = flat(text.slice(from, at)).trimStart()
  const after = flat(text.slice(end, to)).trimEnd()

  return {
    before: from > 0 && before !== '' ? `…${before}` : before,
    after: to < text.length && after !== '' ? `${after}…` : after,
  }
}

/** A glimpse of a caught value, enough to recognise it: its ends, never the middle. */
export function peekOf(value: string): string {
  const pem = /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.exec(value)
  if (pem) return pem[0]
  if (value.length >= 16) return `${value.slice(0, 4)}…${value.slice(-4)}`
  if (value.length >= 10) return `${value.slice(0, 2)}…${value.slice(-2)}`

  return DOT.repeat(value.length)
}

/**
 * A token-like string with no known shape: 20+ characters of letters, digits, `_` or `-`,
 * holding both letters and at least three digits. Git hashes (40 hex) and UUIDs are left alone.
 */
const LOOSE_TOKEN = /(?<![\w/.@-])[A-Za-z0-9][A-Za-z0-9_-]{19,}(?![\w/.@-])/g
const isLooseSecret = (s: string) =>
  /[A-Za-z]/.test(s) &&
  (s.match(/[0-9]/g)?.length ?? 0) >= 3 &&
  !/^[0-9a-f]{40}$/i.test(s) &&
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) &&
  !/^[A-Z0-9_]+$/.test(s) // an UPPER_CASE_NAME is a variable name, not its value

/**
 * Finds token-shaped strings and returns the text with each one cut out.
 * `allowed` holds values the person said are not keys: they stay in the text.
 * Each placeholder is unique, so a key can be put back or named in its own place.
 */
export function redactSecrets(
  text: string,
  allowed: ReadonlySet<string> = new Set(),
): { found: Found[]; text: string } {
  const found: Array<Omit<Found, 'around'>> = []
  const used = new Map<string, number>()
  const placeholderOf = (label: string) => {
    const n = (used.get(label) ?? 0) + 1
    used.set(label, n)
    return n === 1 ? `[${label} removed]` : `[${label} ${n} removed]`
  }
  let out = text
  for (const { kind, name, re } of PATTERNS) {
    out = out.replace(re, value => {
      if (allowed.has(value)) return value
      const placeholder = placeholderOf(`${kind} key`)
      found.push({ kind, name, value, placeholder, isKnown: true })
      return placeholder
    })
  }
  // the person's own words, not the placeholders (they say "key") or the keys (sk-ant-api03-…)
  if (SECRET_CONTEXT.test(out.replace(/\[[^\]\n]* removed\]/g, ' '))) {
    out = out.replace(LOOSE_TOKEN, match => {
      if (!isLooseSecret(match) || allowed.has(match)) return match
      const placeholder = placeholderOf('key')
      found.push({ kind: 'API', name: 'API_KEY', value: match, placeholder, isKnown: false })
      return placeholder
    })
  }

  return { found: found.map(item => ({ ...item, around: aroundOf(out, item.placeholder) })), text: out }
}

/** Puts `to` where `from` stands in a text, once; `$` in `to` is taken literally. */
export const replaceOnce = (text: string, from: string, to: string) => text.replace(from, () => to)

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
    leaked: (n: number) =>
      `secret-drop: the message held ${n === 1 ? 'something that looks like a key' : `${n} strings that look like keys`}, so it was not sent. The band above the prompt shows what was caught: save it, or press "Not a key" to put it back.`,
    personAsks: 'Save a key',
    guardTitle: 'Your message holds something that looks like a key',
    guardReason: 'the message was not sent, so the key stays out of the chat',
    guardHint: (kind: string, isKnown: boolean) =>
      isKnown ? `looks like a ${kind} key` : 'unknown format: check that it is really a key',
    whyLabel: 'Why:',
    caughtLabel: 'Caught:',
    notKey: 'Not a key',
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
    leaked: (n: number) =>
      `secret-drop: в сообщении ${n === 1 ? 'было что-то похожее на ключ' : `нашлись строки, похожие на ключи (${n})`}, поэтому я его не отправил. В плашке над полем ввода видно, что именно поймано: сохрани или нажми «Это не ключ», и строка вернётся в сообщение.`,
    personAsks: 'Сохранить ключ',
    guardTitle: 'В сообщении что-то похожее на ключ',
    guardReason: 'сообщение не отправил, чтобы ключ не ушёл в чат',
    guardHint: (kind: string, isKnown: boolean) =>
      isKnown ? `похоже на ключ ${kind}` : 'формат не узнал: проверь, точно ли это ключ',
    whyLabel: 'Зачем:',
    caughtLabel: 'Поймал:',
    notKey: 'Это не ключ',
    nameCue: 'Имя',
    keyCue: 'Ключ',
    dontSave: 'Не сохранять',
    badName: 'secret-drop: имя — латинские буквы, цифры и _, не с цифры',
    savedAs: (name: string, where: string) => `${name} (сохранён в ${where})`,
  },
} satisfies Record<Lang, Record<string, unknown>>

export type Strings = (typeof STRINGS)['en']

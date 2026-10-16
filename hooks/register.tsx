import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SecretAsk, SecretRequest } from '../types'
import {
  DOT,
  ENV_NAME,
  STRINGS,
  applyMaskedEdit,
  githubNameProblem,
  peekOf,
  redactSecrets,
  replaceOnce,
  scrub,
  upsertEnv,
} from './lib'
import type { Lang, Strings } from './lib'
import { CUE_H, FOOT_H, cueSvg, cueWidth, detailText, footSvg, headerHeight, headerSvg, reportSvg, toneOf } from './look'
import type { Destination, Detail } from './look'

// The pane id of 0.1.0, closed on load so an old window does not linger.
const OLD_PANE = 'secret-drop'

const request = atom({ plugin: 'secret-drop', key: 'request' } as const, null)
const rev = atom({ plugin: 'secret-drop', key: 'rev' } as const, 0)
const isRevealed = atom({ plugin: 'secret-drop', key: 'isRevealed' } as const, false)

type Engine = EngineInterface

// Prompt origins a person typed: the terminal, the phone bridge, the desktop app (an SDK host).
const HUMAN_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

type StartArgs = {
  secrets: SecretAsk[]
  reason?: string
  saveTo?: Array<'env' | 'github'>
  envFile?: string
  githubRepo?: string
  githubEnvironment?: string
  from: SecretRequest['from']
  /** Values already known (the guard caught them), by secret index. */
  prefill?: string[]
  draft?: string
}

const TOOL_DESCRIPTION = `Ask the user for secrets (API keys, tokens, passwords) through a masked input window, then save them to a .env file and/or GitHub Actions secrets WITHOUT the values ever entering this conversation.

Use it whenever a task needs a secret from the user: never ask them to paste a secret into the chat, and never spin up a local server or form to collect one.

The window shows only what you pass, and a user who cannot tell what a key is or why it is needed skips it. So always pass \`reason\` (what the key is for in this task) and, for every secret, a \`hint\` naming the service and where exactly to get the key (the page or the menu path). Both in the user's language.

The call returns at once and the window stays open for the user. End your turn right after calling it. When the user is done you receive a message starting with "[secret-drop]" listing what was saved where (names and lengths only). Afterwards refer to the values through the environment (process.env.NAME, $NAME, \${{ secrets.NAME }}); never print, cat or echo them.`

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    secrets: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      description: 'The secrets to ask for, in order.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Variable name, e.g. OPENAI_API_KEY.' },
          hint: {
            type: 'string',
            description:
              "Shown next to the name, in the user's language: which service the key belongs to and where exactly to get it, e.g. \"OpenAI: platform.openai.com → API keys → Create new secret key\".",
          },
        },
        required: ['name', 'hint'],
      },
    },
    reason: {
      type: 'string',
      description:
        "One sentence, in the user's language: what the key is needed for in this task, e.g. \"the bot sends voice replies through ElevenLabs\".",
    },
    save_to: {
      type: 'array',
      items: { type: 'string', enum: ['env', 'github'] },
      description: 'Where to save: a dotenv file, GitHub Actions secrets, or both. Default ["env"].',
    },
    env_file: {
      type: 'string',
      description: 'The dotenv file, relative to the working directory or absolute. Default ".env".',
    },
    github_repo: { type: 'string', description: 'owner/repo for GitHub secrets. Default: the repository of the working directory.' },
    github_environment: { type: 'string', description: 'A GitHub deployment environment, for environment secrets.' },
  },
  required: ['secrets', 'reason'],
}

const MISSING_WHY = `The window would not tell the user what to paste or why, so it was not opened. Call request_secret again with \`reason\` (one sentence: what the key is for in this task) and a \`hint\` for every secret (the service and where exactly to get the key), in the user's language.`

// The values live here and only here, for as long as the window is open.
let buffer = ''
const values = new Map<string, string>()
// Keys the prompt guard caught, waiting in the band to be saved, by secret index.
const prefill = new Map<number, string>()
// Strings the person said are not keys: the guard lets them through for the rest of the session.
const notSecrets = new Set<string>()
let S: Strings = STRINGS.en

const namesOf = (req: SecretRequest) =>
  req.secrets
    .slice(req.index)
    .map(ask => ask.name)
    .join(', ')

// The band's requestId, as its last drawing saw it: what $.ui.focus addresses.
let bandId: string | undefined

const inputKey = (req: SecretRequest) => `value-${req.id}-${req.index}`
const nameKey = (req: SecretRequest) => `name-${req.id}-${req.index}`

async function focusBand($: Engine, req: SecretRequest) {
  if (bandId === undefined) return
  await $.ui.focus({ requestId: bandId, key: inputKey(req) }).catch(() => undefined)
}

async function absolutePath($: Engine, path: string) {
  if (path.startsWith('/')) return path
  if (path.startsWith('~/')) return `${(await $.env.get('HOME')) ?? ''}${path.slice(1)}`
  const cwd = await $.session.cwd()

  return `${cwd}/${path.replace(/^\.\//, '')}`
}

async function envLabelOf($: Engine, file: string) {
  const cwd = await $.session.cwd()
  if (file === `${cwd}/.env`) return S.envProject
  if (file.startsWith(`${cwd}/`)) return file.slice(cwd.length + 1)
  const home = await $.env.get('HOME')

  return home && file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file
}

async function start($: Engine, args: StartArgs): Promise<SecretRequest | string> {
  const current = await read($, request)
  if (current && current.phase !== 'finished') {
    return `Another secret request is still open (${namesOf(current)}). Wait for the user to finish it.`
  }
  const saveTo = args.saveTo && args.saveTo.length > 0 ? args.saveTo : ['env']
  const seen = new Set<string>()
  const secrets: SecretAsk[] = []
  for (const ask of args.secrets) {
    const name = String(ask?.name ?? '').trim()
    if (!ENV_NAME.test(name)) return `"${name}" is not a valid variable name (letters, digits and _, not starting with a digit).`
    const ghProblem = saveTo.includes('github') ? githubNameProblem(name) : undefined
    if (ghProblem) return `"${name}" cannot be a GitHub secret: ${ghProblem}.`
    if (seen.has(name)) continue
    seen.add(name)
    secrets.push({
      name,
      ...(ask.hint ? { hint: String(ask.hint) } : {}),
      ...(ask.placeholder ? { placeholder: ask.placeholder } : {}),
      ...(ask.around ? { around: ask.around } : {}),
    })
  }
  if (secrets.length === 0) return 'Name at least one secret.'

  const envFile = saveTo.includes('env') ? await absolutePath($, args.envFile ?? '.env') : undefined
  const req: SecretRequest = {
    id: `${Date.now()}`,
    secrets,
    reason: args.reason,
    envFile,
    envLabel: envFile ? await envLabelOf($, envFile) : undefined,
    github: saveTo.includes('github')
      ? { repo: args.githubRepo, environment: args.githubEnvironment }
      : undefined,
    from: args.from,
    ...(args.draft !== undefined ? { draft: args.draft } : {}),
    index: 0,
    captured: [],
    skipped: [],
    phase: 'input',
    report: [],
  }
  values.clear()
  prefill.clear()
  args.prefill?.forEach((value, i) => prefill.set(i, value))
  buffer = prefill.get(0) ?? ''
  await update($, isRevealed, () => false)
  await update($, request, () => req)
  void focusBand($, req)

  return req
}

async function ensureIgnored($: Engine, file: string, report: string[]) {
  const dir = file.slice(0, file.lastIndexOf('/')) || '/'
  const top = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) return
  const root = top.stdout.trim()
  const rel = file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
  const tracked = await $.process.run(['git', '-C', root, 'ls-files', '--error-unmatch', rel])
  if (tracked.exitCode === 0) {
    report.push(S.tracked(rel))
    return
  }
  const ignored = await $.process.run(['git', '-C', root, 'check-ignore', '-q', rel])
  if (ignored.exitCode === 0) return
  const gitignore = `${root}/.gitignore`
  const old = (await $.fs.exists(gitignore)) ? String(await $.fs.read(gitignore)) : ''
  await $.fs.write(gitignore, `${old}${old && !old.endsWith('\n') ? '\n' : ''}/${rel}\n`)
  report.push(S.gitignored(`/${rel}`))
}

async function save($: Engine, req: SecretRequest): Promise<string[]> {
  const report: string[] = []
  if (values.size === 0) return [S.nothing]
  const names = [...values.keys()].join(', ')

  if (req.envFile) {
    try {
      const existed = await $.fs.exists(req.envFile)
      const old = existed ? String(await $.fs.read(req.envFile)) : ''
      await $.fs.write(req.envFile, upsertEnv(old, values))
      if (!existed) await $.process.run(['chmod', '600', req.envFile])
      report.push(S.savedEnv(names, req.envFile))
      await ensureIgnored($, req.envFile, report)
    } catch (error) {
      report.push(S.failedEnv(scrub(String(error), values.values())))
    }
  }

  if (req.github) {
    let repo = req.github.repo
    if (!repo) {
      const view = await $.process
        .run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])
        .catch(() => undefined)
      repo = view?.exitCode === 0 ? view.stdout.trim() : undefined
    }
    for (const [name, value] of values) {
      const argv = ['gh', 'secret', 'set', name]
      if (repo) argv.push('--repo', repo)
      if (req.github.environment) argv.push('--env', req.github.environment)
      try {
        const ran = await $.process.run(argv, { stdin: value, timeoutMs: 60_000 })
        report.push(
          ran.exitCode === 0
            ? S.savedGh(name, repo ?? '?')
            : S.failedGh(name, scrub(ran.stderr.trim().split('\n')[0] ?? `exit ${ran.exitCode}`, values.values())),
        )
      } catch (error) {
        report.push(S.failedGh(name, scrub(String(error), values.values())))
      }
    }
  }

  return report
}

async function tellModel($: Engine, req: SecretRequest, lengths: Map<string, number>, isCancelled: boolean) {
  if (req.from === 'guard' && isCancelled) return
  const lines = ['[secret-drop]']
  if (isCancelled) {
    lines.push('The user cancelled the secure input. Nothing was saved.')
  } else {
    lines.push(
      req.from === 'model'
        ? 'The user finished the secure input you requested.'
        : req.from === 'guard'
          ? 'The user pasted a key into a message; secret-drop kept the message from being sent and the user stored the key instead.'
          : 'The user stored secrets through /secret.',
    )
    const got = req.captured.map(name => `${name} (${lengths.get(name) ?? 0} chars)`)
    if (got.length > 0) lines.push(`Entered: ${got.join(', ')}.`)
    if (req.skipped.length > 0) lines.push(`Skipped by the user: ${req.skipped.join(', ')}.`)
    lines.push(...req.report)
    lines.push('The values were never shown in this conversation. Use them through the environment; do not print or read them back.')
  }
  const text = lines.join('\n')
  if (req.from === 'model') {
    void $.prompt.submit({ text })
  } else {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  }
}

/** Puts the saved keys' names where the guard cut them out, if the person left the message as it was. */
async function restoreDraft($: Engine, req: SecretRequest) {
  if (req.from !== 'guard' || req.draft === undefined) return
  const box = await $.prompt.read()
  if (box.text !== req.draft) return
  let text = req.draft
  const where = req.envLabel ?? req.envFile ?? '.env'
  for (const ask of req.secrets) {
    if (ask.placeholder && req.captured.includes(ask.name)) text = replaceOnce(text, ask.placeholder, S.savedAs(ask.name, where))
  }
  if (text !== req.draft) await $.prompt.fill({ text })
}

/**
 * "Not a key": the caught string goes back into the message where it stood, the guard
 * lets it through from now on, and the band moves to the next one.
 */
async function release($: Engine) {
  const req = await read($, request)
  if (!req || req.phase !== 'input' || req.from !== 'guard') return
  const ask = req.secrets[req.index]
  const value = prefill.get(req.index)
  if (!ask || value === undefined) return advance($, 'skip')
  notSecrets.add(value)
  if (ask.placeholder && req.draft !== undefined) {
    const draft = replaceOnce(req.draft, ask.placeholder, value)
    // the box may have been edited meanwhile: put the string back wherever its placeholder still is
    const box = await $.prompt.read()
    if (box.text.includes(ask.placeholder)) await $.prompt.fill({ text: replaceOnce(box.text, ask.placeholder, value) })
    await update($, request, now => (now && now.id === req.id ? { ...now, draft } : now))
  }
  await advance($, 'release')
}

async function renameAsk($: Engine, name: string) {
  const clean = name.trim().replace(/[\s-]+/g, '_')
  await update($, request, req => {
    if (!req || req.phase !== 'input') return req
    return { ...req, secrets: req.secrets.map((ask, i) => (i === req.index ? { ...ask, name: clean } : ask)) }
  })
}

async function finish($: Engine, isCancelled: boolean) {
  const req = await read($, request)
  if (!req || req.phase !== 'input') return
  $.ui.status(undefined)
  const lengths = new Map([...values].map(([name, value]) => [name, value.length]))
  // every caught string turned out not to be a key: nothing to save, nothing to tell
  if (isCancelled || (req.from === 'guard' && values.size === 0)) {
    buffer = ''
    values.clear()
    prefill.clear()
    await update($, request, () => null)
    await tellModel($, req, lengths, true)
    return
  }
  await update($, request, () => ({ ...req, phase: 'saving' as const }))
  const report = await save($, req)
  buffer = ''
  values.clear()
  prefill.clear()
  const done: SecretRequest = { ...req, phase: 'finished', report }
  await update($, request, () => done)
  await tellModel($, done, lengths, false)
  await restoreDraft($, done)
  $.clock.after(8_000, () => {
    void (async () => {
      const now = await read($, request)
      if (now?.id === done.id && now.phase === 'finished') await update($, request, () => null)
    })()
  })
}

async function advance($: Engine, how: 'take' | 'skip' | 'release') {
  const req = await read($, request)
  if (!req || req.phase !== 'input') return
  const ask = req.secrets[req.index]
  if (!ask) return
  const isTaken = how === 'take'
  if (isTaken && buffer === '') return
  if (isTaken && !ENV_NAME.test(ask.name)) {
    $.ui.toast(S.badName)
    return
  }
  if (isTaken) values.set(ask.name, buffer)
  buffer = ''
  const next: SecretRequest = {
    ...req,
    captured: isTaken ? [...req.captured, ask.name] : req.captured,
    skipped: how === 'skip' ? [...req.skipped, ask.name] : req.skipped,
    released: how === 'release' ? [...(req.released ?? []), ask.name] : req.released,
  }
  await update($, isRevealed, () => false)
  if (req.index + 1 < req.secrets.length) {
    const moved = { ...next, index: req.index + 1 }
    buffer = prefill.get(moved.index) ?? ''
    await update($, request, () => moved)
    void focusBand($, moved)
    return
  }
  await update($, request, () => next)
  await finish($, false)
}

export const register: Register = (on, options) => {
  const guardPrompts = options.guardPrompts !== false

  on('session.start', async ($, e, next) => {
    const setting = options.language
    if (setting === 'en' || setting === 'ru') {
      S = STRINGS[setting]
    } else {
      const locale = [await $.env.get('LC_ALL'), await $.env.get('LC_MESSAGES'), await $.env.get('LANG')].find(Boolean)
      let lang: Lang = locale?.toLowerCase().startsWith('ru') ? 'ru' : 'en'
      if (!locale) {
        const apple = await $.process
          .run(['defaults', 'read', '-g', 'AppleLanguages'], { timeoutMs: 3_000 })
          .catch(() => undefined)
        if (apple && /\bru\b/i.test(apple.stdout)) lang = 'ru'
      }
      S = STRINGS[lang]
    }

    await $.tool.register({
      name: 'request_secret',
      description: TOOL_DESCRIPTION,
      inputSchema: TOOL_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: 'secret',
      description: 'Enter API keys or passwords in a masked window; they go to .env or GitHub Secrets, never into the chat',
      argumentHint: 'NAME [NAME…] [--github [owner/repo]] [--env-file path] [--no-env]',
    })

    await $.ui.close({ id: OLD_PANE })

    // A reload starts with no values in memory: an open request asks again from the first key.
    const stale = await read($, request)
    if (stale && stale.phase === 'input') {
      await update($, request, () => ({ ...stale, index: 0, captured: [], skipped: [] }))
    } else if (stale) {
      await update($, request, () => null)
      $.ui.status(undefined)
    }

    return next(e)
  })

  on('tool.call', { tool: 'mcp__secret-drop__request_secret' }, async ($, e) => {
    const input = e as unknown as {
      secrets?: SecretAsk[]
      reason?: string
      save_to?: Array<'env' | 'github'>
      env_file?: string
      github_repo?: string
      github_environment?: string
    }
    if (!Array.isArray(input.secrets) || input.secrets.length === 0) return { deny: 'Pass `secrets`: [{ name, hint }].' }
    const isBlank = (s: unknown) => String(s ?? '').trim() === ''
    if (isBlank(input.reason) || input.secrets.some(ask => isBlank(ask?.hint))) return { deny: MISSING_WHY }
    const started = await start($, {
      secrets: input.secrets,
      reason: input.reason,
      saveTo: input.save_to,
      envFile: input.env_file,
      githubRepo: input.github_repo,
      githubEnvironment: input.github_environment,
      from: 'model',
    })
    if (typeof started === 'string') return { deny: started }

    const where = [
      started.envFile ? `dotenv file ${started.envFile}` : undefined,
      started.github ? `GitHub secrets${started.github.repo ? ` of ${started.github.repo}` : ''}` : undefined,
    ].filter(Boolean)

    return {
      result: `A masked input window is open for the user for ${started.secrets
        .map(ask => ask.name)
        .join(', ')} (saving to ${where.join(' and ')}). You will not see the values. End your turn now: do not poll and do not ask the user to paste anything into the chat. A "[secret-drop]" message will tell you when they are saved.`,
    }
  })

  on('command.run', { command: 'secret' }, async ($, e) => {
    const tokens = e.args.split(/\s+/).filter(Boolean)
    const names: string[] = []
    const saveTo = new Set<'env' | 'github'>(['env'])
    let envFile: string | undefined
    let githubRepo: string | undefined
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] ?? ''
      if (token === '--github' || token === '--gh') {
        saveTo.add('github')
        const repo = tokens[i + 1]
        if (repo && !repo.startsWith('--') && repo.includes('/')) {
          githubRepo = repo
          i++
        }
      } else if (token === '--env-file') {
        envFile = tokens[++i]
      } else if (token === '--no-env') {
        saveTo.delete('env')
      } else {
        names.push(token)
      }
    }

    if (names.length === 0) {
      const pending = await read($, request)
      if (pending && pending.phase === 'input') {
        await focusBand($, pending)
        return { text: `secret-drop: ${S.bandWaiting(namesOf(pending))}` }
      }
      return { text: 'Usage: /secret NAME [NAME…] [--github [owner/repo]] [--env-file path] [--no-env]' }
    }
    if (saveTo.size === 0) return { text: 'secret-drop: nowhere to save (--no-env without --github).' }

    const started = await start($, {
      secrets: names.map(name => ({ name })),
      saveTo: [...saveTo],
      envFile,
      githubRepo,
      from: 'person',
    })
    if (typeof started === 'string') return { text: `secret-drop: ${started}` }

    return { text: `secret-drop: ${started.secrets.map(ask => ask.name).join(', ')}` }
  })

  if (guardPrompts) {
    on('prompt.submit', async ($, e, next) => {
      // only what a person typed: agents' notifications, routines and other sessions pass untouched
      if (!HUMAN_ORIGINS.has(e.origin.kind)) return next(e)
      const { found, text } = redactSecrets(e.text, notSecrets)
      if (found.length === 0) return next(e)
      $.clock.after(150, () => void $.prompt.fill({ text }))
      // the same guessed name twice gets a number, so neither key is dropped
      const used = new Map<string, number>()
      const secrets = found.map(item => {
        const n = (used.get(item.name) ?? 0) + 1
        used.set(item.name, n)
        return {
          name: n > 1 ? `${item.name}_${n}` : item.name,
          hint: S.guardHint(item.kind, item.isKnown),
          placeholder: item.placeholder,
          around: item.around,
        }
      })
      await start($, { secrets, from: 'guard', prefill: found.map(item => item.value), draft: text })

      return { drop: S.leaked(found.length) }
    })
  }

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    bandId = e.requestId
    const req = await read($, request)
    await read($, rev)
    const revealed = await read($, isRevealed)
    if (!req || e.props.hasSurvey || e.surface === 'mobile') return next(e)
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Input } = table
    // the terminal draws no Svg: it gets the text layout below
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : null
    // the desktop reports about 8 CSS pixels per column
    const W = Math.max(320, Math.min(1400, (e.props.bodyColumns || 100) * 8))
    const shownLine = (line: string) =>
      req.envFile && req.envLabel ? line.split(req.envFile).join(req.envLabel) : line
    const isGuard = req.from === 'guard'
    const title = isGuard ? S.guardTitle : req.from === 'person' ? S.personAsks : S.asks
    // what the band says under the name: why Claude needs it, or which string of the message was caught
    const detailOf = (index: number): Detail | undefined => {
      if (!isGuard) return req.reason ? { label: S.whyLabel, before: req.reason } : undefined
      const around = req.secrets[index]?.around
      const caught = prefill.get(index)
      if (!around && caught === undefined) return undefined
      return {
        label: S.caughtLabel,
        before: around?.before ?? '',
        mark: caught !== undefined ? peekOf(caught) : '…',
        after: around?.after ?? '',
        ...(caught !== undefined ? { tail: S.chars(caught.length) } : {}),
      }
    }

    if (Svg && req.phase !== 'input') {
      const lines = req.phase === 'saving' ? [] : req.report.map(line => ({ text: shownLine(line), tone: toneOf(line) }))
      return (
        <Box flexDirection="row" alignItems="flex-start" columnGap={1}>
          <Svg
            source={reportSvg(S.saving, lines, W - 40, req.phase === 'saving')}
            alt={req.phase === 'saving' ? S.saving : `${S.done}: ${lines.map(line => line.text).join('; ')}`}
            width={W - 40}
          />
          {req.phase === 'finished' && (
            <Button key="close" plain dimColor label="✕" role="dismiss" onPress={() => void update($, request, () => null)} />
          )}
        </Box>
      )
    }

    if (Svg) {
      const ask = req.secrets[req.index]
      if (!ask) return next(e)
      const count = req.secrets.length
      const destinations: Destination[] = []
      if (req.envFile) destinations.push({ kind: 'env', label: req.envLabel ?? req.envFile })
      if (req.github) destinations.push({ kind: 'github', label: S.ghTo(req.github.repo, req.github.environment) })
      const cueW = isGuard ? Math.max(cueWidth(S.nameCue), cueWidth(S.keyCue)) : cueWidth(S.cue)
      const detail = detailOf(req.index)
      const look = {
        title,
        ...(isGuard ? { reason: S.guardReason } : {}),
        name: ask.name,
        hint: ask.hint,
        ...(detail ? { detail } : {}),
        step: { index: req.index, count },
        destinations,
      }
      return (
        <Box flexDirection="column" rowGap={1}>
          <Svg
            key={`head-${req.id}-${req.index}-${W}`}
            source={headerSvg(look, W)}
            alt={`${look.title}: ${ask.name}${ask.hint ? `, ${ask.hint}` : ''}${detail ? `. ${detailText(detail)}` : ''} → ${destinations.map(d => d.label).join(', ')}`}
            width={W}
            height={headerHeight(look)}
          />
          {isGuard && (
            <Box flexDirection="row" alignItems="center" columnGap={1}>
              <Svg key={`cue-name-${cueW}`} source={cueSvg(S.nameCue, cueW)} alt={S.nameCue} width={cueW} height={CUE_H} />
              <Box>
                <Input
                  key={nameKey(req)}
                  value={ask.name}
                  submitLabel={S.next}
                  onInput={value => void renameAsk($, value)}
                  onSubmit={value => {
                    void renameAsk($, value).then(() => focusBand($, req))
                  }}
                />
              </Box>
            </Box>
          )}
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            <Svg
              key={`cue-${isGuard ? 'key' : 'ask'}-${cueW}`}
              source={cueSvg(isGuard ? S.keyCue : S.cue, cueW)}
              alt={isGuard ? S.keyCue : S.cue}
              width={cueW}
              height={CUE_H}
            />
            <Box>
              <Input
                key={inputKey(req)}
                placeholder={S.placeholder}
                value={revealed ? buffer : DOT.repeat(buffer.length)}
                submitLabel={req.index === count - 1 ? S.save : S.next}
                autoFocus
                onInput={value => {
                  buffer = revealed ? value : applyMaskedEdit(buffer, value)
                  void update($, rev, n => n + 1)
                }}
                onSubmit={value => {
                  buffer = revealed ? value : applyMaskedEdit(buffer, value)
                  void advance($, 'take')
                }}
              />
            </Box>
            <Box flexGrow={1} />
            <Button
              key="reveal"
              plain
              dimColor
              label={revealed ? S.hide : S.show}
              onPress={() => void update($, isRevealed, shown => !shown)}
            />
            {isGuard ? (
              <Button key="release" plain label={S.notKey} onPress={() => void release($)} />
            ) : (
              count > 1 && <Button key="skip" plain dimColor label={S.skip} onPress={() => void advance($, 'skip')} />
            )}
            <Button
              key="cancel"
              plain
              dimColor
              label={isGuard ? S.dontSave : S.cancel}
              role="dismiss"
              onPress={() => void finish($, true)}
            />
          </Box>
          <Svg key={`foot-${W}`} source={footSvg(S.footer, W)} alt={S.footer} width={W} height={FOOT_H} />
        </Box>
      )
    }

    if (req.phase !== 'input') {
      return (
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Box flexDirection="column">
            {req.phase === 'saving' ? (
              <Text dimColor>🔐 {S.saving}</Text>
            ) : (
              req.report.map(line => (
                <Text
                  wrap="truncate-middle"
                  color={line.startsWith('✗') ? 'red' : line.startsWith('⚠') ? 'yellow' : 'green'}
                >
                  {line}
                </Text>
              ))
            )}
          </Box>
          {req.phase === 'finished' && (
            <Button key="close" label={S.close} role="dismiss" onPress={() => void update($, request, () => null)} />
          )}
        </Box>
      )
    }

    const ask = req.secrets[req.index]
    if (!ask) return next(e)
    const count = req.secrets.length
    const isLast = req.index === count - 1
    const where = [
      req.envFile ? (req.envLabel ?? req.envFile) : undefined,
      req.github ? S.ghTo(req.github.repo, req.github.environment) : undefined,
    ].filter((line): line is string => line !== undefined)
    const detail = detailOf(req.index)
    const about = [isGuard ? S.guardReason : undefined, ask.hint].filter(Boolean).join(' · ')

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Text wrap="truncate-end">
            <Text bold>🔐 {title} </Text>
            <Text bold color="cyan">
              {ask.name}
            </Text>
            {count > 1 ? <Text dimColor> · {S.of(req.index + 1, count)}</Text> : ''}
          </Text>
          <Text dimColor wrap="truncate-middle">
            → {where.join(' · ')}
          </Text>
        </Box>
        {about !== '' && (
          <Text dimColor wrap="truncate-end">
            {about}
          </Text>
        )}
        {detail &&
          (detail.mark === undefined ? (
            <Text wrap="wrap">
              <Text dimColor>{detail.label} </Text>
              {detail.before}
            </Text>
          ) : (
            <Text wrap="truncate-start">
              <Text dimColor>{detail.label} «</Text>
              {detail.before}
              <Text bold color="cyan">
                {detail.mark}
              </Text>
              {detail.after}
              <Text dimColor>»{detail.tail ? ` · ${detail.tail}` : ''}</Text>
            </Text>
          ))}
        {isGuard && (
          <Input
            key={nameKey(req)}
            label={S.nameCue}
            value={ask.name}
            submitLabel={S.next}
            onInput={value => void renameAsk($, value)}
            onSubmit={value => {
              void renameAsk($, value).then(() => focusBand($, req))
            }}
          />
        )}
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Box flexGrow={1}>
            <Input
              key={inputKey(req)}
              label={isGuard ? S.keyCue : undefined}
              placeholder={S.placeholder}
              value={revealed ? buffer : DOT.repeat(buffer.length)}
              submitLabel={isLast ? S.save : S.next}
              autoFocus
              onInput={value => {
                buffer = revealed ? value : applyMaskedEdit(buffer, value)
                void update($, rev, n => n + 1)
              }}
              onSubmit={value => {
                buffer = revealed ? value : applyMaskedEdit(buffer, value)
                void advance($, 'take')
              }}
            />
          </Box>
          <Button
            key="reveal"
            label={revealed ? S.hide : S.show}
            onPress={() => void update($, isRevealed, shown => !shown)}
          />
          {isGuard ? (
            <Button key="release" label={S.notKey} onPress={() => void release($)} />
          ) : (
            count > 1 && <Button key="skip" label={S.skip} onPress={() => void advance($, 'skip')} />
          )}
          <Button key="cancel" label={isGuard ? S.dontSave : S.cancel} role="dismiss" onPress={() => void finish($, true)} />
        </Box>
        <Text dimColor>🔒 {S.footer}</Text>
      </Box>
    )
  })
}

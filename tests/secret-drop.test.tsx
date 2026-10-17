import { describe, expect, test } from 'claude-code/testing'

import { applyMaskedEdit, quoteEnv, redactSecrets, upsertEnv } from '../hooks/lib'

describe('masked field', () => {
  test('typing, pasting and deleting through dots', () => {
    let real = ''
    real = applyMaskedEdit(real, 'sk-abc') // paste into the empty field
    expect(real).toBe('sk-abc')
    real = applyMaskedEdit(real, '••••••d') // one more key after the redraw
    expect(real).toBe('sk-abcd')
    real = applyMaskedEdit(real, '••••••') // backspace
    expect(real).toBe('sk-abc')
    real = applyMaskedEdit(real, '•••X•••') // typed in the middle
    expect(real).toBe('sk-Xabc')
    real = applyMaskedEdit(real, '••••ef') // two keys before the redraw caught up
    expect(real).toBe('sk-Xef')
    real = applyMaskedEdit(real, 'new') // select all, paste
    expect(real).toBe('new')
  })
})

describe('dotenv', () => {
  test('replaces in place and appends the rest', () => {
    const before = '# keys\nexport OPENAI_API_KEY=old\nPORT=3000'
    const after = upsertEnv(
      before,
      new Map([
        ['OPENAI_API_KEY', 'sk-new'],
        ['TELEGRAM_BOT_TOKEN', '123:AA b'],
      ]),
    )
    expect(after).toBe("# keys\nexport OPENAI_API_KEY=sk-new\nPORT=3000\nTELEGRAM_BOT_TOKEN='123:AA b'\n")
  })

  test('quotes what needs quoting', () => {
    expect(quoteEnv('abc=')).toBe('abc=')
    expect(quoteEnv('pa ss#1')).toBe("'pa ss#1'")
    expect(quoteEnv("it's\nmulti")).toBe('"it\'s\\nmulti"')
  })
})

describe('prompt guard', () => {
  test('cuts known key shapes out of a prompt', () => {
    const key = `sk-ant-api03-${'x'.repeat(40)}`
    const bot = `1234567890:AA${'y'.repeat(33)}`
    const { found, text } = redactSecrets(`here is my key ${key} and bot ${bot}`)
    expect(found.map(item => item.kind)).toEqual(['Anthropic', 'Telegram bot'])
    expect(text).toBe('here is my key [Anthropic key removed] and bot [Telegram bot key removed]')
  })

  test('catches ElevenLabs keys and unknown keys named as such', () => {
    const fake = `sk_${'1c2b'.repeat(8)}`
    const { found, text } = redactSecrets(`Я хочу чтобы ты сохранил этот ключик от Elevenlabs API → ${fake}`)
    expect(found.map(item => item.kind)).toEqual(['ElevenLabs'])
    expect(text).toBe('Я хочу чтобы ты сохранил этот ключик от Elevenlabs API → [ElevenLabs key removed]')

    const loose = redactSecrets('вот токен от сервиса: Zq81kLm02XpR7tYv9wQe')
    expect(loose.found.map(item => item.kind)).toEqual(['API'])
    expect(loose.text).toBe('вот токен от сервиса: [key removed]')
  })

  test('leaves hashes, ids, links and variable names alone', () => {
    const texts = [
      'key commit 3f2a9c1e5b7d4f6a8c0e2b4d6f8a1c3e5b7d9f0a broke the build',
      'api request id 123e4567-e89b-12d3-a456-426614174000',
      'ключ лежит в https://example.com/docs/api/keys2024/v3/reference',
      'put the key into OPENAI_API_KEY_2024_PROD',
      'the token expires in 3600 seconds',
      'Сделай урок голосом через ElevenLabs (голос uuAEb8aX4QXTwh8CAexT, ключ ELEVENLABS_API_KEY в ~/Movies/.env)',
      'API: модель eleven_v4, voice_id uuAEb8aX4QXTwh8CAexT, ключ лежит в .env',
    ]
    for (const text of texts) expect(redactSecrets(text).found).toEqual([])
  })

  test('leaves ordinary text alone', () => {
    expect(redactSecrets('set OPENAI_API_KEY in .env, see sk-learn docs').found).toEqual([])
  })
})

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
} as const

describe('secure input flow', () => {
  test('a tool call shows the band above the prompt; typed value goes to .env, the model only hears the length', async ($, on) => {
    const writes: Array<{ path: string; text: string }> = []
    const submitted: string[] = []
    on('session.cwd', () => ({ value: '/proj' }))
    on('fs.exists', () => ({ value: false }))
    on('fs.write', (_$, e) => {
      writes.push({ path: e.path, text: e.text })
      return { value: undefined }
    })
    on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'not a repo', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('ui.focus', () => ({}))
    on('ui.close', () => ({ value: undefined }))
    on('prompt.submit', (_$, e) => {
      submitted.push(e.text)
      return { text: e.text }
    })

    const called = await $.tool.call({
      tool: 'mcp__secret-drop__request_secret',
      secrets: [{ name: 'OPENAI_API_KEY', hint: 'platform.openai.com' }],
      reason: 'for the bot',
    })
    expect(JSON.stringify(called)).toContain('End your turn')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'secret-drop', surface, component: 'AbovePrompt', props: BAND_PROPS })
      if (surface === 'desktop') {
        const head = await ui.find({ type: 'Svg' })
        expect(String((head?.props as { alt?: string } | undefined)?.alt)).toContain('OPENAI_API_KEY')
      } else {
        expect(await ui.find({ type: 'Text', text: 'OPENAI_API_KEY' })).toBeDefined()
      }
      await ui.unmount()
    }

    const ui = await $.ui.mount({ plugin: 'secret-drop', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    const field = await ui.find({ type: 'Input' })
    const key = field?.key ?? ''
    await ui.input({ key, text: 'sk-secret-123', kind: 'change' })
    expect((await ui.find({ type: 'Input' }))?.text).toBe('•'.repeat(13))
    await ui.input({ key, text: '•'.repeat(13) })

    expect(writes).toEqual([{ path: '/proj/.env', text: 'OPENAI_API_KEY=sk-secret-123\n' }])
    expect(submitted.length).toBe(1)
    expect(submitted[0]).toContain('OPENAI_API_KEY (13 chars)')
    expect(submitted[0]).not.toContain('sk-secret-123')
    await ui.unmount()
  })
})

describe('caught key', () => {
  test('a key pasted into a message opens the band already filled in, then the message gets its name', async ($, on) => {
    const key = `sk_${'9f3a'.repeat(8)}`
    const writes: Array<{ path: string; text: string }> = []
    const fills: string[] = []
    const draft = 'Use this elevenlabs key → [ElevenLabs key removed]'
    on('session.cwd', () => ({ value: '/proj' }))
    on('fs.exists', () => ({ value: false }))
    on('fs.write', (_$, e) => {
      writes.push({ path: e.path, text: e.text })
      return { value: undefined }
    })
    on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('ui.focus', () => ({}))
    on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
    on('prompt.fill', (_$, e) => {
      fills.push(e.text)
      return { isFilled: true }
    })

    const sent = await $.prompt.submit({ text: `Use this elevenlabs key → ${key}`, wait: false, origin: { kind: 'composer' } })
    expect('drop' in sent && typeof sent.drop === 'string').toBe(true)

    const desk = await $.ui.mount({ plugin: 'secret-drop', surface: 'desktop', component: 'AbovePrompt', props: BAND_PROPS })
    const head = await desk.find({ type: 'Svg' })
    expect(String((head?.props as { alt?: string } | undefined)?.alt)).toContain('ELEVENLABS_API_KEY')
    await desk.unmount()

    const ui = await $.ui.mount({ plugin: 'secret-drop', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    const inputs = await ui.findAll({ type: 'Input' })
    const nameField = inputs.find(item => String(item.key).startsWith('name-'))
    const valueField = inputs.find(item => String(item.key).startsWith('value-'))
    expect(valueField?.text).toBe('•'.repeat(key.length))
    await ui.input({ key: String(nameField?.key), text: 'ELEVEN_KEY', kind: 'change' })
    await ui.input({ key: String(valueField?.key), text: '•'.repeat(key.length) })

    expect(writes).toEqual([{ path: '/proj/.env', text: `ELEVEN_KEY=${key}\n` }])
    expect(fills.at(-1)).toBe('Use this elevenlabs key → ELEVEN_KEY (saved to .env in the project folder)')
    expect(fills.some(text => text.includes(key))).toBe(false)
    await ui.unmount()
  })
})

describe('origins', () => {
  test("an agent's notification that mentions a key-like id is not stopped", async ($, on) => {
    const delivered: string[] = []
    on('prompt.submit', (_$, e) => {
      delivered.push(e.text)
      return { text: e.text }
    })
    const text = `Agent finished: API key rotation done, run id Zq81kLm02XpR7tYv9wQe, key sk_${'9f3a'.repeat(8)}`
    const sent = await $.prompt.submit({ text, wait: false, origin: { kind: 'task-notification' } })
    expect('drop' in sent && sent.drop !== undefined).toBe(false)
    expect(delivered).toEqual([text])
  })
})

describe("another session's brief", () => {
  test('a long task handed to a new session is not stopped for a voice id near the word key', async ($, on) => {
    const delivered: string[] = []
    on('prompt.submit', (_$, e) => {
      delivered.push(e.text)
      return { text: e.text }
    })
    const brief =
      'Сделай урок для YouTube. Видео делать скиллом onetake, голосом Артёма через ElevenLabs: ' +
      'голос uuAEb8aX4QXTwh8CAexT, модель eleven_v4, ключ ELEVENLABS_API_KEY в ~/Movies/Instagram/.env (значение не выводить).'
    const sent = await $.prompt.submit({ text: brief, wait: false, origin: { kind: 'sdk' } })
    expect('drop' in sent && sent.drop !== undefined).toBe(false)
    expect(delivered).toEqual([brief])
  })
})

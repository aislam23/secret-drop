export type SecretAsk = {
  name: string
  hint?: string
  /** What stands for this key in a blocked prompt, to swap for its name once saved. */
  placeholder?: string
  /** The blocked prompt's words on both sides of the key, so the band shows which string was caught. */
  around?: { before: string; after: string }
}

export type SecretRequest = {
  id: string
  secrets: SecretAsk[]
  reason?: string
  /** Absolute path of the env file to write, when saving to one. */
  envFile?: string
  /** The env file as the window names it: relative to the project, or with ~. */
  envLabel?: string
  /** Set when saving to GitHub Actions secrets. */
  github?: { repo?: string; environment?: string }
  /** Who started it: the model's tool call, the person's /secret, or the prompt guard. */
  from: 'model' | 'person' | 'guard'
  /** The blocked prompt with its keys cut out, when the guard started it. */
  draft?: string
  index: number
  captured: string[]
  skipped: string[]
  /** Caught strings the person said are not keys: put back into the message, never saved. */
  released?: string[]
  phase: 'input' | 'saving' | 'finished'
  report: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'secret-drop': {
      request: SecretRequest | null
      rev: number
      isRevealed: boolean
    }
  }
}

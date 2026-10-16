# 🔐 secret-drop

A Claude Code mod for handing Claude API keys and passwords **without pasting them into the chat**.

When Claude needs a key, a band appears right above the prompt with a masked field. You paste the key and press Enter. The mod writes it to `.env` or GitHub Actions secrets on its own. Claude only learns `OPENAI_API_KEY saved (51 chars)`, never the value.

No more "start a local server so I can type the key in a browser".

The story of how this mod was built with Claude, step by step and with screenshots (in Russian): [How I taught Claude to take passwords and keys safely](https://islamov-tema.ru/blog/claude-secret-drop).

## Install

In a Claude Code terminal session:

```
/plugin install secret-drop --marketplace aislam23/secret-drop
```

Answer `y` to add the marketplace, then pick the user scope. Once installed at the user scope, the mod also works in the desktop app's Code tab.

## How it works

**Claude asks.** The mod gives Claude a `request_secret` tool and tells it to use the tool instead of asking for keys in the chat. Claude has to say what the key is for and where to get it: a call without a `reason` and a `hint` for every key is sent back to it, so the band never asks for a bare name.

> Claude: I need the OpenAI key for the bot. I've opened a secure field above your prompt.

```
(🔑)  Claude asks for a key                                      ●○ 1/2  [📄 .env in the project folder]
      OPENAI_API_KEY  platform.openai.com → API keys
      Why: the bot calls the OpenAI API

Paste the key →  [ •••••••••••••••••••• ] [next]                          Show   Skip   Cancel
🛡 The value never enters the chat. Claude only learns the name and length.
```

On the desktop app the band is drawn with SVG in Claude's own colours. In the terminal it is plain text.

After you press Enter on the last key, the mod saves everything and sends Claude a short report:

```
[secret-drop] The user finished the secure input you requested.
Entered: OPENAI_API_KEY (51 chars), TELEGRAM_BOT_TOKEN (46 chars).
✓ OPENAI_API_KEY, TELEGRAM_BOT_TOKEN → /Users/me/bot/.env
✓ added /.env to .gitignore
✓ OPENAI_API_KEY → GitHub Secrets (me/bot)
```

**You ask.** You can also open the field yourself:

```
/secret OPENAI_API_KEY STRIPE_SECRET_KEY
/secret DEPLOY_TOKEN --github                # .env plus this repo's GitHub secrets
/secret DEPLOY_TOKEN --github me/other-repo --no-env
/secret DB_PASSWORD --env-file config/.env.local
```

**Safety net.** If you paste a key straight into the chat anyway (OpenAI, Anthropic, ElevenLabs, GitHub, GitLab, AWS, Google, Stripe, Slack, Telegram bot, Supabase, Hugging Face, Groq, xAI, Perplexity, Replicate, npm, Yandex, private keys), the message is **not sent**. A long token next to words like *key*, *token*, *password* or *ключ* is caught too, even in an unknown format.

Instead, the band opens right away with the caught key already filled in (as dots) and a name guessed from its format, such as `ELEVENLABS_API_KEY`. It shows which string of the message was caught, so you can tell the keys apart: the words around it, the key's first and last four characters and its length.

```
(🔑)  Your message holds something that looks like a key · the message was not sent…   ●○○ 1/3
      API_KEY  unknown format: check that it is really a key
      Caught: «…and the token for the bot: Zq81…9wQe, then check the logs…» · 20 chars
```

Fix the name if you like and press Enter. The key is saved, and your message comes back into the prompt box with the key's name where the key was: `use ELEVENLABS_API_KEY (saved to .env in the project folder)`. If the caught string is not a key at all (an order id, say), press **Not a key**: it goes back into the message where it was and is let through for the rest of the session. Press **Don't save** to drop the key instead.

## What it does with the value

- **.env:** updates the line in place, keeping `export` if it was there, or appends a new one. Values with spaces or special characters get quoted. A new file gets `chmod 600`. If the file is in a git repo and not ignored, the mod adds it to `.gitignore`. If it is already committed, it warns you.
- **GitHub:** runs `gh secret set NAME [--repo] [--env]` and passes the value through **stdin**, so it never shows up in the process list. This needs [`gh`](https://cli.github.com) to be signed in.
- The value stays only in the mod's memory until it is saved. It is not written to the transcript, the mod's state, logs or the message to Claude, and the masked field shows dots.

## Settings

In `/config` → secret-drop:

| Option | Default | |
| --- | --- | --- |
| `language` | `auto` | `en` / `ru` window text. `auto` follows `LANG`, falling back to the macOS language list |
| `guardPrompts` | `true` | block messages that contain keys |

## Limits

- This keeps secrets out of the **conversation**. Claude can still run `cat .env` if you allow it, so say no to that request. The tool's description tells Claude not to.
- The masked field redraws as you type. Over a slow link a character may show for a split second before it turns into a dot.
- On the desktop app the text field has a fixed width, so a very long key scrolls inside it.
- Other mods that hook `ui.input` could see what you type, just as any installed plugin sees your keystrokes. Install mods you trust.
- The mobile app has no text field yet. Use the terminal or the desktop app.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

MIT © Artem Islamov

---

## По-русски

Мод для Claude Code: передаёт Claude ключи и пароли **без вставки в чат**. Когда Claude нужен ключ, прямо над полем сообщения появляется плашка со скрытым полем. Вставляешь ключ, жмёшь Enter, и мод сам кладёт его в `.env` или в GitHub Secrets. Claude узнаёт только «OPENAI_API_KEY сохранён (51 симв.)».

- Claude сам вызывает инструмент `request_secret`, а ты можешь открыть окно сам: `/secret ИМЯ [--github]`.
- Claude обязан объяснить, что это за ключ, зачем он нужен и где его взять: вызов без `reason` и `hint` возвращается ему обратно.
- Если всё-таки вставишь ключ в сообщение, оно не уйдёт. Сразу откроется плашка с уже подставленным ключом и угаданным именем (например `ELEVENLABS_API_KEY`) и покажет, какая именно строка поймана: слова вокруг, первые и последние 4 символа, длина. Жмёшь Enter, и ключ сохранён, а в сообщении вместо ключа стоит его имя. Если это не ключ (номер заказа, id), жми «Это не ключ»: строка вернётся в сообщение.
- `.env` добавляется в `.gitignore`. В GitHub значение уходит через stdin `gh secret set`.

Как мод делался вместе с Claude, со скриншотами и выводами про работу с агентом: [Как я научил Claude безопасно брать пароли и ключи с помощью мода](https://islamov-tema.ru/blog/claude-secret-drop).

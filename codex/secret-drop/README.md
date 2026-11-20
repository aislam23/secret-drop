# Secret Drop for Codex — защищённый ввод секретов на macOS

**Версия: 0.6.0.** Оригинальный проект [aislam23/secret-drop](https://github.com/aislam23/secret-drop), MIT, commit `a54d43a` / Claude plugin `0.2.2`. Эта реализация для Codex ведётся отдельно и не заменяет оригинальный Claude-плагин.

## Что происходит при запросе секретов

1. Codex вызывает локальный MCP-инструмент `secret-drop-local.request_secret` с `name` (один ключ) или `secrets: [{name, hint?}, ...]` (до 12 переменных). Поддержаны короткий plain-text `reason`, `env_file: "config/.env.local"` внутри существующего проекта и `github_environment`. Передаёт место сохранения, **не значение ключа**.
2. На Mac появляется **небольшое отдельное окно AppKit**, не встроенное в поле ввода Codex. Имена переменных отображаются в бордовых моноширинных плашках, по центру горизонтально и вертикально; скрытые поля расположены справа. Для длинного списка есть прокрутка.
3. Перед Save человек видит полный локально вычисленный target и отмечает `I confirm the exact destination above`. Для `github`/`both` нужна отдельная отметка на внешний GitHub write с явным repo/environment. **Пустые поля пропускаются независимо**, отмена или неотмеченное подтверждение не пишут ничего. Все заполненные значения одной операцией записываются в выбранный `.env`/`.env.*` с режимом `0600`; прежние значения пропущенных имён сохраняются.
4. **После записи локальный процесс сам проверяет файл**: точные записанные значения сравниваются с исходными в памяти процесса, проверяется владелец, регулярный файл и права `0600`. Codex получает только имена и статусы `Saved and verified locally`, `NOT VERIFIED`, `Skipped (not entered)`, без содержимого секретов. Проверка не устанавливает, что внешний сервис примет API-ключ.
5. Отдельное назначение `github` или `both` требует явного разрешения и репозитория: `gh secret set` получает секрет через stdin, а `--env` передаётся отдельным argv-аргументом. Успешный код возврата `gh` **не доказывает работоспособность ключа** и не является независимым подтверждением внешнего сервиса. GitHub batch не атомарен.

## Границы parity с upstream

| Возможность | Статус для Codex | Граница |
| --- | --- | --- |
| Один или несколько секретов, Save/Skip/Cancel, masked AppKit GUI | Supported | Компактное отдельное macOS окно: бордовые mono-плашки слева, masked поля справа. |
| `reason`, безопасный `hint`, точный nested `env_file` | Supported | Только plain text без control/bidi; target только внутри canonical проекта, его parent уже существует. |
| `.env` write/readback | Supported | `dir_fd`/`O_NOFOLLOW`, regular one-link user-owned file, лимит 1 MiB; `.gitignore` получает точное правило выбранного файла. Существующий dotenv обязан быть `0600`. |
| GitHub repo/environment | Supported | После отдельного human approval; value только stdin, repo/environment только argv. |
| Ручной вызов | Supported | Скилл ниже использует тот же `secret-drop-local.request_secret`; отдельного `/secret` composer command нет. |
| `UserPromptSubmit` heuristic | Partial | Bundled hook — публично поддерживаемый механизм, но Codex выполняет hooks лишь после human trust. Установка, enablement и interception в конкретном host **не проверены E2E**; это не default DLP и не prefill/draft restore. |
| OpenCode transform | Partial / experimental | Он не доказывает pre-admission security; его runtime dependency не считается audit-проверенной host integration, и host E2E не выполнен. |
| Плашка внутри composer, перехват с prefill, draft restore | Unavailable | Нет подтверждённого supported API; не используются Accessibility overlay, private API или патчинг приложения. |

## Модель угрозы и ограничения writer

До чтения существующего dotenv/helper `.gitignore` writer открывает file descriptor с no-follow и проверяет type, link count, owner, размер и режим. Он держит descriptor директории во время atomic replace и откажется от symlink, hardlink, non-regular, foreign-owned, group/world-writable directory или небезопасного пути. Это предотвращает обычные path substitution и импорт прежнего содержимого через hardlink.

Процесс того же macOS UID, имеющий право одновременно менять тот же project directory, всё ещё нельзя полностью исключить одними POSIX filesystem checks: это не sandbox и не защита от злонамеренного равноправного локального процесса. Не запускайте Secret Drop в совместно writable checkout; для более сильной границы нужна изоляция ОС/пользователя.

## Синтетическая автономная E2E-проверка (не запускать с реальными ключами)

Создайте новый временный проект внутри home с существующим `config/`; запросите `TEST_ONE` и `TEST_TWO`, `reason`, `env_file: config/.env.local`, а при GitHub-ветке используйте mock `gh`, `example/demo` и `staging`. Проверьте отдельный AppKit modal, полный target, две checkbox-подтверждения для `both`, Save с заполненным только `TEST_ONE`, и только status-only ответ. Затем отдельно Cancel, all-blank и снятое confirmation: ни dotenv, ни mock `gh` не должны измениться. Не вводите или не печатайте реальные секреты; эта процедура не является host hook E2E.

## Отличие от Claude Code

В оригинале плашка появляется внутри интерфейса Claude (`AbovePrompt`). Для Codex Desktop на текущем публичном API **не подтверждена возможность** встроить собственный защищённый контрол непосредственно над composer. Не используются Accessibility overlay, приватные API или патчинг бинарника. Отдельное окно остаётся ограничением среды.

## Обновление и проверка

```sh
codex plugin marketplace add shzk/secret-drop --ref feat/codex-secret-drop
codex plugin marketplace upgrade secret-drop-tkrv
codex plugin remove secret-drop-codex@secret-drop-tkrv
codex plugin add secret-drop-codex@secret-drop-tkrv
```

После обновления нужна **новая сессия Codex Desktop**. Проверка в тестовом проекте: запросить `TEST_ONE` и `TEST_TWO`, заполнить только первое вымышленным значением и Save. Codex должен получить `TEST_ONE saved and verified`, `TEST_TWO skipped`; `stat -f '%Sp' .env` должен показать `-rw-------`. В чат **не выводить значения** и не давать модели читать файл. Отдельно проверить Cancel, пустой ввод и запрет чтения секретов инструментами агента.

Реальные API-ключи, production и новые платные интеграции в тестах не используются. Установка, компиляция и unit-тесты не заменяют пользовательскую визуальную приёмку. История испытаний хранится в каноническом Engineering Knowledge.

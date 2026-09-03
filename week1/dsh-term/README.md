# dsh-term

Своя интерактивная терминальная CLI для [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — тонкий клиент поверх SDK JSON-RPC протокола. Ноль внешних зависимостей, только Node.js.

## Как это работает

```
dsh-term
   │  spawn
   ▼
dsh --profile sdk   ◄── JSON-RPC 2.0 по newline-delimited stdio
   │  (initialize / session/prompt / shutdown)
   ▼
Harness runtime (полный агент: инструменты, сессии, субагенты)
```

- **Пока модель думает — в терминале плывёт кит DeepSeek** (`🐋~~~~ deep diving…`); пошёл видимый ответ — кит останавливается и текст стримится; после вызова инструмента кит возвращается.
- Активность инструментов выводится строками (`▶ bash …`, `✔ done`)
- Сессии стойкие: последняя сессия запоминается и **автоматически продолжается** при следующем запуске; есть `/resume` и `--resume`
- События субагентов (`subagent.started`) тоже рендерятся

## Первый вход: токен

При первом запуске `dsh-term` сам запросит DEEPSEEK API ключ (ввод скрыт) и сохранит его в managed-хранилище харнесса — `<home>/.credentials.yaml` (формат `version: 1` / `refs` / `records`). Дальше токен берётся оттуда автоматически; харнесс подхватывает его сам. Сменить токен — команда `/token`.

Приоритет токена: окружение (`DEEPSEEK_API_KEY`) → хранилище → интерактивный запрос.

## Запуск

```powershell
dsh-term
```

Изолированный home по умолчанию — `~/.dsh-term` (SDK-рекомендация: не смешивать с `~/.dsh`). Чтобы переиспользовать managed credentials из общего home:

```powershell
dsh-term --dsh-home C:\Users\<you>\.dsh
```

## Опции

| Флаг | Назначение |
|---|---|
| `--dsh-home <path>` | Harness home (default: `~/.dsh-term`) |
| `--profile <name>` | профиль рантайма (default: `sdk`) |
| `--provider <id>` | провайдер (default: `deepseek-official`; env `DSH_TERM_PROVIDER`) |
| `--model <name>` | модель (default: `deepseek-v4-flash`; env `DSH_TERM_MODEL`) |
| `--max-tokens <n>` | лимит токенов ответа |
| `--session <id>` | продолжить конкретную сессию (синоним: `--resume <id>`) |
| `--workspace <path>` | рабочая папка сессий (default: текущая) |
| `--dsh-bin <path>` | путь к `dsh` (default: `dsh` из PATH) |

## Команды REPL

```
/help            справка
/session         показать id текущей сессии
/resume [id]     продолжить сессию: по id или выбором из списка
/new             начать новую сессию
/token           сменить сохранённый API ключ
/exit            завершить (или Ctrl+C)
```

## Примечания

- **Анимация** — только в интерактивном терминале (TTY); отключить: `DSH_TERM_NO_ANIM=1`. На пайпе поведение обычное, построчное.
- **Сессии на диске**: `sessions/<ns-по-рабочей-папке>/<sessionId>/session.jsonl[.zstd]` (сжатие zstd по умолчанию); `/resume` находит их рекурсивно.
- **Скриптовый ввод**: stdin читается построчно; при EOF (`< file`, Ctrl+Z+Enter) после обработки всех строк CLI корректно завершается. Внимание: пайп из Windows PowerShell 5.1 в нативные процессы не закрывает stdin — для скриптов используйте редирект из файла (`cmd /c "dsh-term < in.txt"`).
- **Внутренности**: реализовано по [@deepseek-ai/dsh-sdk-protocol](C:/Program%20Files/dsh/deepseek-harness/packages/sdk/protocol/README.md): запросы `initialize` / `session/prompt` / `shutdown`; нотификации `session.event` / `session.status` / `subagent.started` / `subagent.finished`; одна JSON-RPC 2.0 фрейма на строку; битые строки игнорируются.
- **Патч харнесса** (resume-сессий): `C:/Program%20Files/dsh/deepseek-harness/packages/sdk/server/` — `createSession` пробует `agents.resume`, а `create` только для новых id. При переустановке харнесса патч сотрётся.

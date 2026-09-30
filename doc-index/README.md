# doc-index — локальный индекс документов с эмбеддингами

День 21: пайплайн индексации — **чанкинг → эмбеддинги → индекс с метаданными → поиск**,
и сравнение двух стратегий чанкинга на размеченном наборе вопросов.

Корпус — хранилище Obsidian `effective-ai` (заметки про AI SDLC: карточки понятий,
конспекты кластера, ЗУН-матрицы). Хранилище открывается **только на чтение**: ничего
в него не пишется, все артефакты лежат в `out/`.

## Что сделано

| Шаг | Реализация |
|---|---|
| Сбор корпуса | `collect.py`: обход хранилища, frontmatter (теги, источник), чистка разметки Obsidian, нумерация строк сохраняется |
| Чанкинг | `chunk.py`: две стратегии — `fixed` (окно 1000 символов, перекрытие 150) и `structural` (иерархия заголовков + хлебные крошки) |
| Эмбеддинги | `embed.py`: локальная Ollama, модель `bge-m3` (1024 измерения, 8192 токена контекста), кэш по хешу текста |
| Индекс | `store.py`: SQLite (метаданные + текст + FTS5) **и** FAISS **и** JSON-выгрузка |
| Поиск | `search.py`: векторный (FAISS) + лексический (FTS5/BM25), слияние через RRF |
| Сравнение | `evaluate.py`: 23 вопроса с эталонами → `recall@1`, `recall@5`, `MRR` |
| CLI | `cli.py`: `index`, `search`, `evaluate`, `stats` |

## Метаданные чанка

`chunk_id`, `source`, `file`, `title`, `section`, `breadcrumb`, `folder`, `tags`,
`links`, `doc_source`, `start_line`, `end_line`, `n_chars`, `n_tokens_est`, `merged`, `text`.

Две стратегии дают **одинаковую** схему — иначе сравнение было бы нечестным.
`start_line`/`end_line` настоящие, по ним чанк открывается в Obsidian в том же месте.

## Запуск

Зависимости: `pyyaml`, `numpy`, `faiss-cpu` (см. `requirements.txt`) и локальная Ollama
с моделью:

```powershell
ollama pull bge-m3          # 1.2 ГБ, один раз
```

```powershell
cd doc-index
python -m doc_index stats                                  # корпус и чанки, без модели
python -m doc_index index --strategy fixed,structural,structural_nobc
python -m doc_index search "чем агент отличается от модели" --strategy structural
python -m doc_index evaluate                                # сравнение стратегий
```

Параметры чанкинга переопределяются флагами (`--fixed-size`, `--fixed-overlap`,
`--structural-max`, `--structural-min`), корпус — `--vault`, артефакты — `--out`.

## Тесты

```powershell
python -m unittest discover -s tests
```

28 тестов: чистка разметки и нумерация строк, границы чанков, хлебные крошки, склейка
коротких секций, заголовки внутри код-блоков, FTS-запрос, слияние RRF, выдача
с метаданными. Сеть и Ollama для тестов не нужны: эмбеддер подменён детерминированным.

## Артефакты в `out/`

- `index.db` — SQLite: чанки, FTS5, эмбеддинги, кэш;
- `index_<стратегия>.faiss` — векторный индекс;
- `chunks_<стратегия>.json` — выгрузка чанков с метаданными;
- `metrics.md`, `metrics.json` — сравнение стратегий.

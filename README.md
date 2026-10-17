# custom-theme-minimalism

Минималистичный кастомный футер для [Pi](https://pi.dev) (`@earendil-works/pi-coding-agent`):
каталог + git-ветка слева, токены сессии / использование контекста / статус MCP-серверов справа.
Цвет каждого элемента настраивается отдельно.

## Что показывает футер

```
~/project (main)          ↑12.3K ↓4.1K  76.3K/1M  MCP:2/5
```

- слева: текущий рабочий каталог (`~` вместо home) и git-ветка в скобках, если каталог — репозиторий;
- справа: input/output токены сессии, использование контекста (`used/window`), статус MCP-серверов
  (`MCP:N/M`, где N — сервера с видимыми tools, M — включённые сервера из `mcp.json`); текст статуса
  зелёный, если все сервера подключены, иначе красный.

## Установка

Расширение — обычный TypeScript-файл Pi. Самый простой способ — симлинк в пользовательскую
директорию расширений:

```bash
ln -s "$(pwd)/custom-footer.ts" ~/.pi/agent/extensions/custom-footer.ts
ln -s "$(pwd)/custom-footer-support" ~/.pi/agent/extensions/custom-footer-support
```

Футер активируется автоматически при старте Pi (`session_start`), без команды.

## Настройка цвета

Создайте (не коммитьте) файл `~/.pi/agent/custom-footer-support/colors.json` — все поля опциональны,
значение — либо имя foreground-токена активной темы Pi (`dim`, `muted`, `text`, `accent`, `success`,
`error`, ...), либо hex-цвет `"#rgb"`/`"#rrggbb"`:

```json
{
  "cwd": "muted",
  "branch": "muted",
  "tokens": "muted",
  "context": "muted",
  "mcpOk": "success",
  "mcpBad": "error"
}
```

См. `colors.example.json` как шаблон. Конфиг перечитывается на каждом рендере футера — изменения
применяются без перезапуска Pi. Отсутствующий файл или невалидный JSON — используются дефолты из
примера выше. Невалидное значение одного поля откатывается к дефолту только для этого поля.

## Разработка

Чистая логика (форматирование чисел, цветов, подсчёт MCP-серверов) вынесена в
`custom-footer-support/helpers.ts` и покрыта тестами на `node:test`:

```bash
node --test custom-footer-support/custom-footer.test.mjs
```

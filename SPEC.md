# ClipSnap — Clipboard Image Paste for Terminal AI Tools

## Technical Specification v1.0

---

## 1. Overview

**ClipSnap** — MCP-сервер + Claude Code плагин, решающий проблему ненадёжной вставки изображений из буфера обмена в терминальных AI-инструментах (Claude Code, Codex CLI, Gemini CLI).

### Проблема

Ctrl+V image paste в iTerm2 + Claude Code работает ~50-60% времени из-за:
- **ENOBUFS**: osascript дампит весь PNG как hex → buffer overflow
- **Sandbox**: `sandbox-exec` блокирует `com.apple.hiservices-xpcservice`
- **Race condition**: async clipboard read не синхронизирован с focus state

Те же проблемы есть у Codex CLI и Gemini CLI. Это фундаментальная проблема терминальных эмуляторов — у них нет стандартного протокола для передачи бинарных данных из clipboard.

### Решение

MCP-сервер, работающий как отдельный Node.js-процесс:
- **Обходит sandbox** (sandbox-exec оборачивает только Bash tool, не MCP-серверы)
- **Возвращает image content напрямую** через MCP protocol (base64)
- **Работает с любым MCP-клиентом** (Claude Code, Codex CLI, Gemini CLI, Cursor)
- **Надёжно** — использует `pngpaste` с fallback на `osascript`

### Naming

| Элемент | Название |
|---------|----------|
| npm package | `clipsnap-mcp` |
| MCP server name | `clipsnap` |
| Claude Code plugin | `clipsnap` |
| GitHub repo | `clipsnap-mcp` |
| Tool prefix | `mcp__clipsnap__` |

---

## 2. Architecture

### Компоненты

```
clipsnap-mcp/
├── .claude-plugin/
│   └── plugin.json               # Claude Code plugin manifest
├── commands/
│   ├── paste.md                  # /clipsnap:paste — single image
│   └── paste-recent.md           # /clipsnap:paste-recent — last N from folder
├── hooks/
│   └── hooks.json                # UserPromptSubmit auto-detect (optional)
├── scripts/
│   └── auto-detect.sh            # Hook script
├── .mcp.json                     # MCP server bundled config
├── src/
│   ├── index.ts                  # MCP server entry point
│   ├── clipboard.ts              # Clipboard reading (pngpaste/osascript)
│   ├── image.ts                  # Image processing (resize, format)
│   ├── storage.ts                # Temp file management + cleanup
│   ├── security.ts               # ConcealedType/TransientType checks
│   └── config.ts                 # Configuration from env vars
├── package.json
├── tsconfig.json
├── LICENSE                       # MIT
└── README.md
```

### Stack

| Решение | Почему |
|---------|--------|
| **TypeScript** | Рекомендован MCP SDK, самый зрелый SDK (v1.27), 30K+ проектов на npm |
| **@modelcontextprotocol/sdk** v1.x | Стабильный production API |
| **stdio transport** | Стандарт для локальных CLI-инструментов |
| **pngpaste** (primary) | Быстрый, надёжный, без AppleScript overhead |
| **osascript** (fallback) | Работает без дополнительных зависимостей |
| **sharp** (optional) | Resize/compress — если установлен, иначе sips (macOS built-in) |

### Flow: вставка одного изображения

```
User: "посмотри скриншот" или /clipsnap:paste
  │
  ▼
Claude Code → вызывает MCP tool `paste_image`
  │
  ▼
ClipSnap MCP Server (отдельный Node.js процесс, ВНЕ sandbox):
  1. Security check: ConcealedType / TransientType маркеры
  2. Read clipboard: pngpaste → osascript fallback
  3. Save to $TMPDIR/clipsnap-<session>/img-<timestamp>.png
  4. Resize if needed (max 1568px long side)
  5. Encode to base64
  6. Cleanup old files (TTL/count/size)
  7. Return MCP response with image content
  │
  ▼
Claude Code получает image content → видит картинку → отвечает
```

### Flow: несколько изображений из папки

```
User: "сравни последние 3 скриншота из ~/Screenshots"
  │
  ▼
Claude Code → вызывает MCP tool `paste_recent`
  │
  ▼
ClipSnap MCP Server:
  1. Read last N files from specified folder (sorted by mtime)
  2. Filter by image extensions (png, jpg, jpeg, gif, webp, tiff, heic)
  3. Resize each if needed
  4. Return MCP response with multiple image content blocks
  │
  ▼
Claude Code получает N изображений → видит все → отвечает
```

---

## 3. MCP Tools

### 3.1 `paste_image`

Читает изображение из системного буфера обмена.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `format` | `"png" \| "jpeg"` | no | from config | Output format |
| `quality` | `number (1-100)` | no | 80 | JPEG quality (ignored for PNG) |
| `max_dimension` | `number` | no | 1568 | Max long edge in pixels |
| `save` | `boolean` | no | true | Save copy to temp dir |

**Response:** MCP image content (base64)

```json
{
  "content": [
    {
      "type": "image",
      "data": "<base64>",
      "mimeType": "image/png"
    },
    {
      "type": "text",
      "text": "Image from clipboard (1920x1080 → resized to 1568x882, 247KB). Saved: /tmp/clipsnap/img-1741234567.png"
    }
  ]
}
```

**Error responses:**

| Ситуация | Response |
|----------|----------|
| Clipboard пуст / нет изображения | `"No image found in clipboard. Copy a screenshot first (Cmd+Shift+4 or from Shottr)."` |
| ConcealedType detected | `"Clipboard contains concealed data (possibly a password). Skipping for security."` |
| TransientType detected | `"Clipboard contains transient data. It may have expired. Try copying again."` |
| pngpaste not found | `"pngpaste not installed. Install: brew install pngpaste. Using osascript fallback."` |
| osascript fallback failed | `"Failed to read clipboard image. Ensure Terminal has clipboard access in System Settings."` |

### 3.2 `paste_recent`

Читает последние N изображений из указанной папки.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `count` | `number (1-10)` | no | 3 | Number of images |
| `folder` | `string` | no | `~/Screenshots` | Source folder |
| `max_dimension` | `number` | no | 1568 | Max long edge |

**Response:** Multiple image content blocks

```json
{
  "content": [
    { "type": "text", "text": "3 recent images from ~/Screenshots:" },
    { "type": "image", "data": "<base64_1>", "mimeType": "image/png" },
    { "type": "text", "text": "1. Screenshot 2026-03-06 at 14.23.45.png (1568x882)" },
    { "type": "image", "data": "<base64_2>", "mimeType": "image/png" },
    { "type": "text", "text": "2. Screenshot 2026-03-06 at 14.20.12.png (1568x882)" },
    { "type": "image", "data": "<base64_3>", "mimeType": "image/png" },
    { "type": "text", "text": "3. Screenshot 2026-03-06 at 14.15.33.png (1568x882)" }
  ]
}
```

### 3.3 `paste_file`

Читает конкретный файл изображения по пути.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | **yes** | — | Absolute or ~ path to image |
| `max_dimension` | `number` | no | 1568 | Max long edge |

**Response:** Single image content block

### 3.4 `list_images`

Показывает сохранённые изображения текущей сессии.

**Parameters:** none

**Response:**
```json
{
  "content": [{
    "type": "text",
    "text": "ClipSnap session images (4 files, 12.3 MB):\n1. img-1741234567.png (1568x882, 3.1 MB) — 5 min ago\n2. img-1741234400.png (1568x1024, 2.8 MB) — 8 min ago\n..."
  }]
}
```

### 3.5 `cleanup_images`

Принудительная очистка temp-файлов.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `all` | `boolean` | no | false | Delete ALL sessions (not just current) |
| `older_than_minutes` | `number` | no | 0 | Delete files older than N minutes |

---

## 4. Claude Code Plugin Components

### 4.1 plugin.json

```json
{
  "name": "clipsnap",
  "version": "1.0.0",
  "description": "Reliable clipboard image paste for terminal AI tools. Bypasses iTerm2/terminal clipboard bugs.",
  "author": {
    "name": "Aleksei Zelentsov"
  },
  "repository": "https://github.com/<username>/clipsnap-mcp",
  "license": "MIT",
  "keywords": ["clipboard", "image", "paste", "screenshot", "iTerm2"]
}
```

### 4.2 .mcp.json

```json
{
  "mcpServers": {
    "clipsnap": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"],
      "env": {
        "CLIPSNAP_MAX_FILES": "50",
        "CLIPSNAP_TTL_MINUTES": "60",
        "CLIPSNAP_MAX_SIZE_MB": "200",
        "CLIPSNAP_MAX_DIMENSION": "1568",
        "CLIPSNAP_IMAGE_FORMAT": "png",
        "CLIPSNAP_JPEG_QUALITY": "80",
        "CLIPSNAP_SCREENSHOTS_DIR": "~/Screenshots",
        "CLIPSNAP_CHECK_CONCEALED": "true",
        "CLIPSNAP_CLEANUP_ON_EXIT": "true"
      }
    }
  }
}
```

### 4.3 /clipsnap:paste command

```markdown
---
description: Paste an image from clipboard into the conversation
---

Use the `paste_image` MCP tool from the clipsnap server to read the current clipboard image
and include it in your response. If no image is found, tell the user to copy a screenshot first.
```

### 4.4 /clipsnap:paste-recent command

```markdown
---
description: Include last N screenshots from the screenshots folder
---

Ask the user how many recent screenshots to include (default: 3).
Use the `paste_recent` MCP tool from the clipsnap server.
Show each image with its filename and timestamp.
```

### 4.5 UserPromptSubmit Hook (optional, disabled by default)

**hooks.json:**
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "type": "command",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/auto-detect.sh"
      }
    ]
  }
}
```

**auto-detect.sh** — добавляет hint в контекст, если промпт содержит ключевые слова:
```bash
#!/bin/bash
# Read hook input from stdin
input=$(cat)
prompt=$(echo "$input" | jq -r '.prompt // ""')

# Check for image-related keywords (ru + en)
if echo "$prompt" | grep -qiE '(скриншот|скрин|screenshot|image|картинк|фото|экран|снимок|paste|вставь)'; then
  # Check if clipboard actually has an image
  if command -v pngpaste &>/dev/null; then
    if pngpaste - >/dev/null 2>&1; then
      echo '{"additionalContext": "[ClipSnap] Clipboard contains an image. Use the paste_image tool from clipsnap to read it."}'
      exit 0
    fi
  fi
fi

echo '{"continue": true}'
```

**Почему disabled by default:** hook срабатывает на КАЖДЫЙ промпт, вызывает pngpaste каждый раз. Для пользователей, которые редко вставляют скрины — лишний overhead. Включается вручную в настройках.

---

## 5. Security

### 5.1 Clipboard Safety

```typescript
// security.ts — проверки перед чтением clipboard
interface ClipboardSafetyResult {
  safe: boolean;
  reason?: string;
}

async function checkClipboardSafety(): Promise<ClipboardSafetyResult> {
  // 1. Check ConcealedType (passwords from 1Password, Bitwarden, etc.)
  // Uses: osascript -e 'clipboard info'
  // Look for: "org.nspasteboard.ConcealedType"

  // 2. Check TransientType (temporary clipboard data)
  // Look for: "org.nspasteboard.TransientType"

  // 3. Verify image type exists
  // Look for: "public.png" or "public.tiff" or "public.jpeg"
}
```

### 5.2 File Safety

- Temp files created with mode `0600` (owner read/write only)
- UUID-based subdirectories per session: `$TMPDIR/clipsnap-<uuid>/`
- No predictable file paths (timestamp + random suffix)
- Graceful shutdown handler cleans up files

### 5.3 No Data Leaks

- Clipboard content is NEVER logged (not even in debug mode)
- Image data is NEVER cached in memory beyond the current request
- Temp files are the only persistence, controlled by cleanup policy
- No network calls, no telemetry, no external services

### 5.4 macOS 16 Readiness

macOS 16 (Tahoe) введёт iOS-style clipboard privacy prompt — приложения получат алерт при программном чтении pasteboard.

**Подготовка:**
- `pngpaste` будет вызывать системный промпт → пользователь разрешит один раз для Terminal
- Документировать в README: "Allow clipboard access when prompted"
- Graceful handling: если доступ запрещён → понятное сообщение + инструкция

---

## 6. Storage & Cleanup

### 6.1 File Layout

```
$TMPDIR/
└── clipsnap-<session-uuid>/
    ├── img-1741234567-a1b2.png
    ├── img-1741234600-c3d4.png
    └── img-1741234700-e5f6.jpeg
```

- `$TMPDIR` — per-user directory (mode 0700), macOS auto-cleans after 3 days
- Session UUID — isolates files between multiple Claude Code tabs
- Timestamp + random suffix — prevents collision and predictability

### 6.2 Cleanup Strategy (defense in depth)

| Layer | Trigger | Default | Description |
|-------|---------|---------|-------------|
| **Count limit** | After each save | 50 files | Delete oldest when exceeded |
| **TTL** | After each save | 60 minutes | Delete files older than TTL |
| **Size limit** | After each save | 200 MB | Delete oldest when total size exceeded |
| **Session exit** | SIGINT/SIGTERM | enabled | Delete current session directory |
| **OS fallback** | macOS periodic | 3 days | $TMPDIR auto-cleanup |
| **Manual** | `cleanup_images` tool | — | User-triggered cleanup |

### 6.3 Multi-Session Behavior

| Сценарий | Поведение |
|----------|-----------|
| 3 таба Claude Code | Каждый — свой MCP process, свой session UUID, своя папка |
| Один таб вызывает `paste_image` | Читает clipboard, другие табы не затронуты |
| Два таба одновременно вызывают `paste_image` | Оба прочитают одно и то же (clipboard — singleton), сохранят в разные файлы |
| Один таб завершается | Cleanup только его папки, другие нетронуты |
| `cleanup_images(all=true)` | Удаляет ВСЕ clipsnap-* папки |

### 6.4 Disk Usage Estimates

| Сценарий | Без resize | С resize (1568px) | JPEG 80 + resize |
|----------|-----------|-------------------|-------------------|
| 1 Retina скриншот | ~4 MB | ~1.5 MB | ~0.4 MB |
| 10 скриншотов/день | ~40 MB | ~15 MB | ~4 MB |
| 50 скриншотов/день | ~200 MB | ~75 MB | ~20 MB |
| 100 скриншотов/день | ~400 MB | ~150 MB | ~40 MB |

---

## 7. Configuration

Все параметры задаются через environment variables в MCP-конфигурации.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CLIPSNAP_MAX_FILES` | number | 50 | Max files per session |
| `CLIPSNAP_TTL_MINUTES` | number | 60 | File time-to-live |
| `CLIPSNAP_MAX_SIZE_MB` | number | 200 | Max total size per session |
| `CLIPSNAP_MAX_DIMENSION` | number | 1568 | Max image long edge (px). Claude's internal limit — values above this waste tokens without quality gain |
| `CLIPSNAP_IMAGE_FORMAT` | `png \| jpeg` | png | Output format. JPEG saves ~5x disk but lossy |
| `CLIPSNAP_JPEG_QUALITY` | number (1-100) | 80 | JPEG quality. 80 = good for code screenshots |
| `CLIPSNAP_SCREENSHOTS_DIR` | path | ~/Screenshots | Default folder for `paste_recent` tool |
| `CLIPSNAP_CHECK_CONCEALED` | boolean | true | Check ConcealedType/TransientType before reading |
| `CLIPSNAP_CLEANUP_ON_EXIT` | boolean | true | Delete session files on SIGINT/SIGTERM |
| `CLIPSNAP_AUTO_DETECT_HOOK` | boolean | false | Enable UserPromptSubmit auto-detect hook |

### Token Cost

Формула Claude: `tokens = (width * height) / 750`

| Image size | Tokens | Cost (Sonnet $3/1M input) |
|------------|--------|---------------------------|
| 1568x1024 (optimal) | ~2,141 | $0.006 |
| 800x600 (small snippet) | ~640 | $0.002 |
| 1568x882 (16:9 resized) | ~1,841 | $0.006 |

100 скриншотов/день на Sonnet = ~210K tokens = **~$0.63/day**

---

## 8. Platform Support

### Primary: macOS

| Method | Priority | Availability |
|--------|----------|--------------|
| `pngpaste` | 1 (primary) | `brew install pngpaste` |
| `osascript` (AppleScript) | 2 (fallback) | Built-in macOS |
| `sips` (resize) | built-in | Built-in macOS |

### Future: Linux

| Method | Priority | Availability |
|--------|----------|--------------|
| `xclip -selection clipboard -t image/png -o` | 1 (X11) | `apt install xclip` |
| `wl-paste --type image/png` | 1 (Wayland) | `apt install wl-clipboard` |

### Future: Windows

| Method | Priority | Availability |
|--------|----------|--------------|
| PowerShell `Get-Clipboard -Format Image` | 1 | Built-in |

**v1.0 — только macOS.** Linux и Windows в roadmap.

---

## 9. Compatibility

MCP-сервер работает с любым MCP-клиентом:

| Client | MCP Support | Tested |
|--------|-------------|--------|
| **Claude Code** | Full (stdio) | v1.0 target |
| **Codex CLI** | Full (stdio + HTTP) | v1.1 target |
| **Gemini CLI** | Full (stdio) | v1.1 target |
| **Cursor** | Beta (stdio + HTTP) | v1.1 target |
| **Windsurf** | Yes | future |
| **Zed** | Yes (extensions) | future |

### Standalone MCP Usage (without Claude Code plugin)

```bash
# Install globally
npm install -g clipsnap-mcp

# Add to any MCP client config:
{
  "mcpServers": {
    "clipsnap": {
      "command": "npx",
      "args": ["-y", "clipsnap-mcp"]
    }
  }
}
```

### Claude Code Plugin Usage

```bash
# Install as plugin (auto-configures MCP + commands + hooks)
claude plugin add clipsnap
```

---

## 10. User Experience

### Scenario 1: Single Screenshot

```
# User takes screenshot with Shottr, copies to clipboard
# In Claude Code:

> /clipsnap:paste
# OR simply:
> посмотри что на этом скриншоте

[Claude calls paste_image → sees image → responds]
```

### Scenario 2: Multiple Screenshots

```
# User takes 4 screenshots with Shottr/Cmd+Shift+4, saved to ~/Screenshots

> покажи последние 4 скриншота и сравни их

[Claude calls paste_recent(count=4) → sees all 4 → responds]
```

### Scenario 3: Specific File

```
> проанализируй ~/Desktop/mockup.png

[Claude calls paste_file(path="~/Desktop/mockup.png") → sees image → responds]
```

### Scenario 4: Cleanup

```
> /clipsnap:cleanup
# OR:
> почисти временные скриншоты

[Claude calls cleanup_images → reports deleted count/size]
```

### Scenario 5: Multiple Tabs

```
# Tab 1: working on UI
> вставь скриншот дизайна
[reads clipboard, saves to clipsnap-uuid1/img-001.png]

# Tab 2: working on API (simultaneously)
> вставь скриншот Postman
[reads clipboard, saves to clipsnap-uuid2/img-001.png]

# No conflicts — separate sessions
```

---

## 11. Error Handling

| Error | User Message | Recovery |
|-------|-------------|----------|
| No image in clipboard | "No image found in clipboard. Copy a screenshot first (Cmd+Shift+4, Shottr, or Cmd+C on an image)." | User copies image |
| Concealed clipboard | "Clipboard contains concealed data (likely a password). Skipping for security. Copy a screenshot instead." | User copies image |
| pngpaste missing | "pngpaste not found. Install: `brew install pngpaste`. Using slower osascript fallback for now." | Auto-fallback to osascript |
| osascript fails | "Cannot read clipboard. In System Settings > Privacy > Automation, allow Terminal to control your computer." | User grants permission |
| macOS 16 permission | "Clipboard access denied by macOS. When prompted, click 'Allow' to grant clipboard access to Terminal." | User allows |
| Disk full | "Cannot save image: disk space low. Run cleanup_images or free disk space." | User cleans up |
| Image too large | "Image is very large (8000x6000). Resizing to 1568x1176 for optimal processing." | Auto-resize, warn |
| Folder not found | "Folder ~/Screenshots not found. Set CLIPSNAP_SCREENSHOTS_DIR to your screenshots folder." | User sets config |
| No images in folder | "No image files found in ~/Screenshots. Take some screenshots first." | User takes screenshots |
| File not found | "File not found: ~/Desktop/mockup.png" | User checks path |
| Unsupported format | "Unsupported image format: .svg. Supported: PNG, JPEG, GIF, WebP, TIFF, HEIC." | User converts |

---

## 12. Development Plan

### Phase 1: Core MCP Server (MVP)

- [ ] Project setup (TypeScript, MCP SDK, tsconfig, package.json)
- [ ] `clipboard.ts` — pngpaste + osascript fallback
- [ ] `security.ts` — ConcealedType/TransientType checks
- [ ] `image.ts` — resize with sips (macOS built-in, no deps)
- [ ] `storage.ts` — temp file management, session isolation
- [ ] `config.ts` — env var parsing with defaults
- [ ] `index.ts` — MCP server with `paste_image` tool
- [ ] Test manually with Claude Code
- [ ] Publish to npm as `clipsnap-mcp`

### Phase 2: Full Tool Suite

- [ ] `paste_recent` tool — read N images from folder
- [ ] `paste_file` tool — read specific image file
- [ ] `list_images` tool — list session images
- [ ] `cleanup_images` tool — manual cleanup
- [ ] Cleanup on SIGINT/SIGTERM
- [ ] TTL / count / size cleanup after each save

### Phase 3: Claude Code Plugin

- [ ] plugin.json manifest
- [ ] .mcp.json bundled config
- [ ] `/clipsnap:paste` slash command
- [ ] `/clipsnap:paste-recent` slash command
- [ ] UserPromptSubmit hook (optional, disabled by default)
- [ ] Test as plugin: `claude plugin install`

### Phase 4: Polish & Distribution

- [ ] README with install instructions, GIF demos
- [ ] Error messages refinement
- [ ] npm publish with `prepublishOnly` build
- [ ] Submit to Claude Code plugin marketplace
- [ ] Submit to MCP Registry

### Phase 5: Cross-Platform (future)

- [ ] Linux support (xclip / wl-paste)
- [ ] Windows support (PowerShell)
- [ ] Test with Codex CLI, Gemini CLI, Cursor

---

## 13. Dependencies

### Runtime

| Package | Version | Purpose | Required |
|---------|---------|---------|----------|
| `@modelcontextprotocol/sdk` | ^1.27 | MCP server framework | yes |
| `zod` | ^3.23 | Schema validation | yes |

### System (macOS)

| Tool | Install | Purpose | Required |
|------|---------|---------|----------|
| `pngpaste` | `brew install pngpaste` | Primary clipboard reader | recommended |
| `osascript` | built-in | Fallback clipboard reader | built-in |
| `sips` | built-in | Image resize/convert | built-in |

### Dev

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.7 | Compiler |
| `@types/node` | ^22 | Node.js types |

**Zero heavy dependencies.** No sharp, no canvas, no native modules. `sips` (macOS built-in) handles all image processing.

---

## 14. Alternatives Considered

| Approach | Verdict | Why not |
|----------|---------|---------|
| Fix Ctrl+V in Claude Code | Impossible | Source closed, obfuscated, DMCA on deobfuscation |
| Hook-only (no MCP) | Limited | `additionalContext` is text-only, can't return images |
| Standalone CLI tool | Less integrated | User has to manually run command + paste path |
| VS Code extension | Limited scope | Only works in VS Code terminal |
| Keyboard Maestro/Shortcuts | Fragile | OS-level automation, hard to distribute |
| Existing claudecode-copy-img-mcp | Base only | Returns path not image, no cleanup, no security, no multi-image, no plugin |

---

## 15. Success Criteria

- [ ] `paste_image` работает 100% (vs ~50% native Ctrl+V)
- [ ] Время от "скопировал скриншот" до "Claude видит картинку" < 3 секунды
- [ ] Работает в iTerm2, Terminal.app, WezTerm, Kitty, VS Code terminal
- [ ] Не утекают пароли/tokens из clipboard
- [ ] Cleanup не даёт разрастись temp-файлам > 200MB
- [ ] Установка в 1 команду: `npm install -g clipsnap-mcp` или `claude plugin add clipsnap`
- [ ] Работает с несколькими табами Claude Code одновременно
- [ ] Готов к macOS 16 clipboard privacy changes

---

## Sources

- [Claude Code iTerm2 Image Paste Bug #29365](https://github.com/anthropics/claude-code/issues/29365)
- [ENOBUFS Silent Failure #29776](https://github.com/anthropics/claude-code/issues/29776)
- [Sandbox Blocks Clipboard #17042](https://github.com/anthropics/claude-code/issues/17042)
- [Expose Image Data to Hooks #16592](https://github.com/anthropics/claude-code/issues/16592)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Claude Vision API — Token Calculation](https://platform.claude.com/docs/en/build-with-claude/vision)
- [macOS 16 Clipboard Privacy](https://9to5mac.com/2025/05/12/macos-16-clipboard-privacy-protection/)
- [NSPasteboard ConcealedType](https://nspasteboard.org/)
- [Claude Code Plugin Docs](https://code.claude.com/docs/en/plugins)
- [MCP Server Naming Conventions](https://zazencodes.com/blog/mcp-server-naming-conventions)
- [oxplot/clipboard-mcp](https://github.com/oxplot/clipboard-mcp)
- [albertoelopez/claudecode-copy-img-mcp](https://github.com/albertoelopez/claudecode-copy-img-mcp)
- [Codex CLI Image Paste Issues](https://github.com/openai/codex/issues/3397)
- [Gemini CLI Image Paste Issues](https://github.com/google-gemini/gemini-cli/issues/15381)

# ClipSnap

**Reliable screenshot and clipboard image paste for terminal AI tools.**

[![npm version](https://img.shields.io/npm/v/clipsnap-mcp)](https://www.npmjs.com/package/clipsnap-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](https://github.com/zelentsov-dev/clipsnap-mcp)

An [MCP](https://modelcontextprotocol.io/) server that gives AI coding assistants reliable access to clipboard images and screenshot files. A background Swift daemon watches the clipboard in real time, so screenshots from any app -- including clipboard-only tools like Shottr -- are captured automatically and available instantly. Works with Claude Code, Codex CLI, Gemini CLI, Cursor, and any MCP-compatible client.

---

## The Problem

Pasting images into terminal AI tools is broken. `Ctrl+V` / `Cmd+V` image paste in iTerm2, Terminal.app, and other terminal emulators fails **40-50% of the time** due to fundamental limitations:

| Bug | Cause |
|-----|-------|
| **ENOBUFS** ([#29776](https://github.com/anthropics/claude-code/issues/29776)) | `osascript` dumps the entire PNG as hex, causing buffer overflow |
| **Sandbox** ([#17042](https://github.com/anthropics/claude-code/issues/17042)) | `sandbox-exec` blocks clipboard access via `com.apple.hiservices-xpcservice` |
| **Race condition** ([#29365](https://github.com/anthropics/claude-code/issues/29365)) | Async clipboard read is not synchronized with terminal focus state |

These issues affect Claude Code, [Codex CLI](https://github.com/openai/codex/issues/3397), and [Gemini CLI](https://github.com/google-gemini/gemini-cli/issues/15381). Terminals have no standard protocol for transferring binary data from the clipboard.

## The Solution

ClipSnap takes a two-pronged approach:

1. **Clipboard watcher** -- a lightweight Swift daemon polls `NSPasteboard` every 500ms and saves new images to `~/.clipsnap/clipboard-captures/` as PNG files. This captures clipboard-only screenshots (e.g., Shottr with Esc, or Cmd+C on an image) that would otherwise be lost.
2. **Multi-source discovery** -- when you ask for a screenshot, ClipSnap searches three sources in parallel: watcher captures, native macOS screenshots directory, and Spotlight (`mdfind`). The newest image wins.

Both components run as a single MCP server **outside the terminal sandbox**, delivering images to AI tools as base64-encoded content.

- Bypasses `sandbox-exec` (MCP servers run outside the sandbox)
- Clipboard images captured automatically in real time (~500ms latency)
- Parallel multi-source search: watcher + native dir + Spotlight
- Resizes images to optimal dimensions for AI vision models (saves tokens)
- Auto-cleans temp files with configurable TTL, count, and size limits
- Detects passwords and sensitive clipboard data before reading
- Graceful degradation if Swift watcher binary is not built

---

## Quick Start

### Standalone MCP Server

Add to your MCP client configuration (`claude_desktop_config.json`, `.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "clipsnap": {
      "command": "npx",
      "args": ["-y", "clipsnap-mcp"]
    }
  }
}
```

### Claude Code Plugin

```bash
claude plugin add clipsnap-mcp
```

This auto-configures the MCP server, slash commands (`/clipsnap:paste`, `/clipsnap:paste-recent`), and optional hooks.

### Recommended: Install pngpaste

```bash
brew install pngpaste
```

`pngpaste` is used as a legacy clipboard fallback. Without it, ClipSnap falls back to `osascript` (slower, built-in). The primary clipboard capture path uses the Swift watcher daemon, which does not require `pngpaste`.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  MCP Server (Node.js)                                           │
│                                                                  │
│  Startup: spawns Swift watcher daemon                            │
│  Shutdown: sends SIGTERM to watcher                              │
│                                                                  │
│  Tools:                                                          │
│    paste_recent  — returns N most recent screenshots             │
│    cleanup_images — deletes temp/session images                  │
│                                                                  │
│  Screenshot Discovery (parallel, via Promise.allSettled):        │
│    1. ~/.clipsnap/clipboard-captures/  (watcher, instant)        │
│    2. Native macOS screenshots dir     (direct scan, instant)    │
│    3. Spotlight mdfind                 (broad, may have delay)   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ spawns
┌──────────────────────────▼──────────────────────────────────────┐
│  Clipboard Watcher (Swift, background daemon)                    │
│                                                                  │
│  Polls NSPasteboard every 500ms                                  │
│  Saves new clipboard images as PNG to ~/.clipsnap/               │
│  Auto-prunes to max 50 files                                     │
│  JSON structured logging to stderr                               │
│  Clean shutdown on SIGTERM/SIGINT via Atomic<Bool>               │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Swift clipboard watcher** | NSPasteboard polling is cheap and reliable; captures clipboard-only screenshots that never hit disk |
| **Watcher is optional** | Graceful degradation -- if the binary is not built, Spotlight + native dir still work |
| **Parallel multi-source** | `Promise.allSettled` on watcher dir + native dir + Spotlight; fastest source wins |
| **stdio transport** | Standard for local CLI tools; universal MCP client support |
| **`sips` for resize** | Built-in macOS, zero native dependencies |
| **UUID session dirs** | Isolates temp files between multiple Claude Code tabs |
| **Max 50 watcher files** | Auto-prunes oldest captures to bound disk usage |
| **JSON structured logging** | Watcher emits JSON lines to stderr for debuggability |

---

## Tools Reference

### `paste_recent`

Returns the most recent N screenshot images. Combines three sources: clipboard watcher captures, native macOS screenshots directory, and Spotlight. Results are sorted by time, newest first. This is the primary tool.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `count` | `number (1-10)` | No | `3` | Number of images to return |
| `folder` | `string` | No | -- | Scan a specific folder instead of the default multi-source search |
| `max_dimension` | `number` | No | `1568` | Max long edge in pixels |

**Example prompts:** "Look at my screenshot", "Compare the last 4 screenshots", `/clipsnap:paste`

---

### `cleanup_images`

Deletes temporary ClipSnap images.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `all` | `boolean` | No | `false` | Delete ALL sessions (not just current) |
| `older_than_minutes` | `number` | No | `0` | Delete files older than N minutes |

---

## How It Works

```
1. Claude Code starts
   └─► MCP server starts
       └─► Swift clipboard watcher spawns as background daemon

2. User takes screenshot (any app: native, Shottr, CleanShot X, browser Cmd+C, etc.)
   └─► Clipboard gets image
       └─► Watcher detects NSPasteboard change within ~500ms
           └─► Saves PNG to ~/.clipsnap/clipboard-captures/clip-<ts>-<uuid>.png

3. User: "look at my screenshot"
   └─► MCP client calls `paste_recent` tool
       └─► Parallel search:
           ├── Watcher captures dir (clipboard images, instant)
           ├── Native macOS screenshots dir (file-saved screenshots)
           └── Spotlight mdfind (broad coverage, all apps)
       └─► Merge, dedup, sort by time → return newest N as base64 images

4. Claude Code exits
   └─► SIGTERM → watcher receives signal → Atomic<Bool> flips → clean shutdown
```

---

## Configuration

All settings are configured via environment variables in your MCP server config:

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `CLIPSNAP_MAX_FILES` | number | `50` | Max files per session |
| `CLIPSNAP_TTL_MINUTES` | number | `60` | File time-to-live in minutes |
| `CLIPSNAP_MAX_SIZE_MB` | number | `200` | Max total size per session (MB) |
| `CLIPSNAP_MAX_DIMENSION` | number | `1568` | Max image long edge (px). Values above 1568 waste tokens without quality gain |
| `CLIPSNAP_IMAGE_FORMAT` | `png \| jpeg` | `png` | Output format. JPEG saves ~5x disk but is lossy |
| `CLIPSNAP_JPEG_QUALITY` | number (1-100) | `80` | JPEG quality. 80 is good for code screenshots |
| `CLIPSNAP_SCREENSHOTS_DIR` | path | auto-detected | Native screenshots folder. Auto-detected from `defaults read com.apple.screencapture location`, falls back to `~/Screenshots` or `~/Desktop` |
| `CLIPSNAP_CHECK_CONCEALED` | boolean | `true` | Check ConcealedType/TransientType before reading |
| `CLIPSNAP_CLEANUP_ON_EXIT` | boolean | `true` | Delete session files on SIGINT/SIGTERM |

<details>
<summary>Full MCP config example with all variables</summary>

```json
{
  "mcpServers": {
    "clipsnap": {
      "command": "npx",
      "args": ["-y", "clipsnap-mcp"],
      "env": {
        "CLIPSNAP_MAX_FILES": "50",
        "CLIPSNAP_TTL_MINUTES": "60",
        "CLIPSNAP_MAX_SIZE_MB": "200",
        "CLIPSNAP_MAX_DIMENSION": "1568",
        "CLIPSNAP_IMAGE_FORMAT": "png",
        "CLIPSNAP_JPEG_QUALITY": "80",
        "CLIPSNAP_CHECK_CONCEALED": "true",
        "CLIPSNAP_CLEANUP_ON_EXIT": "true"
      }
    }
  }
}
```

</details>

### Token Cost

Claude calculates image tokens as `(width x height) / 750`:

| Image Size | Tokens | Cost (Sonnet, $3/1M input) |
|------------|--------|---------------------------|
| 1568x882 (16:9 resized) | ~1,841 | $0.006 |
| 1568x1024 (optimal) | ~2,141 | $0.006 |
| 800x600 (small snippet) | ~640 | $0.002 |

---

## Building

### Prerequisites

- **Node.js** 20+
- **Swift** 6.2+ / Xcode 26+ (for the clipboard watcher)
- **macOS** 15+ (Sequoia or later)

### Build

```bash
npm install
npm run build    # builds TypeScript (tsc) + Swift watcher (swift build -c release)
```

The build script compiles both the TypeScript MCP server and the Swift clipboard watcher. If Swift is not available, the watcher build is skipped gracefully -- the server will still work using Spotlight and native directory scanning.

### Development

```bash
npm run dev      # runs the server with tsx for hot-reload
```

---

## Security

ClipSnap is designed with a security-first approach:

- **Password detection** -- checks for `org.nspasteboard.ConcealedType` before reading clipboard (passwords from 1Password, Bitwarden, macOS Keychain). Refuses to read and warns the user
- **Transient data detection** -- checks for `org.nspasteboard.TransientType` (temporary clipboard data that may have expired)
- **File permissions** -- temp files created with mode `0600` (owner read/write only), watcher directory with `0700`
- **Session isolation** -- UUID-based subdirectories per MCP process (`$TMPDIR/clipsnap-<uuid>/`)
- **Unpredictable paths** -- timestamp + random suffix prevents path guessing
- **No logging of content** -- clipboard data is never logged, not even in debug mode
- **No memory caching** -- image data is not retained beyond the current request
- **No network calls** -- no telemetry, no external services, fully offline
- **Graceful cleanup** -- SIGINT/SIGTERM handler deletes session directory and stops the watcher

---

## Compatibility

### MCP Clients

| Client | Status | Notes |
|--------|--------|-------|
| **Claude Code** | Supported | Primary target. Works as standalone MCP or plugin |
| **Cursor** | Supported | Add to `.cursor/mcp.json` |
| **Claude Desktop** | Supported | Add to `claude_desktop_config.json` |
| **Codex CLI** | Supported | stdio + HTTP transport |
| **Gemini CLI** | Supported | stdio transport |
| **Windsurf** | Supported | MCP config |
| **Zed** | Supported | Extensions |

### Terminals

| Terminal | Status |
|----------|--------|
| iTerm2 | Tested |
| Terminal.app | Tested |
| WezTerm | Tested |
| Kitty | Tested |
| VS Code Terminal | Tested |
| Alacritty | Tested |

### System Requirements

- **macOS** 15+ (Sequoia or later)
- **Node.js** 20+
- **Swift** 6.2+ (for building the clipboard watcher; optional at runtime)
- **pngpaste** (optional): `brew install pngpaste` -- legacy clipboard fallback
- **sips** (built-in macOS) -- used for image resize/convert

> **Note:** Linux and Windows support is planned for a future release.

---

## Troubleshooting

<details>
<summary><strong>Watcher not capturing clipboard images</strong></summary>

The Swift watcher binary must be built first:

```bash
cd watcher && swift build -c release
```

Or run `npm run build` which builds both TypeScript and Swift. If the binary is missing, ClipSnap still works -- it just uses Spotlight and native directory scanning instead of real-time clipboard capture.

Check watcher logs (JSON lines on stderr) for errors.

</details>

<details>
<summary><strong>pngpaste not found</strong></summary>

Install via Homebrew:

```bash
brew install pngpaste
```

This is only needed as a legacy clipboard fallback. The primary clipboard capture path uses the Swift watcher daemon, which does not need `pngpaste`.

</details>

<details>
<summary><strong>"No recent images found"</strong></summary>

Make sure you have taken a screenshot or copied an image:
- Take a screenshot: `Cmd+Shift+4` (region) or `Cmd+Shift+3` (full screen)
- Copy from an app: `Cmd+C` on an image in Preview, Figma, browser, etc.
- Use a screenshot tool like Shottr or CleanShot X

If the watcher is running, clipboard images are captured automatically. Otherwise, only file-saved screenshots (native dir + Spotlight) are discovered.

</details>

<details>
<summary><strong>"Clipboard contains concealed data"</strong></summary>

Your clipboard contains a password or sensitive data (from 1Password, Bitwarden, macOS Keychain, etc.). ClipSnap refuses to read it for security. Copy a screenshot instead.

To disable this check (not recommended):

```json
{ "env": { "CLIPSNAP_CHECK_CONCEALED": "false" } }
```

</details>

<details>
<summary><strong>"Cannot read clipboard" / osascript permission error</strong></summary>

Grant Terminal clipboard/automation access:

1. Open **System Settings** > **Privacy & Security** > **Automation**
2. Find your terminal app (iTerm2, Terminal, etc.)
3. Enable access

On macOS 16 (Tahoe) and later, you may also see a clipboard privacy prompt -- click "Allow" when prompted.

</details>

<details>
<summary><strong>Screenshots directory not found</strong></summary>

ClipSnap auto-detects your macOS screenshot directory from `defaults read com.apple.screencapture location`, falling back to `~/Screenshots` or `~/Desktop`. To override:

```json
{ "env": { "CLIPSNAP_SCREENSHOTS_DIR": "~/Desktop" } }
```

</details>

<details>
<summary><strong>Images look blurry or low quality</strong></summary>

By default, images are output as PNG (lossless). If you switched to JPEG, increase the quality:

```json
{ "env": { "CLIPSNAP_IMAGE_FORMAT": "png" } }
```

Or for JPEG with higher quality:

```json
{ "env": { "CLIPSNAP_JPEG_QUALITY": "95" } }
```

</details>

<details>
<summary><strong>Disk space growing</strong></summary>

ClipSnap auto-cleans temp files and the watcher auto-prunes to 50 captures. You can also trigger manual cleanup:

- Ask your AI: "Clean up clipsnap images"
- Or adjust limits: `CLIPSNAP_MAX_FILES`, `CLIPSNAP_TTL_MINUTES`, `CLIPSNAP_MAX_SIZE_MB`

Disk usage per Retina screenshot: ~1.5 MB (PNG, resized) or ~0.4 MB (JPEG 80).

</details>

---

## Contributing

Contributions are welcome! Here is how to get started:

```bash
git clone https://github.com/zelentsov-dev/clipsnap-mcp.git
cd clipsnap-mcp
npm install
npm run build    # TypeScript + Swift watcher
npm run dev      # dev server with hot-reload
```

To test manually, configure your MCP client to point to the local build:

```json
{
  "mcpServers": {
    "clipsnap": {
      "command": "node",
      "args": ["/path/to/clipsnap-mcp/dist/index.js"]
    }
  }
}
```

Please open an issue before starting work on large changes.

---

## License

[MIT](LICENSE) -- Alexey Zelentsov

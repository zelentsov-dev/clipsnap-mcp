# ClipSnap

**Reliable clipboard image paste for terminal AI tools.**

[![npm version](https://img.shields.io/npm/v/clipsnap-mcp)](https://www.npmjs.com/package/clipsnap-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](https://github.com/zelentsov-dev/clipsnap-mcp)

An [MCP](https://modelcontextprotocol.io/) server that gives AI coding assistants reliable access to clipboard images and screenshot files. Works with Claude Code, Codex CLI, Gemini CLI, Cursor, and any MCP-compatible client.

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

ClipSnap runs as a separate Node.js process **outside the terminal sandbox**, using the MCP protocol to deliver images directly to AI tools as base64-encoded content.

- Bypasses `sandbox-exec` (MCP servers run outside the sandbox)
- Uses `pngpaste` (fast, reliable) with `osascript` fallback (zero-install)
- Resizes images to optimal dimensions for AI vision models (saves tokens)
- Auto-cleans temp files with configurable TTL, count, and size limits
- Detects passwords and sensitive clipboard data before reading

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

`pngpaste` is the primary clipboard reader -- fast and reliable. Without it, ClipSnap falls back to `osascript` (slower, built-in).

---

## Features

- **5 MCP tools** -- paste from clipboard, read recent screenshots, open specific files, list session images, cleanup temp files
- **Smart resizing** -- auto-downscale to 1568px (Claude's optimal limit) using `sips` (built-in macOS, no native dependencies)
- **Security-first** -- detects `ConcealedType` (passwords from 1Password, Bitwarden) and `TransientType` markers before reading
- **Multi-session safe** -- each MCP process gets an isolated temp directory with UUID-based naming
- **Defense-in-depth cleanup** -- TTL, file count, total size limits, SIGINT/SIGTERM handler, plus macOS `$TMPDIR` auto-cleanup
- **Zero heavy dependencies** -- only `@modelcontextprotocol/sdk` and `zod`. Image processing uses `sips` (built-in macOS)
- **Claude Code plugin** -- slash commands and optional auto-detect hook for seamless UX
- **macOS 16 ready** -- graceful handling of upcoming clipboard privacy prompts

---

## Tools Reference

### `paste_image`

Reads an image from the system clipboard and returns it as MCP image content.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `format` | `"png" \| "jpeg"` | No | `png` | Output format |
| `quality` | `number (1-100)` | No | `80` | JPEG quality (ignored for PNG) |
| `max_dimension` | `number` | No | `1568` | Max long edge in pixels |
| `save` | `boolean` | No | `true` | Save a copy to the temp directory |

**Example prompt:** "Look at this screenshot" or `/clipsnap:paste`

---

### `paste_recent`

Reads the last N images from a folder (default: `~/Screenshots`).

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `count` | `number (1-10)` | No | `3` | Number of images to return |
| `folder` | `string` | No | `~/Screenshots` | Source folder path |
| `max_dimension` | `number` | No | `1568` | Max long edge in pixels |

**Example prompt:** "Compare the last 4 screenshots" or `/clipsnap:paste-recent`

---

### `paste_file`

Reads a specific image file by path.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | `string` | **Yes** | -- | Absolute or `~`-prefixed path to image |
| `max_dimension` | `number` | No | `1568` | Max long edge in pixels |

**Supported formats:** PNG, JPEG, GIF, WebP, TIFF, HEIC

**Example prompt:** "Analyze ~/Desktop/mockup.png"

---

### `list_images`

Shows images saved during the current ClipSnap session. Takes no parameters.

Returns a text listing with filenames, dimensions, sizes, and timestamps.

---

### `cleanup_images`

Deletes temporary ClipSnap images.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `all` | `boolean` | No | `false` | Delete ALL sessions (not just current) |
| `older_than_minutes` | `number` | No | `0` | Delete files older than N minutes |

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
| `CLIPSNAP_SCREENSHOTS_DIR` | path | `~/Screenshots` | Default folder for `paste_recent` |
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
        "CLIPSNAP_SCREENSHOTS_DIR": "~/Screenshots",
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

## How It Works

```
User: "look at this screenshot"
  |
  v
MCP Client (Claude Code / Cursor / Codex CLI / ...)
  |
  v
ClipSnap MCP Server (separate Node.js process, OUTSIDE terminal sandbox)
  |
  |-- 1. Security check: ConcealedType / TransientType markers
  |-- 2. Read clipboard: pngpaste -> osascript fallback
  |-- 3. Save to $TMPDIR/clipsnap-<session-uuid>/img-<ts>-<rand>.png
  |-- 4. Resize if needed (max 1568px via sips)
  |-- 5. Encode to base64
  |-- 6. Cleanup old files (TTL / count / size limits)
  |
  v
MCP Response: { type: "image", data: "<base64>", mimeType: "image/png" }
  |
  v
AI sees the image and responds
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **stdio transport** | Standard for local CLI tools; universal MCP client support |
| **`pngpaste` primary** | Fast, reliable, no AppleScript overhead |
| **`sips` for resize** | Built-in macOS, zero native dependencies |
| **UUID session dirs** | Isolates files between multiple Claude Code tabs |
| **`0600` file permissions** | Owner read/write only on temp images |

---

## Security

ClipSnap is designed with a security-first approach:

- **Password detection** -- checks for `org.nspasteboard.ConcealedType` before reading clipboard (passwords from 1Password, Bitwarden, macOS Keychain). Refuses to read and warns the user
- **Transient data detection** -- checks for `org.nspasteboard.TransientType` (temporary clipboard data that may have expired)
- **File permissions** -- temp files created with mode `0600` (owner read/write only)
- **Session isolation** -- UUID-based subdirectories per MCP process (`$TMPDIR/clipsnap-<uuid>/`)
- **Unpredictable paths** -- timestamp + random suffix prevents path guessing
- **No logging of content** -- clipboard data is never logged, not even in debug mode
- **No memory caching** -- image data is not retained beyond the current request
- **No network calls** -- no telemetry, no external services, fully offline
- **Graceful cleanup** -- SIGINT/SIGTERM handler deletes session directory

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

- **macOS** 12+ (Monterey or later)
- **Node.js** 20+
- **pngpaste** (recommended): `brew install pngpaste`
- **sips** (built-in macOS) -- used for image resize/convert

> **Note:** Linux and Windows support is planned for a future release.

---

## Troubleshooting

<details>
<summary><strong>pngpaste not found</strong></summary>

Install via Homebrew:

```bash
brew install pngpaste
```

ClipSnap works without it (falls back to `osascript`), but `pngpaste` is faster and more reliable.

</details>

<details>
<summary><strong>"No image found in clipboard"</strong></summary>

Make sure you have an image copied to the clipboard:
- Take a screenshot: `Cmd+Shift+4` (region) or `Cmd+Shift+3` (full screen)
- Copy from an app: `Cmd+C` on an image in Preview, Figma, browser, etc.
- Use a screenshot tool like Shottr or CleanShot X

Text-only clipboard content is not supported by `paste_image`. Use `paste_file` to read image files directly.

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
<summary><strong>Folder not found: ~/Screenshots</strong></summary>

The default screenshots folder is `~/Screenshots`. If your screenshots are saved elsewhere, set the environment variable:

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

ClipSnap auto-cleans temp files, but you can also trigger manual cleanup:

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
npm run dev
```

The dev server runs with `tsx` for hot-reload. To test manually, configure your MCP client to point to the local build:

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

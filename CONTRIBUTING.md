# Contributing to ClipSnap

Thanks for your interest in contributing!

## Getting Started

```bash
git clone https://github.com/zelentsov-dev/clipsnap-mcp.git
cd clipsnap-mcp
npm install
npm run build
```

## Development

```bash
npm run dev    # run with tsx (hot reload)
npm run build  # compile TypeScript + Swift watcher
```

## Guidelines

- **Open an issue first** before starting work on large changes
- Keep PRs focused — one feature or fix per PR
- Follow existing code style (TypeScript strict mode, 2-space indent)
- Test your changes manually on macOS with iTerm2 + Claude Code
- No external runtime dependencies — the project is intentionally dependency-light

## Architecture

```
src/
  index.ts        — MCP server entry point, tool definitions
  config.ts       — environment variable parsing
  clipboard.ts    — pngpaste + osascript clipboard reading
  image.ts        — sips-based image processing
  screenshots.ts  — multi-source screenshot discovery
  security.ts     — concealed clipboard detection
  storage.ts      — session file management + cleanup
  watcher.ts      — Swift watcher process lifecycle

watcher/
  Sources/        — Swift clipboard watcher daemon
  Package.swift   — Swift package manifest
```

## Reporting Bugs

Use the [bug report template](https://github.com/zelentsov-dev/clipsnap-mcp/issues/new?template=bug_report.yml). Include:

- ClipSnap version (`npm list -g clipsnap-mcp`)
- macOS version
- Terminal app (iTerm2, Terminal.app, etc.)
- MCP client (Claude Code, Cursor, etc.)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

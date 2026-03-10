# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-03-06

### Added

- MCP server with stdio transport for clipboard image access
- Swift clipboard watcher daemon polling NSPasteboard every 500ms
- `paste_recent` tool — returns recent images from clipboard captures, native screenshots dir, and Spotlight
- `cleanup_images` tool — manual cleanup of temporary session files
- Multi-source image discovery (watcher + native dir + Spotlight mdfind)
- Smart image resizing via `sips` (default max 1568px long edge)
- Password/concealed clipboard detection (1Password, Bitwarden, macOS Keychain)
- Session isolation with UUID-based temp directories
- Symlink protection via `lstat`
- 3-layer auto-cleanup (TTL, max files, max size)
- Configurable via 9 environment variables
- macOS-native: zero external dependencies beyond Node.js and Swift

### Security

- ConcealedType/TransientType clipboard checks before reading
- File permissions: 0600 files, 0700 directories
- maxBuffer + timeout limits on child processes
- No content logging, no network calls, zero telemetry

[1.0.0]: https://github.com/zelentsov-dev/clipsnap-mcp/releases/tag/v1.0.0

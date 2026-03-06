#!/usr/bin/env node

/**
 * ClipSnap MCP Server — entry point.
 *
 * Exposes clipboard and image tools over the Model Context Protocol (MCP) via stdio transport.
 *
 * Tools provided:
 * - `paste_image` — reads an image from the macOS clipboard
 * - `paste_recent` — shows recent images from session history or Spotlight
 * - `paste_file` — reads a specific image file by path
 * - `cleanup_images` — deletes temporary session images
 *
 * Configuration is loaded from environment variables (see {@link loadConfig} in `config.ts`).
 * A per-session temp directory is created on startup and cleaned up on exit.
 *
 * @module
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { readFile, readdir, stat, lstat, rm } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import { loadConfig } from './config.js';
import { checkClipboardSafety } from './security.js';
import { readClipboardImage } from './clipboard.js';
import { processImage } from './image.js';
import { StorageManager } from './storage.js';
import { findRecentScreenshots } from './screenshots.js';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.tiff', '.heic',
]);

/** Maximum file size (100 MB) to prevent loading excessively large images into memory. */
const MAX_FILE_SIZE = 100 * 1024 * 1024;

const config = loadConfig();
const storage = new StorageManager(config);

function resolvePath(p: string): string {
  if (p.startsWith('~')) {
    return join(homedir(), p.slice(p.startsWith('~/') ? 2 : 1));
  }
  return p;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

/** Processes image data and builds a standard MCP image response. */
async function buildImageResponse(
  data: Buffer,
  source: string,
  opts: { format: 'png' | 'jpeg'; quality: number; maxDimension: number; shouldSave: boolean },
): Promise<CallToolResult> {
  const processed = await processImage(data, {
    maxDimension: opts.maxDimension,
    format: opts.format,
    quality: opts.quality,
  });

  let savedPath = '';
  if (opts.shouldSave) {
    savedPath = await storage.saveImage(processed.data, opts.format);
  }

  const resized =
    processed.originalWidth !== processed.width ||
    processed.originalHeight !== processed.height;
  const sizeInfo = formatBytes(processed.data.length);
  const content: CallToolResult['content'] = [];

  if (processed.originalWidth > 4000 || processed.originalHeight > 4000) {
    content.push({
      type: 'text',
      text: `Image is very large (${processed.originalWidth}x${processed.originalHeight}). Resizing to ${processed.width}x${processed.height} for optimal processing.`,
    });
  }

  content.push({
    type: 'image',
    data: processed.data.toString('base64'),
    mimeType: processed.mimeType,
  });

  let description = `${source} (${processed.originalWidth}x${processed.originalHeight}`;
  if (resized) {
    description += ` → resized to ${processed.width}x${processed.height}`;
  }
  description += `, ${sizeInfo})`;
  if (savedPath) {
    description += `. Saved: ${savedPath}`;
  }
  content.push({ type: 'text', text: description });

  return { content };
}

const server = new McpServer({
  name: 'clipsnap',
  version: '1.0.0',
});

// Tool 1: paste_image — Read image from clipboard
server.registerTool(
  'paste_image',
  {
    title: 'Paste Clipboard Image',
    description:
      'Reads an image from the macOS clipboard. Use when the user says "look at my screenshot", "check the clipboard", or shares a visual. Falls back to the most recent screenshot file if clipboard is empty. The image is saved to session history for later access via paste_recent.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      format: z.enum(['png', 'jpeg']).optional().describe('Output format (default: png)'),
      quality: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe('JPEG quality 1-100 (ignored for PNG)'),
      max_dimension: z
        .number()
        .min(1)
        .optional()
        .describe('Max long edge in pixels (default: 1568)'),
      save: z.boolean().optional().describe('Save to session history (default: true)'),
    },
  },
  async (args): Promise<CallToolResult> => {
    const format = args.format ?? config.imageFormat;
    const quality = args.quality ?? config.jpegQuality;
    const maxDimension = args.max_dimension ?? config.maxDimension;
    const shouldSave = args.save ?? true;

    // --- Try clipboard first ---
    let clipboardBlocked = false;
    if (config.checkConcealed) {
      const safety = await checkClipboardSafety();
      if (!safety.safe) {
        return {
          content: [{ type: 'text', text: safety.reason! }],
          isError: true,
        };
      }
      clipboardBlocked = !safety.hasImage;
    }

    if (!clipboardBlocked) {
      try {
        const clipboard = await readClipboardImage();
        return await buildImageResponse(clipboard.data, 'Image from clipboard', {
          format, quality, maxDimension, shouldSave,
        });
      } catch {
        // Clipboard read failed — fall through to screenshot fallback
      }
    }

    // --- Fallback: latest screenshot via Spotlight (any app) ---
    const recent = await findRecentScreenshots(1, config.screenshotsDir);
    if (recent.length > 0) {
      try {
        const raw = await readFile(recent[0].path);
        return await buildImageResponse(raw, `Latest screenshot: ${recent[0].name}`, {
          format, quality, maxDimension, shouldSave,
        });
      } catch {
        // Fall through to error
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: `No image in clipboard and no screenshots found. Copy a screenshot first (Cmd+Shift+4, Shottr, or Cmd+C on an image).`,
        },
      ],
      isError: true,
    };
  },
);

// Tool 2: paste_recent — Show recent images from session + Spotlight
server.registerTool(
  'paste_recent',
  {
    title: 'Paste Recent Screenshots',
    description:
      'Shows the last N images by combining session history (paste_image saves) and macOS Spotlight screenshots (from any app: native, Shottr, CleanShot X). Results are sorted by time, newest first. Use when the user says "show my last screenshots" or "look at what I just captured". Pass folder to scan a specific directory instead.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      count: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe('Number of images to return (default: 3)'),
      folder: z.string().optional().describe('Scan a specific folder instead of session + Spotlight'),
      max_dimension: z
        .number()
        .min(1)
        .optional()
        .describe('Max long edge in pixels (default: 1568)'),
    },
  },
  async (args): Promise<CallToolResult> => {
    const count = args.count ?? 3;
    const maxDimension = args.max_dimension ?? config.maxDimension;

    // Explicit folder — scan it directly
    if (args.folder) {
      const folder = resolvePath(args.folder);
      const found = await findRecentScreenshots(count, folder);
      if (found.length === 0) {
        return {
          content: [{ type: 'text', text: `No image files found in ${folder}.` }],
          isError: true,
        };
      }
      return await buildRecentResponse(found, folder, maxDimension);
    }

    // Merge session history + Spotlight, dedup by path, sort by mtime desc
    const sessionFiles = await storage.listImages();
    const spotlightResults = await findRecentScreenshots(count * 2, config.screenshotsDir);

    const seen = new Set<string>();
    const merged: { path: string; name: string; mtime: Date }[] = [];

    for (const f of sessionFiles) {
      if (!seen.has(f.path)) {
        seen.add(f.path);
        merged.push({ path: f.path, name: f.name, mtime: f.mtime });
      }
    }
    for (const f of spotlightResults) {
      if (!seen.has(f.path)) {
        seen.add(f.path);
        merged.push(f);
      }
    }

    merged.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const selected = merged.slice(0, count);

    if (selected.length === 0) {
      return {
        content: [{ type: 'text', text: 'No recent images found. Take a screenshot first (Cmd+Shift+4, Shottr, CleanShot X) or call paste_image to capture the clipboard.' }],
        isError: true,
      };
    }

    return await buildRecentResponse(selected, 'session + Spotlight', maxDimension);
  },
);

async function buildRecentResponse(
  entries: { path: string; name: string; mtime: Date }[],
  source: string,
  maxDimension: number,
): Promise<CallToolResult> {
  const content: CallToolResult['content'] = [
    { type: 'text', text: `${entries.length} recent images from ${source}:` },
  ];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      const raw = await readFile(entry.path);
      const format = extname(entry.name).toLowerCase() === '.jpg' ||
        extname(entry.name).toLowerCase() === '.jpeg'
        ? 'jpeg' as const
        : 'png' as const;

      const processed = await processImage(raw, {
        maxDimension,
        format,
        quality: config.jpegQuality,
      });

      content.push({
        type: 'image',
        data: processed.data.toString('base64'),
        mimeType: processed.mimeType,
      });
      content.push({
        type: 'text',
        text: `${i + 1}. ${entry.name} (${processed.width}x${processed.height}, ${timeAgo(entry.mtime)})`,
      });
    } catch (error) {
      content.push({
        type: 'text',
        text: `${i + 1}. ${entry.name} — error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return { content };
}

// Tool 3: paste_file — Read a specific image file
server.registerTool(
  'paste_file',
  {
    title: 'Paste Image File',
    description:
      'Reads a specific image file by absolute path and returns it. Use when you already know the file path (e.g., from logs, file listings, or user input). Supports PNG, JPEG, GIF, WebP, TIFF, HEIC.',
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      path: z.string().describe('Absolute path or ~/relative path to the image file'),
      max_dimension: z
        .number()
        .min(1)
        .optional()
        .describe('Max long edge in pixels (default: 1568)'),
    },
  },
  async (args): Promise<CallToolResult> => {
    const filePath = resolvePath(args.path);
    const maxDimension = args.max_dimension ?? config.maxDimension;
    const ext = extname(filePath).toLowerCase();

    if (!IMAGE_EXTENSIONS.has(ext)) {
      return {
        content: [
          {
            type: 'text',
            text: `Unsupported image format: ${ext}. Supported: PNG, JPEG, GIF, WebP, TIFF, HEIC.`,
          },
        ],
        isError: true,
      };
    }

    let raw: Buffer;
    try {
      const fileInfo = await stat(filePath);
      if (fileInfo.size > MAX_FILE_SIZE) {
        return {
          content: [
            {
              type: 'text',
              text: `File too large: ${formatBytes(fileInfo.size)}. Maximum supported size is ${formatBytes(MAX_FILE_SIZE)}.`,
            },
          ],
          isError: true,
        };
      }
      raw = await readFile(filePath);
    } catch {
      return {
        content: [
          { type: 'text', text: `File not found: ${filePath}` },
        ],
        isError: true,
      };
    }

    try {
      const format = ext === '.jpg' || ext === '.jpeg'
        ? 'jpeg' as const
        : 'png' as const;

      const processed = await processImage(raw, {
        maxDimension,
        format,
        quality: config.jpegQuality,
      });

      const resized =
        processed.originalWidth !== processed.width ||
        processed.originalHeight !== processed.height;
      let description = `${filePath} (${processed.originalWidth}x${processed.originalHeight}`;
      if (resized) {
        description += ` → resized to ${processed.width}x${processed.height}`;
      }
      description += `, ${formatBytes(processed.data.length)})`;

      return {
        content: [
          {
            type: 'image',
            data: processed.data.toString('base64'),
            mimeType: processed.mimeType,
          },
          { type: 'text', text: description },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  },
);

// Tool 4: cleanup_images — Manual cleanup
server.registerTool(
  'cleanup_images',
  {
    title: 'Cleanup Session Images',
    description:
      'Deletes temporary ClipSnap images from the session temp directory. Automatic cleanup already runs on TTL/size limits, so this is rarely needed. Use all=true to purge all sessions.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      all: z
        .boolean()
        .optional()
        .describe('Delete ALL sessions, not just current (default: false)'),
      older_than_minutes: z
        .number()
        .optional()
        .describe('Only delete files older than N minutes'),
    },
  },
  async (args): Promise<CallToolResult> => {
    if (args.all) {
      // Delete all clipsnap-* directories in TMPDIR
      const tmp = tmpdir();
      let totalDeleted = 0;
      let totalFreed = 0;
      try {
        const entries = await readdir(tmp);
        for (const entry of entries) {
          if (entry.startsWith('clipsnap-')) {
            const dirPath = join(tmp, entry);
            try {
              const info = await lstat(dirPath);
              if (info.isDirectory() && !info.isSymbolicLink()) {
                // Count files before deletion
                const files = await readdir(dirPath);
                for (const f of files) {
                  try {
                    const fStat = await stat(join(dirPath, f));
                    totalFreed += fStat.size;
                    totalDeleted++;
                  } catch {
                    // skip
                  }
                }
                await rm(dirPath, { recursive: true, force: true });
              }
            } catch {
              // skip inaccessible dirs
            }
          }
        }
      } catch {
        // TMPDIR read failed
      }

      return {
        content: [
          {
            type: 'text',
            text: `Cleaned up all sessions: ${totalDeleted} files deleted, ${formatBytes(totalFreed)} freed.`,
          },
        ],
      };
    }

    const result = await storage.cleanup({
      olderThanMinutes: args.older_than_minutes,
      all: !args.older_than_minutes,
    });

    return {
      content: [
        {
          type: 'text',
          text: `Cleanup complete: ${result.deletedCount} files deleted, ${formatBytes(result.freedBytes)} freed.`,
        },
      ],
    };
  },
);

// --- Server lifecycle ---

async function main() {
  await storage.initialize();

  // Graceful shutdown
  if (config.cleanupOnExit) {
    const shutdown = async () => {
      await storage.destroy();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ClipSnap MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

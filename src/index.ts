#!/usr/bin/env node

/**
 * ClipSnap MCP Server — entry point.
 *
 * Exposes clipboard and image tools over the Model Context Protocol (MCP) via stdio transport.
 *
 * Tools provided:
 * - `paste_image` — reads an image from the macOS clipboard
 * - `paste_recent` — reads the last N images from a screenshots folder
 * - `paste_file` — reads a specific image file by path
 * - `list_images` — lists images saved during the current session
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
import { processImage, getImageInfo } from './image.js';
import { StorageManager } from './storage.js';

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
      'Reads an image from the system clipboard and returns it. Bypasses terminal clipboard bugs.',
    inputSchema: {
      format: z.enum(['png', 'jpeg']).optional().describe('Output format'),
      quality: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe('JPEG quality (1-100, ignored for PNG)'),
      max_dimension: z
        .number()
        .min(1)
        .optional()
        .describe('Max long edge in pixels'),
      save: z.boolean().optional().describe('Save copy to temp dir'),
    },
  },
  async (args): Promise<CallToolResult> => {
    // Security check
    if (config.checkConcealed) {
      const safety = await checkClipboardSafety();
      if (!safety.safe) {
        return {
          content: [{ type: 'text', text: safety.reason! }],
          isError: true,
        };
      }
      if (!safety.hasImage) {
        return {
          content: [
            {
              type: 'text',
              text: 'No image found in clipboard. Copy a screenshot first (Cmd+Shift+4, Shottr, or Cmd+C on an image).',
            },
          ],
          isError: true,
        };
      }
    }

    try {
      const clipboard = await readClipboardImage();

      const format = args.format ?? config.imageFormat;
      const quality = args.quality ?? config.jpegQuality;
      const maxDimension = args.max_dimension ?? config.maxDimension;
      const shouldSave = args.save ?? true;

      const processed = await processImage(clipboard.data, {
        maxDimension,
        format,
        quality,
      });

      let savedPath = '';
      if (shouldSave) {
        savedPath = await storage.saveImage(processed.data, format);
      }

      const resized =
        processed.originalWidth !== processed.width ||
        processed.originalHeight !== processed.height;
      const sizeInfo = formatBytes(processed.data.length);

      const content: CallToolResult['content'] = [];

      // Warn if image was very large
      if (
        processed.originalWidth > 4000 ||
        processed.originalHeight > 4000
      ) {
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

      let description = `Image from clipboard (${processed.originalWidth}x${processed.originalHeight}`;
      if (resized) {
        description += ` → resized to ${processed.width}x${processed.height}`;
      }
      description += `, ${sizeInfo})`;
      if (savedPath) {
        description += `. Saved: ${savedPath}`;
      }
      content.push({ type: 'text', text: description });

      return { content };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Detect macOS 16+ clipboard permission denial
      if (msg.includes('not permitted') || msg.includes('denied')) {
        return {
          content: [
            {
              type: 'text',
              text: 'Clipboard access denied by macOS. When prompted, click "Allow" to grant clipboard access to Terminal.',
            },
          ],
          isError: true,
        };
      }
      // Detect disk full
      if (msg.includes('ENOSPC') || msg.includes('No space left')) {
        return {
          content: [
            {
              type: 'text',
              text: 'Cannot save image: disk space low. Run cleanup_images or free disk space.',
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: msg }],
        isError: true,
      };
    }
  },
);

// Tool 2: paste_recent — Read last N images from a folder
server.registerTool(
  'paste_recent',
  {
    title: 'Paste Recent Screenshots',
    description:
      'Reads the last N images from a folder (default: ~/Screenshots).',
    inputSchema: {
      count: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe('Number of images (1-10)'),
      folder: z.string().optional().describe('Source folder path'),
      max_dimension: z
        .number()
        .min(1)
        .optional()
        .describe('Max long edge in pixels'),
    },
  },
  async (args): Promise<CallToolResult> => {
    const count = args.count ?? 3;
    const folder = resolvePath(args.folder ?? config.screenshotsDir);
    const maxDimension = args.max_dimension ?? config.maxDimension;

    let entries: string[];
    try {
      entries = await readdir(folder);
    } catch {
      return {
        content: [
          {
            type: 'text',
            text: `Folder not found: ${folder}. Set CLIPSNAP_SCREENSHOTS_DIR to your screenshots folder.`,
          },
        ],
        isError: true,
      };
    }

    // Filter image files and get stats
    const imageFiles: { name: string; path: string; mtime: Date }[] = [];
    for (const name of entries) {
      const ext = extname(name).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;
      const filePath = join(folder, name);
      try {
        const info = await stat(filePath);
        if (info.isFile()) {
          imageFiles.push({ name, path: filePath, mtime: info.mtime });
        }
      } catch {
        // skip inaccessible files
      }
    }

    if (imageFiles.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No image files found in ${folder}. Take some screenshots first.`,
          },
        ],
        isError: true,
      };
    }

    // Sort by mtime descending, take last N
    imageFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const selected = imageFiles.slice(0, count);

    const content: CallToolResult['content'] = [
      {
        type: 'text',
        text: `${selected.length} recent images from ${folder}:`,
      },
    ];

    for (let i = 0; i < selected.length; i++) {
      const file = selected[i];
      try {
        const raw = await readFile(file.path);
        const format = extname(file.name).toLowerCase() === '.jpg' ||
          extname(file.name).toLowerCase() === '.jpeg'
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
          text: `${i + 1}. ${file.name} (${processed.width}x${processed.height})`,
        });
      } catch (error) {
        content.push({
          type: 'text',
          text: `${i + 1}. ${file.name} — error: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return { content };
  },
);

// Tool 3: paste_file — Read a specific image file
server.registerTool(
  'paste_file',
  {
    title: 'Paste Image File',
    description: 'Reads a specific image file by path and returns it.',
    inputSchema: {
      path: z.string().describe('Absolute or ~ path to image file'),
      max_dimension: z
        .number()
        .min(1)
        .optional()
        .describe('Max long edge in pixels'),
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

// Tool 4: list_images — List saved session images
server.registerTool(
  'list_images',
  {
    title: 'List Session Images',
    description: 'Shows images saved during the current ClipSnap session.',
  },
  async (): Promise<CallToolResult> => {
    const files = await storage.listImages();

    if (files.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No images saved in current session.',
          },
        ],
      };
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const lines: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      let dims = '';
      try {
        const info = await getImageInfo(f.path);
        dims = `${info.width}x${info.height}, `;
      } catch {
        // skip dimensions if sips fails
      }
      lines.push(
        `${i + 1}. ${f.name} (${dims}${formatBytes(f.size)}) — ${timeAgo(f.mtime)}`,
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `ClipSnap session images (${files.length} files, ${formatBytes(totalSize)}):\n${lines.join('\n')}`,
        },
      ],
    };
  },
);

// Tool 5: cleanup_images — Manual cleanup
server.registerTool(
  'cleanup_images',
  {
    title: 'Cleanup Images',
    description:
      'Deletes temporary ClipSnap images. Use all=true to delete all sessions.',
    inputSchema: {
      all: z
        .boolean()
        .optional()
        .describe('Delete ALL sessions (not just current)'),
      older_than_minutes: z
        .number()
        .optional()
        .describe('Delete files older than N minutes'),
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

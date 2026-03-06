#!/usr/bin/env node

/**
 * ClipSnap MCP Server — entry point.
 *
 * Exposes clipboard and image tools over the Model Context Protocol (MCP) via stdio transport.
 *
 * Tools provided:
 * - `paste_recent` — shows recent images from session history + watcher + Spotlight
 * - `cleanup_images` — deletes temporary session images
 *
 * A Swift clipboard watcher runs alongside the server, capturing clipboard images
 * to ~/.clipsnap/clipboard-captures/ for instant discovery without Spotlight delay.
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
import { processImage } from './image.js';
import { StorageManager } from './storage.js';
import { findRecentScreenshots } from './screenshots.js';
import { startWatcher, stopWatcher } from './watcher.js';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';


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

// Tool: paste_recent — Show recent images from watcher + session + Spotlight
server.registerTool(
  'paste_recent',
  {
    title: 'Paste Recent Screenshots',
    description:
      'Shows the last N images by combining clipboard watcher captures, session history, and macOS Spotlight screenshots. The clipboard watcher catches images copied via any app (Shottr Esc, Cmd+C, etc.) instantly — no Spotlight delay. Results are sorted by time, newest first. Use when the user says "show my last screenshots", "look at my clipboard", or "check what I just captured". Pass folder to scan a specific directory instead.',
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

    // Merge session history + watcher + Spotlight, dedup by path, sort by mtime desc
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
        content: [{ type: 'text', text: 'No recent images found. Take a screenshot (Cmd+Shift+4, Shottr, CleanShot X) or copy an image to the clipboard.' }],
        isError: true,
      };
    }

    return await buildRecentResponse(selected, 'watcher + session + Spotlight', maxDimension);
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

// Tool: cleanup_images — Manual cleanup
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
  startWatcher();

  // Graceful shutdown
  const shutdown = async () => {
    stopWatcher();
    if (config.cleanupOnExit) {
      await storage.destroy();
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ClipSnap MCP server running on stdio');
}

main().catch((error) => {
  stopWatcher();
  console.error('Fatal error:', error);
  process.exit(1);
});

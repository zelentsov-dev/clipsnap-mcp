import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ScreenshotEntry {
  path: string;
  name: string;
  mtime: Date;
}

/**
 * Finds recent screenshots system-wide using macOS Spotlight (`mdfind`).
 * Falls back to scanning a specific folder if Spotlight fails.
 *
 * @param count - Maximum number of screenshots to return
 * @param fallbackDir - Directory to scan if mdfind fails
 * @returns Array of screenshot entries sorted by mtime descending
 */
export async function findRecentScreenshots(
  count: number,
  fallbackDir?: string,
): Promise<ScreenshotEntry[]> {
  try {
    return await findViaSpotlight(count);
  } catch {
    if (fallbackDir) {
      return findViaFolder(fallbackDir, count);
    }
    return [];
  }
}

async function findViaSpotlight(count: number): Promise<ScreenshotEntry[]> {
  const { stdout } = await execFileAsync(
    'mdfind',
    ['kMDItemIsScreenCapture == 1'],
    { timeout: 5_000, maxBuffer: 10 * 1024 * 1024 },
  );

  const paths = stdout.trim().split('\n').filter(Boolean);
  if (paths.length === 0) return [];

  // mdfind returns files in arbitrary order, so we must stat all of them to find the newest
  const entries: ScreenshotEntry[] = [];

  const promises = paths.map(async (p) => {
    try {
      const info = await stat(p);
      if (info.isFile()) {
        const name = p.split('/').pop() ?? p;
        return { path: p, name, mtime: info.mtime } as ScreenshotEntry;
      }
    } catch {
      // skip inaccessible files
    }
    return null;
  });

  const results = await Promise.all(promises);
  for (const r of results) {
    if (r) entries.push(r);
  }

  entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return entries.slice(0, count);
}

async function findViaFolder(folder: string, count: number): Promise<ScreenshotEntry[]> {
  const { readdir } = await import('node:fs/promises');
  const { extname, join } = await import('node:path');

  const IMAGE_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.tiff', '.heic',
  ]);

  let dirEntries: string[];
  try {
    dirEntries = await readdir(folder);
  } catch {
    return [];
  }

  const entries: ScreenshotEntry[] = [];
  for (const name of dirEntries) {
    const ext = extname(name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const filePath = join(folder, name);
    try {
      const info = await stat(filePath);
      if (info.isFile()) {
        entries.push({ path: filePath, name, mtime: info.mtime });
      }
    } catch {
      // skip
    }
  }

  entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return entries.slice(0, count);
}

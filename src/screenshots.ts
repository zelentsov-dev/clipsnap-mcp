import { execFile } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.tiff', '.heic',
]);

/** Well-known directory where the clipboard watcher saves captured images. */
const WATCHER_DIR = join(homedir(), '.clipsnap', 'clipboard-captures');

export interface ScreenshotEntry {
  path: string;
  name: string;
  mtime: Date;
}

/**
 * Finds recent screenshots from multiple sources in parallel:
 * 1. Watcher captures dir — clipboard images saved by the Swift watcher (instant)
 * 2. Native macOS screenshots dir (instant)
 * 3. Spotlight `mdfind` — broad coverage for all apps/locations (may have indexing delay)
 *
 * Results are merged, deduplicated by path, and sorted by mtime desc.
 */
export async function findRecentScreenshots(
  count: number,
  nativeDir?: string,
): Promise<ScreenshotEntry[]> {
  const dirsToScan = [WATCHER_DIR];
  if (nativeDir) dirsToScan.push(nativeDir);

  const [directResult, spotlightResult] = await Promise.allSettled([
    scanDirs(dirsToScan, count * 2),
    findViaSpotlight(count * 2),
  ]);

  const seen = new Set<string>();
  const merged: ScreenshotEntry[] = [];

  for (const entry of directResult.status === 'fulfilled' ? directResult.value : []) {
    if (!seen.has(entry.path)) {
      seen.add(entry.path);
      merged.push(entry);
    }
  }
  for (const entry of spotlightResult.status === 'fulfilled' ? spotlightResult.value : []) {
    if (!seen.has(entry.path)) {
      seen.add(entry.path);
      merged.push(entry);
    }
  }

  merged.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return merged.slice(0, count);
}

/** Scans multiple directories for image files in parallel. */
async function scanDirs(dirs: string[], count: number): Promise<ScreenshotEntry[]> {
  const results = await Promise.all(dirs.map((dir) => scanFolder(dir, count)));

  const seen = new Set<string>();
  const merged: ScreenshotEntry[] = [];
  for (const entries of results) {
    for (const entry of entries) {
      if (!seen.has(entry.path)) {
        seen.add(entry.path);
        merged.push(entry);
      }
    }
  }

  merged.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return merged.slice(0, count);
}

async function findViaSpotlight(count: number): Promise<ScreenshotEntry[]> {
  const { stdout } = await execFileAsync(
    'mdfind',
    ['kMDItemIsScreenCapture == 1'],
    { timeout: 5_000, maxBuffer: 10 * 1024 * 1024 },
  );

  const paths = stdout.trim().split('\n').filter(Boolean);
  if (paths.length === 0) return [];

  const entries: ScreenshotEntry[] = [];
  const promises = paths.map(async (p) => {
    try {
      const info = await lstat(p);
      if (info.isFile() && !info.isSymbolicLink()) {
        return { path: p, name: p.split('/').pop() ?? p, mtime: info.mtime } as ScreenshotEntry;
      }
    } catch { /* skip */ }
    return null;
  });

  const results = await Promise.all(promises);
  for (const r of results) {
    if (r) entries.push(r);
  }

  entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return entries.slice(0, count);
}

async function scanFolder(folder: string, count: number): Promise<ScreenshotEntry[]> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return [];
  }

  const entries: ScreenshotEntry[] = [];
  for (const name of names) {
    if (!IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    const filePath = join(folder, name);
    try {
      const info = await lstat(filePath);
      if (info.isFile() && !info.isSymbolicLink()) {
        entries.push({ path: filePath, name, mtime: info.mtime });
      }
    } catch { /* skip */ }
  }

  entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return entries.slice(0, count);
}

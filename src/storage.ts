import { mkdir, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import type { Config } from './config.js';

/**
 * Metadata for a stored image file within the session directory.
 */
export interface ImageFile {
  /** Absolute path to the image file. */
  path: string;
  /** File name (without directory). */
  name: string;
  /** File size in bytes. */
  size: number;
  /** Last modification time. */
  mtime: Date;
}

/**
 * Summary of a cleanup operation.
 */
export interface CleanupResult {
  /** Number of files deleted. */
  deletedCount: number;
  /** Total bytes freed by the deletion. */
  freedBytes: number;
}

/** File extensions recognized as image files by the storage manager. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpeg', '.jpg']);

/**
 * Manages temporary image storage for a single ClipSnap session.
 *
 * Each session gets a unique directory under `$TMPDIR` (e.g., `/tmp/clipsnap-<uuid>/`).
 * The manager handles saving, listing, and cleaning up images based on TTL, file count,
 * and total size constraints from the {@link Config}.
 */
export class StorageManager {
  /** Absolute path to the session's temporary directory. */
  private sessionDir: string;
  private config: Config;

  /**
   * Creates a new storage manager for a session.
   * Call {@link initialize} before using any other methods.
   *
   * @param config - Application configuration with storage limits
   */
  constructor(config: Config) {
    this.config = config;
    this.sessionDir = join(tmpdir(), `clipsnap-${randomUUID()}`);
  }

  /** Creates the session directory with restricted permissions (0700). */
  async initialize(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Saves image data to the session directory and triggers automatic cleanup.
   *
   * Files are named with a timestamp and random suffix: `img-<timestamp>-<hex>.<ext>`.
   * File permissions are set to 0600 (owner read/write only).
   *
   * @param data - Raw image bytes to write
   * @param format - Image format, determines the file extension
   * @returns Absolute path to the saved file
   */
  async saveImage(data: Buffer, format: 'png' | 'jpeg'): Promise<string> {
    const timestamp = Date.now();
    const random = randomBytes(2).toString('hex');
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    const filename = `img-${timestamp}-${random}.${ext}`;
    const filePath = join(this.sessionDir, filename);

    await writeFile(filePath, data, { mode: 0o600 });
    await this.cleanup();

    return filePath;
  }

  /**
   * Lists all image files in the session directory, sorted by modification time (newest first).
   *
   * @returns Array of {@link ImageFile} objects, or an empty array if the directory doesn't exist
   */
  async listImages(): Promise<ImageFile[]> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionDir);
    } catch {
      return [];
    }

    const files: ImageFile[] = [];

    for (const name of entries) {
      const ext = name.substring(name.lastIndexOf('.')).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) continue;

      const filePath = join(this.sessionDir, name);
      try {
        const info = await stat(filePath);
        if (info.isFile()) {
          files.push({
            path: filePath,
            name,
            size: info.size,
            mtime: info.mtime,
          });
        }
      } catch {
        // File may have been deleted between readdir and stat
      }
    }

    files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return files;
  }

  /**
   * Cleans up session images based on configurable criteria.
   *
   * When called without options (or after `saveImage`), applies three cleanup passes in order:
   * 1. **TTL** — deletes files older than `config.ttlMinutes`
   * 2. **File count** — removes oldest files exceeding `config.maxFiles`
   * 3. **Total size** — removes oldest files until total size is under `config.maxSizeMB`
   *
   * @param options - Optional cleanup overrides
   * @param options.all - If `true`, deletes all session images regardless of TTL/limits
   * @param options.olderThanMinutes - Custom TTL override (in minutes) for this cleanup run
   * @returns A {@link CleanupResult} with the count and bytes freed
   */
  async cleanup(options?: {
    all?: boolean;
    olderThanMinutes?: number;
  }): Promise<CleanupResult> {
    let deletedCount = 0;
    let freedBytes = 0;

    if (options?.all) {
      const files = await this.listImages();
      for (const file of files) {
        await rm(file.path, { force: true }).catch(() => {});
        deletedCount++;
        freedBytes += file.size;
      }
      return { deletedCount, freedBytes };
    }

    const ttl = options?.olderThanMinutes ?? this.config.ttlMinutes;
    let files = await this.listImages();

    // 1. Delete files older than TTL
    const cutoff = Date.now() - ttl * 60 * 1000;
    const expired = files.filter((f) => f.mtime.getTime() < cutoff);
    for (const file of expired) {
      await rm(file.path, { force: true }).catch(() => {});
      deletedCount++;
      freedBytes += file.size;
    }

    if (expired.length > 0) {
      files = await this.listImages();
    }

    // 2. Enforce max file count (delete oldest first)
    if (files.length > this.config.maxFiles) {
      const toDelete = files.slice(this.config.maxFiles); // Already sorted newest-first
      for (const file of toDelete) {
        await rm(file.path, { force: true }).catch(() => {});
        deletedCount++;
        freedBytes += file.size;
      }
      files = await this.listImages();
    }

    // 3. Enforce max total size (delete oldest first)
    const maxBytes = this.config.maxSizeMB * 1024 * 1024;
    let totalSize = files.reduce((sum, f) => sum + f.size, 0);
    if (totalSize > maxBytes) {
      // Delete from the end (oldest) until under limit
      for (let i = files.length - 1; i >= 0 && totalSize > maxBytes; i--) {
        const file = files[i];
        await rm(file.path, { force: true }).catch(() => {});
        totalSize -= file.size;
        deletedCount++;
        freedBytes += file.size;
      }
    }

    return { deletedCount, freedBytes };
  }

  /**
   * Recursively deletes the entire session directory and all its contents.
   * Silently ignores errors (e.g., directory already removed).
   */
  async destroy(): Promise<void> {
    await rm(this.sessionDir, { recursive: true, force: true }).catch(() => {});
  }
}

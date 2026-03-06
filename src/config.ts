import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

/**
 * Application configuration controlling image processing, storage limits, and security behavior.
 * All values can be overridden via environment variables prefixed with `CLIPSNAP_`.
 */
export interface Config {
  /** Maximum number of image files to retain in the session directory. Oldest files are deleted first. */
  maxFiles: number;
  /** Time-to-live in minutes for saved images. Files older than this are deleted during cleanup. */
  ttlMinutes: number;
  /** Maximum total storage size in megabytes for all session images combined. */
  maxSizeMB: number;
  /** Maximum dimension (width or height) in pixels. Images exceeding this are downscaled proportionally. */
  maxDimension: number;
  /** Output image format for clipboard captures. */
  imageFormat: 'png' | 'jpeg';
  /** JPEG compression quality (1-100). Only applies when `imageFormat` is `'jpeg'`. */
  jpegQuality: number;
  /** Absolute path to the folder used by `paste_recent` to find screenshot files. */
  screenshotsDir: string;
  /** Whether to inspect clipboard metadata for concealed/transient types before reading. */
  checkConcealed: boolean;
  /** Whether to delete the session temp directory on process exit (SIGINT/SIGTERM). */
  cleanupOnExit: boolean;
}

/**
 * Reads an environment variable and parses it as an integer.
 * Returns the fallback value if the variable is unset or not a valid integer.
 *
 * @param key - Environment variable name
 * @param fallback - Default value when the variable is missing or unparseable
 * @returns The parsed integer or the fallback
 */
function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Reads an environment variable and parses it as a boolean.
 * Recognizes `"true"` and `"false"` (case-insensitive). Returns the fallback otherwise.
 *
 * @param key - Environment variable name
 * @param fallback - Default value when the variable is missing or not a boolean string
 * @returns The parsed boolean or the fallback
 */
function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return fallback;
}

/**
 * Resolves a file path, expanding a leading `~` to the user's home directory.
 *
 * @param raw - A file path that may begin with `~` or `~/`
 * @returns An absolute resolved path
 *
 * @example
 * resolvePath('~/Screenshots') // => '/Users/alice/Screenshots'
 * resolvePath('/tmp/foo')      // => '/tmp/foo'
 */
function resolvePath(raw: string): string {
  if (raw.startsWith('~')) {
    return resolve(homedir(), raw.slice(raw.startsWith('~/') ? 2 : 1));
  }
  return resolve(raw);
}

/**
 * Auto-detects the macOS screenshot folder.
 *
 * Resolution order:
 * 1. `defaults read com.apple.screencapture location` (user's macOS setting)
 * 2. `~/Screenshots` (if exists)
 * 3. `~/Desktop` (macOS default)
 */
function detectScreenshotsDir(): string {
  try {
    const raw = execFileSync('defaults', ['read', 'com.apple.screencapture', 'location'], {
      encoding: 'utf-8',
      timeout: 3_000,
    }).trim();
    if (raw) return resolvePath(raw);
  } catch {
    // defaults key not set — fall through
  }

  const home = homedir();
  const candidates = [
    join(home, 'Screenshots'),
    join(home, 'Desktop'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

/**
 * Loads the application configuration from environment variables with sensible defaults.
 *
 * The screenshots directory is auto-detected from macOS settings unless overridden
 * via `CLIPSNAP_SCREENSHOTS_DIR`.
 *
 * @returns A fully resolved {@link Config} object
 */
export function loadConfig(): Config {
  const format = process.env['CLIPSNAP_IMAGE_FORMAT'];
  const quality = envInt('CLIPSNAP_JPEG_QUALITY', 80);

  return {
    maxFiles: envInt('CLIPSNAP_MAX_FILES', 50),
    ttlMinutes: envInt('CLIPSNAP_TTL_MINUTES', 60),
    maxSizeMB: envInt('CLIPSNAP_MAX_SIZE_MB', 200),
    maxDimension: envInt('CLIPSNAP_MAX_DIMENSION', 1568),
    imageFormat: format === 'jpeg' ? 'jpeg' : 'png',
    jpegQuality: Math.max(1, Math.min(100, quality)),
    screenshotsDir: process.env['CLIPSNAP_SCREENSHOTS_DIR']
      ? resolvePath(process.env['CLIPSNAP_SCREENSHOTS_DIR'])
      : detectScreenshotsDir(),
    checkConcealed: envBool('CLIPSNAP_CHECK_CONCEALED', true),
    cleanupOnExit: envBool('CLIPSNAP_CLEANUP_ON_EXIT', true),
  };
}

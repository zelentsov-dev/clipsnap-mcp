import { homedir } from 'node:os';
import { resolve } from 'node:path';

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
 * Loads the application configuration from environment variables with sensible defaults.
 *
 * Environment variables:
 * - `CLIPSNAP_MAX_FILES` — max stored files (default: 50)
 * - `CLIPSNAP_TTL_MINUTES` — file TTL in minutes (default: 60)
 * - `CLIPSNAP_MAX_SIZE_MB` — max total storage in MB (default: 200)
 * - `CLIPSNAP_MAX_DIMENSION` — max image dimension in px (default: 1568)
 * - `CLIPSNAP_IMAGE_FORMAT` — `"png"` or `"jpeg"` (default: `"png"`)
 * - `CLIPSNAP_JPEG_QUALITY` — JPEG quality 1-100 (default: 80)
 * - `CLIPSNAP_SCREENSHOTS_DIR` — screenshots folder (default: `~/Screenshots`)
 * - `CLIPSNAP_CHECK_CONCEALED` — check for password managers (default: `true`)
 * - `CLIPSNAP_CLEANUP_ON_EXIT` — auto-delete on exit (default: `true`)
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
    screenshotsDir: resolvePath(
      process.env['CLIPSNAP_SCREENSHOTS_DIR'] ?? '~/Screenshots',
    ),
    checkConcealed: envBool('CLIPSNAP_CHECK_CONCEALED', true),
    cleanupOnExit: envBool('CLIPSNAP_CLEANUP_ON_EXIT', true),
  };
}

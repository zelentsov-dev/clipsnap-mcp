import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Result of a clipboard safety inspection.
 * Used to prevent accidental exposure of sensitive data (e.g., passwords from password managers).
 */
export interface ClipboardSafetyResult {
  /** Whether the clipboard content is considered safe to read. */
  safe: boolean;
  /** Human-readable explanation when `safe` is `false`. */
  reason?: string;
  /** Whether an image type was detected among the clipboard flavors. */
  hasImage: boolean;
}

/** Strings that appear in `osascript -e 'clipboard info'` output when image data is present. */
const IMAGE_MARKERS = ['PNGf', 'TIFF', 'JPEG', 'GIF picture', 'public.png', 'public.tiff', 'public.jpeg'] as const;

/**
 * Inspects the macOS clipboard metadata via `osascript` to detect unsafe content
 * before reading the actual data.
 *
 * Checks for:
 * - **ConcealedType** — set by password managers (1Password, etc.) to mark sensitive data
 * - **TransientType** — set by apps for ephemeral clipboard content that may have expired
 *
 * Fails open: if `osascript` itself fails, the result is `{ safe: true, hasImage: false }`
 * so that the clipboard reader can attempt its own error handling.
 *
 * @returns A {@link ClipboardSafetyResult} indicating safety and image presence
 */
export async function checkClipboardSafety(): Promise<ClipboardSafetyResult> {
  let stdout: string;
  try {
    const result = await execFileAsync('osascript', ['-e', 'clipboard info'], {
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
    });
    stdout = result.stdout;
  } catch {
    // Fail open: let the clipboard reader handle actual errors
    return { safe: true, hasImage: false };
  }

  if (stdout.includes('org.nspasteboard.ConcealedType')) {
    return {
      safe: false,
      reason:
        'Clipboard contains concealed data (likely a password). Skipping for security. Copy a screenshot instead.',
      hasImage: false,
    };
  }

  if (stdout.includes('org.nspasteboard.TransientType')) {
    return {
      safe: false,
      reason:
        'Clipboard contains transient data. It may have expired. Try copying again.',
      hasImage: false,
    };
  }

  const hasImage = IMAGE_MARKERS.some((marker) => stdout.includes(marker));

  return { safe: true, hasImage };
}

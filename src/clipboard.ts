import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/** Maximum buffer size (50 MB) for child process stdout when reading clipboard image data. */
const MAX_BUFFER = 50 * 1024 * 1024;

/**
 * Raw image data read from the macOS clipboard.
 */
export interface ClipboardResult {
  /** The raw image bytes. */
  data: Buffer;
  /** The native format the image was read in (`"png"` via pngpaste, or `"tiff"` via osascript fallback). */
  format: "png" | "tiff";
}

/**
 * Checks whether the `pngpaste` CLI tool is installed and available on `$PATH`.
 *
 * @returns `true` if pngpaste is found, `false` otherwise
 */
export async function isPngpasteAvailable(): Promise<boolean> {
  try {
    await execFile("which", ["pngpaste"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads an image from the macOS system clipboard.
 *
 * Attempts `pngpaste` first (fast, outputs PNG to stdout). If pngpaste is not installed,
 * falls back to `osascript` which reads via AppleScript (slower, supports PNG and TIFF).
 *
 * @returns A {@link ClipboardResult} containing the raw image data and its format
 * @throws {Error} If no image is found on the clipboard
 * @throws {Error} If clipboard access is denied by macOS
 */
export async function readClipboardImage(): Promise<ClipboardResult> {
  const pngpasteResult = await tryPngpaste();
  if (pngpasteResult) return pngpasteResult;

  return readViaOsascript();
}

/**
 * Attempts to read clipboard image data using the `pngpaste` CLI tool.
 * Returns `null` if pngpaste is not installed (ENOENT), allowing the caller to fall back.
 *
 * @returns The clipboard image as PNG, or `null` if pngpaste is unavailable
 * @throws {Error} If pngpaste is available but no image is on the clipboard
 */
async function tryPngpaste(): Promise<ClipboardResult | null> {
  try {
    const { stdout } = await execFile("pngpaste", ["-"], {
      encoding: "buffer",
      maxBuffer: MAX_BUFFER,
    });

    if (stdout && stdout.length > 0) {
      return { data: stdout, format: "png" };
    }

    throw new Error(
      "No image found in clipboard. Copy a screenshot first (Cmd+Shift+4, Shottr, or Cmd+C on an image).",
    );
  } catch (error: unknown) {
    if (isEnoent(error)) {
      process.stderr.write(
        "pngpaste not found. Install: brew install pngpaste. Using slower osascript fallback for now.\n",
      );
      return null;
    }

    if (isPngpasteNoImageError(error)) {
      throw new Error(
        "No image found in clipboard. Copy a screenshot first (Cmd+Shift+4, Shottr, or Cmd+C on an image).",
      );
    }

    throw error;
  }
}

/**
 * Reads clipboard image data using macOS `osascript` (AppleScript).
 * Tries PNG format first, then TIFF as a fallback.
 *
 * @returns The clipboard image data and its detected format
 * @throws {Error} If neither PNG nor TIFF data can be read (likely a permissions issue)
 */
async function readViaOsascript(): Promise<ClipboardResult> {
  const pngResult = await tryOsascriptFormat("PNGf");
  if (pngResult) return { data: pngResult, format: "png" };

  const tiffResult = await tryOsascriptFormat("TIFF");
  if (tiffResult) return { data: tiffResult, format: "tiff" };

  throw new Error(
    "Cannot read clipboard. In System Settings > Privacy > Automation, allow Terminal to control your computer.",
  );
}

/**
 * Attempts to read a specific image format from the clipboard using `osascript`.
 * The AppleScript command returns hex-encoded data wrapped in `«data ...»` delimiters.
 *
 * @param formatClass - The AppleScript clipboard class to request (`"PNGf"` or `"TIFF"`)
 * @returns The decoded image buffer, or `null` if the format is not available
 */
async function tryOsascriptFormat(
  formatClass: "PNGf" | "TIFF",
): Promise<Buffer | null> {
  try {
    const { stdout } = await execFile(
      "osascript",
      [
        "-e",
        `set imgData to the clipboard as «class ${formatClass}»`,
        "-e",
        "return imgData",
      ],
      { encoding: "utf-8", maxBuffer: MAX_BUFFER },
    );

    return parseOsascriptHex(stdout.trim(), formatClass);
  } catch {
    return null;
  }
}

/**
 * Parses the hex-encoded output from `osascript`'s clipboard read command.
 * Expected format: `«data PNGf<hex>»` or `«data TIFF<hex>»`.
 *
 * @param raw - The trimmed stdout from osascript
 * @param formatClass - The format class used in the AppleScript command
 * @returns The decoded binary data, or `null` if the output doesn't match the expected format
 */
function parseOsascriptHex(
  raw: string,
  formatClass: "PNGf" | "TIFF",
): Buffer | null {
  const prefix = `«data ${formatClass}`;
  const suffix = "»";

  if (!raw.startsWith(prefix) || !raw.endsWith(suffix)) {
    return null;
  }

  const hex = raw.slice(prefix.length, -suffix.length).trim();
  if (hex.length === 0 || hex.length % 2 !== 0) {
    return null;
  }

  return Buffer.from(hex, "hex");
}

/** Checks whether an error is an ENOENT (file/command not found) error. */
function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Checks whether a pngpaste error indicates "no image on clipboard" (non-zero exit, but not ENOENT). */
function isPngpasteNoImageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const execError = error as { code?: number; stderr?: string };
  return (
    typeof execError.code === "number" &&
    execError.code !== 0 &&
    !isEnoent(error)
  );
}

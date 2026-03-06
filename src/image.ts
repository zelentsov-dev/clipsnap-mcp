import { execFile } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Options applied to all sips invocations to prevent hangs and memory exhaustion. */
const SIPS_OPTIONS = { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 };

/**
 * Basic metadata about an image file, as reported by macOS `sips`.
 */
export interface ImageInfo {
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** Image format identifier (e.g., `"png"`, `"jpeg"`, `"tiff"`). */
  format: string;
}

/**
 * An image that has been resized and/or format-converted, ready for MCP response delivery.
 */
export interface ProcessedImage {
  /** The final image data after processing. */
  data: Buffer;
  /** MIME type of the output image. */
  mimeType: 'image/png' | 'image/jpeg';
  /** Final width in pixels (after any resizing). */
  width: number;
  /** Final height in pixels (after any resizing). */
  height: number;
  /** Original width in pixels before processing. */
  originalWidth: number;
  /** Original height in pixels before processing. */
  originalHeight: number;
}

/**
 * Retrieves image dimensions and format using macOS `sips` (Scriptable Image Processing System).
 *
 * @param filePath - Absolute path to the image file
 * @returns An {@link ImageInfo} object with width, height, and format
 * @throws {Error} If `sips` output cannot be parsed (e.g., unsupported file type)
 */
export async function getImageInfo(filePath: string): Promise<ImageInfo> {
  const { stdout } = await execFileAsync('sips', [
    '-g', 'pixelWidth',
    '-g', 'pixelHeight',
    '-g', 'format',
    filePath,
  ], SIPS_OPTIONS);

  const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
  const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);
  const formatMatch = stdout.match(/format:\s*(\S+)/);

  if (!widthMatch || !heightMatch || !formatMatch) {
    throw new Error(`Failed to parse sips output for ${filePath}`);
  }

  return {
    width: parseInt(widthMatch[1], 10),
    height: parseInt(heightMatch[1], 10),
    format: formatMatch[1],
  };
}

/**
 * Processes a raw image buffer: optionally downscales to fit within `maxDimension`,
 * converts to the target format, and applies JPEG quality settings.
 *
 * Uses a temporary file and macOS `sips` for all transformations. The temp file
 * is always cleaned up, even on error.
 *
 * @param input - Raw image data (any format supported by sips)
 * @param options - Processing parameters
 * @param options.maxDimension - Maximum allowed dimension (longest edge) in pixels
 * @param options.format - Target output format
 * @param options.quality - JPEG quality (1-100); ignored for PNG
 * @returns A {@link ProcessedImage} with the transformed data and metadata
 * @throws {Error} If sips fails to process the image
 */
export async function processImage(
  input: Buffer,
  options: {
    maxDimension: number;
    format: 'png' | 'jpeg';
    quality: number;
  },
): Promise<ProcessedImage> {
  const tempPath = join(tmpdir(), `clipsnap-${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, input, { mode: 0o600 });

    const original = await getImageInfo(tempPath);
    const originalWidth = original.width;
    const originalHeight = original.height;

    const longestSide = Math.max(originalWidth, originalHeight);
    if (longestSide > options.maxDimension) {
      await execFileAsync('sips', [
        '--resampleHeightWidthMax', String(options.maxDimension),
        tempPath,
      ], SIPS_OPTIONS);
    }

    const sipsFormat = options.format === 'jpeg' ? 'jpeg' : 'png';
    await execFileAsync('sips', ['-s', 'format', sipsFormat, tempPath], SIPS_OPTIONS);

    if (options.format === 'jpeg') {
      await execFileAsync('sips', [
        '-s', 'formatOptions', String(options.quality),
        tempPath,
      ], SIPS_OPTIONS);
    }

    const final = await getImageInfo(tempPath);
    const data = await readFile(tempPath);

    return {
      data,
      mimeType: options.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      width: final.width,
      height: final.height,
      originalWidth,
      originalHeight,
    };
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

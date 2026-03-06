import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { accessSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCHER_BINARY = join(__dirname, '..', 'watcher', '.build', 'release', 'clipsnap-watcher');

/** Well-known directory where the clipboard watcher saves captured images. */
export const WATCHER_CAPTURES_DIR = join(homedir(), '.clipsnap', 'clipboard-captures');

let watcherProcess: ChildProcess | null = null;

/**
 * Spawns the clipboard watcher as a background process.
 * The watcher polls NSPasteboard every 500ms and saves new images to WATCHER_CAPTURES_DIR.
 * Safe to call multiple times — only one watcher runs at a time.
 */
export function startWatcher(): void {
  if (watcherProcess) return;

  try {
    accessSync(WATCHER_BINARY);
  } catch {
    // Binary not built — skip silently, paste_recent still works via Spotlight + direct scan
    return;
  }

  try {
    watcherProcess = spawn(WATCHER_BINARY, [WATCHER_CAPTURES_DIR], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    watcherProcess.stderr?.on('data', (data: Buffer) => {
      process.stderr.write(`[clipsnap-watcher] ${data.toString()}`);
    });

    watcherProcess.on('exit', () => {
      watcherProcess = null;
    });

    watcherProcess.unref();
  } catch {
    watcherProcess = null;
  }
}

/** Gracefully stops the clipboard watcher process. */
export function stopWatcher(): void {
  if (!watcherProcess) return;
  watcherProcess.kill('SIGTERM');
  watcherProcess = null;
}

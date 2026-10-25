import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '@stryker-mutator/api/logging';

/** How long the runner waits for a directory it made to be removed: a run's directory, or the compile cache. */
const REMOVE_WAIT_MS = 2_000;

/**
 * Creates `dir` for this user alone, or checks that the one that exists is this user's: in a temporary directory that
 * other users share, someone else could have made it first, with links in it, to read or plant the peaks.
 */
export function ownDir(dir: string, owned: (path: string) => boolean = isOwn): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  if (!owned(dir)) {
    throw new Error(`"${dir}" belongs to another user; remove it, or run Stryker as that user.`);
  }
}

/**
 * Removes a directory the runner created, waiting at most `waitMs`. A process that a test file started can outlive the
 * file's process, and Windows refuses to remove a directory that a running process works in. With retries, `rm` gives
 * up after about a second when the process works in the directory itself, but waits until the process ends when it
 * works in a directory inside it, as in the run's temporary directory. What is left is for `removeLeftDirs` of a later
 * runner, with a warning.
 */
export function removeDir(
  dir: string,
  log: Logger,
  {
    waitMs = REMOVE_WAIT_MS,
    remove = (path: string) => rm(path, { recursive: true, maxRetries: 10, retryDelay: 20 }),
  } = {},
): Promise<void> {
  return new Promise((done) => {
    let waiting = true;
    const timer = setTimeout(() => {
      waiting = false;
      log.warn(`Stopped waiting for ${dir} to be removed after ${waitMs} ms; a later runner removes what is left.`);
      done();
    }, waitMs);

    remove(dir).then(
      () => {
        clearTimeout(timer);
        done();
      },
      (error: Error) => {
        clearTimeout(timer);

        if (waiting) {
          log.warn(`Left ${dir} for a later runner to remove: ${error.message}`);
          done();
        }
      },
    );
  });
}

/** Whether a process with this id runs; one that exists but may not be signalled runs too. */
export function isRunning(pid: number, kill: (pid: number, signal: 0) => void = process.kill): boolean {
  try {
    kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Whether this user owns the file or directory itself, not what a link points to. Windows has no user ids, so there
 * every one counts as owned.
 */
export function isOwn(
  path: string,
  user: { getuid?: () => number } = process,
  stat: (path: string) => { uid: number } = lstatSync,
): boolean {
  return user.getuid === undefined || stat(path).uid === user.getuid();
}

/**
 * Removes the directories in `dir` that runners of this user's processes that no longer run left behind; a shared
 * temporary directory holds other users' directories too. Stryker kills a worker whose run takes too long, and a
 * killed worker cannot remove its run directory or its compile cache. The dry-run peaks of a Stryker run go once
 * Stryker's own process has ended. A directory that cannot be removed yet is left for a later runner.
 */
export function removeLeftDirs(
  dir: string,
  {
    running = isRunning,
    owned = isOwn,
    remove = (path: string) => rmSync(path, { recursive: true }),
  } = {},
): void {
  for (const name of readdirSync(dir)) {
    const pid = /^stryker-node-test-(?:cache-|peaks-)?(\d+)-/.exec(name)?.[1];
    const path = join(dir, name);

    if (pid !== undefined && !running(Number(pid))) {
      try {
        if (owned(path)) {
          remove(path);
        }
      } catch {
        // A process that the killed worker started may still work in it, or another runner removed it first.
      }
    }
  }
}

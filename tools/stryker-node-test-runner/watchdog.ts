// The memory watchdog: a worker thread that ends its process once the process holds more memory than its limit. It
// guards mutant runs, and a dry run under nodeTest.maxMemoryMB, against Node.js's assertion diff, which grows with the
// square of the lines it compares (nodejs/node#62792). node-assert-diff.test.ts fails once a Node.js release fixes it.
import { writeFileSync } from 'node:fs';

import type { ProcessRecord } from './hook-core.ts';

export interface MemoryLimitReached {
  rssMB: number;
  limitMB: number;
}

export function workersAllowed(permission: { has(scope: string): boolean } | undefined): boolean {
  return permission?.has('worker') !== false;
}

export interface WatchdogData {
  limitMB: number;
  recordPath: string;
}

/**
 * From a worker, process.exit and process.abort do not end a process whose main thread is blocked, and a signal does.
 */
export function checkMemory(
  { limitMB, recordPath }: WatchdogData,
  rssBytes: number,
  write: (path: string, data: string) => void = writeFileSync,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): void {
  const rssMB = Math.round(rssBytes / 1048576);

  if (rssMB > limitMB) {
    const record = { tests: [], memoryLimitReached: { rssMB, limitMB } } satisfies ProcessRecord;

    try {
      write(recordPath, JSON.stringify(record));
    } finally {
      kill(process.pid, 'SIGKILL');
    }
  }
}

export function watch(data: WatchdogData, rss: () => number = process.memoryUsage.rss): void {
  setInterval(() => checkMemory(data, rss()), 50);
}

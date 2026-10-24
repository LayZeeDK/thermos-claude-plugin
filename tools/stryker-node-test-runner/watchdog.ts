// The memory watchdog: a worker thread that ends its process once the process holds more memory than its limit. It
// guards mutant runs against Node.js's assertion diff, which grows with the square of the lines it compares
// (nodejs/node#62792); node-assert-diff.test.ts fails once a Node.js release fixes that.
import { writeFileSync } from 'node:fs';

import type { ProcessRecord } from './hook-core.ts';

export interface WatchdogData {
  limitMB: number;
  /** Where the process's record goes, which the process cannot write once the watchdog ends it. */
  recordPath: string;
}

/**
 * Looks at the process's resident memory once. Over the limit, it writes the process's record, which tells the runner
 * why the process ended, and ends the process: from a worker, process.exit and process.abort do not end a process
 * whose main thread is blocked, and a signal does.
 */
export function checkMemory(
  { limitMB, recordPath }: WatchdogData,
  rssBytes: number,
  write: (path: string, data: string) => void = writeFileSync,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): void {
  const rssMB = Math.round(rssBytes / 1048576);

  if (rssMB > limitMB) {
    const record: ProcessRecord = { tests: [], memoryLimitReached: { rssMB, limitMB } };
    write(recordPath, JSON.stringify(record));
    kill(process.pid, 'SIGKILL');
  }
}

/** Looks at the process's memory every 50 ms. */
export function watch(data: WatchdogData, rss: () => number = process.memoryUsage.rss): void {
  setInterval(() => checkMemory(data, rss()), 50);
}

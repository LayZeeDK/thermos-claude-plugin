import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '@stryker-mutator/api/logging';

import { ownDir } from './dirs.ts';
import type { ProcessRecord } from './hook-core.ts';

/**
 * Where the runners of one Stryker run keep the most memory a process of each test file held in the dry run, one file
 * per test file. Stryker runs the dry run in one worker and the mutants in all of them, each a process it forks and
 * may replace, so the directory is named after the process they share: Stryker's own.
 */
export function peakMemoryDir(strykerPid: number): string {
  return join(tmpdir(), `stryker-node-test-peaks-${strykerPid}-dry-run`);
}

/**
 * The memory each process of a test file may hold. A test that a mutant fails can need more than it did passing, as
 * Node.js's assertion diff grows with the square of the lines it compares (nodejs/node#62792).
 */
export interface MemoryLimits {
  startDryRun(): number | undefined;
  record(file: string, records: ProcessRecord[]): void;
  forMutantRun(file: string): number;
}

/**
 * Without lzNodeTest.maxMemoryMB, a mutant run gives a file its dry-run peak times 1.5 plus 1024 MB, as Stryker scales
 * and pads its timeouts.
 */
export function memoryLimits(maxMemoryMB: number | undefined, dir: string, log: Logger): MemoryLimits {
  if (maxMemoryMB === undefined) {
    return new DryRunPeaks(dir, log);
  }

  return { startDryRun: () => maxMemoryMB, record: () => {}, forMutantRun: () => maxMemoryMB };
}

class DryRunPeaks implements MemoryLimits {
  readonly #dir: string;
  readonly #log: Logger;
  readonly #unmeasured = new Set<string>();

  constructor(dir: string, log: Logger) {
    this.#dir = dir;
    this.#log = log;
  }

  startDryRun(): undefined {
    ownDir(this.#dir);
  }

  record(file: string, records: ProcessRecord[]): void {
    const peakMB = Math.max(0, ...records.map((record) => record.peakMemoryMB ?? 0));
    writeFileSync(this.#path(file), String(peakMB));
  }

  /** A file without a dry-run peak, as when Stryker's --testFiles names fewer files, gets the floor with a warning. */
  forMutantRun(file: string): number {
    const peakMB = storedPeak(this.#path(file));
    const limitMB = Math.round((peakMB ?? 0) * 1.5 + 1024);

    if (peakMB === undefined && !this.#unmeasured.has(file)) {
      this.#unmeasured.add(file);
      this.#log.warn(
        `The dry run left no readable memory peak for "${file}", ` +
          `so each process of its mutant runs may hold ${limitMB} MB. ` +
          'Set lzNodeTest.maxMemoryMB to choose the limit.',
      );
    }

    return limitMB;
  }

  #path(file: string): string {
    return join(this.#dir, createHash('sha256').update(file).digest('hex'));
  }
}

function storedPeak(path: string): number | undefined {
  try {
    const stored = readFileSync(path, 'utf8');

    return /^\d+$/.test(stored) ? Number(stored) : undefined;
  } catch {}
}

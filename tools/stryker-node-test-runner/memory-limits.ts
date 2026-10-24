import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
 * How much memory in MB each process of a test file may hold before the memory watchdog ends it. A test that a mutant
 * fails can need more memory than it did passing, and Node.js's assertion diff grows with the square of the lines it
 * compares (nodejs/node#62792).
 *
 * With `nodeTest.maxMemoryMB` every run, the dry run included, runs under it. Without it the dry run runs without a
 * limit and records each file's peak, and a mutant run gives a file its peak times 1.5 plus 1024 MB, as Stryker scales
 * and pads its timeouts.
 */
export class MemoryLimits {
  readonly #maxMemoryMB: number | undefined;
  readonly #dir: string;
  readonly #log: Logger;
  /** Test files a mutant run found no dry-run peak for, each warned about once. */
  readonly #unmeasured = new Set<string>();

  constructor(maxMemoryMB: number | undefined, dir: string, log: Logger) {
    this.#maxMemoryMB = maxMemoryMB;
    this.#dir = dir;
    this.#log = log;
  }

  /** Readies the dry run, and returns the limit it runs under, if any. */
  forDryRun(): number | undefined {
    if (this.#maxMemoryMB === undefined) {
      ownDir(this.#dir);
    }

    return this.#maxMemoryMB;
  }

  /** Records the most memory a process of `file` held in the dry run, for the mutant runs of every worker. */
  record(file: string, records: ProcessRecord[]): void {
    if (this.#maxMemoryMB === undefined) {
      const peakMB = Math.max(0, ...records.map((record) => record.peakMemoryMB ?? 0));
      writeFileSync(this.#path(file), String(peakMB));
    }
  }

  /**
   * The limit of `file`'s processes in a mutant run. A file the dry run did not run, as when Stryker's --testFiles
   * names fewer files than nodeTest.testFiles, has no peak; it gets the floor, with a warning.
   */
  forMutantRun(file: string): number {
    if (this.#maxMemoryMB !== undefined) {
      return this.#maxMemoryMB;
    }

    const path = this.#path(file);
    const peakMB = existsSync(path) ? Number(readFileSync(path, 'utf8')) : undefined;
    const limitMB = Math.round((peakMB ?? 0) * 1.5 + 1024);

    if (peakMB === undefined && !this.#unmeasured.has(file)) {
      this.#unmeasured.add(file);
      this.#log.warn(
        `The dry run left no memory peak for "${file}", so each process of its mutant runs may hold ${limitMB} MB. ` +
          'Set nodeTest.maxMemoryMB to choose the limit.',
      );
    }

    return limitMB;
  }

  #path(file: string): string {
    return join(this.#dir, createHash('sha256').update(file).digest('hex'));
  }
}

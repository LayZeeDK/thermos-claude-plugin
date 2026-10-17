// Test files, runners and results for runner.test.ts, and the constants index.test.ts shares with it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { INSTRUMENTER_CONSTANTS, type Mutant, type MutantCoverage, type StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import {
  DryRunStatus,
  TestStatus,
  type CompleteDryRunResult,
  type DryRunOptions,
  type DryRunResult,
  type MutantRunOptions,
  type TestResult,
} from '@stryker-mutator/api/test-runner';

import { NodeTestRunner } from './index.ts';

export const ACTIVE_MUTANT = INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE;
export const HOOK_URL = pathToFileURL(join(import.meta.dirname, 'hook.ts')).href;
export const REPORTER_ARG = `--test-reporter=${pathToFileURL(join(import.meta.dirname, 'reporter.ts')).href}`;

/** The NODE_OPTIONS of the processes a runner starts, given this process's NODE_OPTIONS without reporters. */
export function runNodeOptions(): string {
  const inherited = process.env.NODE_OPTIONS ? [process.env.NODE_OPTIONS] : [];

  return [`--import ${JSON.stringify(HOOK_URL)}`, ...inherited].join(' ');
}

/**
 * A process id that no process has: above the largest that Linux (2^22) and macOS (99999) hand out, and one that
 * Windows reports as not running. The id of a process that ended can be handed out again at once.
 */
export const NO_PROCESS = 2 ** 31 - 1;

export const COVER = [
  'const cover = (id) => {',
  '  const ns = globalThis.__stryker__;',
  '  const coverage = (ns.mutantCoverage ??= { static: {}, perTest: {} });',
  '  const hits = ns.currentTestId ? (coverage.perTest[ns.currentTestId] ??= {}) : coverage.static;',
  '  hits[id] = (hits[id] ?? 0) + 1;',
  '};',
].join(' ');

/** A node:test file whose code can simulate Stryker's instrumented code with `cover(mutantId)`. */
export function fixture(...lines: string[]): string {
  return [
    "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    "import { describe, it } from 'node:test';",
    COVER,
    ...lines,
    '',
  ].join('\n');
}

export const PASSING = fixture("it('passes', () => {});");
export const FAILING = fixture("it('fails', () => { throw new Error('expected failure'); });");

/** Creates the files in a temporary directory and makes it the working directory for the rest of the test. */
export function project(t: TestContext, files: Record<string, string>): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'node-test-runner-')));
  const previous = process.cwd();

  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }

  process.chdir(dir);
  t.after(() => {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

/** A logger that keeps its debug messages, and says whether debug logging is on as `debugEnabled` does. */
export function logger(debug: string[] = [], debugEnabled = true): Logger {
  const no = () => false;
  const ignore = () => {};

  return {
    isTraceEnabled: no,
    isDebugEnabled: () => debugEnabled,
    isInfoEnabled: no,
    isWarnEnabled: no,
    isErrorEnabled: no,
    isFatalEnabled: no,
    trace: ignore,
    debug: (message: string) => {
      debug.push(message);
    },
    info: ignore,
    warn: ignore,
    error: ignore,
    fatal: ignore,
  };
}

export async function initRunner(testFiles: string[] | undefined): Promise<NodeTestRunner> {
  const options = testFiles ? { nodeTest: { testFiles } } : {};
  const runner = new NodeTestRunner(options as unknown as StrykerOptions, logger());
  await runner.init();

  return runner;
}

export const DRY_RUN: DryRunOptions = { timeout: 10_000, disableBail: false, coverageAnalysis: 'perTest' };

export function mutantRunOptions(options: Partial<MutantRunOptions> = {}): MutantRunOptions {
  return {
    timeout: 10_000,
    disableBail: false,
    // Not a number, so it never activates a mutant in an instrumented copy of the hook.
    activeMutant: { id: 'fixture-mutant' } as Mutant,
    sandboxFileName: 'sandbox',
    mutantActivation: 'runtime',
    reloadEnvironment: true,
    ...options,
  };
}

export function complete(result: DryRunResult): CompleteDryRunResult {
  assert.equal(result.status, DryRunStatus.Complete);

  return result as CompleteDryRunResult;
}

/**
 * The fixture's own coverage. Under Stryker the runner under test is instrumented too, so its numeric mutant ids
 * reach the coverage that the fixture's processes report.
 */
export function fixtureCoverage(coverage: MutantCoverage | undefined): MutantCoverage | undefined {
  const own = (hits: Record<string, number>) =>
    Object.fromEntries(Object.entries(hits).filter(([id]) => !/^\d+$/.test(id)));

  return (
    coverage && {
      static: own(coverage.static),
      perTest: Object.fromEntries(
        Object.entries(coverage.perTest)
          .map(([test, hits]) => [test, own(hits)] as const)
          .filter(([, hits]) => Object.keys(hits).length > 0),
      ),
    }
  );
}

/** Whether a run that `settle` waited for never ended. */
export let stalled = false;

/** The compile cache directories runners of this process created; runners in other processes name theirs by pid. */
export function ownCacheDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith(`stryker-node-test-cache-${process.pid}-`))
    .sort();
}

/**
 * Waits for a run for at most `ms` milliseconds. A run that never ends fails its test and every later run at once, so
 * a hanging runner fails this file quickly instead of hanging it.
 */
export async function settle<T>(run: Promise<T>, ms = 5_000): Promise<T> {
  assert.ok(!stalled, 'an earlier run never ended');
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      run,
      new Promise<never>((_, fail) => {
        timer = setTimeout(() => {
          stalled = true;
          fail(new Error(`the run did not end within ${ms} ms`));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function summary(tests: TestResult[]) {
  return tests.map((test) => ({
    id: test.id,
    status: test.status,
    failureMessage: test.status === TestStatus.Failed ? test.failureMessage : undefined,
  }));
}

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { INSTRUMENTER_CONSTANTS, type Mutant, type MutantCoverage, type StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import {
  DryRunStatus,
  MutantRunStatus,
  TestStatus,
  type CompleteDryRunResult,
  type DryRunOptions,
  type DryRunResult,
  type MutantRunOptions,
  type MutantRunResult,
  type TestResult,
} from '@stryker-mutator/api/test-runner';

import { NodeTestRunner, runEnv, type NodeTestOptions } from './index.ts';

export const ACTIVE_MUTANT = INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE;
export const HOOK_URL = pathToFileURL(join(import.meta.dirname, 'hook.ts')).href;
export const REPORTER_ARG = `--test-reporter=${pathToFileURL(join(import.meta.dirname, 'reporter.ts')).href}`;

export function runNodeOptions(): string {
  return runEnv(process.env, '', '', '', { dryRun: false, disableBail: false }, undefined).NODE_OPTIONS;
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

const FIXTURE_HEADER = [
  "import assert from 'node:assert/strict';",
  "import { spawnSync } from 'node:child_process';",
  "import { describe, it } from 'node:test';",
  COVER,
];

export const FIXTURE_HEADER_LINES = FIXTURE_HEADER.length;

export function fixture(...lines: string[]): string {
  return [...FIXTURE_HEADER, ...lines, ''].join('\n');
}

export const PASSING = fixture("it('passes', () => {});");

export const GROWS =
  'const held = []; const end = Date.now() + 5_000; while (Date.now() < end) { ' +
  'if (held.length < 25) held.push(new Int32Array(4e6).fill(1)); const pause = Date.now() + 10; while (Date.now() < pause); }';
export const FAILING = fixture("it('fails', () => { throw new Error('expected failure'); });");

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

export function logger(debug: string[] = [], debugEnabled = true, warnings: string[] = []): Logger {
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
    warn: (message: string) => {
      warnings.push(message);
    },
    error: ignore,
    fatal: ignore,
  };
}

export interface RunnerOptions {
  lzNodeTest?: NodeTestOptions;
  testFiles?: string[];
  concurrency?: number;
  checkers?: string[];
  allowEmpty?: boolean;
}

export function strykerOptions(options: RunnerOptions = {}): StrykerOptions {
  return { checkers: [], testFiles: [], ...options } as unknown as StrykerOptions;
}

export async function initRunner(testFiles: string[] | undefined, lzNodeTest: NodeTestOptions = {}): Promise<NodeTestRunner> {
  const options = { lzNodeTest: { ...lzNodeTest, ...(testFiles && { testFiles }) } };
  const runner = new NodeTestRunner(strykerOptions(options), logger());
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
  assert.ok(result.status === DryRunStatus.Complete, `expected a complete run, got ${JSON.stringify(result)}`);

  return result;
}

export function withoutDuration(
  result: MutantRunResult,
): MutantRunResult extends infer R ? (R extends unknown ? Omit<R, 'duration'> : never) : never {
  if (result.status === MutantRunStatus.Killed || result.status === MutantRunStatus.Survived) {
    const { duration, ...rest } = result;

    assert.ok(duration !== undefined && duration >= 0, `expected a duration, got ${JSON.stringify(result)}`);

    return rest;
  }

  return result;
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

let stalled = false;

export function ownCacheDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith(`stryker-node-test-cache-${process.pid}-`))
    .sort();
}

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

export function shareCompileCache(): string {
  const cacheDir = mkdtempSync(join(tmpdir(), 'node-test-runner-cache-'));
  process.env.NODE_COMPILE_CACHE = cacheDir;

  // Removed on exit rather than in an `after` hook, and ahead of the hook's own exit listener, so a process that dies
  // early or whose hook fails on exit (both happen under mutation testing) leaves nothing. The runners the tests never
  // dispose (a mutant of the runner can give each one a directory) are swept here too.
  process.prependListener('exit', () => {
    for (const dir of [cacheDir, ...ownCacheDirs().map((name) => join(tmpdir(), name))]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A process a test started may still hold a file for a moment; the next run removes its own directory anyway.
      }
    }
  });

  after(() => {
    if (stalled) {
      // A stalled run can leave a blocked process behind that would keep this one alive.
      process.exit(1);
    }
  });

  return cacheDir;
}

export function summary(tests: TestResult[]) {
  return tests.map((test) => ({
    id: test.id,
    status: test.status,
    failureMessage: test.status === TestStatus.Failed ? test.failureMessage : undefined,
  }));
}

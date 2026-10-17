// A Stryker test runner for node:test. Each test file runs in its own `node` process with hook.ts loaded through
// NODE_OPTIONS, so every process the tests spawn reports mutant coverage too, attributed to the test that spawned
// it, and with reporter.ts as node:test's reporter, which gives the hook the results. Results and coverage are per
// test, and a mutant run executes only the tests that cover the mutant.
import { spawn } from 'node:child_process';
import { globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import {
  INSTRUMENTER_CONSTANTS,
  type CoverageAnalysis,
  type MutantCoverage,
  type StrykerOptions,
} from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { commonTokens, declareClassPlugin, PluginKind, tokens } from '@stryker-mutator/api/plugin';
import {
  determineHitLimitReached,
  DryRunStatus,
  TestStatus,
  toMutantRunResult,
  type DryRunOptions,
  type DryRunResult,
  type MutantActivation,
  type MutantRunOptions,
  type MutantRunResult,
  type TestResult,
  type TestRunner,
  type TestRunnerCapabilities,
} from '@stryker-mutator/api/test-runner';

import { ENV, within, type ProcessRecord, type RecordedTest } from './hook-core.ts';

/** Options under `nodeTest` in the Stryker configuration. */
export interface NodeTestOptions {
  /** Glob patterns for the test files, relative to the working directory. Defaults to every `.test.ts` file. */
  testFiles?: string[];
  /** Arguments for `node` ahead of the test file, such as `--enable-source-maps`. */
  nodeArgs?: string[];
}

interface RunOptions {
  dryRun: boolean;
  disableBail: boolean;
  /** Set in the dry run only. */
  coverageAnalysis?: CoverageAnalysis;
  activeMutant?: string;
  /** When the mutant becomes active; from the start of the process unless this is `runtime`. */
  mutantActivation?: MutantActivation;
  hitLimit?: number;
  /** Test ids to run; every test runs when absent. */
  testFilter?: string[];
}

/** What one test file's run produced. */
export interface FileRun {
  records: ProcessRecord[];
  exitCode: number | null;
  stderr: string;
  /** The arguments the runner ran `node` with. */
  args: string[];
  /** The NODE_OPTIONS the runner ran `node` with. */
  nodeOptions: string;
}

const HOOK_URL = pathToFileURL(resolve(import.meta.dirname, 'hook.ts')).href;
const REPORTER_URL = pathToFileURL(resolve(import.meta.dirname, 'reporter.ts')).href;

/**
 * Merges the mutant coverage of several processes by adding up the hit counts. Without `perTest`, the hits inside
 * tests count as static, as Stryker's coverage analysis `all` expects.
 */
export function mergeCoverage(coverages: (MutantCoverage | undefined)[], perTest = true): MutantCoverage {
  const total: MutantCoverage = { static: {}, perTest: {} };
  const add = (into: Record<string, number>, from: Record<string, number>) => {
    for (const [mutantId, hits] of Object.entries(from)) {
      into[mutantId] = (into[mutantId] ?? 0) + hits;
    }
  };

  for (const coverage of coverages) {
    if (!coverage) {
      continue;
    }

    add(total.static, coverage.static);

    for (const [testId, hits] of Object.entries(coverage.perTest)) {
      add(perTest ? (total.perTest[testId] ??= {}) : total.static, hits);
    }
  }

  return total;
}

/** Turns the recorded tests of one test file into Stryker test results. */
export function toTestResults(testFile: string, recorded: RecordedTest[]): TestResult[] {
  return recorded.map((test) => {
    const base = {
      id: test.id,
      name: test.id,
      fileName: testFile,
      timeSpentMs: Math.round(test.timeSpentMs),
      ...(test.startPosition && { startPosition: test.startPosition }),
    };

    if (test.status === 'failed') {
      return { ...base, status: TestStatus.Failed, failureMessage: test.failureMessage ?? 'Test failed' };
    }

    return { ...base, status: test.status === 'passed' ? TestStatus.Success : TestStatus.Skipped };
  });
}

/**
 * The error message for a test file whose process failed outside any test, such as when it does not load, with the
 * command that reproduces it and its stderr, as Stryker's tap runner reports it. The command has the arguments and
 * NODE_OPTIONS that the runner ran `node` with.
 */
export function fileError(
  testFile: string,
  exitCode: number | null,
  stderr: string,
  args: string[],
  nodeOptions: string,
): string {
  const command = ['node', ...args.map((arg) => `"${arg}"`)].join(' ');
  const output = stderr.trim();

  return [
    `Error running file "${testFile}": node exited with code ${exitCode} outside any test.`,
    `To reproduce it, run \`${command}\` in ${process.cwd()} with NODE_OPTIONS set to \`${nodeOptions}\`.`,
    ...(output ? ['Stderr:', output] : []),
  ].join('\n');
}

/**
 * Leaves out node's options that add a node:test reporter or a reporter destination, with their values, so the
 * runner's reporter is the only one; node refuses more reporters than destinations. An argument may be quoted, as in
 * NODE_OPTIONS.
 */
function withoutReporters(args: string[]): string[] {
  const reporterOption = (arg: string) => /^--test-reporter(?:-destination)?(=|$)/.exec(arg.replaceAll('"', ''));

  // A reporter option without `=` takes the next argument as its value.
  return args.filter((arg, index) => !reporterOption(arg) && reporterOption(String(args[index - 1]))?.[1] !== '');
}

/** Returns the test files that contain at least one of the filtered test ids, or every file without a filter. */
export function filesFor(testFiles: string[], testFilter: string[] | undefined): string[] {
  if (!testFilter) {
    return testFiles;
  }

  return testFiles.filter((file) => testFilter.some((id) => within(id, file)));
}

/**
 * Builds the environment for one test file's process tree. The processes use `tmpDir` as their temporary directory,
 * and keep Node's compile cache in `cacheDir` unless the environment names a directory.
 */
export function runEnv(
  base: NodeJS.ProcessEnv,
  file: string,
  outDir: string,
  tmpDir: string,
  run: RunOptions,
  cacheDir: string | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    // The hook comes first, so a copy of this runner under test takes precedence over the runner running it.
    NODE_OPTIONS: [
      `--import ${JSON.stringify(HOOK_URL)}`,
      // node splits NODE_OPTIONS at spaces outside double quotes.
      ...withoutReporters(base.NODE_OPTIONS?.match(/(?:[^\s"]|"(?:[^"\\]|\\.)*")+/g) ?? []),
    ].join(' '),
    [ENV.out]: outDir,
    [ENV.file]: file,
    [ENV.dryRun]: String(run.dryRun),
    // os.tmpdir() reads TMPDIR first on POSIX and TEMP first on Windows, then TMP.
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
  };

  const runState = [
    // Set when Stryker itself runs under `node --test`; node:test in the test file would then ignore `.only` and
    // write its report to stdout for an outer runner instead of using its reporters.
    'NODE_TEST_CONTEXT',
    ENV.current,
    ENV.hitLimit,
    ENV.filter,
    ENV.bail,
    ENV.activeMutant,
    INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE,
  ];

  for (const key of runState) {
    delete env[key];
  }

  if (env.NODE_COMPILE_CACHE === undefined && cacheDir !== undefined) {
    env.NODE_COMPILE_CACHE = cacheDir;
  }

  // At runtime activation the hook activates the mutant once the tests start, so module-level code runs unmutated.
  if (run.activeMutant !== undefined) {
    const runtime = run.mutantActivation === 'runtime';
    env[runtime ? ENV.activeMutant : INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE] = run.activeMutant;
  }

  if (run.hitLimit !== undefined) {
    env[ENV.hitLimit] = String(run.hitLimit);
  }

  if (run.testFilter) {
    env[ENV.filter] = JSON.stringify(run.testFilter);
  }

  // The dry run must run every test to collect each one's coverage.
  if (!run.dryRun && !run.disableBail) {
    env[ENV.bail] = 'true';
  }

  return env;
}

function removeNow(dir: string): void {
  rmSync(dir, { recursive: true });
}

/**
 * Removes a directory the runner created. A process that a test file started can outlive the file's process by a
 * moment, and Windows refuses to remove a directory that a running process works in (EPERM from Node.js 24, EBUSY
 * from 22), so that failure is retried for about a second before it is thrown.
 */
export async function removeDir(dir: string, remove = removeNow): Promise<void> {
  for (let attempt = 1; attempt !== 20; attempt++) {
    try {
      remove(dir);

      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(String((error as NodeJS.ErrnoException).code))) {
        throw error;
      }

      await sleep(50);
    }
  }

  remove(dir);
}

/** Whether a process with this id runs; one that exists but may not be signalled runs too. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Removes the directories in `dir` that runners of processes that no longer run left behind. Stryker kills a worker
 * whose run takes too long, and a killed worker cannot remove its run directory or its compile cache. A directory
 * that cannot be removed yet is left for a later runner.
 */
export function removeLeftDirs(dir: string, running = isRunning, remove = removeNow): void {
  for (const name of readdirSync(dir)) {
    const pid = /^stryker-node-test-(?:cache-)?(\d+)-/.exec(name)?.[1];

    if (pid !== undefined && !running(Number(pid))) {
      try {
        remove(join(dir, name));
      } catch {
        // A process that the killed worker started may still work in it.
      }
    }
  }
}

export class NodeTestRunner implements TestRunner {
  static inject = tokens(commonTokens.options, commonTokens.logger);

  #testFiles: string[] = [];
  /**
   * Every process compiles the hook and its imports; Node's compile cache makes that a one-time cost per runner.
   * The directory is this runner's own, because the cache keeps an entry for every file a process loads, including
   * the throwaway fixtures of the tests, and Node's default directory would grow with every run.
   */
  #cacheDir?: string;
  readonly #patterns: string[];
  readonly #nodeArgs: string[];
  readonly #log: Logger;

  constructor(options: StrykerOptions, log: Logger) {
    const nodeTest = (options as { nodeTest?: NodeTestOptions }).nodeTest;
    const patterns = nodeTest?.testFiles ?? ['**/*.test.ts'];
    // Only the dry run gets Stryker's --testFiles; the mutant runs of other workers must find those files too.
    this.#patterns = options.testFiles ? [...patterns, ...options.testFiles] : patterns;
    this.#nodeArgs = withoutReporters(nodeTest?.nodeArgs ?? []);
    this.#log = log;
  }

  capabilities(): TestRunnerCapabilities {
    return { reloadEnvironment: true };
  }

  async init(): Promise<void> {
    // globSync returns a file once per spelling, relative for a relative pattern and absolute for an absolute one.
    const files = globSync(this.#patterns, { exclude: (name) => name === 'node_modules' }).map((file) => resolve(file));
    this.#testFiles = [...new Set(files)].sort();

    if (this.#testFiles.length === 0) {
      throw new Error(`No test files match ${JSON.stringify(this.#patterns)}`);
    }

    removeLeftDirs(tmpdir());

    if (process.env.NODE_COMPILE_CACHE === undefined) {
      this.#cacheDir = mkdtempSync(join(tmpdir(), `stryker-node-test-cache-${process.pid}-`));
    }
  }

  async dispose(): Promise<void> {
    if (this.#cacheDir !== undefined) {
      await removeDir(this.#cacheDir);
    }
  }

  dryRun(options: DryRunOptions): Promise<DryRunResult> {
    const files = options.testFiles?.length ? options.testFiles.map((file) => resolve(file)) : this.#testFiles;

    return this.#run(files, {
      dryRun: true,
      disableBail: options.disableBail,
      coverageAnalysis: options.coverageAnalysis,
    });
  }

  async mutantRun(options: MutantRunOptions): Promise<MutantRunResult> {
    const result = await this.#run(filesFor(this.#testFiles, options.testFilter), {
      dryRun: false,
      disableBail: options.disableBail,
      activeMutant: options.activeMutant.id,
      mutantActivation: options.mutantActivation,
      hitLimit: options.hitLimit,
      testFilter: options.testFilter,
    });

    return toMutantRunResult(result);
  }

  async #run(files: string[], run: RunOptions): Promise<DryRunResult> {
    const tests: TestResult[] = [];
    const coverages: (MutantCoverage | undefined)[] = [];

    for (const file of files) {
      const { records, exitCode, stderr, args, nodeOptions } = await this.runFile(file, run);

      for (const record of records) {
        const timeout = determineHitLimitReached(record.hitCount, run.hitLimit);

        if (timeout) {
          return timeout;
        }

        coverages.push(record.mutantCoverage);
      }

      const results = toTestResults(file, records.flatMap((record) => record.tests));
      const failed = results.some((result) => result.status === TestStatus.Failed);

      // Like Stryker's own runners, a failure that no test explains is an error, not a killed mutant.
      if (exitCode !== 0 && !failed) {
        const errorMessage = fileError(file, exitCode, stderr, args, nodeOptions);

        return { status: DryRunStatus.Error, errorMessage };
      }

      // Without its record the file's results are unknown, as when jest's runner misses a file's coverage.
      if (!records.some((record) => record.main)) {
        const errorMessage =
          `Missing test results for "${file}": its process ended without writing them. Either the Stryker hook ` +
          'did not run in it, or it left without running exit listeners (process.reallyExit, process.abort).';

        return { status: DryRunStatus.Error, errorMessage };
      }

      tests.push(...results);

      if (!run.disableBail && failed) {
        break;
      }
    }

    // A mutant run's result drops the coverage, which is empty there anyway.
    if (run.coverageAnalysis === 'off') {
      return { status: DryRunStatus.Complete, tests };
    }

    return {
      status: DryRunStatus.Complete,
      tests,
      mutantCoverage: mergeCoverage(coverages, run.coverageAnalysis !== 'all'),
    };
  }

  /**
   * Runs one test file and collects the record of every process it started. The processes get a temporary directory
   * inside the run's directory, so what they leave there is removed with it, however they exit.
   */
  async runFile(file: string, run: RunOptions): Promise<FileRun> {
    const runDir = mkdtempSync(join(tmpdir(), `stryker-node-test-${process.pid}-`));
    const outDir = join(runDir, 'out');
    const tmpDir = join(runDir, 'tmp');

    try {
      mkdirSync(outDir);
      mkdirSync(tmpDir);
      const env = runEnv(process.env, file, outDir, tmpDir, run, this.#cacheDir);
      const args = [`--test-reporter=${REPORTER_URL}`, ...this.#nodeArgs, file];

      if (this.#log.isDebugEnabled()) {
        this.#log.debug(`Running: \`node ${args.map((arg) => `"${arg}"`).join(' ')}\` in ${process.cwd()}`);
      }

      const { exitCode, stderr } = await new Promise<{ exitCode: number | null; stderr: string }>((done, fail) => {
        const child = spawn(process.execPath, args, {
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let errors = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string) => (errors += chunk));
        child.on('error', fail);
        child.on('close', (code) => done({ exitCode: code, stderr: errors }));
      });
      const records = readdirSync(outDir).map(
        (name) => JSON.parse(readFileSync(join(outDir, name), 'utf8')) as ProcessRecord,
      );

      return { records, exitCode, stderr, args, nodeOptions: env.NODE_OPTIONS as string };
    } finally {
      await removeDir(runDir);
    }
  }
}

export const strykerPlugins = [declareClassPlugin(PluginKind.TestRunner, 'node-test', NodeTestRunner)];

export const strykerValidationSchema = {
  type: 'object',
  properties: {
    nodeTest: {
      type: 'object',
      properties: {
        testFiles: { type: 'array', items: { type: 'string' } },
        nodeArgs: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
  },
};

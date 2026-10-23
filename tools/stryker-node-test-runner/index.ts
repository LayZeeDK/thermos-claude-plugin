// Each test file runs in its own `node` process with hook.ts loaded through NODE_OPTIONS, so every process the tests
// spawn reports mutant coverage too, attributed to the test that spawned it.
import { spawn } from 'node:child_process';
import { globSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

import { ENV, testId, within, type ProcessRecord, type RecordedTest } from './hook-core.ts';

/** Options under `nodeTest` in the Stryker configuration. */
export interface NodeTestOptions {
  /** Glob patterns for the test files, relative to the working directory. Defaults to every `.test.ts` file. */
  testFiles?: string[];
  /** Arguments for `node` ahead of the test file, such as `--enable-source-maps`. */
  nodeArgs?: string[];
}

/** A dry run, which collects coverage, or a mutant run. */
export type RunOptions =
  | {
      dryRun: true;
      disableBail: boolean;
      coverageAnalysis: CoverageAnalysis;
      activeMutant?: undefined;
      mutantActivation?: undefined;
      hitLimit?: undefined;
      testFilter?: undefined;
    }
  | {
      dryRun: false;
      disableBail: boolean;
      coverageAnalysis?: undefined;
      activeMutant?: string;
      /** When the mutant becomes active; from the start of the process unless this is `runtime`. */
      mutantActivation?: MutantActivation;
      hitLimit?: number;
      /** Test ids to run; every test runs when absent. */
      testFilter?: string[];
    };

export interface FileRun {
  records: ProcessRecord[];
  exitCode: number | null;
  stderr: string;
  args: string[];
  nodeOptions: string;
  unreadable?: string;
}

const HOOK_URL = pathToFileURL(resolve(import.meta.dirname, 'hook.ts')).href;
const REPORTER_URL = pathToFileURL(resolve(import.meta.dirname, 'reporter.ts')).href;
/** How long a run waits, after a test file's process exits, for the processes it started to close stderr. */
const CLOSE_GRACE_MS = 1_500;
/** How long a run waits for its directory to be removed. */
const REMOVE_WAIT_MS = 2_000;

/**
 * Merges the mutant coverage of several processes by adding up the hit counts. Without `perTest`, the hits inside
 * tests count as static, as Stryker's coverage analysis `all` expects.
 */
export function mergeCoverage(coverages: (MutantCoverage | undefined)[], perTest: boolean): MutantCoverage {
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

/**
 * Turns the recorded tests of one test file into Stryker test results. A test's name leaves out the test file, which
 * its id starts with, as Stryker's runners name tests after their suites only.
 */
export function toTestResults(testFile: string, recorded: RecordedTest[]): TestResult[] {
  const prefix = testId(testFile, '');

  return recorded.map((test) => {
    const base = {
      id: test.id,
      name: test.id.slice(prefix.length),
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

function nodeCommand(args: string[]): string {
  return ['node', ...args.map((arg) => `"${arg}"`)].join(' ');
}

/**
 * The error message for a test file whose process failed outside any test, such as when it does not load, with the
 * command that reproduces it, node:test's diagnostics of errors raised after their test ended, and its stderr, as
 * Stryker's tap runner reports it. The command has the arguments and NODE_OPTIONS that the runner ran `node` with.
 */
export function fileError(testFile: string, { records, exitCode, stderr, args, nodeOptions }: FileRun): string {
  const diagnostics = records.flatMap((record) => record.diagnostics ?? []);
  const output = stderr.trim();

  return [
    `Error running file "${testFile}": node exited with code ${exitCode} outside any test.`,
    `To reproduce it, run \`${nodeCommand(args)}\` in ${process.cwd()} with NODE_OPTIONS set to \`${nodeOptions}\`.`,
    ...(diagnostics.length > 0 ? ['Diagnostics:', ...diagnostics] : []),
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

/** Checks that the file parses and has a list of tests: tests can write files to the same directory. */
export function parseRecord(json: string): ProcessRecord {
  const record = JSON.parse(json) as Partial<ProcessRecord> | null;

  if (!Array.isArray(record?.tests)) {
    throw new Error('not a record of test results');
  }

  return record as ProcessRecord;
}

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

/**
 * Waits for a process to end and collects its stderr. Processes it started inherit stderr and can keep it open after
 * it exits; the records of those that end soon arrive by the time stderr closes, so this waits for that, but at most
 * `graceMs` after the exit, and then lets go of stderr.
 */
export function processEnd(child: EndingProcess, graceMs: number): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((done, fail) => {
    let errors = '';
    let grace: NodeJS.Timeout | undefined;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (errors += chunk));
    child.on('error', fail);
    child.on('exit', (code) => {
      grace = setTimeout(() => {
        child.stderr.destroy();
        done({ exitCode: code, stderr: errors });
      }, graceMs);
    });
    child.on('close', (code) => {
      clearTimeout(grace);
      done({ exitCode: code, stderr: errors });
    });
  });
}

/** The part of a child process that `processEnd` uses. */
export interface EndingProcess {
  stderr: {
    setEncoding(encoding: 'utf8'): unknown;
    on(event: 'data', listener: (chunk: string) => void): unknown;
    destroy(): unknown;
  };
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit' | 'close', listener: (code: number | null) => void): unknown;
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
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);

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
 * killed worker cannot remove its run directory or its compile cache. A directory that cannot be removed yet is left
 * for a later runner.
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
    const pid = /^stryker-node-test-(?:cache-)?(\d+)-/.exec(name)?.[1];
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
      await removeDir(this.#cacheDir, this.#log);
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
      const fileRun = await this.runFile(file, run);
      const { records, exitCode, unreadable } = fileRun;

      if (unreadable !== undefined) {
        return { status: DryRunStatus.Error, errorMessage: `Unreadable test results for "${file}": ${unreadable}` };
      }

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
        return { status: DryRunStatus.Error, errorMessage: fileError(file, fileRun) };
      }

      // Without its record the file's results are unknown, as when jest's runner misses a file's coverage.
      const main = records.find((record) => record.main);

      if (!main) {
        const errorMessage =
          `Missing test results for "${file}": its process ended without writing them. Either the Stryker hook ` +
          'did not run in it, or it left without running exit listeners (process.reallyExit, process.abort).';

        return { status: DryRunStatus.Error, errorMessage };
      }

      // Stryker treats a test runner that exits during a run as crashed, whatever its exit code, and so do its runners
      // that run the tests in their own process; the tests that node:test did not report are unknown.
      if (!failed && main.unfinished) {
        const errorMessage =
          `Unfinished test results for "${file}": its process exited before node:test reported every test, as when ` +
          'a test calls process.exit().';

        return { status: DryRunStatus.Error, errorMessage };
      }

      tests.push(...results);

      if (!run.disableBail && failed) {
        break;
      }
    }

    // Mutant runs leave coverageAnalysis unset and take the next return; toMutantRunResult drops their coverage.
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
        this.#log.debug(`Running: \`${nodeCommand(args)}\` in ${process.cwd()}`);
      }

      const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
      const { exitCode, stderr } = await processEnd(child, CLOSE_GRACE_MS);
      let unreadable: string | undefined;
      const records = readdirSync(outDir).flatMap((name) => {
        try {
          return [parseRecord(readFileSync(join(outDir, name), 'utf8'))];
        } catch (error) {
          // A process that the tests started can still be writing its record when the grace period ends; the test
          // file's own process writes its record before it exits.
          if (name === `${child.pid}.json`) {
            unreadable = (error as Error).message;
          }

          return [];
        }
      });

      return { records, exitCode, stderr, args, nodeOptions: env.NODE_OPTIONS as string, ...(unreadable && { unreadable }) };
    } finally {
      await removeDir(runDir, this.#log);
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

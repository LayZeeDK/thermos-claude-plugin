// Each test file runs in its own `node` process with hook.ts loaded through NODE_OPTIONS, so every process the tests
// spawn reports mutant coverage too, attributed to the test that spawned it.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
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

import {
  ENV,
  MEMORY_MARKER,
  testId,
  within,
  type MemoryLimitReached,
  type ProcessRecord,
  type RecordedTest,
} from './hook-core.ts';

/** Options under `nodeTest` in the Stryker configuration. */
export interface NodeTestOptions {
  /** Glob patterns for the test files, relative to the working directory. Defaults to every `.test.ts` file. */
  testFiles?: string[];
  /** Arguments for `node` ahead of the test file, such as `--enable-source-maps`. */
  nodeArgs?: string[];
  /**
   * The memory in MB that each process of a mutant run may hold before the runner ends it and reports the mutant as
   * timed out. Defaults to the most memory a process of the test file held in the dry run, times 1.5, plus 1024.
   */
  maxMemoryMB?: number;
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
      memoryLimitMB?: undefined;
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
      /** The memory in MB that each process may hold. */
      memoryLimitMB?: number;
    };

export interface FileRun {
  records: ProcessRecord[];
  exitCode: number | null;
  stderr: string;
  args: string[];
  nodeOptions: string;
  unreadable?: string;
  memoryLimitReached?: MemoryLimitReached;
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
 *
 * Each test's time includes the time the file's run spent outside its outermost tests, whose time includes their
 * subtests': running any test of the file runs the file's whole process. Stryker's mutant timeout scales with the
 * summed time of the tests it runs, so it then scales with the processes it starts, which Stryker's other workers slow
 * down as well.
 */
export function toTestResults(testFile: string, recorded: RecordedTest[], fileMs: number): TestResult[] {
  const prefix = testId(testFile, '');
  const outermost = recorded.filter((test) => !recorded.some((other) => other !== test && within(test.id, other.id)));
  const outside = fileMs - outermost.reduce((sum, test) => sum + test.timeSpentMs, 0);

  return recorded.map((test) => {
    const base = {
      id: test.id,
      name: test.id.slice(prefix.length),
      fileName: testFile,
      timeSpentMs: Math.round(test.timeSpentMs + outside),
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

/** What one test file's run says: the result that ends the whole run, or its tests and coverage. */
type FileOutcome =
  | { end: DryRunResult }
  | { results: TestResult[]; coverages: (MutantCoverage | undefined)[]; failed: boolean };

/**
 * Runs `work` on the items, at most `limit` at a time and starting them in order, and starts no more once a result
 * `stops` the run or `work` rejects. Returns the results of the first items, in order, up to the first that `stops`
 * the run. A rejection comes once the items already started have settled, so no work outlives the call.
 */
export async function runInPool<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
  stops: (result: R) => boolean,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  // One past the first item, in order, whose result stops the run.
  let end = items.length;
  let failed = false;
  const lane = async () => {
    for (let index = next++; !failed && index < end; index = next++) {
      try {
        const result = await work(items[index] as T);
        results[index] = result;

        if (stops(result)) {
          end = Math.min(end, index + 1);
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  const lanes = await Promise.allSettled(Array.from({ length: limit }, lane));
  const rejected = lanes.find((settled) => settled.status === 'rejected');

  if (rejected) {
    throw rejected.reason;
  }

  return results.slice(0, end);
}

/** Turns one test file's run, which took `fileMs`, into its outcome. */
function fileOutcome(file: string, fileRun: FileRun, fileMs: number, run: RunOptions): FileOutcome {
  const { records, exitCode, unreadable, memoryLimitReached } = fileRun;

  // The ended process wrote no record, so this comes before the checks of the records.
  if (memoryLimitReached) {
    const { rssMB, limitMB } = memoryLimitReached;

    return { end: { status: DryRunStatus.Timeout, reason: `Memory limit reached (${rssMB}/${limitMB} MB)` } };
  }

  if (unreadable !== undefined) {
    return { end: { status: DryRunStatus.Error, errorMessage: `Unreadable test results for "${file}": ${unreadable}` } };
  }

  for (const record of records) {
    const timeout = determineHitLimitReached(record.hitCount, run.hitLimit);

    if (timeout) {
      return { end: timeout };
    }
  }

  const results = toTestResults(file, records.flatMap((record) => record.tests), fileMs);
  const failed = results.some((result) => result.status === TestStatus.Failed);

  // Like Stryker's own runners, a failure that no test explains is an error, not a killed mutant.
  if (exitCode !== 0 && !failed) {
    return { end: { status: DryRunStatus.Error, errorMessage: fileError(file, fileRun) } };
  }

  // Without its record the file's results are unknown, as when jest's runner misses a file's coverage.
  const main = records.find((record) => record.main);

  if (!main) {
    const errorMessage =
      `Missing test results for "${file}": its process ended without writing them. Either the Stryker hook ` +
      'did not run in it, or it left without running exit listeners (process.reallyExit, process.abort).';

    return { end: { status: DryRunStatus.Error, errorMessage } };
  }

  // Stryker treats a test runner that exits during a run as crashed, whatever its exit code, and so do its runners
  // that run the tests in their own process; the tests that node:test did not report are unknown.
  if (!failed && main.unfinished) {
    const errorMessage =
      `Unfinished test results for "${file}": its process exited before node:test reported every test, as when ` +
      'a test calls process.exit().';

    return { end: { status: DryRunStatus.Error, errorMessage } };
  }

  return { results, coverages: records.map((record) => record.mutantCoverage), failed };
}

export function filesFor(testFiles: string[], testFilter: string[] | undefined): string[] {
  if (!testFilter) {
    return testFiles;
  }

  return testFiles.filter((file) => testFilter.some((id) => within(id, file)));
}

/**
 * How many test runner processes Stryker runs the mutants in, as `ConcurrencyTokenProvider` in `@stryker-mutator/core`
 * computes them: `concurrency` as a number or a percentage of the cores, by default one less than the cores above 4.
 * Checkers take half of them only until checking is done (`freeCheckers`).
 */
export function testRunnerConcurrency(concurrency: StrykerOptions['concurrency'], cores: number): number {
  const percentage = /^(100|[1-9]?[0-9])%$/.exec(String(concurrency))?.[1];

  if (percentage !== undefined) {
    return Math.max(1, Math.round((cores * Number(percentage)) / 100));
  }

  if (typeof concurrency === 'number') {
    return concurrency;
  }

  return cores > 4 ? cores - 1 : cores;
}

/**
 * Where the runners of one Stryker run keep the most memory a process of each test file held in the dry run, one file
 * per test file. Stryker runs the dry run in one worker and the mutants in all of them, each a process it forks and
 * may replace, so the directory is named after the process they share: Stryker's own.
 */
export function peakMemoryDir(strykerPid: number): string {
  return join(tmpdir(), `stryker-node-test-peaks-${strykerPid}-dry-run`);
}

function peakMemoryPath(dir: string, testFile: string): string {
  return join(dir, createHash('sha256').update(testFile).digest('hex'));
}

/**
 * The memory in MB that each process of a test file's mutant run may hold: `maxMemoryMB` when set, otherwise the most
 * a process of the file held in the dry run, scaled and padded as Stryker scales and pads its timeouts. A test that a
 * mutant fails can need more memory than it did passing, and Node.js's assertion diff grows with the square of the
 * lines it compares (nodejs/node#62792).
 */
export function memoryLimitFor(peakMB: number, maxMemoryMB: number | undefined): number {
  return maxMemoryMB ?? Math.round(peakMB * 1.5 + 1024);
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
): NodeJS.ProcessEnv & { NODE_OPTIONS: string } {
  const env: NodeJS.ProcessEnv & { NODE_OPTIONS: string } = {
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
    ENV.memoryLimit,
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

  if (run.memoryLimitMB !== undefined) {
    env[ENV.memoryLimit] = String(run.memoryLimitMB);
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
 * How a test file's process is spawned: on POSIX in a process group of its own, so that `endGroup` can end the
 * processes its tests leave running. On Windows libuv's job object already ends them with the test file's process.
 */
export function groupOptions(platform: NodeJS.Platform): { detached: boolean; windowsHide: true } {
  return { detached: platform !== 'win32', windowsHide: true };
}

/**
 * Ends what is left of a test file's process group once its run is over: processes its tests started and left
 * running, also when the memory watchdog or a crash ended the test file's process. A process that detached itself has
 * a group of its own and stays.
 */
export function endGroup(
  pid: number,
  platform: NodeJS.Platform,
  kill: (pid: number, signal: NodeJS.Signals) => void = (target, signal) => process.kill(target, signal),
): void {
  if (!groupOptions(platform).detached) {
    return;
  }

  try {
    kill(-pid, 'SIGKILL');
  } catch (error) {
    // The group no longer exists once every process in it has ended.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
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
  readonly #dryRunConcurrency: number;
  readonly #maxMemoryMB: number | undefined;
  readonly #peakMemoryDir = peakMemoryDir(process.ppid);
  readonly #log: Logger;

  constructor(options: StrykerOptions, log: Logger) {
    const nodeTest = (options as { nodeTest?: NodeTestOptions }).nodeTest;
    const patterns = nodeTest?.testFiles ?? ['**/*.test.ts'];
    // Only the dry run gets Stryker's --testFiles; the mutant runs of other workers must find those files too.
    this.#patterns = options.testFiles ? [...patterns, ...options.testFiles] : patterns;
    this.#nodeArgs = withoutReporters(nodeTest?.nodeArgs ?? []);
    this.#dryRunConcurrency = testRunnerConcurrency(options.concurrency, availableParallelism());
    this.#maxMemoryMB = nodeTest?.maxMemoryMB;
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
    const run = {
      dryRun: true,
      disableBail: options.disableBail,
      coverageAnalysis: options.coverageAnalysis,
    } satisfies RunOptions;
    mkdirSync(this.#peakMemoryDir, { recursive: true });

    // The dry run runs as many files at once as Stryker later runs test runners for the mutants, so the test times it
    // reports, which size each mutant's timeout, include the slowdown of processes competing for the cores.
    return this.#run(files, run, this.#dryRunConcurrency, async (file) => {
      const fileRun = await this.runFile(file, run);
      const peakMB = Math.max(0, ...fileRun.records.map((record) => record.peakMemoryMB ?? 0));
      writeFileSync(peakMemoryPath(this.#peakMemoryDir, file), String(peakMB));

      return fileRun;
    });
  }

  async mutantRun(options: MutantRunOptions): Promise<MutantRunResult> {
    const started = performance.now();
    const run = {
      dryRun: false,
      disableBail: options.disableBail,
      activeMutant: options.activeMutant.id,
      mutantActivation: options.mutantActivation,
      hitLimit: options.hitLimit,
      testFilter: options.testFilter,
    } satisfies RunOptions;
    const result = await this.#run(filesFor(this.#testFiles, options.testFilter), run, 1, (file) =>
      this.runFile(file, { ...run, memoryLimitMB: this.#memoryLimitMB(file) }),
    );
    const mutantResult = toMutantRunResult(result);

    // toMutantRunResult sums the test times, which count each file's time outside its tests once per test. A mutant
    // run runs one file at a time, so its own time is the time of the file processes it ran.
    return 'duration' in mutantResult
      ? { ...mutantResult, duration: Math.round(performance.now() - started) }
      : mutantResult;
  }

  /** The memory in MB that each process of a test file's mutant run may hold. */
  #memoryLimitMB(file: string): number {
    const peakPath = peakMemoryPath(this.#peakMemoryDir, file);
    const peakMB = existsSync(peakPath) ? Number(readFileSync(peakPath, 'utf8')) : 0;

    return memoryLimitFor(peakMB, this.#maxMemoryMB);
  }

  /** Runs the files, `limit` at a time, each through `runOne`, and puts their outcomes together. */
  async #run(
    files: string[],
    run: RunOptions,
    limit: number,
    runOne: (file: string) => Promise<FileRun>,
  ): Promise<DryRunResult> {
    const tests: TestResult[] = [];
    const coverages: (MutantCoverage | undefined)[] = [];
    const ends = (outcome: FileOutcome) => 'end' in outcome || (!run.disableBail && outcome.failed);
    const outcomes = await runInPool(
      files,
      limit,
      async (file) => {
        const started = performance.now();
        const fileRun = await runOne(file);

        return fileOutcome(file, fileRun, performance.now() - started, run);
      },
      ends,
    );

    for (const outcome of outcomes) {
      if ('end' in outcome) {
        return outcome.end;
      }

      tests.push(...outcome.results);
      coverages.push(...outcome.coverages);
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

      const child = spawn(process.execPath, args, {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        ...groupOptions(process.platform),
      });
      const { exitCode, stderr } = await processEnd(child, CLOSE_GRACE_MS);
      endGroup(child.pid as number, process.platform);
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

      const markerPath = join(outDir, MEMORY_MARKER);
      const memoryLimitReached = existsSync(markerPath)
        ? (JSON.parse(readFileSync(markerPath, 'utf8')) as MemoryLimitReached)
        : undefined;

      return {
        records,
        exitCode,
        stderr,
        args,
        nodeOptions: env.NODE_OPTIONS,
        ...(unreadable && { unreadable }),
        memoryLimitReached,
      };
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
        maxMemoryMB: { type: 'number', exclusiveMinimum: 0 },
      },
      additionalProperties: false,
    },
  },
};

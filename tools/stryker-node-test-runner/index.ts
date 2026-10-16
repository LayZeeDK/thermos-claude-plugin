// A Stryker test runner for node:test. Each test file runs in its own `node` process with hook.ts loaded through
// NODE_OPTIONS, so every process the tests spawn reports mutant coverage too, attributed to the test that spawned
// it. Results and coverage are per test, and a mutant run executes only the tests that cover the mutant.
import { spawn } from 'node:child_process';
import { globSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { INSTRUMENTER_CONSTANTS, type MutantCoverage, type StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { commonTokens, declareClassPlugin, PluginKind, tokens } from '@stryker-mutator/api/plugin';
import {
  determineHitLimitReached,
  DryRunStatus,
  TestStatus,
  toMutantRunResult,
  type DryRunOptions,
  type DryRunResult,
  type MutantRunOptions,
  type MutantRunResult,
  type TestResult,
  type TestRunner,
  type TestRunnerCapabilities,
} from '@stryker-mutator/api/test-runner';

import { ENV, type ProcessRecord, type RecordedTest } from './hook-core.ts';

/** Options under `nodeTest` in the Stryker configuration. */
export interface NodeTestOptions {
  /** Glob patterns for the test files, relative to the working directory. */
  testFiles: string[];
}

interface RunOptions {
  dryRun: boolean;
  disableBail: boolean;
  activeMutant?: string;
  hitLimit?: number;
  /** Test ids to run; every test runs when absent. */
  testFilter?: string[];
}

/** What one test file's run produced. */
export interface FileRun {
  records: ProcessRecord[];
  exitCode: number | null;
  stderr: string;
}

const HOOK_URL = pathToFileURL(resolve(import.meta.dirname, 'hook.ts')).href;

/** Merges the mutant coverage of several processes by adding up the hit counts. */
export function mergeCoverage(coverages: (MutantCoverage | undefined)[]): MutantCoverage {
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
      add((total.perTest[testId] ??= {}), hits);
    }
  }

  return total;
}

/**
 * Turns the recorded tests of one test file into Stryker test results. A process that exits with a non-zero code
 * without a recorded failure (an error outside any test, a hook failure, a test-level timeout) becomes one failed
 * result named after the file, so the failure is never lost.
 */
export function toTestResults(
  testFile: string,
  recorded: RecordedTest[],
  exitCode: number | null,
  stderr: string,
): TestResult[] {
  const results: TestResult[] = recorded.map((test) => {
    const base = { id: test.id, name: test.id, fileName: testFile, timeSpentMs: Math.round(test.timeSpentMs) };

    return test.status === 'passed'
      ? { ...base, status: TestStatus.Success }
      : { ...base, status: TestStatus.Failed, failureMessage: test.failureMessage ?? 'Test failed' };
  });

  if (exitCode !== 0 && !results.some((result) => result.status === TestStatus.Failed)) {
    results.push({
      id: testFile,
      name: testFile,
      fileName: testFile,
      timeSpentMs: 0,
      status: TestStatus.Failed,
      failureMessage: stderr.trim().split('\n').slice(-5).join('\n') || `node exited with code ${exitCode}`,
    });
  }

  return results;
}

/** Returns the test files that contain at least one of the filtered test ids, or every file without a filter. */
export function filesFor(testFiles: string[], testFilter: string[] | undefined): string[] {
  if (!testFilter) {
    return testFiles;
  }

  return testFiles.filter((file) => testFilter.some((id) => id === file || id.startsWith(`${file} > `)));
}

/** Builds the environment for one test file's process tree. */
export function runEnv(base: NodeJS.ProcessEnv, file: string, outDir: string, run: RunOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    // The hook comes first, so a copy of this runner under test takes precedence over the runner running it.
    NODE_OPTIONS: `--import ${JSON.stringify(HOOK_URL)} ${base.NODE_OPTIONS ?? ''}`.trim(),
    [ENV.out]: outDir,
    [ENV.file]: file,
    [ENV.dryRun]: String(run.dryRun),
  };

  for (const key of [ENV.current, ENV.hitLimit, ENV.filter, INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE]) {
    delete env[key];
  }

  if (run.activeMutant !== undefined) {
    env[INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE] = run.activeMutant;
  }

  if (run.hitLimit !== undefined) {
    env[ENV.hitLimit] = String(run.hitLimit);
  }

  if (run.testFilter) {
    env[ENV.filter] = JSON.stringify(run.testFilter);
  }

  return env;
}

export class NodeTestRunner implements TestRunner {
  static inject = tokens(commonTokens.options, commonTokens.logger);

  #testFiles: string[] = [];
  readonly #options: NodeTestOptions;
  readonly #log: Logger;

  constructor(options: StrykerOptions, log: Logger) {
    this.#options = (options as { nodeTest?: NodeTestOptions }).nodeTest ?? { testFiles: ['**/*.test.ts'] };
    this.#log = log;
  }

  capabilities(): TestRunnerCapabilities {
    return { reloadEnvironment: true };
  }

  async init(): Promise<void> {
    this.#testFiles = globSync(this.#options.testFiles, { exclude: (name) => name === 'node_modules' })
      .map((file) => resolve(file))
      .sort();

    if (this.#testFiles.length === 0) {
      throw new Error(`No test files match ${JSON.stringify(this.#options.testFiles)}`);
    }
  }

  dryRun(options: DryRunOptions): Promise<DryRunResult> {
    return this.#run(this.#testFiles, { dryRun: true, disableBail: options.disableBail });
  }

  async mutantRun(options: MutantRunOptions): Promise<MutantRunResult> {
    const result = await this.#run(filesFor(this.#testFiles, options.testFilter), {
      dryRun: false,
      disableBail: options.disableBail,
      activeMutant: options.activeMutant.id,
      hitLimit: options.hitLimit,
      testFilter: options.testFilter,
    });

    return toMutantRunResult(result);
  }

  async #run(files: string[], run: RunOptions): Promise<DryRunResult> {
    const tests: TestResult[] = [];
    const coverages: (MutantCoverage | undefined)[] = [];

    for (const file of files) {
      const { records, exitCode, stderr } = await this.runFile(file, run);

      for (const record of records) {
        const timeout = determineHitLimitReached(record.hitCount, run.hitLimit);

        if (timeout) {
          return timeout;
        }

        coverages.push(record.mutantCoverage);
      }

      const results = toTestResults(file, records.flatMap((record) => record.tests), exitCode, stderr);
      tests.push(...results);

      if (!run.disableBail && results.some((result) => result.status === TestStatus.Failed)) {
        break;
      }
    }

    return run.dryRun
      ? { status: DryRunStatus.Complete, tests, mutantCoverage: mergeCoverage(coverages) }
      : { status: DryRunStatus.Complete, tests };
  }

  /** Runs one test file and collects the record of every process it started. */
  async runFile(file: string, run: RunOptions): Promise<FileRun> {
    // Stryker disable next-line StringLiteral: the prefix only names the directory
    const outDir = mkdtempSync(join(tmpdir(), 'stryker-node-test-'));

    try {
      const env = runEnv(process.env, file, outDir, run);
      this.#log.debug(`Running node ${file}`);
      const { exitCode, stderr } = await new Promise<{ exitCode: number | null; stderr: string }>((done, fail) => {
        const child = spawn(process.execPath, [file], {
          env,
          // Stryker disable next-line ArrayDeclaration: piping unread output only shows as a hang once a pipe fills
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

      return { records, exitCode, stderr };
    } finally {
      rmSync(outDir, {
        recursive: true,
        // Stryker disable next-line BooleanLiteral: the directory always exists here
        force: true,
      });
    }
  }
}

export const strykerPlugins = [declareClassPlugin(PluginKind.TestRunner, 'node-test', NodeTestRunner)];

export const strykerValidationSchema = {
  // Stryker disable next-line StringLiteral: Stryker reads only the properties, and Ajv ignores an empty $schema
  $schema: 'http://json-schema.org/draft-07/schema',
  type: 'object',
  properties: {
    nodeTest: {
      type: 'object',
      properties: { testFiles: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    },
  },
};

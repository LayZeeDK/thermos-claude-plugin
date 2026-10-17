// Benchmarks the node:test runner on fixed synthetic fixtures, plus one end-to-end `npm run mutate`.
//
//   npm run bench
//   npm run bench -- --runs 9 --mutate-runs 0
//   npm run bench -- --runner path/to/baseline/index.ts --runner tools/stryker-node-test-runner/index.ts
//
// Several `--runner` paths run interleaved (A, B, A, B, ...), so warmup, caches and drift hit every side alike.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { Mutant, StrykerOptions } from '@stryker-mutator/api/core';
import type { Logger } from '@stryker-mutator/api/logging';
import { DryRunStatus, MutantRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';

import type { NodeTestRunner } from './index.ts';

type RunnerModule = typeof import('./index.ts');

interface Scenario {
  name: string;
  /** Runs once and returns the number of tests the runner reported, which the scenario asserts first. */
  run: (runner: NodeTestRunner) => Promise<number>;
}

interface Stat {
  runs: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  /** (max - min) / median, the run-to-run noise a difference must exceed. */
  spread: number;
}

const FILES = 6;
const TESTS_PER_FILE = 5;
const SPAWNING_FILES = 2;
const TEST_COUNT = FILES * TESTS_PER_FILE;

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '7' },
    'mutate-runs': { type: 'string', default: '1' },
    runner: { type: 'string', multiple: true, default: [] },
    json: { type: 'string' },
  },
});
const runs = Number(args.runs);
const mutateRuns = Number(args['mutate-runs']);
const runnerPaths = args.runner.length > 0 ? args.runner : [join(import.meta.dirname, 'index.ts')];
assert.ok(runs >= 1 && mutateRuns >= 0, 'runs must be >= 1 and mutate-runs >= 0');

const COVER = [
  'const cover = (id) => {',
  '  const ns = globalThis.__stryker__;',
  '  const coverage = (ns.mutantCoverage ??= { static: {}, perTest: {} });',
  '  const hits = ns.currentTestId ? (coverage.perTest[ns.currentTestId] ??= {}) : coverage.static;',
  '  hits[id] = (hits[id] ?? 0) + 1;',
  '};',
].join(' ');

function fixtureFile(index: number): string {
  const spawns = index < SPAWNING_FILES;
  const lines = [
    "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    "import { describe, it } from 'node:test';",
    COVER,
    `cover('static-${index}');`,
    `describe('suite ${index}', () => {`,
  ];

  for (let test = 0; test < TESTS_PER_FILE; test++) {
    const body =
      spawns && test === 0
        ? `const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(`${COVER} cover('child-${index}');`)}]); assert.equal(child.status, 0, String(child.stderr));`
        : `assert.equal([${test}].length, 1);`;
    lines.push(`  it('test ${test}', () => { cover('m-${index}-${test}'); ${body} });`);
  }

  lines.push('});', '');

  return lines.join('\n');
}

function silentLogger(): Logger {
  const no = () => false;
  const ignore = () => {};

  return {
    isTraceEnabled: no,
    isDebugEnabled: no,
    isInfoEnabled: no,
    isWarnEnabled: no,
    isErrorEnabled: no,
    isFatalEnabled: no,
    trace: ignore,
    debug: ignore,
    info: ignore,
    warn: ignore,
    error: ignore,
    fatal: ignore,
  };
}

function mutantRunOptions(testFilter?: string[]) {
  return {
    timeout: 60_000,
    disableBail: false,
    // Not a number, so it never activates a mutant in an instrumented copy of the runner.
    activeMutant: { id: 'bench-mutant' } as Mutant,
    sandboxFileName: 'sandbox',
    mutantActivation: 'runtime' as const,
    reloadEnvironment: true,
    testFilter,
  };
}

function scenarios(files: string[]): Scenario[] {
  const testId = (file: number, test: number) => `${files[file]} > suite ${file} > test ${test}`;

  return [
    {
      name: `dry run, ${FILES} files x ${TESTS_PER_FILE} tests`,
      run: async (runner) => {
        const result = await runner.dryRun({ timeout: 60_000, disableBail: false, coverageAnalysis: 'perTest' });
        assert.equal(result.status, DryRunStatus.Complete);
        assert.ok(result.tests.every((test) => test.status === TestStatus.Success));
        assert.equal(Object.keys(result.mutantCoverage?.perTest ?? {}).length, TEST_COUNT);
        assert.equal(result.mutantCoverage?.perTest[testId(0, 0)]?.['child-0'], 1);

        return result.tests.length;
      },
    },
    {
      name: 'mutant run, no filter (every file)',
      run: async (runner) => {
        const result = await runner.mutantRun(mutantRunOptions());
        assert.equal(result.status, MutantRunStatus.Survived);
        assert.equal(result.nrOfTests, TEST_COUNT);

        return result.nrOfTests;
      },
    },
    {
      name: 'mutant run, filter covering 3 files',
      run: async (runner) => {
        const result = await runner.mutantRun(mutantRunOptions([testId(0, 1), testId(2, 1), testId(4, 1)]));
        assert.equal(result.status, MutantRunStatus.Survived);
        assert.equal(result.nrOfTests, 3);

        return result.nrOfTests;
      },
    },
    {
      name: 'mutant run, filter covering 1 file',
      run: async (runner) => {
        const result = await runner.mutantRun(mutantRunOptions([testId(3, 2)]));
        assert.equal(result.status, MutantRunStatus.Survived);
        assert.equal(result.nrOfTests, 1);

        return result.nrOfTests;
      },
    },
  ];
}

function stat(ms: number[]): Stat {
  const sorted = [...ms].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const minMs = sorted[0]!;
  const maxMs = sorted[sorted.length - 1]!;

  return { runs: sorted.length, medianMs, minMs, maxMs, spread: (maxMs - minMs) / medianMs };
}

function format(name: string, { runs, medianMs, minMs, maxMs, spread }: Stat): string {
  const fixed = (value: number) => value.toFixed(0).padStart(7);

  return `${name.padEnd(44)} median ${fixed(medianMs)} ms  min ${fixed(minMs)}  max ${fixed(maxMs)}  spread ${(spread * 100).toFixed(0).padStart(3)}%  runs ${runs}`;
}

async function loadRunner(path: string, dir: string): Promise<NodeTestRunner> {
  const module = (await import(pathToFileURL(resolve(path)).href)) as RunnerModule;
  const options = { nodeTest: { testFiles: [join(dir, '*.test.mjs').replaceAll('\\', '/')] } };
  const runner = new module.NodeTestRunner(options as unknown as StrykerOptions, silentLogger());
  await runner.init();

  return runner;
}

function mutateWallMs(): number {
  const start = performance.now();
  const result = spawnSync('npm', ['run', 'mutate'], { shell: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const ms = performance.now() - start;
  assert.equal(result.status, 0, `npm run mutate failed:\n${result.stdout}\n${result.stderr}`);
  const summary = result.stdout.match(/All files\s*\|\s*([\d.]+)/);
  assert.equal(summary?.[1], '100.00', `npm run mutate did not reach 100%:\n${result.stdout}`);

  return ms;
}

async function main(): Promise<void> {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'node-test-runner-bench-')));
  const files: string[] = [];
  const runners: NodeTestRunner[] = [];

  try {
    for (let index = 0; index < FILES; index++) {
      const file = join(dir, `file-${index}.test.mjs`);
      writeFileSync(file, fixtureFile(index));
      files.push(file);
    }

    runners.push(...(await Promise.all(runnerPaths.map((path) => loadRunner(path, dir)))));
    const labels = runnerPaths.map((path) => (runnerPaths.length > 1 ? `[${path}] ` : ''));
    const samples = new Map<string, number[]>();
    const sample = (label: string) => {
      const existing = samples.get(label);

      if (existing) {
        return existing;
      }

      const created: number[] = [];
      samples.set(label, created);

      return created;
    };

    console.log(`node ${process.version} on ${process.platform} ${process.arch}, ${availableParallelism()} cores`);
    console.log(`fixtures: ${FILES} files x ${TESTS_PER_FILE} tests, ${SPAWNING_FILES} files spawn a child process`);

    for (const scenario of scenarios(files)) {
      // One unmeasured warmup per side covers lazy initialization.
      for (const runner of runners) {
        await scenario.run(runner);
      }

      for (let run = 0; run < runs; run++) {
        for (const [index, runner] of runners.entries()) {
          const start = performance.now();
          const tests = await scenario.run(runner);
          const ms = performance.now() - start;
          assert.ok(tests > 0);
          sample(`${labels[index]}${scenario.name}`).push(ms);
        }
      }
    }

    for (let run = 0; run < mutateRuns; run++) {
      sample('npm run mutate, wall').push(mutateWallMs());
    }

    const stats = Object.fromEntries([...samples].map(([label, ms]) => [label, stat(ms)]));

    for (const [label, value] of Object.entries(stats)) {
      console.log(format(label, value));
    }

    if (args.json) {
      writeFileSync(
        args.json,
        JSON.stringify(
          { node: process.version, platform: process.platform, arch: process.arch, cores: availableParallelism(), stats },
          null,
          2,
        ),
      );
    }
  } finally {
    await Promise.all(runners.map((runner) => runner.dispose?.()));
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();

// Benchmarks the node:test runner on fixed synthetic fixtures, plus each Stryker suite that `npm run mutate` runs,
// timed apart.
//
//   npm run bench
//   npm run bench -- --runs 9 --mutate-runs 0
//   npm run bench -- --runner path/to/baseline/index.ts --runner tools/stryker-node-test-runner/index.ts
//
// Runners alternate order each round (A B, B A), so drift hits both alike.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type { StrykerOptions } from '@stryker-mutator/api/core';
import { DryRunStatus, MutantRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';
import { Bench } from 'tinybench';

import { COVER, DRY_RUN, fixture, logger, mutantRunOptions } from './index.fixtures.ts';
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

function fixtureFile(index: number): string {
  const spawns = index < SPAWNING_FILES;
  const tests: string[] = [];

  for (let test = 0; test < TESTS_PER_FILE; test++) {
    const body =
      spawns && test === 0
        ? `const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(`${COVER} cover('child-${index}');`)}]); assert.equal(child.status, 0, String(child.stderr));`
        : `assert.equal([${test}].length, 1);`;
    tests.push(`  it('test ${test}', () => { cover('m-${index}-${test}'); ${body} });`);
  }

  return fixture(`cover('static-${index}');`, `describe('suite ${index}', () => {`, ...tests, '});');
}

function scenarios(files: string[]): Scenario[] {
  const testId = (file: number, test: number) => `${files[file]} > suite ${file} > test ${test}`;

  return [
    {
      name: `dry run, ${FILES} files x ${TESTS_PER_FILE} tests`,
      run: async (runner) => {
        const result = await runner.dryRun({ ...DRY_RUN, timeout: 60_000 });
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
        const result = await runner.mutantRun(mutantRunOptions({ timeout: 60_000 }));
        assert.equal(result.status, MutantRunStatus.Survived);
        assert.equal(result.nrOfTests, TEST_COUNT);

        return result.nrOfTests;
      },
    },
    {
      name: 'mutant run, filter covering 3 files',
      run: async (runner) => {
        const result = await runner.mutantRun(mutantRunOptions({ timeout: 60_000, testFilter: [testId(0, 1), testId(2, 1), testId(4, 1)] }));
        assert.equal(result.status, MutantRunStatus.Survived);
        assert.equal(result.nrOfTests, 3);

        return result.nrOfTests;
      },
    },
    {
      name: 'mutant run, filter covering 1 file',
      run: async (runner) => {
        const result = await runner.mutantRun(mutantRunOptions({ timeout: 60_000, testFilter: [testId(3, 2)] }));
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

function format(name: string, { runs, medianMs, minMs, maxMs, spread }: Stat, unit = 'ms'): string {
  const fixed = (value: number) => (unit === 'ms' ? value.toFixed(0) : value.toFixed(3)).padStart(7);

  return `${name.padEnd(44)} median ${fixed(medianMs)} ${unit}  min ${fixed(minMs)}  max ${fixed(maxMs)}  spread ${(spread * 100).toFixed(0).padStart(3)}%  runs ${runs}`;
}

async function round(tasks: [name: string, fn: () => unknown][]): Promise<Map<string, number>> {
  const bench = new Bench({
    iterations: 1,
    time: 0,
    warmup: false,
    timestampProvider: 'hrtimeNow',
    throws: true,
    retainSamples: true,
  });

  for (const [name, fn] of tasks) {
    bench.add(name, fn);
  }

  const times = new Map<string, number>();

  for (const task of await bench.run()) {
    assert.ok(task.result.state === 'completed', `${task.name} ended as ${task.result.state}`);
    times.set(task.name, task.result.latency.samples![0]!);
  }

  return times;
}

async function loadRunner(path: string, dir: string): Promise<NodeTestRunner> {
  const module = (await import(pathToFileURL(resolve(path)).href)) as RunnerModule;
  const options = { nodeTest: { testFiles: [join(dir, '*.test.mjs').replaceAll('\\', '/')] } };
  const runner = new module.NodeTestRunner(options as unknown as StrykerOptions, logger([], false));
  await runner.init();

  return runner;
}

/** The Stryker suites that `npm run mutate` runs one after the other, each as its own command. */
const MUTATE_SUITES = (
  JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as {
    scripts: { mutate: string };
  }
).scripts.mutate.split(' && ');

function mutate(suite: string): void {
  const result = spawnSync(`npx ${suite}`, {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${suite} failed:\n${result.stdout}\n${result.stderr}`);
  const summary = result.stdout.match(/All files\s*\|\s*([\d.]+)/);
  assert.equal(summary?.[1], '100.00', `${suite} did not reach 100%:\n${result.stdout}`);
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
    const add = (label: string, ms: number) => samples.set(label, [...(samples.get(label) ?? []), ms]);

    console.log(`node ${process.version} on ${process.platform} ${process.arch}, ${availableParallelism()} cores`);
    console.log(`fixtures: ${FILES} files x ${TESTS_PER_FILE} tests, ${SPAWNING_FILES} files spawn a child process`);

    for (const scenario of scenarios(files)) {
      const sides = runners.map((runner, index): [string, () => Promise<void>] => [
        `${labels[index]}${scenario.name}`,
        async () => {
          assert.ok((await scenario.run(runner)) > 0);
        },
      ]);
      // One unmeasured round covers lazy initialization.
      await round(sides);

      for (let run = 0; run < runs; run++) {
        const times = await round(run % 2 === 0 ? sides : [...sides].reverse());
        const [first] = sides;

        for (const [label] of sides) {
          add(label, times.get(label)!);

          if (label !== first![0]) {
            add(`${label} / first runner`, times.get(label)! / times.get(first![0])!);
          }
        }
      }
    }

    for (let run = 0; run < mutateRuns; run++) {
      for (const suite of MUTATE_SUITES) {
        const label = `${suite}, wall`;
        add(label, (await round([[label, () => mutate(suite)]])).get(label)!);
      }
    }

    const stats = Object.fromEntries([...samples].map(([label, values]) => [label, stat(values)]));

    for (const [label, value] of Object.entries(stats)) {
      console.log(format(label, value, label.endsWith(' / first runner') ? 'x' : 'ms'));
    }

    if (args.json) {
      writeFileSync(
        args.json,
        JSON.stringify(
          {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            cores: availableParallelism(),
            stats,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await Promise.all(runners.map((runner) => runner.dispose()));
    rmSync(dir, { recursive: true, force: true });
  }
}

await main();

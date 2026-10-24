import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { TestStatus } from '@stryker-mutator/api/test-runner';

import { testEach } from '../test-each/test-each.ts';
import { testFor } from '../test-each/test-for.ts';
import { ACTIVE_MUTANT_ENV, ENV } from './hook-core.ts';
import { ACTIVE_MUTANT, HOOK_URL, logger } from './index.fixtures.ts';
import {
  fileError,
  filesFor,
  memoryLimitFor,
  mergeCoverage,
  parseRecord,
  runEnv,
  runInPool,
  type RunOptions,
  testRunnerConcurrency,
  toTestResults,
} from './index.ts';

const FILE = join('/repo', 'a.test.mjs');

describe('mergeCoverage', () => {
  it('adds up the hits of every process and skips processes without coverage', () => {
    assert.deepEqual(
      mergeCoverage(
        [
          { static: { 1: 1 }, perTest: { first: { 2: 1 } } },
          undefined,
          { static: { 1: 2, 3: 1 }, perTest: { first: { 2: 3 }, second: { 4: 1 } } },
        ],
        true,
      ),
      { static: { 1: 3, 3: 1 }, perTest: { first: { 2: 4 }, second: { 4: 1 } } },
    );
  });

  it('is empty without coverage', () => {
    assert.deepEqual(mergeCoverage([], true), { static: {}, perTest: {} });
  });

  it('counts the hits inside tests as static when asked to drop the tests', () => {
    assert.deepEqual(
      mergeCoverage(
        [
          { static: { 1: 1 }, perTest: { first: { 1: 1, 2: 1 } } },
          { static: {}, perTest: { first: { 2: 3 }, second: { 4: 1 } } },
        ],
        false,
      ),
      { static: { 1: 2, 2: 4, 4: 1 }, perTest: {} },
    );
  });
});

describe('toTestResults', () => {
  const base = (id: string) => ({ id, name: id.slice(`${FILE} > `.length), fileName: FILE });

  it('reports each recorded test with its status, failure message, and rounded time plus the time the file spent outside its tests', () => {
    // The tests take 4.4 ms of the file's 10.4 ms, so each test carries the other 6 ms.
    assert.deepEqual(
      toTestResults(
        FILE,
        [
          { id: `${FILE} > passes`, status: 'passed', timeSpentMs: 1.6 },
          { id: `${FILE} > fails`, status: 'failed', failureMessage: 'boom', timeSpentMs: 2.4 },
          { id: `${FILE} > fails silently`, status: 'failed', timeSpentMs: 0 },
          { id: `${FILE} > skipped`, status: 'skipped', timeSpentMs: 0.4 },
        ],
        10.4,
      ),
      [
        { ...base(`${FILE} > passes`), timeSpentMs: 8, status: TestStatus.Success },
        { ...base(`${FILE} > fails`), timeSpentMs: 8, status: TestStatus.Failed, failureMessage: 'boom' },
        {
          ...base(`${FILE} > fails silently`),
          timeSpentMs: 6,
          status: TestStatus.Failed,
          failureMessage: 'Test failed',
        },
        { ...base(`${FILE} > skipped`), timeSpentMs: 6, status: TestStatus.Skipped },
      ],
    );
  });

  it("counts a parent test's time once, as it includes the time of the subtests it runs", () => {
    // The parent's 5 ms include its subtests' 1 ms and 3 ms (the second has a subtest of its own); a sibling takes 1 ms
    // more, so the 10 ms file spent 4 ms outside its tests.
    assert.deepEqual(
      toTestResults(
        FILE,
        [
          { id: `${FILE} > parent > first`, status: 'passed', timeSpentMs: 1 },
          { id: `${FILE} > parent > second > third`, status: 'passed', timeSpentMs: 2 },
          { id: `${FILE} > parent > second`, status: 'passed', timeSpentMs: 3 },
          { id: `${FILE} > parent`, status: 'passed', timeSpentMs: 5 },
          { id: `${FILE} > parenthood`, status: 'passed', timeSpentMs: 1 },
        ],
        10,
      ).map((result) => result.timeSpentMs),
      [5, 6, 7, 9, 5],
    );
  });

  it('reports where a test is declared when the hook recorded it', () => {
    const startPosition = { line: 4, column: 2 };

    assert.deepEqual(
      toTestResults(FILE, [{ id: `${FILE} > passes`, status: 'passed', timeSpentMs: 1, startPosition }], 1),
      [{ ...base(`${FILE} > passes`), timeSpentMs: 1, status: TestStatus.Success, startPosition }],
    );
  });
});

describe('fileError', () => {
  const command =
    `To reproduce it, run \`node "--no-deprecation" "${FILE}"\` in ${process.cwd()} ` +
    'with NODE_OPTIONS set to `--import "hook" --stack-size=900`.';

  testFor([
    ['trimmed stderr', 1, '  \nline 1\nline 2 \n', [], ['Stderr:', 'line 1', 'line 2']],
    ['no stderr', 3, ' \n', [], []],
    ['the missing exit code of a killed process', null, '', [], []],
    [
      'the diagnostics of every process',
      1,
      'out',
      [{ diagnostics: ['late 1'] }, {}, { diagnostics: ['late 2'] }],
      ['Diagnostics:', 'late 1', 'late 2', 'Stderr:', 'out'],
    ],
  ] as const)('names the file, the exit code and the command, with %s', ([, exitCode, stderr, records, end]) => {
    const run = {
      records: records.map((record: { diagnostics?: readonly string[] }) => ({
        tests: [],
        ...(record.diagnostics && { diagnostics: [...record.diagnostics] }),
      })),
      exitCode,
      stderr,
      args: ['--no-deprecation', FILE],
      nodeOptions: '--import "hook" --stack-size=900',
    };

    assert.equal(
      fileError(FILE, run),
      [`Error running file "${FILE}": node exited with code ${exitCode} outside any test.`, command, ...end].join('\n'),
    );
  });
});

describe('parseRecord', () => {
  it('returns the record a process wrote', () => {
    const record = { main: true, tests: [{ id: `${FILE} > t`, status: 'passed', timeSpentMs: 1 }], hitCount: 3 };

    assert.deepEqual(parseRecord(JSON.stringify(record)), record);
  });

  testFor(['{}', 'null', '[]', '{"tests":{}}'])('refuses %s, which lists no tests', (json) => {
    assert.throws(() => parseRecord(json), { message: 'not a record of test results' });
  });

  it('refuses what does not parse', () => {
    assert.throws(() => parseRecord('{'), SyntaxError);
  });
});

describe('filesFor', () => {
  const a = join('/repo', 'a.test.mjs');
  const b = join('/repo', 'b.test.mjs');
  const longer = `${a}.old`;
  const files = [a, b, longer];

  it('returns every file without a filter', () => {
    assert.deepEqual(filesFor(files, undefined), files);
  });

  it('returns no file for an empty filter', () => {
    assert.deepEqual(filesFor(files, []), []);
  });

  it('returns the files that contain a filtered test, or that the filter names themselves', () => {
    assert.deepEqual(filesFor(files, [`${longer} > suite > test`]), [longer]);
    assert.deepEqual(filesFor(files, [`${a} > test`]), [a]);
    assert.deepEqual(filesFor(files, [b, `${a} > test`]), [a, b]);
  });
});

describe('runInPool', () => {
  /** A pool over `count` items whose work the test settles itself, item by item. */
  function setup(count: number, limit: number, stops: (result: number) => boolean = () => false) {
    const started: number[] = [];
    const settle: ((result: number) => void)[] = [];
    const fail: ((error: Error) => void)[] = [];
    const pool = runInPool(
      Array.from({ length: count }, (_, index) => index),
      limit,
      (item) => {
        started.push(item);

        return new Promise<number>((resolve, reject) => {
          settle[item] = resolve;
          fail[item] = reject;
        });
      },
      stops,
    );
    const turn = () => new Promise((resolve) => setImmediate(resolve));

    return { started, settle, fail, pool, turn };
  }

  it('runs at most `limit` items at once, starting them in order, and returns their results in order', async () => {
    const { started, settle, pool, turn } = setup(5, 2);

    await turn();
    assert.deepEqual(started, [0, 1]);
    settle[1]?.(10);
    await turn();
    assert.deepEqual(started, [0, 1, 2]);
    settle[0]?.(0);
    await turn();
    assert.deepEqual(started, [0, 1, 2, 3]);
    settle[3]?.(30);
    settle[2]?.(20);
    await turn();
    settle[4]?.(40);
    await turn();

    assert.deepEqual(started, [0, 1, 2, 3, 4]);
    assert.deepEqual(await pool, [0, 10, 20, 30, 40]);
  });

  it('starts no more items once a result stops the run, and returns the results of those it started', async () => {
    const { started, settle, pool, turn } = setup(5, 2, (result) => result === 1);

    await turn();
    settle[1]?.(1);
    await turn();
    settle[0]?.(0);
    await turn();

    assert.deepEqual(started, [0, 1]);
    assert.deepEqual(await pool, [0, 1]);
  });

  it('returns no results after the first item whose result stops the run, though a later one finished', async () => {
    const { started, settle, pool, turn } = setup(5, 2, (result) => result === 0);

    await turn();
    settle[0]?.(0);
    await turn();
    settle[1]?.(1);
    await turn();

    assert.deepEqual(started, [0, 1]);
    assert.deepEqual(await pool, [0]);
  });

  it('starts no more items once an item fails, and rejects with its error once the started items settle', async () => {
    const { started, settle, fail, pool, turn } = setup(5, 2);
    const error = new Error('spawn EAGAIN');
    let settled = false;
    const rejected = assert.rejects(
      pool.finally(() => (settled = true)),
      error,
    );

    await turn();
    fail[1]?.(error);
    await turn();
    assert.equal(settled, false);
    settle[0]?.(0);
    await turn();

    assert.deepEqual(started, [0, 1]);
    await rejected;
  });

  it('runs every item when the limit exceeds their number, and nothing for no items', async () => {
    const { started, settle, pool, turn } = setup(2, 4);

    await turn();
    assert.deepEqual(started, [0, 1]);
    settle[0]?.(0);
    settle[1]?.(1);

    assert.deepEqual(await pool, [0, 1]);
    assert.deepEqual(await runInPool([], 4, () => Promise.reject(new Error('no work')), () => false), []);
  });
});

describe('testRunnerConcurrency', () => {
  testEach([
    [undefined, false, 8, 7],
    [undefined, false, 4, 4],
    [3, false, 8, 3],
    ['50%', false, 3, 2],
    ['0%', false, 8, 1],
    ['100%', false, 8, 8],
    ['50', false, 8, 7],
    ['150%', false, 8, 7],
    ['x50%', false, 8, 7],
    ['50%x', false, 8, 7],
    [1, true, 8, 2],
    ['0%', true, 8, 2],
    [3, true, 8, 3],
    [4, true, 8, 4],
  ])(
    'gives concurrency %j, with checkers %j, on %d cores %d test runners, as Stryker does',
    (concurrency, checkers, cores, runners) => {
      assert.equal(testRunnerConcurrency(concurrency, checkers, cores), runners);
    },
  );

  testEach([
    [[], undefined],
    [[], 3],
    [[], '50%'],
    [[], '150%'],
    [[], '0%'],
    [['typescript'], undefined],
    [['typescript'], 1],
    [['typescript'], '0%'],
    [['typescript'], 3],
  ])("matches Stryker core's test runner count once checking is done, for checkers %j and concurrency %j", async (checkers, concurrency) => {
    // The computation is private to @stryker-mutator/core; this fails when a release of it changes the count.
    const providerUrl = new URL('./concurrent/concurrency-token-provider.js', import.meta.resolve('@stryker-mutator/core'));
    const { ConcurrencyTokenProvider } = (await import(providerUrl.href)) as {
      ConcurrencyTokenProvider: new (
        options: { checkers: string[]; concurrency: number | string | undefined },
        log: ReturnType<typeof logger>,
      ) => { testRunnerToken$: { subscribe(next: (token: number) => void): unknown }; freeCheckers(): void; dispose(): void };
    };
    const provider = new ConcurrencyTokenProvider({ checkers: [...checkers], concurrency }, logger());
    const tokens: number[] = [];
    provider.testRunnerToken$.subscribe((token) => tokens.push(token));
    provider.freeCheckers();
    provider.dispose();

    assert.equal(testRunnerConcurrency(concurrency, checkers.length > 0, availableParallelism()), tokens.length);
  });
});

describe('memoryLimitFor', () => {
  testEach([
    [0, undefined, 1024],
    [101, undefined, 1176],
    [370, undefined, 1579],
    [370, 300, 300],
  ])('gives a file whose dry run peaked at %d MB, with maxMemoryMB %s, a limit of %d MB', (peak, max, limit) => {
    assert.equal(memoryLimitFor(peak, max), limit);
  });
});

describe('runEnv', () => {
  const OUT = join('/tmp', 'out');
  const TMP = join('/tmp', 'tmp');

  it("names Stryker's active mutant variable as the hook does", () => {
    assert.equal(ACTIVE_MUTANT_ENV, ACTIVE_MUTANT);
  });

  it('loads the hook before inherited options and drops the outer run state', () => {
    const base = {
      PATH: 'path',
      NODE_OPTIONS: '--max-old-space-size=100',
      [ENV.out]: 'outer out',
      NODE_TEST_CONTEXT: 'child-v8',
      TEMP: 'outer temp',
      [ENV.current]: 'outer test',
      [ENV.hitLimit]: '5',
      [ENV.memoryLimit]: '500',
      [ENV.filter]: JSON.stringify(['outer']),
      [ENV.bail]: 'true',
      [ENV.activeMutant]: '8',
      [ACTIVE_MUTANT]: '9',
    };
    const before = { ...base };

    assert.deepEqual(runEnv(base, FILE, OUT, TMP, { dryRun: false, disableBail: true }, undefined), {
      PATH: 'path',
      NODE_OPTIONS: `--import ${JSON.stringify(HOOK_URL)} --max-old-space-size=100`,
      [ENV.out]: OUT,
      [ENV.file]: FILE,
      [ENV.dryRun]: 'false',
      TMPDIR: TMP,
      TEMP: TMP,
      TMP,
    });
    assert.deepEqual(base, before);
  });

  it('drops the node:test reporters and destinations of inherited options, also quoted ones', () => {
    const NODE_OPTIONS = [
      '--test-reporter=spec',
      '--max-old-space-size=100',
      '--test-reporter dot',
      '"--test-reporter-destination=a b"',
      '--test-reporter-destination  stdout',
      '--title="a \\" --test-reporter=b"',
      '--test-reporter-destinations=x',
    ].join(' ');
    const kept = ['--max-old-space-size=100', '--title="a \\" --test-reporter=b"', '--test-reporter-destinations=x'];

    assert.equal(
      runEnv({ NODE_OPTIONS }, FILE, OUT, TMP, { dryRun: false, disableBail: true }, undefined).NODE_OPTIONS,
      [`--import ${JSON.stringify(HOOK_URL)}`, ...kept].join(' '),
    );
  });

  it("uses the runner's compile cache directory unless the environment names one", () => {
    const run = { dryRun: false, disableBail: false } satisfies RunOptions;

    const inherited = { NODE_COMPILE_CACHE: 'inherited' };

    assert.equal(runEnv({}, FILE, OUT, TMP, run, 'own').NODE_COMPILE_CACHE, 'own');
    assert.equal(runEnv(inherited, FILE, OUT, TMP, run, 'own').NODE_COMPILE_CACHE, 'inherited');
    assert.equal(runEnv(inherited, FILE, OUT, TMP, run, undefined).NODE_COMPILE_CACHE, 'inherited');
  });

  it('passes the run state on to the test file', () => {
    assert.deepEqual(
      runEnv(
        {},
        FILE,
        OUT,
        TMP,
        {
          dryRun: false,
          disableBail: true,
          activeMutant: '12',
          hitLimit: 40,
          testFilter: [`${FILE} > test`],
          memoryLimitMB: 1500,
        },
        undefined,
      ),
      {
        NODE_OPTIONS: `--import ${JSON.stringify(HOOK_URL)}`,
        [ENV.out]: OUT,
        [ENV.file]: FILE,
        [ENV.dryRun]: 'false',
        TMPDIR: TMP,
        TEMP: TMP,
        TMP,
        [ACTIVE_MUTANT]: '12',
        [ENV.hitLimit]: '40',
        [ENV.memoryLimit]: '1500',
        [ENV.filter]: JSON.stringify([`${FILE} > test`]),
      },
    );
  });

  it('activates the mutant from the start of the process, or for the hook to activate once the tests start', () => {
    const run = { dryRun: false, disableBail: false, activeMutant: '12' } satisfies RunOptions;
    const active = (mutantActivation: 'runtime' | 'static') => {
      const env = runEnv({}, FILE, OUT, TMP, { ...run, mutantActivation }, undefined);

      return { atStart: env[ACTIVE_MUTANT], onceTestsStart: env[ENV.activeMutant] };
    };

    assert.deepEqual(active('static'), { atStart: '12', onceTestsStart: undefined });
    assert.deepEqual(active('runtime'), { atStart: undefined, onceTestsStart: '12' });
  });

  it('asks the test file to bail only in a mutant run with bail enabled', () => {
    const bails = (
      [
        { dryRun: false, disableBail: false },
        { dryRun: false, disableBail: true },
        { dryRun: true, disableBail: false, coverageAnalysis: 'perTest' },
        { dryRun: true, disableBail: true, coverageAnalysis: 'perTest' },
      ] satisfies RunOptions[]
    ).map((run) => runEnv({}, FILE, OUT, TMP, run, undefined)[ENV.bail]);

    assert.deepEqual(bails, ['true', undefined, undefined, undefined]);
  });
});

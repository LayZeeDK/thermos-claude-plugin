import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { TestStatus } from '@stryker-mutator/api/test-runner';

import { testEach } from '../test-each/test-each.ts';
import { testFor } from '../test-each/test-for.ts';
import { ACTIVE_MUTANT_ENV, ENV } from './hook-core.ts';
import { ACTIVE_MUTANT, HOOK_URL, logger, NO_PROCESS } from './index.fixtures.ts';
import {
  endGroup,
  fileError,
  filesFor,
  groupOptions,
  isOwn,
  isRunning,
  memoryLimitFor,
  mergeCoverage,
  ownDir,
  parseRecord,
  peakMemoryDir,
  processEnd,
  removeDir,
  removeLeftDirs,
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

describe('groupOptions', () => {
  testEach([
    ['linux', { detached: true, windowsHide: true }],
    ['darwin', { detached: true, windowsHide: true }],
    ['win32', { detached: false, windowsHide: true }],
  ] as const)('spawns a test file on %s with %j', (platform, options) => {
    assert.deepEqual(groupOptions(platform), options);
  });
});

describe('endGroup', () => {
  /** endGroup with a kill that records its calls and throws `error` when given one. */
  function setup(platform: NodeJS.Platform, error?: NodeJS.ErrnoException) {
    const calls: unknown[][] = [];
    const end = () =>
      endGroup(123, platform, (pid, signal) => {
        calls.push([pid, signal]);

        if (error) {
          throw error;
        }
      });

    return { calls, end };
  }

  it("kills a POSIX test file's whole process group", () => {
    const { calls, end } = setup('linux');

    end();

    assert.deepEqual(calls, [[-123, 'SIGKILL']]);
  });

  it('leaves Windows, where the processes end with the test file, alone', () => {
    const { calls, end } = setup('win32');

    end();

    assert.deepEqual(calls, []);
  });

  it('takes a group that no longer exists as ended, and throws any other error', () => {
    const gone = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });

    setup('linux', gone).end();
    assert.throws(() => setup('linux', denied).end(), denied);
  });
});

describe('processEnd', () => {
  /** A stand-in for a child process, and how its end promise stands after pending callbacks ran. */
  function ending(graceMs: number) {
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough() });
    const end = processEnd(child, graceMs);
    let state: unknown = 'pending';
    end.then(
      (value) => (state = value),
      (error: unknown) => (state = error),
    );
    const settled = async () => {
      await new Promise(setImmediate);

      return state;
    };

    return { child, settled };
  }

  it('ends when the process closes its stdio, with its exit code and stderr, without waiting', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { child, settled } = ending(1_000);
    child.stderr.write('first ');
    child.stderr.write('second');
    await settled();
    child.emit('exit', 3);
    child.emit('close', 3);

    assert.deepEqual(await settled(), { exitCode: 3, stderr: 'first second' });
  });

  it('stops waiting out the grace period once stderr closes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { child, settled } = ending(1_000);
    child.emit('exit', 0);
    child.emit('close', 0);
    await settled();
    t.mock.timers.tick(1_000);

    assert.equal(child.stderr.destroyed, false);
  });

  it('ends `graceMs` after the process exits when stderr stays open, and lets go of stderr', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { child, settled } = ending(1_000);
    child.stderr.write('before exit');
    await settled();
    child.emit('exit', 1);
    t.mock.timers.tick(999);

    assert.equal(await settled(), 'pending');

    t.mock.timers.tick(1);

    assert.deepEqual(await settled(), { exitCode: 1, stderr: 'before exit' });
    assert.equal(child.stderr.destroyed, true);
  });

  it('fails when the process cannot start', async () => {
    const { child, settled } = ending(1_000);
    const failure = new Error('spawn ENOENT');
    child.emit('error', failure);

    assert.equal(await settled(), failure);
  });
});

describe('removeDir', () => {
  const DIR = join('/tmp', 'run');

  /** Starts removing DIR with `remove`, waiting 1,000 ms, and collects the warnings. */
  function removal(remove: () => Promise<void>) {
    const warnings: string[] = [];
    const removed: string[] = [];
    let state = 'pending';
    void removeDir(DIR, logger([], false, warnings), {
      waitMs: 1_000,
      remove: (path) => {
        removed.push(path);

        return remove();
      },
    }).then(() => (state = 'done'));
    const settled = async () => {
      await new Promise(setImmediate);

      return state;
    };

    return { warnings, removed, settled };
  }

  it('removes the directory without a warning, and stops waiting', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { warnings, removed, settled } = removal(async () => {});

    assert.equal(await settled(), 'done');

    t.mock.timers.tick(1_000);

    assert.deepEqual([removed, warnings], [[DIR], []]);
  });

  it('leaves a directory it cannot remove, with a warning, and stops waiting', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { warnings, settled } = removal(() => Promise.reject(new Error('EPERM: operation not permitted')));

    assert.equal(await settled(), 'done');

    t.mock.timers.tick(1_000);

    assert.deepEqual(warnings, [`Left ${DIR} for a later runner to remove: EPERM: operation not permitted`]);
  });

  it('stops waiting for a directory still in use after `waitMs`, with a warning', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { warnings, settled } = removal(() => new Promise(() => {}));
    t.mock.timers.tick(999);

    assert.deepEqual([await settled(), warnings], ['pending', []]);

    t.mock.timers.tick(1);

    assert.deepEqual(
      [await settled(), warnings],
      ['done', [`Stopped waiting for ${DIR} to be removed after 1000 ms; a later runner removes what is left.`]],
    );
  });

  it('warns once when the removal fails after it stopped waiting', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let fail = (_error: Error) => {};
    const { warnings, settled } = removal(() => new Promise((_, reject) => (fail = reject)));
    t.mock.timers.tick(1_000);
    fail(new Error('EBUSY: resource busy or locked'));
    await settled();

    assert.deepEqual(warnings, [
      `Stopped waiting for ${DIR} to be removed after 1000 ms; a later runner removes what is left.`,
    ]);
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

describe('isRunning', () => {
  it('tells running processes, also ones it may not signal, from ones that do not run', () => {
    // The system process on Windows and init on POSIX run, and only an administrator may signal them.
    const system = process.platform === 'win32' ? 4 : 1;

    assert.deepEqual([process.pid, system, NO_PROCESS].map(isRunning), [true, true, false]);
  });
});

describe('ownDir', () => {
  it("creates the directory, and keeps one that is this user's", (t) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'own-dir-')), 'peaks');
    t.after(() => rmSync(dirname(dir), { recursive: true, force: true }));

    ownDir(dir, () => true);
    ownDir(dir, () => true);

    assert.ok(lstatSync(dir).isDirectory());
  });

  it("refuses a directory that is another user's, and names it", (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'own-dir-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const asked: string[] = [];

    assert.throws(
      () =>
        ownDir(dir, (path) => {
          asked.push(path);

          return false;
        }),
      { message: `"${dir}" belongs to another user; remove it, or run Stryker as that user.` },
    );
    assert.deepEqual(asked, [dir]);
  });
});

describe('removeLeftDirs', () => {
  it('removes the run, cache and dry-run peak directories whose processes ended, and leaves everything else', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'left-dirs-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const names = [
      'stryker-node-test-111-a',
      'stryker-node-test-cache-111-b',
      basename(peakMemoryDir(111)),
      'stryker-node-test-222-c',
      'stryker-node-test-cache-222-d',
      basename(peakMemoryDir(222)),
      'stryker-node-test-e',
      'other-111-f',
      'other-stryker-node-test-111-g',
    ];

    for (const name of names) {
      mkdirSync(join(dir, name));
    }

    const asked: number[] = [];
    removeLeftDirs(dir, {
      running: (pid) => {
        asked.push(pid);

        return pid === 222;
      },
    });

    assert.deepEqual(readdirSync(dir).sort(), names.slice(3).sort());
    assert.deepEqual(asked.sort(), [111, 111, 111, 222, 222, 222]);
  });

  it("leaves the directories of other users' runners", (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'left-dirs-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const names = ['stryker-node-test-111-mine', 'stryker-node-test-111-theirs', 'stryker-node-test-222-running'];

    for (const name of names) {
      mkdirSync(join(dir, name));
    }

    const asked: string[] = [];
    removeLeftDirs(dir, {
      running: (pid) => pid === 222,
      owned: (path) => {
        asked.push(path);

        return path.endsWith('mine');
      },
    });

    assert.deepEqual(readdirSync(dir).sort(), names.slice(1));
    assert.deepEqual(asked.sort(), [join(dir, names[0] as string), join(dir, names[1] as string)]);
  });

  it('leaves a directory it cannot check or remove yet and goes on with the others', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'left-dirs-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const names = ['stryker-node-test-111-a', 'stryker-node-test-111-b', 'stryker-node-test-111-c'];

    for (const name of names) {
      mkdirSync(join(dir, name));
    }

    const removed: string[] = [];

    removeLeftDirs(dir, {
      running: () => false,
      owned: (path) => {
        if (path.endsWith('a')) {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }

        return true;
      },
      remove: (path) => {
        removed.push(basename(path));
        throw Object.assign(new Error('in use'), { code: 'EBUSY' });
      },
    });

    assert.deepEqual(removed.sort(), names.slice(1));
  });
});

describe('isOwn', () => {
  it("compares the user id of the file itself with this process's", () => {
    const stated: string[] = [];
    const stat = (path: string) => {
      stated.push(path);

      return { uid: 7 };
    };

    assert.deepEqual([isOwn('a', { getuid: () => 7 }, stat), isOwn('b', { getuid: () => 8 }, stat)], [true, false]);
    assert.deepEqual(stated, ['a', 'b']);
  });

  it('counts every file as owned where there are no user ids, as on Windows', () => {
    assert.equal(isOwn('a', {}, () => assert.fail('looked up the owner')), true);
  });

  it('counts a directory this process created as owned', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'own-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    assert.equal(isOwn(dir), true);
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

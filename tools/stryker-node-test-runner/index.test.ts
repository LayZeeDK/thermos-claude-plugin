import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, describe, it, type TestContext } from 'node:test';
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
  type TestResult,
} from '@stryker-mutator/api/test-runner';

import { ACTIVE_MUTANT_ENV, ENV } from './hook-core.ts';
import { filesFor, mergeCoverage, NodeTestRunner, removeDir, runEnv, toTestResults } from './index.ts';

const ACTIVE_MUTANT = INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE;
const HOOK_URL = pathToFileURL(join(import.meta.dirname, 'hook.ts')).href;
const REPORTER_ARG = `--test-reporter=${pathToFileURL(join(import.meta.dirname, 'reporter.ts')).href}`;
const FILE = join('/repo', 'a.test.mjs');

describe('mergeCoverage', () => {
  it('adds up the hits of every process and skips processes without coverage', () => {
    assert.deepEqual(
      mergeCoverage([
        { static: { 1: 1 }, perTest: { first: { 2: 1 } } },
        undefined,
        { static: { 1: 2, 3: 1 }, perTest: { first: { 2: 3 }, second: { 4: 1 } } },
      ]),
      { static: { 1: 3, 3: 1 }, perTest: { first: { 2: 4 }, second: { 4: 1 } } },
    );
  });

  it('is empty without coverage', () => {
    assert.deepEqual(mergeCoverage([]), { static: {}, perTest: {} });
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
  const base = (id: string) => ({ id, name: id, fileName: FILE });

  it('reports each recorded test with its status, rounded time, and failure message', () => {
    assert.deepEqual(
      toTestResults(
        FILE,
        [
          { id: `${FILE} > passes`, status: 'passed', timeSpentMs: 1.6 },
          { id: `${FILE} > fails`, status: 'failed', failureMessage: 'boom', timeSpentMs: 2.4 },
          { id: `${FILE} > fails silently`, status: 'failed', timeSpentMs: 0 },
          { id: `${FILE} > skipped`, status: 'skipped', timeSpentMs: 0.4 },
        ],
        1,
        'stderr of a failing run',
      ),
      [
        { ...base(`${FILE} > passes`), timeSpentMs: 2, status: TestStatus.Success },
        { ...base(`${FILE} > fails`), timeSpentMs: 2, status: TestStatus.Failed, failureMessage: 'boom' },
        {
          ...base(`${FILE} > fails silently`),
          timeSpentMs: 0,
          status: TestStatus.Failed,
          failureMessage: 'Test failed',
        },
        { ...base(`${FILE} > skipped`), timeSpentMs: 0, status: TestStatus.Skipped },
      ],
    );
  });

  it('reports where a test is declared when the hook recorded it', () => {
    const startPosition = { line: 4, column: 2 };

    assert.deepEqual(
      toTestResults(FILE, [{ id: `${FILE} > passes`, status: 'passed', timeSpentMs: 1, startPosition }], 0, ''),
      [{ ...base(`${FILE} > passes`), timeSpentMs: 1, status: TestStatus.Success, startPosition }],
    );
  });

  it('reports a failed exit with only skipped tests as a failure of the file', () => {
    assert.deepEqual(toTestResults(FILE, [{ id: `${FILE} > skipped`, status: 'skipped', timeSpentMs: 0 }], 1, ''), [
      { ...base(`${FILE} > skipped`), timeSpentMs: 0, status: TestStatus.Skipped },
      { ...base(FILE), timeSpentMs: 0, status: TestStatus.Failed, failureMessage: 'node exited with code 1' },
    ]);
  });

  it('adds nothing for a clean exit', () => {
    assert.deepEqual(toTestResults(FILE, [], 0, 'a warning'), []);
  });

  for (const [description, exitCode, stderr, failureMessage] of [
    [
      'the last five lines of stderr',
      1,
      '  \nline 1\nline 2\nline 3\nline 4\nline 5\nline 6\n  ',
      'line 2\nline 3\nline 4\nline 5\nline 6',
    ],
    ['trimmed stderr', 1, '  only line \n', 'only line'],
    ['the exit code without stderr', 3, ' \n', 'node exited with code 3'],
    ['the missing exit code of a killed process', null, '', 'node exited with code null'],
  ] as const) {
    it(`reports a failed exit without a recorded failure as a failure of the file, with ${description}`, () => {
      assert.deepEqual(
        toTestResults(FILE, [{ id: `${FILE} > passes`, status: 'passed', timeSpentMs: 1 }], exitCode, stderr),
        [
          { ...base(`${FILE} > passes`), timeSpentMs: 1, status: TestStatus.Success },
          { ...base(FILE), timeSpentMs: 0, status: TestStatus.Failed, failureMessage },
        ],
      );
    });
  }
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

  it('returns the files that contain a filtered test, or that are a filtered failure themselves', () => {
    assert.deepEqual(filesFor(files, [`${longer} > suite > test`]), [longer]);
    assert.deepEqual(filesFor(files, [`${a} > test`]), [a]);
    assert.deepEqual(filesFor(files, [b, `${a} > test`]), [a, b]);
  });
});

describe('removeDir', () => {
  /** A removal that fails with `code` for the first `failures` calls. */
  function failing(code: string, failures = Infinity) {
    const removal = {
      calls: 0,
      remove: () => {
        removal.calls++;

        if (removal.calls <= failures) {
          throw Object.assign(new Error(`${code} ${removal.calls}`), { code });
        }
      },
    };

    return removal;
  }

  for (const code of ['EPERM', 'EBUSY']) {
    it(`tries again while the directory is in use (${code})`, async () => {
      const removal = failing(code, 2);

      await settle(removeDir('dir', removal.remove));

      assert.equal(removal.calls, 3);
    });
  }

  it('throws any other error at once', async () => {
    const removal = failing('EISDIR');

    await assert.rejects(settle(removeDir('dir', removal.remove)), { message: 'EISDIR 1' });

    assert.equal(removal.calls, 1);
  });

  it('throws the last error once the directory has been in use for about a second', async () => {
    const removal = failing('EPERM');
    const start = Date.now();

    await assert.rejects(settle(removeDir('dir', removal.remove)), { message: 'EPERM 20' });

    assert.equal(removal.calls, 20);
    assert.ok(Date.now() - start >= 900, `gave up after ${Date.now() - start} ms`);
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
      [ENV.filter]: '["outer"]',
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

  it("uses the runner's compile cache directory unless the environment names one", () => {
    const run = { dryRun: false, disableBail: false };

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
        { dryRun: true, disableBail: true, activeMutant: '12', hitLimit: 40, testFilter: [`${FILE} > test`] },
        undefined,
      ),
      {
        NODE_OPTIONS: `--import ${JSON.stringify(HOOK_URL)}`,
        [ENV.out]: OUT,
        [ENV.file]: FILE,
        [ENV.dryRun]: 'true',
        TMPDIR: TMP,
        TEMP: TMP,
        TMP,
        [ACTIVE_MUTANT]: '12',
        [ENV.hitLimit]: '40',
        [ENV.filter]: JSON.stringify([`${FILE} > test`]),
      },
    );
  });

  it('activates the mutant from the start of the process, or for the hook to activate once the tests start', () => {
    const run = { dryRun: false, disableBail: false, activeMutant: '12' };
    const active = (mutantActivation: 'runtime' | 'static') => {
      const env = runEnv({}, FILE, OUT, TMP, { ...run, mutantActivation }, undefined);

      return { atStart: env[ACTIVE_MUTANT], onceTestsStart: env[ENV.activeMutant] };
    };

    assert.deepEqual(active('static'), { atStart: '12', onceTestsStart: undefined });
    assert.deepEqual(active('runtime'), { atStart: undefined, onceTestsStart: '12' });
  });

  it('asks the test file to bail only in a mutant run with bail enabled', () => {
    const bails = [
      { dryRun: false, disableBail: false },
      { dryRun: false, disableBail: true },
      { dryRun: true, disableBail: false },
      { dryRun: true, disableBail: true },
    ].map((run) => runEnv({}, FILE, OUT, TMP, run, undefined)[ENV.bail]);

    assert.deepEqual(bails, ['true', undefined, undefined, undefined]);
  });
});

const COVER = [
  'const cover = (id) => {',
  '  const ns = globalThis.__stryker__;',
  '  const coverage = (ns.mutantCoverage ??= { static: {}, perTest: {} });',
  '  const hits = ns.currentTestId ? (coverage.perTest[ns.currentTestId] ??= {}) : coverage.static;',
  '  hits[id] = (hits[id] ?? 0) + 1;',
  '};',
].join(' ');

/** A node:test file whose code can simulate Stryker's instrumented code with `cover(mutantId)`. */
function fixture(...lines: string[]): string {
  return [
    "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    "import { describe, it } from 'node:test';",
    COVER,
    ...lines,
    '',
  ].join('\n');
}

const PASSING = fixture("it('passes', () => {});");
const FAILING = fixture("it('fails', () => { throw new Error('expected failure'); });");

/** Creates the files in a temporary directory and makes it the working directory for the rest of the test. */
function project(t: TestContext, files: Record<string, string>): string {
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
function logger(debug: string[] = [], debugEnabled = true): Logger {
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

async function initRunner(testFiles: string[] | undefined): Promise<NodeTestRunner> {
  const options = testFiles ? { nodeTest: { testFiles } } : {};
  const runner = new NodeTestRunner(options as unknown as StrykerOptions, logger());
  await runner.init();

  return runner;
}

const DRY_RUN: DryRunOptions = { timeout: 10_000, disableBail: false, coverageAnalysis: 'perTest' };

function mutantRunOptions(options: Partial<MutantRunOptions> = {}): MutantRunOptions {
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

function complete(result: DryRunResult): CompleteDryRunResult {
  assert.equal(result.status, DryRunStatus.Complete);

  return result as CompleteDryRunResult;
}

/**
 * The fixture's own coverage. Under Stryker the runner under test is instrumented too, so its numeric mutant ids
 * reach the coverage that the fixture's processes report.
 */
function fixtureCoverage(coverage: MutantCoverage | undefined): MutantCoverage | undefined {
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

// The runners under test and every process they start share this compile cache, so none of them creates its own.
const COMPILE_CACHE = mkdtempSync(join(tmpdir(), 'node-test-runner-cache-'));
process.env.NODE_COMPILE_CACHE = COMPILE_CACHE;

/** The compile cache directories runners of this process created; runners in other processes name theirs by pid. */
function ownCacheDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith(`stryker-node-test-cache-${process.pid}-`))
    .sort();
}

// Removed on exit rather than in an `after` hook, and ahead of the hook's own exit listener, so a process that dies
// early or whose hook fails on exit (both happen under mutation testing) leaves nothing. The runners the tests never
// dispose (a mutant of the runner can give each one a directory) are swept here too.
process.prependListener('exit', () => {
  for (const dir of [COMPILE_CACHE, ...ownCacheDirs().map((name) => join(tmpdir(), name))]) {
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

/**
 * Waits for a run for at most `ms` milliseconds. A run that never ends fails its test and every later run at once, so
 * a hanging runner fails this file quickly instead of hanging it.
 */
async function settle<T>(run: Promise<T>, ms = 5_000): Promise<T> {
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

function summary(tests: TestResult[]) {
  return tests.map((test) => ({
    id: test.id,
    status: test.status,
    failureMessage: test.status === TestStatus.Failed ? test.failureMessage : undefined,
  }));
}

describe('NodeTestRunner', () => {
  it('can reload the environment', () => {
    assert.deepEqual(new NodeTestRunner({} as StrykerOptions, logger()).capabilities(), { reloadEnvironment: true });
  });

  it('runs nothing before it is initialized', async () => {
    const runner = new NodeTestRunner({} as StrykerOptions, logger());

    assert.deepEqual(await settle(runner.dryRun(DRY_RUN)), {
      status: DryRunStatus.Complete,
      tests: [],
      mutantCoverage: { static: {}, perTest: {} },
    });
  });

  it('can be disposed without being initialized', async () => {
    await new NodeTestRunner({} as StrykerOptions, logger()).dispose();
  });

  it('fails to initialize without test files', async (t) => {
    project(t, { 'a.test.mjs': PASSING });
    const options = { nodeTest: { testFiles: ['none/*.test.mjs'] } };
    const runner = new NodeTestRunner(options as unknown as StrykerOptions, logger());

    await assert.rejects(runner.init(), { message: 'No test files match ["none/*.test.mjs"]' });
    await runner.dispose();
  });

  it('keeps multi-byte characters intact in stderr that spans several reads', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture("process.stderr.write('\\u20ac'.repeat(100_000));", 'process.exitCode = 5;'),
    });
    const runner = await initRunner(['a.test.mjs']);

    const { stderr } = await settle(
      runner.runFile(join(dir, 'a.test.mjs'), { dryRun: false, disableBail: false }),
      2_000,
    );

    assert.equal(stderr, String.fromCodePoint(0x20ac).repeat(100_000));
  });

  it('ends a run whose test file writes more to stdout than a pipe holds', async (t) => {
    const dir = project(t, { 'a.test.mjs': fixture("process.stdout.write('x'.repeat(1_000_000));") });
    const runner = await initRunner(['a.test.mjs']);

    const { exitCode } = await settle(
      runner.runFile(join(dir, 'a.test.mjs'), { dryRun: false, disableBail: false }),
      2_000,
    );

    assert.equal(exitCode, 0);
  });

  it('reports callback-style tests once node:test calls them back', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "it('calls back', (t, done) => { setImmediate(done); });",
        "it('calls back with an error', (t, done) => { setImmediate(() => done(new Error('late failure'))); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);

    const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(summary(tests), [
      { id: `${join(dir, 'a.test.mjs')} > calls back`, status: TestStatus.Success, failureMessage: undefined },
      {
        id: `${join(dir, 'a.test.mjs')} > calls back with an error`,
        status: TestStatus.Failed,
        failureMessage: 'late failure',
      },
    ]);
  });

  it('runs the TypeScript test files outside node_modules by default', async (t) => {
    const dir = project(t, {
      'a.test.ts': PASSING,
      [join('sub', 'b.test.ts')]: PASSING,
      [join('node_modules', 'pkg', 'c.test.ts')]: FAILING,
      'd.test.mjs': FAILING,
    });

    for (const options of [{}, { nodeTest: {} }]) {
      const runner = new NodeTestRunner(options as StrykerOptions, logger());
      await runner.init();
      t.after(() => runner.dispose());

      const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

      assert.deepEqual(summary(tests), [
        { id: `${join(dir, 'a.test.ts')} > passes`, status: TestStatus.Success, failureMessage: undefined },
        { id: `${join(dir, 'sub', 'b.test.ts')} > passes`, status: TestStatus.Success, failureMessage: undefined },
      ]);
    }
  });

  it('passes nodeTest.nodeArgs to the node process of each test file', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('exec-argv.json', JSON.stringify(process.execArgv));",
        "it('passes', () => {});",
      ),
    });
    const execArgv = async (options: object) => {
      const runner = new NodeTestRunner(options as StrykerOptions, logger());
      await runner.init();
      await settle(runner.runFile(join(dir, 'a.test.mjs'), { dryRun: false, disableBail: false }));

      return JSON.parse(readFileSync(join(dir, 'exec-argv.json'), 'utf8')) as string[];
    };
    const nodeArgs = ['--no-deprecation', '--stack-size=900'];

    assert.deepEqual(await execArgv({ nodeTest: { testFiles: ['a.test.mjs'], nodeArgs } }), [
      REPORTER_ARG,
      ...nodeArgs,
    ]);
    assert.deepEqual(await execArgv({ nodeTest: { testFiles: ['a.test.mjs'] } }), [REPORTER_ARG]);
  });

  it('runs a test file once when several patterns match it', async (t) => {
    const dir = project(t, { 'a.test.mjs': PASSING });
    const runner = await initRunner(['a.test.mjs', '*.test.mjs', './a.test.mjs', join(dir, 'a.test.mjs')]);

    const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(summary(tests), [
      { id: `${join(dir, 'a.test.mjs')} > passes`, status: TestStatus.Success, failureMessage: undefined },
    ]);
  });

  it('reports the results and coverage of every test, including coverage of the processes a test starts', async (t) => {
    const child = `${COVER} cover('f-shared'); cover('f-child');`;
    const dir = project(t, {
      'a.test.mjs': fixture(
        "cover('f-static');",
        "describe('suite', () => {",
        "  it('passes', () => { cover('f-pass'); });",
        "  it('fails', () => { cover('f-fail'); throw new Error('one is not two'); });",
        '});',
        "it('spawns', () => {",
        "  cover('f-shared');",
        `  const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(child)}]);`,
        '  assert.equal(child.status, 0, String(child.stderr));',
        '});',
      ),
    });
    const file = join(dir, 'a.test.mjs');
    const runner = await initRunner(['*.test.mjs']);

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(summary(tests), [
      { id: `${file} > suite > passes`, status: TestStatus.Success, failureMessage: undefined },
      { id: `${file} > suite > fails`, status: TestStatus.Failed, failureMessage: 'one is not two' },
      { id: `${file} > spawns`, status: TestStatus.Success, failureMessage: undefined },
    ]);
    assert.ok(tests.every((test) => test.fileName === file && test.name === test.id && test.timeSpentMs >= 0));
    assert.equal(mutantCoverage?.static['f-static'], 1);
    assert.equal(mutantCoverage?.perTest[`${file} > suite > passes`]?.['f-pass'], 1);
    assert.equal(mutantCoverage?.perTest[`${file} > suite > fails`]?.['f-fail'], 1);
    assert.equal(mutantCoverage?.perTest[`${file} > spawns`]?.['f-shared'], 2);
    assert.equal(mutantCoverage?.perTest[`${file} > spawns`]?.['f-child'], 1);
  });

  it('logs the node command and directory of each test file, only when debug logging is on', async (t) => {
    const dir = project(t, { 'a.test.mjs': PASSING });
    const file = join(dir, 'a.test.mjs');
    const options = { nodeTest: { testFiles: ['a.test.mjs'], nodeArgs: ['--no-deprecation'] } };
    const debugOf = async (debugEnabled: boolean) => {
      const debug: string[] = [];
      const runner = new NodeTestRunner(options as unknown as StrykerOptions, logger(debug, debugEnabled));
      await runner.init();
      await settle(runner.runFile(file, { dryRun: false, disableBail: false }));

      return debug;
    };

    assert.deepEqual(await debugOf(true), [
      `Running: \`node "${REPORTER_ARG}" "--no-deprecation" "${file}"\` in ${dir}`,
    ]);
    assert.deepEqual(await debugOf(false), []);
  });

  it('reports coverage as the coverage analysis asks: per test, all as static, or none', async (t) => {
    const dir = project(t, { 'a.test.mjs': fixture("cover('s');", "it('covers', () => { cover('t'); });") });
    const runner = await initRunner(['a.test.mjs']);
    const coverage = async (coverageAnalysis: DryRunOptions['coverageAnalysis']) =>
      fixtureCoverage(complete(await settle(runner.dryRun({ ...DRY_RUN, coverageAnalysis }))).mutantCoverage);

    assert.deepEqual(await coverage('perTest'), {
      static: { s: 1 },
      perTest: { [`${join(dir, 'a.test.mjs')} > covers`]: { t: 1 } },
    });
    assert.deepEqual(await coverage('all'), { static: { s: 1, t: 1 }, perTest: {} });
    assert.equal(await coverage('off'), undefined);
  });

  for (const [description, source, failureMessage] of [
    ['its stderr',fixture("process.stderr.write('first\\nsecond\\n');", 'process.exitCode = 3;'), 'first\nsecond'],
    ['its exit code', fixture('process.exitCode = 4;'), 'node exited with code 4'],
  ] as const) {
    it(`reports a test file that exits with an error outside any test as failed, with ${description}`, async (t) => {
      const dir = project(t, { 'a.test.mjs': source });
      const runner = await initRunner(['a.test.mjs']);

      const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

      assert.deepEqual(summary(tests), [{ id: join(dir, 'a.test.mjs'), status: TestStatus.Failed, failureMessage }]);
    });
  }

  it('reports skipped and todo tests as skipped, so a failing todo test kills no mutant', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "it('passes', () => {});",
        "it('is not done', { todo: true }, () => { throw new Error('todo failure'); });",
        "it.skip('is skipped', () => { throw new Error('ran a skipped test'); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    assert.deepEqual(summary(complete(await settle(runner.dryRun(DRY_RUN))).tests), [
      { id: `${a} > passes`, status: TestStatus.Success, failureMessage: undefined },
      { id: `${a} > is not done`, status: TestStatus.Skipped, failureMessage: undefined },
      { id: `${a} > is skipped`, status: TestStatus.Skipped, failureMessage: undefined },
    ]);
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions())), {
      status: MutantRunStatus.Survived,
      nrOfTests: 1,
    });
  });

  it('reports a failing hook against the tests it fails, and a test that times out as failed', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { afterEach } from 'node:test';",
        "describe('each', () => {",
        "  afterEach(() => { throw new Error('afterEach failure'); });",
        "  it('passes, then its hook fails', () => {});",
        '});',
      ),
      'b.test.mjs': fixture(
        "import { after, before } from 'node:test';",
        "describe('once', () => {",
        "  before(() => { throw new Error('before failure'); });",
        "  it('never runs', () => {});",
        '});',
        "describe('last', () => {",
        "  after(() => { throw new Error('after failure'); });",
        "  it('passes', () => {});",
        '});',
        "it('times out', { timeout: 10 }, () => new Promise((resolve) => setTimeout(resolve, 200)));",
      ),
    });
    const runner = await initRunner(['*.test.mjs']);
    const a = join(dir, 'a.test.mjs');
    const b = join(dir, 'b.test.mjs');
    const failsInHook = `${a} > each > passes, then its hook fails`;

    assert.deepEqual(summary(complete(await settle(runner.dryRun({ ...DRY_RUN, disableBail: true }))).tests), [
      { id: failsInHook, status: TestStatus.Failed, failureMessage: 'afterEach failure' },
      {
        id: `${b} > once > never runs`,
        status: TestStatus.Failed,
        failureMessage: 'test did not finish before its parent and was cancelled',
      },
      { id: `${b} > once`, status: TestStatus.Failed, failureMessage: 'before failure' },
      { id: `${b} > last > passes`, status: TestStatus.Success, failureMessage: undefined },
      { id: `${b} > last`, status: TestStatus.Failed, failureMessage: 'after failure' },
      { id: `${b} > times out`, status: TestStatus.Failed, failureMessage: 'test timed out after 10ms' },
    ]);
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ testFilter: [failsInHook] }))), {
      status: MutantRunStatus.Killed,
      killedBy: [failsInHook],
      failureMessage: 'afterEach failure',
      nrOfTests: 1,
    });
  });

  it('reports subtests and expectFailure tests with ids and coverage of their own, and filters subtests', async (t) => {
    // Node.js 22 has no expectFailure.
    const expectFailure = typeof (it as { expectFailure?: unknown }).expectFailure === 'function';
    const dir = project(t, {
      'a.test.mjs': fixture(
        "it('parent', async (t) => {",
        "  cover('parent');",
        "  await t.test('child', () => { cover('child'); });",
        "  await t.test('failing child', () => { throw new Error('child failure'); });",
        "  cover('parent again');",
        '});',
        "it.expectFailure?.('expects a failure', () => { cover('expected'); throw new Error('expected'); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(summary(tests), [
      { id: `${a} > parent > child`, status: TestStatus.Success, failureMessage: undefined },
      { id: `${a} > parent > failing child`, status: TestStatus.Failed, failureMessage: 'child failure' },
      { id: `${a} > parent`, status: TestStatus.Failed, failureMessage: '1 subtest failed' },
      ...(expectFailure
        ? [{ id: `${a} > expects a failure`, status: TestStatus.Success, failureMessage: undefined }]
        : []),
    ]);
    assert.deepEqual(fixtureCoverage(mutantCoverage)?.perTest, {
      [`${a} > parent`]: { parent: 1, 'parent again': 1 },
      [`${a} > parent > child`]: { child: 1 },
      ...(expectFailure && { [`${a} > expects a failure`]: { expected: 1 } }),
    });
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ testFilter: [`${a} > parent > child`] }))), {
      status: MutantRunStatus.Survived,
      nrOfTests: 2,
    });
  });

  it('runs the tests of a suite or test asking for concurrency one at a time, for coverage of their own', async (t) => {
    const interleaved = (name: string) =>
      `async () => { cover('${name} 1'); await new Promise((resolve) => setImmediate(resolve)); cover('${name} 2'); }`;
    const dir = project(t, {
      'a.test.mjs': fixture(
        "describe('suite', { concurrency: true }, () => {",
        `  it('first', ${interleaved('first')});`,
        `  it('second', ${interleaved('second')});`,
        '});',
        "it('parent', { concurrency: 2 }, async (t) => {",
        `  const child = t.test('child', ${interleaved('child')});`,
        `  await Promise.all([child, t.test('sibling', ${interleaved('sibling')})]);`,
        '});',
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const { mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(fixtureCoverage(mutantCoverage), {
      static: {},
      perTest: Object.fromEntries(
        ['suite > first', 'suite > second', 'parent > child', 'parent > sibling'].map((name) => [
          `${a} > ${name}`,
          { [`${name.split(' > ')[1]} 1`]: 1, [`${name.split(' > ')[1]} 2`]: 1 },
        ]),
      ),
    });
  });

  it('reports where the test file declares each test, also through a helper', async (t) => {
    const dir = project(t, {
      'helper.mjs': "import { it } from 'node:test';\nexport const declare = () => it('from a helper', () => {});\n",
      'a.test.mjs': fixture(
        "import { declare } from './helper.mjs';",
        "it('first', () => {});",
        "describe('suite', () => {",
        "  it('nested', () => {});",
        '});',
        'declare();',
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

    // fixture() starts every file with four lines.
    assert.deepEqual(
      tests.map(({ id, startPosition }) => ({ id, startPosition })),
      [
        { id: `${a} > first`, startPosition: { line: 5, column: 0 } },
        { id: `${a} > suite > nested`, startPosition: { line: 7, column: 2 } },
        { id: `${a} > from a helper`, startPosition: { line: 9, column: 0 } },
      ],
    );
  });

  it('names the tests inside only and todo suites after their suites', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture("describe.only('only suite', () => { it.only('runs', () => { cover('only'); }); });"),
      'b.test.mjs': fixture(
        "describe.todo('todo suite', () => {",
        "  it('fails', () => { throw new Error('not done'); });",
        '});',
      ),
    });
    const runner = await initRunner(['*.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(summary(tests), [
      { id: `${a} > only suite > runs`, status: TestStatus.Success, failureMessage: undefined },
      { id: `${join(dir, 'b.test.mjs')} > todo suite > fails`, status: TestStatus.Skipped, failureMessage: undefined },
    ]);
    assert.deepEqual(fixtureCoverage(mutantCoverage)?.perTest, { [`${a} > only suite > runs`]: { only: 1 } });
  });

  it('reports no tests for a test file that declares none', async (t) => {
    project(t, { 'a.test.mjs': fixture("cover('s');") });
    const runner = await initRunner(['a.test.mjs']);

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(tests, []);
    assert.deepEqual(fixtureCoverage(mutantCoverage), { static: { s: 1 }, perTest: {} });
  });

  it('loses the tests that a file exiting with code 0 ran before node:test reported them', async (t) => {
    project(t, {
      'a.test.mjs': fixture(
        "it('passes', () => {});",
        "it('exits', () => { process.exit(0); });",
        "it('never runs', () => {});",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);

    const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(tests, []);
  });

  it('reports a test file whose process is killed as failed, losing the tests it ran', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "it('passes', () => {});",
        "it('is killed', () => { process.kill(process.pid, 'SIGKILL'); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);

    const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

    // A signal leaves no exit code on POSIX; Windows terminates the process with exit code 1.
    const exitCode = process.platform === 'win32' ? 1 : null;
    assert.deepEqual(summary(tests), [
      { id: join(dir, 'a.test.mjs'), status: TestStatus.Failed, failureMessage: `node exited with code ${exitCode}` },
    ]);
  });

  it('stops after the first file with a failure, and a mutant run after any failure, unless bail is off', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        // node:test reports the first tests of a file once its reporters have started, and bailing acts on reported
        // failures; waiting a turn lets the reporters start before the first failure.
        "it('passes', async () => { await new Promise((resolve) => setImmediate(resolve)); });",
        "it('fails', () => { throw new Error('expected failure'); });",
        "it('fails later', () => { throw new Error('later failure'); });",
        "it('calls back later', (t, done) => { done(new Error('callback failure')); });",
      ),
      'b.test.mjs': PASSING,
    });
    const runner = await initRunner(['b.test.mjs', 'a.test.mjs']);
    const a = join(dir, 'a.test.mjs');
    const passedA = { id: `${a} > passes`, status: TestStatus.Success, failureMessage: undefined };
    const failedA = { id: `${a} > fails`, status: TestStatus.Failed, failureMessage: 'expected failure' };
    const laterA = [
      { id: `${a} > fails later`, status: TestStatus.Failed, failureMessage: 'later failure' },
      { id: `${a} > calls back later`, status: TestStatus.Failed, failureMessage: 'callback failure' },
    ];
    const passedB = {
      id: `${join(dir, 'b.test.mjs')} > passes`,
      status: TestStatus.Success,
      failureMessage: undefined,
    };

    assert.deepEqual(summary(complete(await settle(runner.dryRun(DRY_RUN))).tests), [passedA, failedA, ...laterA]);
    assert.deepEqual(summary(complete(await settle(runner.dryRun({ ...DRY_RUN, disableBail: true }))).tests), [
      passedA,
      failedA,
      ...laterA,
      passedB,
    ]);
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions())), {
      status: MutantRunStatus.Killed,
      killedBy: [failedA.id],
      failureMessage: 'expected failure',
      nrOfTests: 2,
    });
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ disableBail: true }))), {
      status: MutantRunStatus.Killed,
      killedBy: [failedA.id, ...laterA.map((test) => test.id)],
      failureMessage: 'expected failure',
      nrOfTests: 5,
    });
  });

  it('runs only the filtered tests of the files that contain them, as a mutant run', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "it('sees the mutant', () => {",
        `  assert.equal(process.env.${ACTIVE_MUTANT}, 'fixture-mutant');`,
        `  assert.equal(process.env.${ENV.dryRun}, 'false');`,
        '});',
        "it('is filtered out', () => { throw new Error('ran a filtered test'); });",
      ),
      'b.test.mjs': FAILING,
    });
    const runner = await initRunner(['*.test.mjs']);
    const testFilter = [`${join(dir, 'a.test.mjs')} > sees the mutant`];

    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ testFilter }))), {
      status: MutantRunStatus.Survived,
      nrOfTests: 1,
    });
  });

  it("runs every test of a file that a mutant run's filter names, as Stryker does with --testFiles", async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture("it('passes', () => {});", "it('fails', () => { throw new Error('expected failure'); });"),
      'b.test.mjs': FAILING,
    });
    const runner = await initRunner(['*.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ testFilter: [a] }))), {
      status: MutantRunStatus.Killed,
      killedBy: [`${a} > fails`],
      failureMessage: 'expected failure',
      nrOfTests: 2,
    });
  });

  it("runs only the files of Stryker's --testFiles in the dry run, also outside nodeTest.testFiles", async (t) => {
    const dir = project(t, { 'a.test.mjs': PASSING, 'b.test.mjs': FAILING, 'c.spec.mjs': FAILING });
    const options = { nodeTest: { testFiles: ['*.test.mjs'] }, testFiles: ['c.spec.mjs'] };
    const runner = new NodeTestRunner(options as unknown as StrykerOptions, logger());
    await runner.init();
    const b = join(dir, 'b.test.mjs');
    const c = join(dir, 'c.spec.mjs');

    assert.deepEqual(summary(complete(await settle(runner.dryRun({ ...DRY_RUN, testFiles: ['b.test.mjs'] }))).tests), [
      { id: `${b} > fails`, status: TestStatus.Failed, failureMessage: 'expected failure' },
    ]);
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ testFilter: [`${c} > fails`] }))), {
      status: MutantRunStatus.Killed,
      killedBy: [`${c} > fails`],
      failureMessage: 'expected failure',
      nrOfTests: 1,
    });
  });

  it('kills a statically activated mutant that only module-level code reaches', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        `if (process.env.${ACTIVE_MUTANT} === 'fixture-mutant') throw new Error('module-level mutant');`,
        "it('passes', () => {});",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    assert.deepEqual(summary(complete(await settle(runner.dryRun(DRY_RUN))).tests), [
      { id: `${a} > passes`, status: TestStatus.Success, failureMessage: undefined },
    ]);
    const result = await settle(runner.mutantRun(mutantRunOptions({ mutantActivation: 'static' })));
    assert.deepEqual(result.status === MutantRunStatus.Killed && result.killedBy, [a]);
  });

  it('activates a mutant once the tests start when activation is runtime, also in processes they start', async (t) => {
    const child = `process.exitCode = process.env.${ACTIVE_MUTANT} === 'fixture-mutant' ? 0 : 1;`;
    const dir = project(t, {
      'a.test.mjs': fixture(
        `if (process.env.${ACTIVE_MUTANT} || globalThis.__stryker__.activeMutant) {`,
        "  throw new Error('module-level mutant');",
        '}',
        "it('sees the mutant', () => {",
        "  assert.equal(globalThis.__stryker__.activeMutant, 'fixture-mutant');",
        `  assert.equal(spawnSync(process.execPath, ['-e', ${JSON.stringify(child)}]).status, 0);`,
        '});',
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const testFilter = [`${join(dir, 'a.test.mjs')} > sees the mutant`];

    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ mutantActivation: 'runtime', testFilter }))), {
      status: MutantRunStatus.Survived,
      nrOfTests: 1,
    });
  });

  it('activates a runtime mutant before the before hooks of suites and before beforeEach hooks', async (t) => {
    const active = `const active = () => process.env.${ACTIVE_MUTANT} || globalThis.__stryker__.activeMutant;`;
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { before } from 'node:test';",
        active,
        "before(() => { if (active()) throw new Error('top-level before hook ran mutated'); });",
        "describe('suite', () => {",
        "  before(() => { if (!active()) throw new Error('before hook ran unmutated'); });",
        "  it('runs', () => {});",
        '});',
      ),
      'b.test.mjs': fixture(
        "import { beforeEach } from 'node:test';",
        active,
        "beforeEach((t, done) => done(active() ? undefined : new Error('beforeEach hook ran unmutated')));",
        "it('runs', () => {});",
      ),
    });
    const runner = await initRunner(['*.test.mjs']);

    for (const testFilter of [[`${join(dir, 'a.test.mjs')} > suite > runs`], [`${join(dir, 'b.test.mjs')} > runs`]]) {
      assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ mutantActivation: 'runtime', testFilter }))), {
        status: MutantRunStatus.Survived,
        nrOfTests: 1,
      });
    }
  });

  it('times out a mutant run that exceeds the hit limit', async (t) => {
    project(t, {
      'a.test.mjs': fixture(
        "it('loops', () => {",
        '  const ns = globalThis.__stryker__;',
        '  for (let i = 0; i < 11; i++) {',
        "    if (ns.hitCount !== undefined && ++ns.hitCount > ns.hitLimit) throw new Error('Hit limit reached');",
        '  }',
        '});',
      ),
    });
    const runner = await initRunner(['*.test.mjs']);

    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ hitLimit: 10, disableBail: true }))), {
      status: MutantRunStatus.Timeout,
      reason: 'Hit limit reached (11/10)',
    });
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ hitLimit: 11 }))), {
      status: MutantRunStatus.Survived,
      nrOfTests: 1,
    });
  });

  it('times out when a process a test starts exceeds the hit limit, counting each process apart', async (t) => {
    const loop = (hits: number) =>
      [
        'const ns = globalThis.__stryker__;',
        `for (let i = 0; i < ${hits}; i++) {`,
        "  if (ns.hitCount !== undefined && ++ns.hitCount > ns.hitLimit) throw new Error('Hit limit reached');",
        '}',
      ].join(' ');
    const spawnLoop = (hits: number) => `spawnSync(process.execPath, ['-e', ${JSON.stringify(loop(hits))}]);`;
    project(t, {
      'a.test.mjs': fixture(`it('spawns a loop', () => { ${spawnLoop(11)} });`),
      'b.test.mjs': fixture(`it('spawns two loops', () => { ${spawnLoop(6)} ${spawnLoop(6)} });`),
    });
    const options = mutantRunOptions({ hitLimit: 10 });

    assert.deepEqual(await settle((await initRunner(['a.test.mjs'])).mutantRun(options)), {
      status: MutantRunStatus.Timeout,
      reason: 'Hit limit reached (11/10)',
    });
    assert.deepEqual(await settle((await initRunner(['b.test.mjs'])).mutantRun(options)), {
      status: MutantRunStatus.Survived,
      nrOfTests: 1,
    });
  });

  it('removes its output directory after a run', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync('out-dir.txt', process.env.${ENV.out});`,
        "it('passes', () => {});",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);

    const { records, exitCode, stderr } = await settle(
      runner.runFile(join(dir, 'a.test.mjs'), { dryRun: false, disableBail: false }),
    );

    assert.deepEqual({ exitCode, stderr, count: records.length }, { exitCode: 0, stderr: '', count: 1 });
    const outDir = readFileSync(join(dir, 'out-dir.txt'), 'utf8');
    assert.equal(dirname(dirname(outDir)), resolve(tmpdir()));
    assert.ok(!existsSync(dirname(outDir)));
  });

  for (const [description, exit] of [
    ['exits', ''],
    ['exits through process.exit', 'process.exit(1);'],
    ['is killed', "process.kill(process.pid, 'SIGKILL');"],
    [
      'leaves a process working in it for a moment',
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], " +
        "{ cwd: left, detached: true, stdio: 'ignore', windowsHide: true }).unref();",
    ],
  ] as const) {
    it(`removes what a test file leaves in the temporary directory when it ${description}`, async (t) => {
      const dir = project(t, {
        'a.test.mjs': fixture(
          "import { spawn } from 'node:child_process';",
          "import { mkdtempSync, writeFileSync } from 'node:fs';",
          "import { tmpdir } from 'node:os';",
          "import { join } from 'node:path';",
          "const left = mkdtempSync(join(tmpdir(), 'left-'));",
          "writeFileSync('left.txt', left);",
          exit,
        ),
      });
      const runner = await initRunner(['a.test.mjs']);

      await settle(runner.runFile(join(dir, 'a.test.mjs'), { dryRun: false, disableBail: false }));

      const left = readFileSync(join(dir, 'left.txt'), 'utf8');
      t.after(() => rmSync(left, { recursive: true, force: true }));
      assert.ok(!existsSync(left), `left behind: ${left}`);
    });
  }

  it('keeps the compile cache of the processes a run starts in its own directory, until it is disposed', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('cache-dir.txt', process.env.NODE_COMPILE_CACHE);",
        "it('passes', () => {});",
      ),
    });
    const before = ownCacheDirs();
    t.after(() => {
      process.env.NODE_COMPILE_CACHE = COMPILE_CACHE;
    });
    delete process.env.NODE_COMPILE_CACHE;
    const runner = await initRunner(['a.test.mjs']);

    const { exitCode } = await settle(runner.runFile(join(dir, 'a.test.mjs'), { dryRun: false, disableBail: false }));

    assert.equal(exitCode, 0);
    const cacheDir = readFileSync(join(dir, 'cache-dir.txt'), 'utf8');
    assert.equal(dirname(cacheDir), resolve(tmpdir()));
    assert.deepEqual(ownCacheDirs(), [...before, basename(cacheDir)].sort());
    // Node keys the cache by its version, then by file: one entry per hook module, written when the process exits.
    const entries = readdirSync(cacheDir).flatMap((version) => readdirSync(join(cacheDir, version)));
    assert.ok(entries.length >= 2, `cache entries: ${entries.join(', ')}`);

    await runner.dispose();

    assert.deepEqual(ownCacheDirs(), before);
  });

  it('creates no compile cache directory when the environment names one', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('cache-dir.txt', process.env.NODE_COMPILE_CACHE);",
        "it('passes', () => {});",
      ),
    });
    const before = ownCacheDirs();
    const runner = await initRunner(['a.test.mjs']);

    await settle(runner.runFile(join(dir, 'a.test.mjs'), { dryRun: false, disableBail: false }));

    assert.equal(readFileSync(join(dir, 'cache-dir.txt'), 'utf8'), COMPILE_CACHE);
    assert.deepEqual(ownCacheDirs(), before);
    await runner.dispose();
  });

  it('fails a run when node cannot start', async (t) => {
    const dir = project(t, { 'a.test.mjs': PASSING });
    const execPath = process.execPath;
    t.after(() => {
      process.execPath = execPath;
    });
    process.execPath = join(dir, 'missing-node');
    const runner = await initRunner(['a.test.mjs']);

    await assert.rejects(settle(runner.runFile(join(dir, 'a.test.mjs'), { dryRun: true, disableBail: false }), 1_000), {
      code: 'ENOENT',
    });

    // Node emits close after the error; letting it fire within this test keeps its coverage attributed to the test.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, describe, it, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { INSTRUMENTER_CONSTANTS, type Mutant, type StrykerOptions } from '@stryker-mutator/api/core';
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

import { ENV } from './hook-core.ts';
import { filesFor, mergeCoverage, NodeTestRunner, runEnv, toTestResults } from './index.ts';

const ACTIVE_MUTANT = INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE;
const HOOK_URL = pathToFileURL(join(import.meta.dirname, 'hook.ts')).href;
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
      ],
    );
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

describe('runEnv', () => {
  const OUT = join('/tmp', 'out');

  it('loads the hook before inherited options and drops the outer run state', () => {
    const base = {
      PATH: 'path',
      NODE_OPTIONS: '--max-old-space-size=100',
      [ENV.out]: 'outer out',
      [ENV.current]: 'outer test',
      [ENV.hitLimit]: '5',
      [ENV.filter]: '["outer"]',
      [ACTIVE_MUTANT]: '9',
    };
    const before = { ...base };

    assert.deepEqual(runEnv(base, FILE, OUT, { dryRun: false, disableBail: false }, undefined), {
      PATH: 'path',
      NODE_OPTIONS: `--import ${JSON.stringify(HOOK_URL)} --max-old-space-size=100`,
      [ENV.out]: OUT,
      [ENV.file]: FILE,
      [ENV.dryRun]: 'false',
    });
    assert.deepEqual(base, before);
  });

  it("uses the runner's compile cache directory unless the environment names one", () => {
    const run = { dryRun: false, disableBail: false };

    assert.equal(runEnv({}, FILE, OUT, run, 'own').NODE_COMPILE_CACHE, 'own');
    assert.equal(runEnv({ NODE_COMPILE_CACHE: 'inherited' }, FILE, OUT, run, 'own').NODE_COMPILE_CACHE, 'inherited');
    assert.equal(runEnv({ NODE_COMPILE_CACHE: 'inherited' }, FILE, OUT, run, undefined).NODE_COMPILE_CACHE, 'inherited');
  });

  it('passes the run state on to the test file', () => {
    assert.deepEqual(
      runEnv(
        {},
        FILE,
        OUT,
        { dryRun: true, disableBail: true, activeMutant: '12', hitLimit: 40, testFilter: [`${FILE} > test`] },
        undefined,
      ),
      {
        NODE_OPTIONS: `--import ${JSON.stringify(HOOK_URL)}`,
        [ENV.out]: OUT,
        [ENV.file]: FILE,
        [ENV.dryRun]: 'true',
        [ACTIVE_MUTANT]: '12',
        [ENV.hitLimit]: '40',
        [ENV.filter]: JSON.stringify([`${FILE} > test`]),
      },
    );
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

function logger(debug: string[] = []): Logger {
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
    debug: (message: string) => {
      debug.push(message);
    },
    info: ignore,
    warn: ignore,
    error: ignore,
    fatal: ignore,
  };
}

async function initRunner(testFiles: string[] | undefined, debug?: string[]): Promise<NodeTestRunner> {
  const options = testFiles ? { nodeTest: { testFiles } } : {};
  const runner = new NodeTestRunner(options as unknown as StrykerOptions, logger(debug));
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

let stalled = false;

// The runners under test and every process they start share this compile cache, so none of them creates its own.
const COMPILE_CACHE_PREFIX = 'node-test-runner-cache-';
const COMPILE_CACHE = mkdtempSync(join(tmpdir(), COMPILE_CACHE_PREFIX));
process.env.NODE_COMPILE_CACHE = COMPILE_CACHE;

// A test process that a mutant ends before any exit listener runs leaves its directory without files (Node may
// have created an empty version directory inside); sweep those here once they are old enough to be dead.
for (const name of readdirSync(tmpdir()).filter((candidate) => candidate.startsWith(COMPILE_CACHE_PREFIX))) {
  const dir = join(tmpdir(), name);

  try {
    const hasFiles = readdirSync(dir, { recursive: true, withFileTypes: true }).some((entry) => entry.isFile());

    if (dir !== COMPILE_CACHE && !hasFiles && Date.now() - statSync(dir).mtimeMs > 600_000) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Another test process may have removed or filled it in the meantime.
  }
}

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

  it('runs the TypeScript test files outside node_modules by default', async (t) => {
    const dir = project(t, {
      'a.test.ts': PASSING,
      [join('sub', 'b.test.ts')]: PASSING,
      [join('node_modules', 'pkg', 'c.test.ts')]: FAILING,
      'd.test.mjs': FAILING,
    });
    const runner = await initRunner(undefined);

    const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(summary(tests), [
      { id: `${join(dir, 'a.test.ts')} > passes`, status: TestStatus.Success, failureMessage: undefined },
      { id: `${join(dir, 'sub', 'b.test.ts')} > passes`, status: TestStatus.Success, failureMessage: undefined },
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
    const debug: string[] = [];
    const runner = await initRunner(['*.test.mjs'], debug);

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
    assert.deepEqual(debug, [`Running node ${file}`]);
  });

  for (const [description, source, failureMessage] of [
    ['its stderr', fixture("process.stderr.write('first\\nsecond\\n');", 'process.exitCode = 3;'), 'first\nsecond'],
    ['its exit code', fixture('process.exitCode = 4;'), 'node exited with code 4'],
  ] as const) {
    it(`reports a test file that exits with an error outside any test as failed, with ${description}`, async (t) => {
      const dir = project(t, { 'a.test.mjs': source });
      const runner = await initRunner(['a.test.mjs']);

      const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

      assert.deepEqual(summary(tests), [{ id: join(dir, 'a.test.mjs'), status: TestStatus.Failed, failureMessage }]);
    });
  }

  it('stops after the first file with a failure unless bail is disabled', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture("it('passes', () => {});", "it('fails', () => { throw new Error('expected failure'); });"),
      'b.test.mjs': PASSING,
    });
    const runner = await initRunner(['b.test.mjs', 'a.test.mjs']);
    const a = join(dir, 'a.test.mjs');
    const passedA = { id: `${a} > passes`, status: TestStatus.Success, failureMessage: undefined };
    const failedA = { id: `${a} > fails`, status: TestStatus.Failed, failureMessage: 'expected failure' };
    const passedB = {
      id: `${join(dir, 'b.test.mjs')} > passes`,
      status: TestStatus.Success,
      failureMessage: undefined,
    };

    assert.deepEqual(summary(complete(await settle(runner.dryRun(DRY_RUN))).tests), [passedA, failedA]);
    assert.deepEqual(summary(complete(await settle(runner.dryRun({ ...DRY_RUN, disableBail: true }))).tests), [
      passedA,
      failedA,
      passedB,
    ]);
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions())), {
      status: MutantRunStatus.Killed,
      killedBy: [failedA.id],
      failureMessage: 'expected failure',
      nrOfTests: 2,
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
    assert.ok(outDir.length > 0);
    assert.ok(!existsSync(outDir));
  });

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
    assert.equal(dirname(cacheDir), tmpdir());
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

// Named to sort after the other test files: the runner runs test files in path order and stops at the first failing
// file, so the quick tests kill a mutant they cover before these slow ones start.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { StrykerOptions } from '@stryker-mutator/api/core';
import { DryRunStatus, MutantRunStatus, TestStatus, type DryRunOptions } from '@stryker-mutator/api/test-runner';

import { ENV } from './hook-core.ts';
import {
  ACTIVE_MUTANT,
  complete,
  COVER,
  DRY_RUN,
  FAILING,
  fixture,
  fixtureCoverage,
  initRunner,
  logger,
  mutantRunOptions,
  NO_PROCESS,
  ownCacheDirs,
  PASSING,
  project,
  REPORTER_ARG,
  runNodeOptions,
  settle,
  shareCompileCache,
  summary,
} from './index.fixtures.ts';
import { fileError, NodeTestRunner } from './index.ts';

const COMPILE_CACHE = shareCompileCache();

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

  it('removes the directories that runners of ended processes left behind when it is initialized', async (t) => {
    project(t, { 'a.test.mjs': PASSING });
    const left = join(tmpdir(), `stryker-node-test-${NO_PROCESS}-left`);
    mkdirSync(join(left, 'out'), { recursive: true });
    t.after(() => rmSync(left, { recursive: true, force: true }));

    await initRunner(['a.test.mjs']);

    assert.ok(!existsSync(left), `left behind: ${left}`);
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
    assert.ok(basename(dirname(outDir)).startsWith(`stryker-node-test-${process.pid}-`), outDir);
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
    const reporters = ['--test-reporter', 'spec', '--test-reporter-destination=stdout'];
    const withReporters = { testFiles: ['a.test.mjs'], nodeArgs: [...reporters, ...nodeArgs] };

    assert.deepEqual(await execArgv({ nodeTest: withReporters }), [REPORTER_ARG, ...nodeArgs]);
    assert.deepEqual(await execArgv({ nodeTest: { testFiles: ['a.test.mjs'] } }), [REPORTER_ARG]);
  });

  it('runs its own reporter only, whatever reporters NODE_OPTIONS and nodeTest.nodeArgs name', async (t) => {
    const dir = project(t, { 'a.test.mjs': PASSING });
    const nodeOptions = process.env.NODE_OPTIONS;
    t.after(() => {
      if (nodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = nodeOptions;
      }
    });
    process.env.NODE_OPTIONS = `${nodeOptions ?? ''} --test-reporter=spec`;
    const options = { nodeTest: { testFiles: ['a.test.mjs'], nodeArgs: ['--test-reporter=dot'] } };
    const runner = new NodeTestRunner(options as unknown as StrykerOptions, logger());
    await runner.init();

    assert.deepEqual(summary(complete(await settle(runner.dryRun(DRY_RUN))).tests), [
      { id: `${join(dir, 'a.test.mjs')} > passes`, status: TestStatus.Success, failureMessage: undefined },
    ]);
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
    assert.deepEqual(
      tests.map((test) => test.name),
      ['suite > passes', 'suite > fails', 'spawns'],
    );
    assert.ok(tests.every((test) => test.fileName === file && test.timeSpentMs >= 0));
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

  it('reports a test file that fails outside any test as an error, after a passing file', async (t) => {
    const dir = project(t, {
      'a.test.mjs': PASSING,
      'b.test.mjs': fixture(
        "it('passes', () => {});",
        "process.stderr.write('first\\nsecond\\n');",
        'process.exitCode = 3;',
      ),
    });
    const options = { nodeTest: { testFiles: ['*.test.mjs'], nodeArgs: ['--no-deprecation'] } };
    const runner = new NodeTestRunner(options as unknown as StrykerOptions, logger());
    await runner.init();
    const b = join(dir, 'b.test.mjs');
    const errorMessage = fileError(b, 3, 'first\nsecond\n', [REPORTER_ARG, '--no-deprecation', b], runNodeOptions());

    assert.deepEqual(await settle(runner.dryRun(DRY_RUN)), { status: DryRunStatus.Error, errorMessage });
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions())), {
      status: MutantRunStatus.Error,
      errorMessage,
    });
  });

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

  it('names the suites and tests a running test registers with it and describe after it, as node:test does', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "it('outer', async () => {",
        "  it('inner', () => { cover('inner'); });",
        "  describe('suite', () => { it('in suite', () => { cover('in suite'); }); });",
        '  await new Promise((resolve) => setImmediate(resolve));',
        "  it('after await', () => { cover('after await'); });",
        '});',
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');
    const ids = ['outer > inner', 'outer > suite > in suite', 'outer > after await'].map((name) => `${a} > ${name}`);

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(
      tests.map(({ id, startPosition }) => ({ id, line: startPosition?.line })),
      [
        { id: ids[0], line: 5 },
        { id: ids[1], line: 6 },
        { id: ids[2], line: 8 },
        { id: `${a} > outer`, line: 4 },
      ],
    );
    assert.deepEqual(fixtureCoverage(mutantCoverage)?.perTest, {
      [ids[0] as string]: { inner: 1 },
      [ids[1] as string]: { 'in suite': 1 },
      [ids[2] as string]: { 'after await': 1 },
    });
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ testFilter: [ids[2] as string] }))), {
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

  it('gives tests without a name the ids node:test gives them, for results, coverage and the filter', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "it('', () => { cover('empty'); });",
        "it({ timeout: 1000 }, function optionsFirst() { cover('options first'); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(
      tests.map(({ id }) => id),
      [`${a} > <anonymous>`, `${a} > optionsFirst`],
    );
    assert.deepEqual(fixtureCoverage(mutantCoverage)?.perTest, {
      [`${a} > <anonymous>`]: { empty: 1 },
      [`${a} > optionsFirst`]: { 'options first': 1 },
    });
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ testFilter: [`${a} > <anonymous>`] }))), {
      status: MutantRunStatus.Survived,
      nrOfTests: 1,
    });
  });

  it('runs neither the tests outside the filter nor their beforeEach and afterEach hooks', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { afterEach, beforeEach } from 'node:test';",
        "const failFor = (name) => (t) => { if (t.name !== 'selected') throw new Error(name + ' ran for ' + t.name); };",
        "beforeEach(failFor('beforeEach'));",
        "afterEach(failFor('afterEach'));",
        "it('selected', () => {});",
        "it('unselected', () => {});",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const testFilter = [`${join(dir, 'a.test.mjs')} > selected`];

    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ testFilter }))), {
      status: MutantRunStatus.Survived,
      nrOfTests: 1,
    });
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

  it('reports a test file whose process exits without the record of its results as an error', async (t) => {
    const dir = project(t, { 'a.test.mjs': PASSING, 'b.test.mjs': fixture('process.reallyExit(0);') });
    const runner = await initRunner(['*.test.mjs']);

    assert.deepEqual(await settle(runner.dryRun(DRY_RUN)), {
      status: DryRunStatus.Error,
      errorMessage:
        `Missing test results for "${join(dir, 'b.test.mjs')}": its process ended without writing them. ` +
        'Either the Stryker hook did not run in it, or it left without running exit listeners ' +
        '(process.reallyExit, process.abort).',
    });
  });

  it('reports a test file whose process is killed as an error, losing the tests it ran', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "it('passes', () => {});",
        "it('is killed', () => { process.kill(process.pid, 'SIGKILL'); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    // A signal leaves no exit code on POSIX; Windows terminates the process with exit code 1.
    const exitCode = process.platform === 'win32' ? 1 : null;
    assert.deepEqual(await settle(runner.dryRun(DRY_RUN)), {
      status: DryRunStatus.Error,
      errorMessage: fileError(a, exitCode, '', [REPORTER_ARG, a], runNodeOptions()),
    });
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

  it('reports a statically activated mutant that breaks loading the test file as a runtime error', async (t) => {
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
    assert.equal(result.status, MutantRunStatus.Error);
    assert.match(result.status === MutantRunStatus.Error ? result.errorMessage : '', /Error: module-level mutant/);
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
});

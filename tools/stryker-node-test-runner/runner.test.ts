// Named to sort after the runner's quicker test files: the runner runs test files in path order and stops at the first
// failing file, so the quick tests kill a mutant they cover before these slow ones start.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { DryRunStatus, MutantRunStatus, TestStatus, type DryRunOptions } from '@stryker-mutator/api/test-runner';

import { testFor } from '../test-each/test-for.ts';
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
  type RunnerOptions,
  runNodeOptions,
  settle,
  shareCompileCache,
  summary,
  strykerOptions,
  withoutDuration,
} from './index.fixtures.ts';
import { fileError, NodeTestRunner } from './index.ts';

const COMPILE_CACHE = shareCompileCache();

describe('NodeTestRunner', () => {
  it('can reload the environment', () => {
    assert.deepEqual(new NodeTestRunner(strykerOptions(), logger()).capabilities(), { reloadEnvironment: true });
  });

  it('runs nothing before it is initialized', async () => {
    const runner = new NodeTestRunner(strykerOptions(), logger());

    assert.deepEqual(await settle(runner.dryRun(DRY_RUN)), {
      status: DryRunStatus.Complete,
      tests: [],
      mutantCoverage: { static: {}, perTest: {} },
    });
  });

  it('rejects, instead of throwing, when the dry run fails before it runs a file', async () => {
    const runner = new NodeTestRunner(strykerOptions(), logger());

    await assert.rejects(runner.dryRun({ ...DRY_RUN, testFiles: [42 as unknown as string] }), TypeError);
  });

  it('can be disposed without being initialized', async () => {
    await new NodeTestRunner(strykerOptions(), logger()).dispose();
  });

  it('fails to initialize without test files', async (t) => {
    project(t, { 'a.test.mjs': PASSING });
    const options = { nodeTest: { testFiles: ['none/*.test.mjs'] } };
    const runner = new NodeTestRunner(strykerOptions(options), logger());

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

    await assert.rejects(settle(runner.runFile(join(dir, 'a.test.mjs'), { dryRun: true, disableBail: false, coverageAnalysis: 'perTest' }), 1_000), {
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

  testFor([
    ['exits', ''],
    ['exits through process.exit', 'process.exit(1);'],
    ['is killed', "process.kill(process.pid, 'SIGKILL');"],
    [
      'leaves a process working in it for a moment',
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], " +
        "{ cwd: left, detached: true, windowsHide: true, stdio: 'ignore' }).unref();",
    ],
  ] as const)('removes what a test file leaves in the temporary directory when it %s', async ([, exit], t) => {
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

  it('ends a run soon after its test file exits, while a process the tests started keeps stderr open', async (t) => {
    let dir = '';
    // Registered ahead of the project's cleanup, which removes the file the daemon's id is in.
    t.after(() => {
      if (existsSync(join(dir, 'daemon.pid'))) {
        process.kill(Number(readFileSync(join(dir, 'daemon.pid'), 'utf8')));
      }
    });
    dir = project(t, {
      'a.test.mjs': fixture(
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "it('starts a daemon', () => {",
        "  const daemon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20_000)'], {",
        "    cwd: '/',",
        '    detached: true, windowsHide: true,',
        "    stdio: 'inherit',",
        '  });',
        '  daemon.unref();',
        "  writeFileSync('daemon.pid', String(daemon.pid));",
        '});',
        "process.on('exit', () => process.stderr.write('before exit'));",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const pipes = () => process.getActiveResourcesInfo().filter((resource) => resource === 'PipeWrap').length;
    const pipesBefore = pipes();
    const started = performance.now();

    const { exitCode, stderr, records } = await settle(
      runner.runFile(join(dir, 'a.test.mjs'), { dryRun: false, disableBail: false }),
      30_000,
    );

    assert.ok(performance.now() - started < 5_000, `took ${performance.now() - started} ms`);
    assert.deepEqual([exitCode, stderr, records.some((record) => record.main)], [0, 'before exit', true]);
    // The run lets go of the stderr pipe that the daemon still holds.
    assert.equal(pipes(), pipesBefore);
  });

  it('leaves out a record that a process the tests started has not finished writing', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "it('passes', () => { writeFileSync(join(process.env.STRYKER_NODE_TEST_OUT, 'half.json'), '{'); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);

    const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(summary(tests), [
      { id: `${join(dir, 'a.test.mjs')} > passes`, status: TestStatus.Success, failureMessage: undefined },
    ]);
  });

  testFor([
    ['does not parse', '{'],
    ['lists no tests', '{}'],
  ] as const)('reports a test file whose own record %s as an error', async ([, content], t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "it('passes', () => {});",
        // Runs after the hook's own exit listener has written the record.
        'process.on(\'exit\', () => writeFileSync(join(process.env.STRYKER_NODE_TEST_OUT, `${process.pid}.json`), ' +
          `${JSON.stringify(content)}));`,
      ),
    });
    const runner = await initRunner(['a.test.mjs']);

    const result = await settle(runner.dryRun(DRY_RUN));

    assert.ok(result.status === DryRunStatus.Error);
    const prefix = `Unreadable test results for "${join(dir, 'a.test.mjs')}": `;
    assert.ok(result.errorMessage.startsWith(prefix), result.errorMessage);
    assert.ok(result.errorMessage.length > prefix.length, result.errorMessage);
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

  testFor([{}, { nodeTest: {} }])(
    'runs the TypeScript test files outside node_modules by default, with the options %j',
    async (options, t) => {
      const dir = project(t, {
        'a.test.ts': PASSING,
        [join('sub', 'b.test.ts')]: PASSING,
        [join('node_modules', 'pkg', 'c.test.ts')]: FAILING,
        'd.test.mjs': FAILING,
      });
      const runner = new NodeTestRunner(strykerOptions(options), logger());
      await runner.init();
      t.after(() => runner.dispose());

      const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

      assert.deepEqual(summary(tests), [
        { id: `${join(dir, 'a.test.ts')} > passes`, status: TestStatus.Success, failureMessage: undefined },
        { id: `${join(dir, 'sub', 'b.test.ts')} > passes`, status: TestStatus.Success, failureMessage: undefined },
      ]);
    },
  );

  it('passes nodeTest.nodeArgs to the node process of each test file', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('exec-argv.json', JSON.stringify(process.execArgv));",
        "it('passes', () => {});",
      ),
    });
    const execArgv = async (options: RunnerOptions) => {
      const runner = new NodeTestRunner(strykerOptions(options), logger());
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
    const runner = new NodeTestRunner(strykerOptions(options), logger());
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
      const runner = new NodeTestRunner(strykerOptions(options), logger(debug, debugEnabled));
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
    const runner = new NodeTestRunner(strykerOptions(options), logger());
    await runner.init();
    const b = join(dir, 'b.test.mjs');
    const errorMessage = fileError(b, {
      records: [],
      exitCode: 3,
      stderr: 'first\nsecond\n',
      args: [REPORTER_ARG, '--no-deprecation', b],
      nodeOptions: runNodeOptions(),
    });

    assert.deepEqual(await settle(runner.dryRun(DRY_RUN)), { status: DryRunStatus.Error, errorMessage });
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions())), {
      status: MutantRunStatus.Error,
      errorMessage,
    });
  });

  it('reports an error raised after its test ended as an error that names the test and the error', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "it('late', () => { setTimeout(() => { throw new Error('late boom'); }, 20); });",
        "it('waits', () => new Promise((resolve) => setTimeout(resolve, 200)));",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const result = await settle(runner.dryRun(DRY_RUN));

    assert.ok(result.status === DryRunStatus.Error);
    const [first, , ...rest] = result.errorMessage.split('\n');
    assert.equal(first, `Error running file "${a}": node exited with code 1 outside any test.`);
    // node:test gives the position of the wrapper that registered the test.
    assert.match(
      rest.join('\n'),
      /^Diagnostics:\nError: Test "late" at .+ generated asynchronous activity after the test ended\. This activity created the error "Error: late boom"/,
    );
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
    assert.deepEqual(withoutDuration(await settle(runner.mutantRun(mutantRunOptions()))), {
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
    assert.deepEqual(withoutDuration(await settle(runner.mutantRun(mutantRunOptions({ testFilter: [failsInHook] })))), {
      status: MutantRunStatus.Killed,
      killedBy: [failsInHook],
      failureMessage: 'afterEach failure',
      nrOfTests: 1,
    });
  });

  it('attributes coverage to the test whose work makes it: a parent after an awaited subtest, an unawaited one', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "it('awaits', async (t) => {",
        "  await t.test('child', () => { cover('awaited child'); });",
        "  cover('parent after await');",
        '});',
        "it('leaves', (t) => {",
        "  t.test('child', async () => { await new Promise((resolve) => setTimeout(resolve, 20)); cover('late child'); });",
        '});',
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    // Node.js 22 cancels the unawaited subtest when its parent ends, but the subtest's work still runs.
    const { mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(fixtureCoverage(mutantCoverage), {
      static: {},
      perTest: {
        [`${a} > awaits`]: { 'parent after await': 1 },
        [`${a} > awaits > child`]: { 'awaited child': 1 },
        [`${a} > leaves > child`]: { 'late child': 1 },
      },
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

    assert.deepEqual(withoutDuration(await settle(runner.mutantRun(mutantRunOptions({ testFilter })))), {
      status: MutantRunStatus.Survived,
      nrOfTests: 1,
    });
  });

  it('runs the bodies of the suites outside the filter, but none of their hooks', async (t) => {
    const fail = (hook: string) => `() => { throw new Error('${hook} ran'); }`;
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import test, { after, afterEach, before, beforeEach } from 'node:test';",
        'const ran = [];',
        "describe('selected', () => {",
        "  before(() => { ran.push('before'); });",
        "  beforeEach(() => { ran.push('beforeEach'); });",
        "  afterEach(() => { ran.push('afterEach'); });",
        "  after(() => { assert.deepEqual(ran, ['unselected body', 'nested body', 'before', 'beforeEach', 'runs', 'afterEach']); });",
        "  it('runs', () => { ran.push('runs'); });",
        '});',
        "describe('unselected', () => {",
        "  ran.push('unselected body');",
        `  before(${fail('before')});`,
        `  beforeEach(${fail('beforeEach')});`,
        `  test.afterEach(${fail('afterEach')});`,
        `  after(${fail('after')});`,
        "  it('skipped', () => {});",
        "  describe('nested', () => {",
        "    ran.push('nested body');",
        `    test.before(${fail('nested before')});`,
        `    test.after(${fail('nested after')});`,
        "    it('skipped too', () => {});",
        '  });',
        '});',
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    assert.deepEqual(withoutDuration(await settle(runner.mutantRun(mutantRunOptions({ testFilter: [`${a} > selected > runs`] })))), {
      status: MutantRunStatus.Survived,
      nrOfTests: 1,
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
    assert.deepEqual(withoutDuration(await settle(runner.mutantRun(mutantRunOptions()))), {
      status: MutantRunStatus.Killed,
      killedBy: [failedA.id],
      failureMessage: 'expected failure',
      nrOfTests: 2,
    });
    assert.deepEqual(withoutDuration(await settle(runner.mutantRun(mutantRunOptions({ disableBail: true })))), {
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

    assert.deepEqual(withoutDuration(await settle(runner.mutantRun(mutantRunOptions({ testFilter })))), {
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

    assert.deepEqual(withoutDuration(await settle(runner.mutantRun(mutantRunOptions({ testFilter: [a] })))), {
      status: MutantRunStatus.Killed,
      killedBy: [`${a} > fails`],
      failureMessage: 'expected failure',
      nrOfTests: 2,
    });
  });

  it("runs only the files of Stryker's --testFiles in the dry run, also outside nodeTest.testFiles", async (t) => {
    const dir = project(t, { 'a.test.mjs': PASSING, 'b.test.mjs': FAILING, 'c.spec.mjs': FAILING });
    const options = { nodeTest: { testFiles: ['*.test.mjs'] }, testFiles: ['c.spec.mjs'] };
    const runner = new NodeTestRunner(strykerOptions(options), logger());
    await runner.init();
    const b = join(dir, 'b.test.mjs');
    const c = join(dir, 'c.spec.mjs');

    assert.deepEqual(summary(complete(await settle(runner.dryRun({ ...DRY_RUN, testFiles: ['b.test.mjs'] }))).tests), [
      { id: `${b} > fails`, status: TestStatus.Failed, failureMessage: 'expected failure' },
    ]);
    assert.deepEqual(withoutDuration(await settle(runner.mutantRun(mutantRunOptions({ testFilter: [`${c} > fails`] })))), {
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
    assert.ok(result.status === MutantRunStatus.Error);
    assert.match(result.errorMessage, /Error: module-level mutant/);
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

    assert.deepEqual(withoutDuration(await settle(runner.mutantRun(mutantRunOptions({ mutantActivation: 'runtime', testFilter })))), {
      status: MutantRunStatus.Survived,
      nrOfTests: 1,
    });
  });

  testFor([
    { hooks: 'the before hooks of suites', file: 'a.test.mjs', test: 'suite > runs' },
    { hooks: 'beforeEach hooks', file: 'b.test.mjs', test: 'runs' },
  ])('activates a runtime mutant before $hooks', async ({ file, test }, t) => {
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
    const testFilter = [`${join(dir, file)} > ${test}`];

    assert.deepEqual(withoutDuration(await settle(runner.mutantRun(mutantRunOptions({ mutantActivation: 'runtime', testFilter })))), {
      status: MutantRunStatus.Survived,
      nrOfTests: 1,
    });
  });
});

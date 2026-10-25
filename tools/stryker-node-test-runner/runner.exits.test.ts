import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { DryRunStatus, MutantRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';

import { testFor } from '../test-each/test-for.ts';
import {
  complete,
  DRY_RUN,
  fixture,
  fixtureCoverage,
  initRunner,
  mutantRunOptions,
  PASSING,
  project,
  REPORTER_ARG,
  runNodeOptions,
  settle,
  shareCompileCache,
  summary,
} from './index.fixtures.ts';
import { isRunning } from './dirs.ts';
import { fileError } from './index.ts';

shareCompileCache();

describe('NodeTestRunner endings', () => {
  it('ends the processes that the tests of a test file leave running once its run is over', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "it('leaves a process running', () => {",
        "  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20_000)'], {",
        "    stdio: 'ignore',",
        '    windowsHide: true,',
        '  });',
        '  child.unref();',
        "  writeFileSync('child.pid', String(child.pid));",
        '});',
      ),
    });
    const pidFile = join(dir, 'child.pid');
    t.after(() => {
      if (existsSync(pidFile) && isRunning(Number(readFileSync(pidFile, 'utf8')))) {
        process.kill(Number(readFileSync(pidFile, 'utf8')));
      }
    });
    const runner = await initRunner(['a.test.mjs']);

    assert.equal((await settle(runner.mutantRun(mutantRunOptions()))).status, MutantRunStatus.Survived);

    // SIGKILL returns before the kernel is done: on Linux the orphaned child stays a zombie, which kill(pid, 0) still
    // finds, until its new parent reaps it. The child would otherwise run for 20 seconds.
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const deadline = Date.now() + 5_000;

    while (isRunning(pid) && Date.now() < deadline) {
      await delay(20);
    }

    assert.equal(isRunning(pid), false);
  });

  it('reports no tests for a test file that declares none', async (t) => {
    project(t, { 'a.test.mjs': fixture("cover('s');") });
    const runner = await initRunner(['a.test.mjs']);

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(tests, []);
    assert.deepEqual(fixtureCoverage(mutantCoverage), { static: { s: 1 }, perTest: {} });
  });

  const passes = "it('passes', async () => { await new Promise((resolve) => setImmediate(resolve)); });";
  const neverEnds = "it('never ends', async () => { await new Promise((resolve) => setTimeout(resolve, 1_000)); });";

  testFor([
    ['while it loads, before it declares a test', ['process.exit(0);', "it('never runs', () => {});"]],
    ['before node:test reports any test', [passes, "it('exits', () => { process.exit(0); });", neverEnds]],
    [
      'after node:test reports a test',
      [passes, "it('exits later', () => { setTimeout(() => process.exit(0), 10); });", neverEnds],
    ],
  ] as const)('reports a test file that exits with code 0 %s as an error', async ([, lines], t) => {
    const dir = project(t, { 'a.test.mjs': fixture(...lines) });
    const runner = await initRunner(['a.test.mjs']);

    assert.deepEqual(await settle(runner.dryRun(DRY_RUN)), {
      status: DryRunStatus.Error,
      errorMessage:
        `Unfinished test results for "${join(dir, 'a.test.mjs')}": its process exited before node:test reported ` +
        'every test, as when a test calls process.exit().',
    });
  });

  it('reports a test that failed before its test file exited with code 0 as failed', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "it('fails', async () => { await new Promise((resolve) => setImmediate(resolve)); throw new Error('x'); });",
        "it('exits later', () => { setTimeout(() => process.exit(0), 10); });",
        "it('never ends', async () => { await new Promise((resolve) => setTimeout(resolve, 1_000)); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);

    const { tests } = complete(await settle(runner.dryRun({ ...DRY_RUN, disableBail: true })));

    assert.deepEqual(summary(tests), [
      { id: `${join(dir, 'a.test.mjs')} > fails`, status: TestStatus.Failed, failureMessage: 'x' },
      { id: `${join(dir, 'a.test.mjs')} > exits later`, status: TestStatus.Success, failureMessage: undefined },
    ]);
  });

  it('reports a test file whose process exits without the record of its results as an error', async (t) => {
    const dir = project(t, { 'a.test.mjs': PASSING, 'b.test.mjs': fixture('process.reallyExit(0);') });
    const runner = await initRunner(['*.test.mjs']);

    assert.deepEqual(await settle(runner.dryRun(DRY_RUN)), {
      status: DryRunStatus.Error,
      errorMessage:
        `Missing test results for "${join(dir, 'b.test.mjs')}": its process ended without writing them. ` +
        'Either the Stryker hook did not run in it, it left without running exit listeners ' +
        '(process.reallyExit, process.abort), or it ran under the permission model without write access to the ' +
        'temporary directory.',
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
      errorMessage: fileError(a, { records: [], exitCode, stderr: '', args: [REPORTER_ARG, a], nodeOptions: runNodeOptions() }),
    });
  });
});

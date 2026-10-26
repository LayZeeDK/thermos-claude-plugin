import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { MutantRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';

import {
  complete,
  DRY_RUN,
  fixture,
  initRunner,
  logger,
  mutantRunOptions,
  project,
  settle,
  shareCompileCache,
  summary,
  strykerOptions,
  withoutDuration,
} from './index.fixtures.ts';
import { NodeTestRunner } from './index.ts';

shareCompileCache();

describe('NodeTestRunner timing', () => {
  it("times each test with the time its file's run spent outside the tests, such as starting node", async (t) => {
    project(t, { 'a.test.mjs': fixture("it('first', () => {});", "it('second', () => {});") });
    const runner = await initRunner(['*.test.mjs']);
    const started = performance.now();

    const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));
    const wall = Math.ceil(performance.now() - started);

    assert.equal(tests.length, 2);

    // Starting node takes tens of milliseconds, and neither test takes one.
    for (const test of tests) {
      assert.ok(test.timeSpentMs >= 20 && test.timeSpentMs <= wall, `${test.timeSpentMs} ms of a ${wall} ms run`);
    }
  });

  async function meetingFiles(t: TestContext, concurrency: number, checkers: string[] = []) {
    const meets = (self: string, other: string) =>
      fixture(
        "const { existsSync, writeFileSync } = await import('node:fs');",
        "const { join } = await import('node:path');",
        `writeFileSync(join(import.meta.dirname, '${self}.started'), '');`,
        `it('meets ${other}', async () => {`,
        '  const deadline = Date.now() + 3_000;',
        `  while (!existsSync(join(import.meta.dirname, '${other}.started'))) {`,
        `    assert.ok(Date.now() < deadline, '${other} never started');`,
        '    await new Promise((resolve) => setTimeout(resolve, 20));',
        '  }',
        '});',
      );
    const dir = project(t, { 'a.test.mjs': meets('a', 'b'), 'b.test.mjs': meets('b', 'a') });
    const options = { lzNodeTest: { testFiles: ['*.test.mjs'] }, concurrency, checkers };
    const runner = new NodeTestRunner(strykerOptions(options), logger());
    await runner.init();

    return { dir, runner, a: `${join(dir, 'a.test.mjs')} > meets b`, b: `${join(dir, 'b.test.mjs')} > meets a` };
  }

  it("runs as many of the dry run's test files at once as Stryker runs test runners, and a mutant run's one at a time", async (t) => {
    const { dir, runner, a, b } = await meetingFiles(t, 2);

    assert.deepEqual(summary(complete(await settle(runner.dryRun(DRY_RUN))).tests), [
      { id: a, status: TestStatus.Success, failureMessage: undefined },
      { id: b, status: TestStatus.Success, failureMessage: undefined },
    ]);

    for (const marker of ['a.started', 'b.started']) {
      rmSync(join(dir, marker));
    }

    assert.deepEqual(withoutDuration(await settle(runner.mutantRun(mutantRunOptions({ disableBail: true })))), {
      status: MutantRunStatus.Killed,
      killedBy: [a],
      failureMessage: 'b never started',
      nrOfTests: 2,
    });
  });

  it("runs the dry run's test files two at once beside checkers at a concurrency of 1, as Stryker does", async (t) => {
    const { runner, a, b } = await meetingFiles(t, 1, ['typescript']);

    assert.deepEqual(summary(complete(await settle(runner.dryRun(DRY_RUN))).tests), [
      { id: a, status: TestStatus.Success, failureMessage: undefined },
      { id: b, status: TestStatus.Success, failureMessage: undefined },
    ]);
  });

  it("runs the dry run's test files one at a time when Stryker runs one test runner", async (t) => {
    const { runner, a, b } = await meetingFiles(t, 1);

    assert.deepEqual(summary(complete(await settle(runner.dryRun({ ...DRY_RUN, disableBail: true }))).tests), [
      { id: a, status: TestStatus.Failed, failureMessage: 'b never started' },
      { id: b, status: TestStatus.Success, failureMessage: undefined },
    ]);
  });

  it("reports a mutant run's duration as the time of its file processes, once per file", async (t) => {
    const tests = Array.from({ length: 10 }, (_, index) => `it('passes ${index}', () => {});`);
    project(t, { 'a.test.mjs': fixture('await new Promise((resolve) => setTimeout(resolve, 300));', ...tests) });
    const runner = await initRunner(['a.test.mjs']);

    const started = performance.now();
    const result = await settle(runner.mutantRun(mutantRunOptions()));
    const elapsed = performance.now() - started;

    assert.ok(result.status === MutantRunStatus.Survived, `expected a survived mutant, got ${JSON.stringify(result)}`);
    assert.ok(result.duration !== undefined, 'expected a duration');
    assert.ok(result.duration >= 300 && result.duration <= Math.ceil(elapsed), `${result.duration} ms of ${elapsed} ms`);
  });
});

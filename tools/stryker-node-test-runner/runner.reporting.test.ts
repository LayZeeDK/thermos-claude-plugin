// The fields of the results the runner reports, which Stryker's reporters show: ids, names and positions.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MutantRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';

import {
  complete,
  DRY_RUN,
  fixture,
  fixtureCoverage,
  initRunner,
  mutantRunOptions,
  project,
  settle,
  shareCompileCache,
} from './index.fixtures.ts';

shareCompileCache();

describe('NodeTestRunner results', () => {
  it('reports where the test file declares a suite that fails by itself', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { before } from 'node:test';",
        "describe('once', () => {",
        "  before(() => { throw new Error('before failure'); });",
        "  it('never runs', () => {});",
        '});',
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

    // fixture() starts every file with four lines.
    assert.deepEqual(
      tests.map(({ id, startPosition }) => ({ id, startPosition })),
      [
        { id: `${a} > once > never runs`, startPosition: { line: 7, column: 2 } },
        { id: `${a} > once`, startPosition: { line: 5, column: 0 } },
      ],
    );
  });

  it('reports where the test file declares each skipped test, however it is skipped', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { test } from 'node:test';",
        "it.skip('it.skip', () => {});",
        "test.skip('test.skip');",
        "it('skip option', { skip: true }, () => {});",
        "describe('suite', () => {",
        "  it.skip('nested', () => {});",
        '});',
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

    // V8 places a call of a shorthand such as `it.skip` at the shorthand's name.
    assert.deepEqual(
      tests.map(({ id, status, startPosition }) => ({ id, status, startPosition })),
      [
        { id: `${a} > it.skip`, status: TestStatus.Skipped, startPosition: { line: 5, column: 3 } },
        { id: `${a} > test.skip`, status: TestStatus.Skipped, startPosition: { line: 6, column: 5 } },
        { id: `${a} > skip option`, status: TestStatus.Skipped, startPosition: { line: 7, column: 0 } },
        { id: `${a} > suite > nested`, status: TestStatus.Skipped, startPosition: { line: 9, column: 5 } },
      ],
    );
  });

  it('reports a skipped suite as one skipped result, without running its body to find its tests', async (t) => {
    const body = "() => { cover('suite body'); it('inside', () => {}); }";
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { suite } from 'node:test';",
        `describe.skip('describe.skip', ${body});`,
        `suite.skip('suite.skip', ${body});`,
        `describe('skip option', { skip: 'not now' }, ${body});`,
        "describe('outer', () => {",
        `  describe.skip('nested', ${body});`,
        "  it('passes', () => {});",
        '});',
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const skipped = (name: string, line: number, column: number) => ({
      id: `${a} > ${name}`,
      name,
      status: TestStatus.Skipped,
      startPosition: { line, column },
    });

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(
      tests.map(({ id, name, status, startPosition }) => ({ id, name, status, startPosition })),
      [
        skipped('describe.skip', 5, 9),
        skipped('suite.skip', 6, 6),
        skipped('skip option', 7, 0),
        skipped('outer > nested', 9, 11),
        {
          id: `${a} > outer > passes`,
          name: 'outer > passes',
          status: TestStatus.Success,
          startPosition: { line: 10, column: 2 },
        },
      ],
    );
    assert.deepEqual(fixtureCoverage(mutantCoverage), { static: {}, perTest: {} });
  });

  it("reports a failing `after` hook outside any suite as the test file's hook, where it is declared", async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { after } from 'node:test';",
        "it('passes', () => {});",
        "after(() => { throw new Error('after failure'); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');
    const hook = `${a} > "after" hook`;

    const { tests } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(
      tests.map(({ id, name, status, startPosition }) => ({ id, name, status, startPosition })),
      [
        { id: `${a} > passes`, name: 'passes', status: TestStatus.Success, startPosition: { line: 5, column: 0 } },
        { id: hook, name: '"after" hook', status: TestStatus.Failed, startPosition: { line: 6, column: 0 } },
      ],
    );
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions())), {
      status: MutantRunStatus.Killed,
      killedBy: [hook],
      failureMessage: 'after failure',
      nrOfTests: 2,
    });
  });
});

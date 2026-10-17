// The fields of the results the runner reports, which Stryker's reporters show: ids, names and positions.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { TestStatus } from '@stryker-mutator/api/test-runner';

import { complete, DRY_RUN, fixture, initRunner, project, settle, shareCompileCache } from './index.fixtures.ts';

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
});

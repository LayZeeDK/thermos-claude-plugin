// The fields of the results the runner reports, which Stryker's reporters show: ids, names and positions.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

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
});

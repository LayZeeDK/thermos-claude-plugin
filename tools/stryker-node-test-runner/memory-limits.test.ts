import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { testFor } from '../test-each/test-for.ts';
import { logger } from './index.fixtures.ts';
import { MemoryLimits } from './memory-limits.ts';

/** MemoryLimits over a peaks directory of the test's own, each made with a logger that keeps its warnings. */
function setup(t: TestContext, maxMemoryMB?: number) {
  const parent = mkdtempSync(join(tmpdir(), 'memory-limits-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const dir = join(parent, 'peaks');
  const warnings: string[] = [];
  const limits = () => new MemoryLimits(maxMemoryMB, dir, logger([], true, warnings));

  return { dir, warnings, limits };
}

describe('MemoryLimits', () => {
  it('runs the dry run and every mutant run under nodeTest.maxMemoryMB, and keeps no peaks', (t) => {
    const { dir, warnings, limits } = setup(t, 1500);
    const dryRun = limits();

    assert.equal(dryRun.forDryRun(), 1500);
    dryRun.record('a.test.ts', [{ tests: [], peakMemoryMB: 2000 }]);

    assert.deepEqual([dryRun.forMutantRun('a.test.ts'), limits().forMutantRun('b.test.ts')], [1500, 1500]);
    assert.equal(existsSync(dir), false);
    assert.deepEqual(warnings, []);
  });

  testFor([
    [[370], 1579],
    [[101], 1176],
    [[50, 370, 100], 1579],
    [[undefined], 1024],
    [[], 1024],
  ] as const)(
    'gives a file whose dry-run processes peaked at %j MB a limit of %d MB, also in another runner',
    ([peaks, limitMB], t) => {
      const { dir, warnings, limits } = setup(t);
      const dryRun = limits();

      assert.equal(dryRun.forDryRun(), undefined);
      assert.ok(existsSync(dir));
      dryRun.record(
        'a.test.ts',
        peaks.map((peakMemoryMB) => ({ tests: [], ...(peakMemoryMB !== undefined && { peakMemoryMB }) })),
      );

      assert.deepEqual([dryRun.forMutantRun('a.test.ts'), limits().forMutantRun('a.test.ts')], [limitMB, limitMB]);
      assert.deepEqual(warnings, []);
    },
  );

  it('gives a file without a dry-run peak 1024 MB, warning about it once', (t) => {
    const { warnings, limits } = setup(t);
    limits().forDryRun();
    const mutantRuns = limits();

    assert.deepEqual([mutantRuns.forMutantRun('a.test.ts'), mutantRuns.forMutantRun('a.test.ts')], [1024, 1024]);
    assert.deepEqual(warnings, [
      'The dry run left no memory peak for "a.test.ts", so each process of its mutant runs may hold 1024 MB. ' +
        'Set nodeTest.maxMemoryMB to choose the limit.',
    ]);
  });
});

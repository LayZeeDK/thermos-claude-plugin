import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MutantRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';

import { ENV } from './hook-core.ts';
import {
  complete,
  DRY_RUN,
  fixture,
  initRunner,
  mutantRunOptions,
  project,
  settle,
  shareCompileCache,
  withoutDuration,
} from './index.fixtures.ts';

shareCompileCache();

describe('NodeTestRunner limits', () => {
  /** Code that counts `hits` hits as instrumented code does, throwing like it once they pass the hit limit. */
  const loop = (hits: number) =>
    [
      'const ns = globalThis.__stryker__;',
      `for (let i = 0; i < ${hits}; i++) {`,
      "  if (ns.hitCount !== undefined && ++ns.hitCount > ns.hitLimit) throw new Error('Hit limit reached');",
      '}',
    ].join(' ');

  it('times out a mutant run that exceeds the hit limit', async (t) => {
    project(t, { 'a.test.mjs': fixture(`it('loops', () => { ${loop(11)} });`) });
    const runner = await initRunner(['*.test.mjs']);

    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ hitLimit: 10, disableBail: true }))), {
      status: MutantRunStatus.Timeout,
      reason: 'Hit limit reached (11/10)',
    });
    assert.deepEqual(withoutDuration(await settle(runner.mutantRun(mutantRunOptions({ hitLimit: 11 })))), {
      status: MutantRunStatus.Survived,
      nrOfTests: 1,
    });
  });

  it('times out a mutant run whose test file exceeds the hit limit while it loads, which fails it outside any test', async (t) => {
    project(t, { 'a.test.mjs': fixture(loop(11), "it('passes', () => {});") });
    const runner = await initRunner(['a.test.mjs']);

    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ hitLimit: 10 }))), {
      status: MutantRunStatus.Timeout,
      reason: 'Hit limit reached (11/10)',
    });
  });

  it('times out when a process a test starts exceeds the hit limit, counting each process apart', async (t) => {
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
    assert.deepEqual(withoutDuration(await settle((await initRunner(['b.test.mjs'])).mutantRun(options))), {
      status: MutantRunStatus.Survived,
      nrOfTests: 1,
    });
  });

  it('times out a mutant run whose process holds more memory than maxMemoryMB while a test blocks it', async (t) => {
    project(t, {
      'a.test.mjs': fixture(
        // Grows by 16 MB about every 10 ms to 400 MB, and blocks for 5 s, so it ends by itself without a watchdog.
        "it('grows', () => {",
        '  const held = [];',
        '  const end = Date.now() + 5_000;',
        '  while (Date.now() < end) {',
        '    if (held.length < 25) held.push(new Int32Array(4e6).fill(1));',
        '    const pause = Date.now() + 10;',
        '    while (Date.now() < pause);',
        '  }',
        '});',
      ),
    });
    const runner = await initRunner(['a.test.mjs'], { maxMemoryMB: 200 });

    const result = await settle(runner.mutantRun(mutantRunOptions()), 10_000);

    assert.ok(result.status === MutantRunStatus.Timeout, `expected a timeout, got ${JSON.stringify(result)}`);
    assert.match(result.reason ?? '', /^Memory limit reached \(\d+\/200 MB\)$/);
  });

  it("limits each mutant run's processes to their file's dry-run peak memory, times 1.5, plus 1024 MB", async (t) => {
    const limit = `process.env.${ENV.memoryLimit}`;
    project(t, { 'a.test.mjs': fixture(`it('fails with its memory limit', () => { if (${limit}) throw new Error(${limit}); });`) });
    const runner = await initRunner(['a.test.mjs']);

    assert.deepEqual(
      complete(await settle(runner.dryRun(DRY_RUN))).tests.map((test) => test.status),
      [TestStatus.Success],
    );
    const limits = [];

    for (const run of [1, 2]) {
      const result = await settle(runner.mutantRun(mutantRunOptions()));
      assert.ok(result.status === MutantRunStatus.Killed, `expected run ${run} to be killed, got ${JSON.stringify(result)}`);
      limits.push(Number(result.failureMessage));
    }

    // A Node.js process that runs one empty test holds well under 500 MB.
    assert.ok(limits[0] !== undefined && limits[0] > 1024 && limits[0] < 1024 + 1.5 * 500, String(limits));
    assert.equal(limits[1], limits[0]);
  });
});

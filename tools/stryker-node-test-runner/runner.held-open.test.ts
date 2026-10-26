import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import { DryRunStatus, MutantRunStatus } from '@stryker-mutator/api/test-runner';

import { ENV } from './hook-core.ts';
import { DRY_RUN, fixture, initRunner, mutantRunOptions, project, settle, shareCompileCache } from './index.fixtures.ts';

shareCompileCache();

const SERVER = "import { createServer } from 'node:http';";
const LISTEN = 'await new Promise((resolve) => createServer().listen(0, resolve));';

/** Shortens the time a test file may stay alive after its tests, for this test only. */
function heldOpenFor(t: TestContext, ms: number): void {
  const previous = process.env[ENV.heldOpen];
  process.env[ENV.heldOpen] = String(ms);
  t.after(() => {
    if (previous === undefined) {
      delete process.env[ENV.heldOpen];
    } else {
      process.env[ENV.heldOpen] = previous;
    }
  });
}

describe('NodeTestRunner with a test file that its tests keep alive', () => {
  it('reports a mutant killed at once when a failed test leaves a server listening', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(SERVER, `it('fails', async () => { ${LISTEN} assert.fail('expected failure'); });`),
    });
    const runner = await initRunner(['a.test.mjs']);

    const result = await settle(runner.mutantRun(mutantRunOptions()));

    assert.equal(result.status, MutantRunStatus.Killed);
    assert.deepEqual('killedBy' in result && result.killedBy, [`${join(dir, 'a.test.mjs')} > fails`]);
  });

  it('ends the dry run of a test file whose passing test leaves a server listening as an error that says what to do', async (t) => {
    heldOpenFor(t, 200);
    const dir = project(t, { 'a.test.mjs': fixture(SERVER, `it('passes', async () => { ${LISTEN} });`) });
    const runner = await initRunner(['a.test.mjs']);

    assert.deepEqual(await settle(runner.dryRun(DRY_RUN)), {
      status: DryRunStatus.Error,
      errorMessage:
        `Test file "${join(dir, 'a.test.mjs')}" stayed alive after its tests and root after hooks ended, held open ` +
        'by TCPServerWrap, so node --test would not end either. Close what its tests open in an after hook, or pass ' +
        '--test-force-exit in lzNodeTest.nodeArgs, as for node --test (NODE_OPTIONS does not allow it); node:test ' +
        'then loses errors raised after a test ended.',
    });
  });

  it('ends the dry run of a held-open file as held open also when node:test filters out a top-level test', async (t) => {
    heldOpenFor(t, 200);
    project(t, {
      'a.test.mjs': fixture(SERVER, `it('passes', async () => { ${LISTEN} });`, "it('filtered out', () => {});"),
    });
    const runner = await initRunner(['a.test.mjs'], { nodeArgs: ['--test-name-pattern=passes'] });

    const result = await settle(runner.dryRun(DRY_RUN));

    assert.equal(result.status, DryRunStatus.Error);
    assert.match('errorMessage' in result ? result.errorMessage : '', /stayed alive .* held open by TCPServerWrap,/);
  });

  it('reports a mutant whose passing test leaves servers listening as timed out, naming them', async (t) => {
    heldOpenFor(t, 200);
    const dir = project(t, { 'a.test.mjs': fixture(SERVER, `it('passes', async () => { ${LISTEN} ${LISTEN} });`) });
    const runner = await initRunner(['a.test.mjs']);

    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions())), {
      status: MutantRunStatus.Timeout,
      reason: `Test file "${join(dir, 'a.test.mjs')}" stayed alive, held open by TCPServerWrap, TCPServerWrap`,
    });
  });

  it('reports an error raised after a test ended, while a server holds the process, as an error', async (t) => {
    heldOpenFor(t, 500);
    project(t, {
      'a.test.mjs': fixture(
        SERVER,
        `it('passes', async () => { ${LISTEN} setTimeout(() => { throw new Error('late'); }, 10); });`,
      ),
    });
    const runner = await initRunner(['a.test.mjs']);

    const result = await settle(runner.mutantRun(mutantRunOptions()));

    assert.equal(result.status, MutantRunStatus.Error);
    assert.match('errorMessage' in result ? result.errorMessage : '', /node exited with code 1 outside any test/);
  });

  it("starts the held-open time once the test file's root after hooks end", async (t) => {
    heldOpenFor(t, 200);
    project(t, {
      'a.test.mjs': fixture(
        SERVER,
        "import { after } from 'node:test';",
        'const server = createServer();',
        'after(async () => {',
        '  await new Promise((resolve) => setTimeout(resolve, 600));',
        '  await new Promise((resolve) => server.close(resolve));',
        '});',
        "it('passes', async () => { await new Promise((resolve) => server.listen(0, resolve)); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);

    assert.equal((await settle(runner.mutantRun(mutantRunOptions()))).status, MutantRunStatus.Survived);
  });

  it('reports a mutant killed at once when node:test times out a root after hook of a file whose test failed', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        SERVER,
        "import { after } from 'node:test';",
        'after(() => new Promise(() => {}), { timeout: 100 });',
        `it('fails', async () => { ${LISTEN} assert.fail('expected failure'); });`,
      ),
    });
    const runner = await initRunner(['a.test.mjs']);

    const result = await settle(runner.mutantRun(mutantRunOptions()));

    assert.equal(result.status, MutantRunStatus.Killed);
    assert.deepEqual('killedBy' in result && result.killedBy, [
      `${join(dir, 'a.test.mjs')} > fails`,
      `${join(dir, 'a.test.mjs')} > "after" hook`,
    ]);
  });

  it('runs a file past the held-open time when an after hook added inside a before hook ran early', async (t) => {
    heldOpenFor(t, 200);
    project(t, {
      'a.test.mjs': fixture(
        "import { after, before } from 'node:test';",
        'before(() => { after(() => {}); });',
        "it('passes slowly', async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);

    assert.equal((await settle(runner.mutantRun(mutantRunOptions()))).status, MutantRunStatus.Survived);
  });
});

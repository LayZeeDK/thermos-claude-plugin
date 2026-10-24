import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MutantRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';

import {
  complete,
  DRY_RUN,
  fixture,
  FIXTURE_HEADER_LINES,
  fixtureCoverage,
  initRunner,
  mutantRunOptions,
  project,
  settle,
  shareCompileCache,
  summary,
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

    assert.deepEqual(
      tests.map(({ id, startPosition }) => ({ id, startPosition })),
      [
        { id: `${a} > once > never runs`, startPosition: { line: FIXTURE_HEADER_LINES + 3, column: 2 } },
        { id: `${a} > once`, startPosition: { line: FIXTURE_HEADER_LINES + 1, column: 0 } },
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

    assert.deepEqual(
      tests.map(({ id, startPosition }) => ({ id, startPosition })),
      [
        { id: `${a} > first`, startPosition: { line: FIXTURE_HEADER_LINES + 1, column: 0 } },
        { id: `${a} > suite > nested`, startPosition: { line: FIXTURE_HEADER_LINES + 3, column: 2 } },
        { id: `${a} > from a helper`, startPosition: { line: FIXTURE_HEADER_LINES + 5, column: 0 } },
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

  it('gives same-named tests of one parent, and names with the separator, ids of their own throughout', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "describe('s', () => {",
        "  it('works', () => { cover('first'); });",
        "  it('works', () => { cover('second'); });",
        '});',
        "describe('a', () => { it('b', () => { cover('nested'); }); });",
        "it('a > b', () => { cover('separator'); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');
    const ids = ['s > works', 's > works (2)', 'a > b', 'a \\> b'].map((name) => `${a} > ${name}`);

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(
      tests.map(({ id, startPosition }) => ({ id, line: startPosition?.line })),
      [
        { id: ids[0], line: 5 },
        { id: ids[1], line: 6 },
        { id: ids[2], line: 8 },
        { id: ids[3], line: 9 },
      ],
    );
    assert.deepEqual(fixtureCoverage(mutantCoverage)?.perTest, {
      [ids[0] as string]: { first: 1 },
      [ids[1] as string]: { second: 1 },
      [ids[2] as string]: { nested: 1 },
      [ids[3] as string]: { separator: 1 },
    });
    assert.deepEqual(await settle(runner.mutantRun(mutantRunOptions({ testFilter: [ids[1] as string] }))), {
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
});

// node:test constructs of the open-source projects the runner was measured on that no other runner test has.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MutantRunStatus, TestStatus } from '@stryker-mutator/api/test-runner';

import {
  complete,
  COVER,
  DRY_RUN,
  fixture,
  fixtureCoverage,
  initRunner,
  mutantRunOptions,
  project,
  settle,
  shareCompileCache,
  summary,
  withoutDuration,
} from './index.fixtures.ts';

shareCompileCache();

const passed = (id: string) => ({ id, status: TestStatus.Success, failureMessage: undefined });

describe('NodeTestRunner with the test context', () => {
  it("reports a test as its plan has it, and counts what runs after a test's body returns as static coverage", async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        // fastify-cookie/test/cookie.test.js:262
        "it('meets its plan', (t) => { t.plan(2); t.assert.ok(true); [1].forEach((n) => t.assert.equal(n, 1)); });",
        "it('misses its plan', (t) => { t.plan(2); t.assert.ok(true); });",
        // fastify/test/404s.test.js:11
        "it('plans its subtests', async (t) => {",
        '  t.plan(2);',
        "  await t.test('one', (t) => { t.plan(1); t.assert.ok(true); cover('one'); });",
        "  await t.test('two', () => { cover('two'); });",
        '});',
        // pino-pretty/test/error-objects.test.js:38
        "it('waits for its plan', (t) => {",
        '  t.plan(1, { wait: true });',
        "  setTimeout(() => { cover('late'); t.assert.ok(true); }, 20);",
        '});',
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun({ ...DRY_RUN, disableBail: true })));

    assert.deepEqual(summary(tests), [
      passed(`${a} > meets its plan`),
      {
        id: `${a} > misses its plan`,
        status: TestStatus.Failed,
        failureMessage: 'plan expected 2 assertions but received 1',
      },
      passed(`${a} > plans its subtests > one`),
      passed(`${a} > plans its subtests > two`),
      passed(`${a} > plans its subtests`),
      passed(`${a} > waits for its plan`),
    ]);
    assert.deepEqual(fixtureCoverage(mutantCoverage), {
      static: { late: 1 },
      perTest: { [`${a} > plans its subtests > one`]: { one: 1 }, [`${a} > plans its subtests > two`]: { two: 1 } },
    });
  });

  it('counts the work of the after hooks a test registers as static coverage, and of its before hooks as its own', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import test, { after, before } from 'node:test';",
        'const ran = [];',
        'let host;',
        // fastify/test/listen.1.test.js:12
        "before(async () => { host = await Promise.resolve('localhost'); });",
        // fastify/test/promises.test.js:7
        "test.after(() => { cover('test.after'); assert.deepEqual(ran, ['t.before', 'child', 'body', 't.after', 'after']); });",
        "it('hooks', async (t) => {",
        // fastify/test/logger/logging.test.js:22
        "  t.before(() => { ran.push('t.before'); cover('t.before'); });",
        // fastify/test/404s.test.js:19
        "  t.after(() => { ran.push('t.after'); cover('t.after'); });",
        // fastify/test/reply-web-stream-locked.test.js:11
        "  after(() => { ran.push('after'); cover('after'); });",
        "  await t.test('child', () => { ran.push('child'); cover('child'); });",
        "  ran.push('body');",
        "  cover('body');",
        '});',
        "it('reads what the before hook set', () => { assert.equal(host, 'localhost'); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(summary(tests), [
      passed(`${a} > hooks > child`),
      passed(`${a} > hooks`),
      passed(`${a} > reads what the before hook set`),
    ]);
    assert.deepEqual(fixtureCoverage(mutantCoverage), {
      static: { 't.after': 1, after: 1, 'test.after': 1 },
      perTest: { [`${a} > hooks`]: { 't.before': 1, body: 1 }, [`${a} > hooks > child`]: { child: 1 } },
    });
    assert.deepEqual(
      withoutDuration(await settle(runner.mutantRun(mutantRunOptions({ testFilter: [`${a} > hooks > child`] })))),
      { status: MutantRunStatus.Survived, nrOfTests: 2 },
    );
  });

  it('names the tests that a helper module registers after the test file whose call registers them', async (t) => {
    const dir = project(t, {
      // fastify/test/helper.js:48
      'helper.mjs': [
        COVER,
        'export function payload(method, t) {',
        '  const test = t.test;',
        '  test(`${method} can be created`, () => { cover(method); });',
        '}',
        // fast-json-stringify/test/json-schema-test-suite/util.js:5
        'export async function each(t, names) {',
        '  for (const name of names) await t.test(name, () => { cover(name); });',
        '}',
        '',
      ].join('\n'),
      'a.test.mjs': fixture(
        "import t from 'node:test';",
        "import { each, payload } from './helper.mjs';",
        "payload('put', t);",
        "it('runs', (t) => each(t, ['first', 'second']));",
      ),
      'b.test.mjs': fixture("import t from 'node:test';", "import { payload } from './helper.mjs';", "payload('put', t);"),
    });
    const runner = await initRunner(['*.test.mjs']);
    const a = join(dir, 'a.test.mjs');
    const b = join(dir, 'b.test.mjs');

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(summary(tests), [
      passed(`${a} > put can be created`),
      passed(`${a} > runs > first`),
      passed(`${a} > runs > second`),
      passed(`${a} > runs`),
      passed(`${b} > put can be created`),
    ]);
    assert.deepEqual(fixtureCoverage(mutantCoverage), {
      static: {},
      perTest: {
        [`${a} > put can be created`]: { put: 1 },
        [`${a} > runs > first`]: { first: 1 },
        [`${a} > runs > second`]: { second: 1 },
        [`${b} > put can be created`]: { put: 1 },
      },
    });
  });

  it('counts the work of a server that a test starts, and closes with t.after, as the coverage of the test', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "import { createServer } from 'node:http';",
        // fastify/test/404s.test.js:11
        "it('serves', async (t) => {",
        "  const server = createServer((req, res) => { cover('handled'); res.end('ok'); });",
        '  await new Promise((resolve) => server.listen(0, resolve));',
        '  t.after(() => new Promise((resolve) => server.close(resolve)));',
        '  const res = await fetch(`http://127.0.0.1:${server.address().port}`);',
        "  assert.equal(await res.text(), 'ok');",
        '});',
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(summary(tests), [passed(`${a} > serves`)]);
    assert.deepEqual(fixtureCoverage(mutantCoverage), { static: {}, perTest: { [`${a} > serves`]: { handled: 1 } } });
  });

  it("counts the work of a test's mocked methods and timers as its own", async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        "it('mocks', (t) => {",
        // fastify/test/router-compile.test.js:58
        '  const clock = { now: () => 1 };',
        "  const now = t.mock.method(clock, 'now', () => 2);",
        '  assert.equal(clock.now(), 2);',
        '  assert.equal(now.mock.callCount(), 1);',
        // fastify/test/plugin.4.test.js:48
        "  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });",
        '  t.after(() => t.mock.timers.reset());',
        "  setTimeout(() => { cover('timer'); }, 10_000);",
        '  t.mock.timers.tick(10_000);',
        '  assert.equal(Date.now(), 10_000);',
        '});',
        "it('runs next', () => { cover('next'); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const { tests, mutantCoverage } = complete(await settle(runner.dryRun(DRY_RUN)));

    assert.deepEqual(summary(tests), [passed(`${a} > mocks`), passed(`${a} > runs next`)]);
    assert.deepEqual(fixtureCoverage(mutantCoverage), {
      static: {},
      perTest: { [`${a} > mocks`]: { timer: 1 }, [`${a} > runs next`]: { next: 1 } },
    });
  });

  it('reports a test as failed when a callback throws while the test awaits, and runs the next test', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        // pino-pretty/test/cli.test.js:21
        "it('awaits', async () => {",
        "  setImmediate(() => { throw new Error('thrown in a callback'); });",
        '  await new Promise(() => {});',
        '});',
        "it('runs next', () => {});",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const { tests } = complete(await settle(runner.dryRun({ ...DRY_RUN, disableBail: true })));

    assert.deepEqual(summary(tests), [
      { id: `${a} > awaits`, status: TestStatus.Failed, failureMessage: 'thrown in a callback' },
      passed(`${a} > runs next`),
    ]);
  });

  it('keeps its results whatever a test writes to stdout', async (t) => {
    const dir = project(t, {
      'a.test.mjs': fixture(
        // pino-pretty/test/cli-rc.test.js:198
        "it('writes', () => { process.stdout.write('TAP version 13\\nnot ok 1 - written\\n'); });",
        "it('fails', () => { throw new Error('expected failure'); });",
      ),
    });
    const runner = await initRunner(['a.test.mjs']);
    const a = join(dir, 'a.test.mjs');

    const { tests } = complete(await settle(runner.dryRun({ ...DRY_RUN, disableBail: true })));

    assert.deepEqual(summary(tests), [
      passed(`${a} > writes`),
      { id: `${a} > fails`, status: TestStatus.Failed, failureMessage: 'expected failure' },
    ]);
  });
});

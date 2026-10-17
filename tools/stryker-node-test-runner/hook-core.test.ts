import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ACTIVE_MUTANT_ENV,
  ENV,
  install,
  installed,
  recordEvents,
  redirectNodeTest,
  reporting,
  wrapNodeTest,
  wrappedNodeTest,
  type HookDependencies,
  type ModuleHooks,
  type NodeTestModule,
  type ProcessRecord,
  type RecordedTest,
  type StrykerNamespace,
  type TestEvent,
} from './hook-core.ts';

type Fn = (this: unknown, ...args: unknown[]) => unknown;

interface Registration {
  /** The node:test function, such as `it` or `it.skip`. */
  kind: string;
  name: string;
  /** The arguments after the name, as the wrapper passed them on. */
  rest: unknown[];
  self: unknown;
}

interface SuiteCall {
  self: unknown;
  args: unknown[];
}

const TEST_FILE = join('/repo', 'a.test.ts');

/**
 * A stand-in for node:test that records registrations. Like node:test, it runs suite bodies, except those of skipped
 * suites, while they are registered (with a recognisable `this` and argument) and reports a suite body that throws
 * instead of throwing. Its tests have `expectFailure` unless it stands in for Node.js 22.
 */
function fakeNodeTest(expectFailure = true) {
  const registrations: Registration[] = [];
  const suiteResults: unknown[] = [];
  const register = (kind: string) =>
    function (this: unknown, name: string, ...rest: unknown[]) {
      registrations.push({ kind, name, rest, self: this });
      const body = rest.find((arg) => typeof arg === 'function') as Fn | undefined;

      if (/^(describe|suite)(\.only|\.todo)?$/.test(kind) && body) {
        try {
          suiteResults.push(body.call('suite this', 'suite argument'));
        } catch (error) {
          suiteResults.push(error);
        }
      }

      return `${kind} ${name}`;
    };
  /** Registers a hook, recorded with its kind as its name and the hook as the first argument after it. */
  const hook = (kind: string) =>
    function (this: unknown, ...rest: unknown[]) {
      registrations.push({ kind, name: kind, rest, self: this });

      return kind;
    };
  const withShorthands = (kind: string, tests = true) =>
    Object.assign(register(kind), {
      skip: register(`${kind}.skip`),
      todo: register(`${kind}.todo`),
      only: register(`${kind}.only`),
      ...(tests && expectFailure && { expectFailure: register(`${kind}.expectFailure`) }),
      mock: `${kind}.mock`,
    });
  // Like node:test, the module is the `test` function, which carries the other functions.
  const test = withShorthands('test');
  const module: NodeTestModule = Object.assign(test, {
    describe: withShorthands('describe', false),
    suite: withShorthands('suite', false),
    it: withShorthands('it'),
    test,
    before: hook('before'),
    beforeEach: hook('beforeEach'),
    run: 'run',
  });

  return { module, registrations, suiteResults };
}

/**
 * A test context as node:test passes it to a test's body, which notes whether the test skipped itself, and whose
 * `test` adds its subtests to `registrations` as `t.test`.
 */
function testContext(registrations: Registration[] = []) {
  const context = {
    skipped: false,
    skip: () => {
      context.skipped = true;
    },
    test: function (this: unknown, name: string, ...rest: unknown[]) {
      registrations.push({ kind: 't.test', name, rest, self: this });

      return `t.test ${name}`;
    },
  };

  return context;
}

/** The body the wrapper registered for the test with this name. */
function rawBodyOf(registrations: Registration[], name: string): Fn {
  const registration = registrations.find((candidate) => candidate.name === name);
  assert.ok(registration, `${name} was not registered`);

  return registration.rest.find((arg) => typeof arg === 'function') as Fn;
}

/** Returns the body the wrapper registered for the test with this name, as a function that returns a promise. */
function bodyOf(registrations: Registration[], name: string): (this: unknown, ...args: unknown[]) => Promise<unknown> {
  const body = rawBodyOf(registrations, name);

  return async function (this: unknown, ...args: unknown[]) {
    return body.apply(this, args);
  };
}

/** Wraps a fake node:test with the given filter, bail setting and mutant to activate at runtime. */
function wrapped(filter?: string[], bail = false, activeMutant?: string) {
  const fake = fakeNodeTest();
  const ns: StrykerNamespace = {};
  const env: Record<string, string | undefined> = {};
  const tests: RecordedTest[] = [];
  /** The current test id each test body saw, by calling `see`. */
  const seen: (string | undefined)[] = [];
  const module = wrapNodeTest({
    ns,
    testFile: TEST_FILE,
    tests,
    filter: filter && new Set(filter),
    bail,
    activeMutant,
    env,
    nodeTest: fake.module,
  });

  return { ...fake, original: fake.module, module, ns, env, tests, seen, see: () => seen.push(ns.currentTestId) };
}

describe('wrapNodeTest', () => {
  it('names tests after the file, the enclosing suites, and the test, for every node:test function', async () => {
    const { module, registrations, seen, see } = wrapped();
    module.describe('outer', () => {
      module.suite('inner', () => {
        module.it('first', see);
      });
      module.test('second', see);
    });
    module.suite('sibling', () => {
      module.it('third', see);
    });
    module.test('top', see);

    for (const name of ['first', 'second', 'third', 'top']) {
      await bodyOf(registrations, name)(testContext());
    }

    assert.deepEqual(seen, [
      `${TEST_FILE} > outer > inner > first`,
      `${TEST_FILE} > outer > second`,
      `${TEST_FILE} > sibling > third`,
      `${TEST_FILE} > top`,
    ]);
  });

  it('leaves the suite after a suite body throws', async () => {
    const { module, registrations, suiteResults, seen, see } = wrapped();
    const failure = new Error('broken suite');
    module.describe('broken', () => {
      throw failure;
    });
    module.it('after', see);

    await bodyOf(registrations, 'after')(testContext());

    assert.equal(suiteResults[0], failure);
    assert.deepEqual(seen, [`${TEST_FILE} > after`]);
  });

  it('passes the name, options, receiver and return values through to node:test', async () => {
    const { module, registrations, suiteResults } = wrapped();
    const options = { timeout: 1000 };
    let suiteCall: SuiteCall | undefined;
    let testCall: SuiteCall | undefined;

    const suiteReturn = module.describe.call(
      'describe this',
      'suite',
      options,
      function (this: unknown, ...args: unknown[]) {
        suiteCall = { self: this, args };

        return 'suite body result';
      },
    );
    const testReturn = module.it.call('it this', 'case', options, function (this: unknown, ...args: unknown[]) {
      testCall = { self: this, args };

      return 'test body result';
    });

    assert.equal(suiteReturn, 'describe suite');
    assert.equal(testReturn, 'it case');
    assert.deepEqual(
      registrations.map(({ kind, name, rest, self }) => ({ kind, name, options: rest[0], self, count: rest.length })),
      [
        { kind: 'describe', name: 'suite', options, self: 'describe this', count: 2 },
        { kind: 'it', name: 'case', options, self: 'it this', count: 2 },
      ],
    );
    assert.deepEqual(suiteCall, { self: 'suite this', args: ['suite argument'] });
    assert.equal(suiteResults[0], 'suite body result');

    const context = testContext();
    const result = await bodyOf(registrations, 'case').call('test this', context, 'second argument');

    assert.deepEqual(testCall, { self: 'test this', args: [context, 'second argument'] });
    assert.equal(result, 'test body result');
  });

  it('registers tests and suites without a body unchanged', () => {
    const { module, registrations } = wrapped();
    module.describe('empty suite');
    module.it('empty test', { timeout: 5 });

    assert.deepEqual(
      registrations.map(({ name, rest }) => ({ name, rest })),
      [
        { name: 'empty suite', rest: [] },
        { name: 'empty test', rest: [{ timeout: 5 }] },
      ],
    );
  });

  it('keeps the other properties of the node:test module and functions', () => {
    const { module } = wrapped();

    for (const kind of ['describe', 'suite', 'it', 'test'] as const) {
      assert.equal((module[kind] as unknown as { mock: string }).mock, `${kind}.mock`);
    }

    assert.equal((module as unknown as { run: string }).run, 'run');
  });

  it('wraps the module, which is the test function, in a copy and leaves node:test unchanged', async () => {
    const { module, original, registrations, seen, see } = wrapped();
    const unwrapped = { ...original };
    module('default export', see);
    module.only('default export only', see);

    for (const name of ['default export', 'default export only']) {
      await bodyOf(registrations, name)(testContext());
    }

    assert.deepEqual(seen, [`${TEST_FILE} > default export`, `${TEST_FILE} > default export only`]);
    assert.equal(module.test, module);
    assert.notEqual(module, original);
    assert.deepEqual({ ...original }, unwrapped);
  });

  it('names the tests of only and todo suites and shorthands after their suites', async () => {
    const { module, registrations, seen, see } = wrapped();
    module.describe.only('describe.only', () => {
      module.it('first', see);
      module.it.only('it.only', see);
    });
    module.suite.only('suite.only', () => {
      module.test.only('test.only', see);
    });
    module.describe.todo('describe.todo', () => {
      module.it.todo('it.todo', see);
    });
    module.suite.todo('suite.todo', () => {
      module.test.todo('test.todo', see);
    });

    for (const name of ['first', 'it.only', 'test.only', 'it.todo', 'test.todo']) {
      await bodyOf(registrations, name)(testContext());
    }

    assert.deepEqual(seen, [
      `${TEST_FILE} > describe.only > first`,
      `${TEST_FILE} > describe.only > it.only`,
      `${TEST_FILE} > suite.only > test.only`,
      `${TEST_FILE} > describe.todo > it.todo`,
      `${TEST_FILE} > suite.todo > test.todo`,
    ]);
    assert.deepEqual(
      registrations.map(({ kind, name }) => `${kind} ${name}`),
      [
        'describe.only describe.only',
        'it first',
        'it.only it.only',
        'suite.only suite.only',
        'test.only test.only',
        'describe.todo describe.todo',
        'it.todo it.todo',
        'suite.todo suite.todo',
        'test.todo test.todo',
      ],
    );
  });

  it('names subtests after the test that registers them, which is current again once they end', async () => {
    const { module, registrations, ns, env, seen, see } = wrapped();
    const context = testContext(registrations);
    const childContext = testContext(registrations);
    module.describe('suite', () => {
      module.it('parent', async (t: { test: (name: string, body: Fn) => unknown }) => {
        see();
        assert.equal(t.test('child', see), 't.test child');
        await bodyOf(registrations, 'child')(childContext);
        see();
      });
    });
    module.test('calls back', (t: { test: (name: string, body: Fn) => unknown }, done: () => void) => {
      t.test('callback child', see);
      done();
    });

    await bodyOf(registrations, 'parent')(context);
    childContext.test('grandchild', see);
    await bodyOf(registrations, 'grandchild')(testContext());
    const callbackContext = testContext(registrations);
    rawBodyOf(registrations, 'calls back')(callbackContext, () => {});
    await bodyOf(registrations, 'callback child')(testContext());

    assert.deepEqual(seen, [
      `${TEST_FILE} > suite > parent`,
      `${TEST_FILE} > suite > parent > child`,
      `${TEST_FILE} > suite > parent`,
      `${TEST_FILE} > suite > parent > child > grandchild`,
      `${TEST_FILE} > calls back > callback child`,
    ]);
    assert.deepEqual(
      registrations.filter(({ kind }) => kind === 't.test').map(({ name, self }) => [name, self]),
      [
        ['child', context],
        ['grandchild', childContext],
        ['callback child', callbackContext],
      ],
    );
    assert.equal(ns.currentTestId, undefined);
    assert.ok(!(ENV.current in env));
  });

  it('runs a test whose subtest the filter selects, and skips the subtests it does not select', async () => {
    const { module, registrations, seen, see } = wrapped([`${TEST_FILE} > parent > wanted`]);
    const skipped: Record<string, boolean> = {};
    const run = async (name: string) => {
      const context = testContext(registrations);
      await bodyOf(registrations, name)(context);
      skipped[name] = context.skipped;
    };
    module.it('parent', async (t: { test: (name: string, body: Fn) => unknown }) => {
      see();
      t.test('wanted', see);
      t.test('unwanted', see);
      await run('wanted');
      await run('unwanted');
    });
    module.it('paren', see);

    await run('parent');
    await run('paren');

    assert.deepEqual(skipped, { wanted: false, unwanted: true, parent: false, paren: true });
    assert.deepEqual(seen, [`${TEST_FILE} > parent`, `${TEST_FILE} > parent > wanted`]);
  });

  it('wraps expectFailure on Node.js 24, where tests have it', async () => {
    const { module, registrations, seen, see } = wrapped();
    module.it.expectFailure?.('it.expectFailure', see);
    module.test.expectFailure?.('test.expectFailure', see);

    for (const name of ['it.expectFailure', 'test.expectFailure']) {
      await bodyOf(registrations, name)(testContext());
    }

    assert.deepEqual(seen, [`${TEST_FILE} > it.expectFailure`, `${TEST_FILE} > test.expectFailure`]);
    assert.equal(module.describe.expectFailure, undefined);

    const node22 = wrapNodeTest({
      ns: {},
      testFile: TEST_FILE,
      tests: [],
      filter: undefined,
      bail: false,
      activeMutant: undefined,
      env: {},
      nodeTest: fakeNodeTest(false).module,
    });

    assert.deepEqual([node22.it.expectFailure, node22.expectFailure], [undefined, undefined]);
  });

  it('rethrows what a test body throws or rejects with', async () => {
    const { module, registrations } = wrapped();
    const failure = new Error('expected 1 to be 2');
    module.it('fails', () => {
      throw failure;
    });
    module.it('rejects with 0', async () => {
      throw 0;
    });

    await assert.rejects(bodyOf(registrations, 'fails')(testContext()), (error) => error === failure);
    await assert.rejects(bodyOf(registrations, 'rejects with 0')(testContext()), (error) => error === 0);
  });

  describe('callback-style tests', () => {
    it('declares `done`, so node:test passes it, and keeps the test current until `done` is called', () => {
      const { module, registrations, ns, env } = wrapped();
      const context = testContext();
      const seen: unknown[] = [];
      let finish: ((error?: unknown) => void) | undefined;
      module.it('calls back', function (this: unknown, t: unknown, done: (error?: unknown) => void) {
        seen.push(this, t);
        finish = done;
      });
      const body = rawBodyOf(registrations, 'calls back');
      const receiver = {};
      const calls: unknown[][] = [];

      assert.equal(body.length, 2);

      body.call(receiver, context, (...args: unknown[]) => calls.push(args));

      assert.deepEqual(seen, [receiver, context]);
      assert.deepEqual([ns.currentTestId, env[ENV.current]], [
        `${TEST_FILE} > calls back`,
        `${TEST_FILE} > calls back`,
      ]);
      assert.deepEqual(calls, []);

      finish?.();

      assert.deepEqual(calls, [[undefined]]);
      assert.equal(ns.currentTestId, undefined);
      assert.ok(!(ENV.current in env));
      assert.equal(context.skipped, false);
    });

    it('passes the error given to `done` on', () => {
      const { module, registrations } = wrapped();
      const failure = new Error('called back with an error');
      module.it('fails', (_t: unknown, done: (error?: unknown) => void) => done(failure));
      const calls: unknown[][] = [];

      rawBodyOf(registrations, 'fails')(testContext(), (...args: unknown[]) => calls.push(args));

      assert.deepEqual(calls, [[failure]]);
    });

    it('rethrows a synchronous throw and leaves the test', () => {
      const { module, registrations, ns } = wrapped();
      module.it('throws', (_t: unknown, _done: unknown) => {
        throw 0;
      });

      assert.throws(
        () => rawBodyOf(registrations, 'throws')(testContext(), () => {}),
        (error) => error === 0,
      );

      assert.equal(ns.currentTestId, undefined);
    });
  });

  it('sets the current test id in the namespace and the environment while the test runs', async () => {
    const { module, registrations, ns, env } = wrapped();
    const seen: unknown[] = [];
    module.it('observes', () => {
      seen.push(ns.currentTestId, env[ENV.current]);
    });

    await bodyOf(registrations, 'observes')(testContext());

    assert.deepEqual(seen, [`${TEST_FILE} > observes`, `${TEST_FILE} > observes`]);
  });

  it('activates the runtime mutant when a test starts and keeps it active, also for processes it starts', async () => {
    const { module, registrations, ns, env } = wrapped(undefined, false, '7');
    const seen: unknown[] = [];
    module.it('first', () => {
      seen.push(ns.activeMutant, env[ACTIVE_MUTANT_ENV]);
    });
    module.it('second', (_t: unknown, done: () => void) => {
      seen.push(ns.activeMutant);
      done();
    });

    assert.deepEqual([ns.activeMutant, env[ACTIVE_MUTANT_ENV]], [undefined, undefined]);

    await bodyOf(registrations, 'first')(testContext());

    assert.deepEqual([ns.activeMutant, env[ACTIVE_MUTANT_ENV]], ['7', '7']);

    ns.activeMutant = undefined;
    await bodyOf(registrations, 'second')(testContext(), () => {});

    assert.deepEqual(seen, ['7', '7', '7']);
  });

  it('activates the runtime mutant before beforeEach hooks and the before hooks of suites run', () => {
    const { module, registrations, ns, env } = wrapped(undefined, false, '7');
    const seen: unknown[] = [];
    const observe = function (this: unknown, ...args: unknown[]) {
      seen.push(ns.activeMutant, env[ACTIVE_MUTANT_ENV], this, args);

      return 'hook result';
    };
    const withDone = (_t: unknown, done: unknown) => (done as () => void)();
    const topLevelBefore = () => {};
    module.before(topLevelBefore, { timeout: 5 });
    module.beforeEach(observe, { timeout: 6 });
    module.beforeEach(withDone);
    module.describe('suite', () => {
      module.before(observe);
    });
    const hooks = registrations.filter(({ kind }) => kind !== 'describe').map(({ kind, rest }) => ({ kind, rest }));

    assert.deepEqual(
      hooks.map(({ kind, rest }) => [kind, rest.slice(1), (rest[0] as Fn).length]),
      [
        ['before', [{ timeout: 5 }], 0],
        ['beforeEach', [{ timeout: 6 }], 0],
        ['beforeEach', [], 2],
        ['before', [], 0],
      ],
    );
    assert.equal(hooks[0]?.rest[0], topLevelBefore);
    assert.deepEqual([ns.activeMutant, env[ACTIVE_MUTANT_ENV]], [undefined, undefined]);

    for (const index of [1, 3]) {
      assert.equal((hooks[index]?.rest[0] as Fn).call('hook this', 'context'), 'hook result');
      ns.activeMutant = undefined;
    }

    assert.deepEqual(seen, ['7', '7', 'hook this', ['context'], '7', '7', 'hook this', ['context']]);
  });

  it('leaves a statically activated mutant alone', async () => {
    const { module, registrations, ns, env } = wrapped();
    ns.activeMutant = '3';
    module.it('runs', () => {});

    await bodyOf(registrations, 'runs')(testContext());

    assert.equal(ns.activeMutant, '3');
    assert.ok(!(ACTIVE_MUTANT_ENV in env));
  });

  it('clears the current test id after a test, also after a failure', async () => {
    const { module, registrations, ns, env } = wrapped();
    module.it('passes', () => {});
    module.it('fails', () => {
      throw new Error('no');
    });

    await bodyOf(registrations, 'passes')(testContext());

    assert.equal(ns.currentTestId, undefined);
    assert.ok(!(ENV.current in env));

    await assert.rejects(bodyOf(registrations, 'fails')(testContext()));

    assert.equal(ns.currentTestId, undefined);
    assert.ok(!(ENV.current in env));
  });

  it('skips the tests outside the filter and runs the others', async () => {
    const filter = [`${TEST_FILE} > group > wanted`, `${TEST_FILE} > elsewhere`];
    const { module, registrations, ns, seen, see } = wrapped(filter);
    module.describe('group', () => {
      module.it('wanted', see);
      module.it('unwanted', see);
    });
    module.test('other', see);
    module.test('calls back', (_t: unknown, done: () => void) => {
      see();
      done();
    });
    const contexts = ['wanted', 'unwanted', 'other', 'calls back'].map((name) => {
      const context = testContext();
      void bodyOf(registrations, name)(context, () => {});

      return context.skipped;
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(contexts, [false, true, true, true]);
    assert.deepEqual(seen, [`${TEST_FILE} > group > wanted`]);
    assert.equal(ns.currentTestId, undefined);
  });

  it('runs every test of the file when the filter names the file itself', async () => {
    const { module, registrations, seen, see } = wrapped([TEST_FILE]);
    module.describe('group', () => {
      module.it('first', see);
    });
    module.test('second', see);

    for (const name of ['first', 'second']) {
      await bodyOf(registrations, name)(testContext());
    }

    assert.deepEqual(seen, [`${TEST_FILE} > group > first`, `${TEST_FILE} > second`]);
  });

  for (const bail of [true, false]) {
    it(`${bail ? 'skips' : 'runs'} the tests after a reported failure with bail ${bail ? 'on' : 'off'}`, async () => {
      const { module, registrations, tests } = wrapped(undefined, bail);
      const ran: string[] = [];
      module.it('before the failure', () => {
        ran.push('before the failure');
      });
      module.it('later', () => {
        ran.push('later');
      });
      module.it('calls back later', (_t: unknown, done: () => void) => {
        ran.push('calls back later');
        done();
      });
      const calls: unknown[][] = [];

      tests.push({ id: `${TEST_FILE} > passed`, status: 'passed', timeSpentMs: 1 });
      tests.push({ id: `${TEST_FILE} > skipped`, status: 'skipped', timeSpentMs: 1 });
      await bodyOf(registrations, 'before the failure')(testContext());
      tests.push({ id: `${TEST_FILE} > failed`, status: 'failed', timeSpentMs: 1 });
      const later = testContext();
      await bodyOf(registrations, 'later')(later);
      const callsBackLater = testContext();
      await bodyOf(registrations, 'calls back later')(callsBackLater, (...args: unknown[]) => calls.push(args));

      assert.deepEqual(ran, bail ? ['before the failure'] : ['before the failure', 'later', 'calls back later']);
      assert.deepEqual([later.skipped, callsBackLater.skipped], [bail, bail]);
      assert.deepEqual(calls, bail ? [[]] : [[undefined]]);
    });
  }
});

/** Reporter events for one test, as node:test reports them: start, then pass or fail. */
function reported(
  name: string,
  nesting: number,
  outcome: 'pass' | 'fail',
  details: NonNullable<TestEvent['data']['details']>,
  flags: { skip?: unknown; todo?: unknown } = {},
): TestEvent[] {
  return [
    { type: 'test:start', data: { name, nesting } },
    { type: `test:${outcome}`, data: { name, nesting, ...flags, details } },
  ];
}

function record(events: TestEvent[]): RecordedTest[] {
  const tests: RecordedTest[] = [];
  const recordEvent = recordEvents(TEST_FILE, tests);

  for (const event of events) {
    recordEvent(event);
  }

  return tests;
}

describe('recordEvents', () => {
  const testDetails = { type: 'test', duration_ms: 1.5 } as const;
  const suiteDetails = { type: 'suite', duration_ms: 3 } as const;

  it('records each test with its status and time, named after the file, its suites and its parent tests', () => {
    assert.deepEqual(
      record([
        { type: 'test:enqueue', data: { name: 'top', nesting: 0 } },
        { type: 'test:start', data: { name: 'outer', nesting: 0 } },
        ...reported('first', 1, 'pass', testDetails),
        { type: 'test:start', data: { name: 'parent', nesting: 1 } },
        ...reported('child', 2, 'pass', testDetails),
        { type: 'test:pass', data: { name: 'parent', nesting: 1, details: { type: 'test', duration_ms: 2 } } },
        ...reported('second', 1, 'pass', testDetails),
        { type: 'test:pass', data: { name: 'outer', nesting: 0, details: suiteDetails } },
        { type: 'test:complete', data: { name: 'outer', nesting: 0, details: suiteDetails } },
        ...reported('top', 0, 'pass', { type: 'test', duration_ms: 0.25 }),
        { type: 'test:diagnostic', data: { name: 'tests 5', nesting: 0 } },
      ]),
      [
        { id: `${TEST_FILE} > outer > first`, status: 'passed', timeSpentMs: 1.5 },
        { id: `${TEST_FILE} > outer > parent > child`, status: 'passed', timeSpentMs: 1.5 },
        { id: `${TEST_FILE} > outer > parent`, status: 'passed', timeSpentMs: 2 },
        { id: `${TEST_FILE} > outer > second`, status: 'passed', timeSpentMs: 1.5 },
        { id: `${TEST_FILE} > top`, status: 'passed', timeSpentMs: 0.25 },
      ],
    );
  });

  it('records a failed test with what it threw, or with the message node:test gives the failure', () => {
    const failure = (message: string, cause: unknown, failureType = 'testCodeFailure') => ({
      ...testDetails,
      error: { failureType, message, cause },
    });

    assert.deepEqual(
      record([
        ...reported('throws', 0, 'fail', failure('wrapped', new Error('expected 1 to be 2'))),
        ...reported('throws text', 0, 'fail', failure('plain text', 'plain text')),
        ...reported('times out', 0, 'fail', failure('test timed out after 5ms', 'test timed out after 5ms')),
        ...reported('hook', 0, 'fail', failure('failed running afterEach hook', new Error('hook'), 'hookFailed')),
        ...reported('without cause', 0, 'fail', { ...testDetails, error: { message: 'no cause' } }),
      ]).map(({ id, status, failureMessage }) => ({ id, status, failureMessage })),
      [
        { id: `${TEST_FILE} > throws`, status: 'failed', failureMessage: 'expected 1 to be 2' },
        { id: `${TEST_FILE} > throws text`, status: 'failed', failureMessage: 'plain text' },
        { id: `${TEST_FILE} > times out`, status: 'failed', failureMessage: 'test timed out after 5ms' },
        { id: `${TEST_FILE} > hook`, status: 'failed', failureMessage: 'hook' },
        { id: `${TEST_FILE} > without cause`, status: 'failed', failureMessage: 'no cause' },
      ],
    );
  });

  it('records skipped and todo tests as skipped, whatever their outcome', () => {
    const error = { failureType: 'testCodeFailure', message: 'not done', cause: new Error('not done') };

    assert.deepEqual(
      record([
        ...reported('skipped', 0, 'pass', testDetails, { skip: true }),
        ...reported('skipped with a reason', 0, 'pass', testDetails, { skip: 'not here' }),
        ...reported('todo', 0, 'pass', testDetails, { todo: true }),
        ...reported('failing todo', 0, 'fail', { ...testDetails, error }, { todo: 'later' }),
      ]),
      [
        { id: `${TEST_FILE} > skipped`, status: 'skipped', timeSpentMs: 1.5 },
        { id: `${TEST_FILE} > skipped with a reason`, status: 'skipped', timeSpentMs: 1.5 },
        { id: `${TEST_FILE} > todo`, status: 'skipped', timeSpentMs: 1.5 },
        { id: `${TEST_FILE} > failing todo`, status: 'skipped', timeSpentMs: 1.5 },
      ],
    );
  });

  it('records a suite only when it fails by itself, not when it passes or a test inside it fails', () => {
    const suiteFailure = (failureType: string, message: string, cause: unknown) => ({
      ...suiteDetails,
      error: { failureType, message, cause },
    });

    assert.deepEqual(
      record([
        ...reported('passes', 0, 'pass', suiteDetails),
        ...reported('fails inside', 0, 'fail', suiteFailure('subtestsFailed', '1 subtest failed', '1 subtest failed')),
        ...reported('before', 0, 'fail', suiteFailure('hookFailed', 'failed running before hook', new Error('before'))),
      ]),
      [{ id: `${TEST_FILE} > before`, status: 'failed', failureMessage: 'before', timeSpentMs: 3 }],
    );
  });
});

let imports = 0;

/**
 * Resolves and loads `node:test` through the module hooks, as an import and as a require, and evaluates both modules
 * with `wrapped` as the wrapped node:test module.
 */
async function importRedirected(hooks: ModuleHooks, wrapped: unknown) {
  const global = globalThis as HookDependencies['global'];
  const previous = global[wrappedNodeTest];
  const passOn = () => assert.fail('passed node:test on');
  const sourceFor = (conditions: string[]) => {
    const { url } = hooks.resolve('node:test', { conditions }, passOn) as { url: string };

    return (hooks.load(url, {}, passOn) as { source: string }).source;
  };

  try {
    global[wrappedNodeTest] = wrapped as NodeTestModule;
    // A comment of its own keeps the import from coming from the module cache.
    const source = `${sourceFor(['node', 'import'])}\n// ${++imports}`;
    const module = (await import(`data:text/javascript,${encodeURIComponent(source)}`)) as Record<string, unknown>;
    const commonjs = { exports: undefined as unknown };
    new Function('module', sourceFor(['node', 'require']))(commonjs);

    return { module, commonjs: commonjs.exports };
  } finally {
    global[wrappedNodeTest] = previous;
  }
}

describe('redirectNodeTest', () => {
  it('resolves node:test to a module of its own for import and for require, and leaves other modules alone', () => {
    const hooks = redirectNodeTest(['it']);
    const passOn = (...args: unknown[]) => ({ passedOn: args });
    const context = { conditions: ['node', 'import'] };
    type Resolved = { url: string; format: string; shortCircuit?: true };
    const imported = hooks.resolve('node:test', context, passOn) as Resolved;
    const required = hooks.resolve('node:test', { conditions: ['node', 'require'] }, passOn) as typeof imported;
    const loaded = [imported, required].map(({ url }) => hooks.load(url, {}, passOn) as typeof imported);

    assert.deepEqual(
      [imported.format, required.format, imported.url === required.url],
      ['module', 'commonjs', false],
    );
    assert.deepEqual([imported, required].map(({ url }) => url.startsWith('node:')), [false, false]);
    // Node.js requires a hook that does not pass a module on to say so.
    assert.deepEqual(
      [imported, required, ...loaded].map(({ format, shortCircuit }) => [format, shortCircuit]),
      [
        ['module', true],
        ['commonjs', true],
        ['module', true],
        ['commonjs', true],
      ],
    );
    assert.deepEqual(hooks.resolve('node:assert', context, passOn), { passedOn: ['node:assert', context] });
    assert.deepEqual(hooks.load('node:assert', context, passOn), { passedOn: ['node:assert', context] });
    assert.deepEqual(hooks.load(`x${imported.url}`, context, passOn), { passedOn: [`x${imported.url}`, context] });
  });

  it('gives the wrapped module as default export and require result, and its properties as named exports', async () => {
    const wrapped = Object.assign(() => 'test', { it: () => 'it', mock: { name: 'mock' } });

    const { module, commonjs } = await importRedirected(redirectNodeTest(['it', 'mock']), wrapped);

    assert.deepEqual({ ...module }, { default: wrapped, it: wrapped.it, mock: wrapped.mock });
    assert.equal(commonjs, wrapped);
  });
});

interface Harness {
  deps: HookDependencies;
  fake: ReturnType<typeof fakeNodeTest>;
  records: { path: string; record: ProcessRecord }[];
  calls: string[];
  /** The module hooks the hook registered. */
  hooks: ModuleHooks[];
  /** The wrapped node:test module the hook published. */
  wrapped: () => NodeTestModule;
  exit: () => void;
}

/** Hook dependencies with fakes, for a process whose main file is the test file unless `mainFile` says otherwise. */
function harness(env: Record<string, string | undefined>, overrides: Partial<HookDependencies> = {}): Harness {
  const fake = fakeNodeTest();
  const records: Harness['records'] = [];
  const calls: string[] = [];
  const hooks: ModuleHooks[] = [];
  const listeners: (() => void)[] = [];
  const deps: HookDependencies = {
    env,
    mainFile: TEST_FILE,
    pid: 4321,
    global: {},
    nodeTest: () => {
      calls.push('nodeTest');

      return fake.module;
    },
    registerHooks: (registered) => {
      calls.push(deps.global[wrappedNodeTest] ? 'registerHooks' : 'registerHooks before publishing');
      hooks.push(registered);
    },
    onExit: (listener) => {
      calls.push('onExit');
      listeners.push(listener);
    },
    writeRecord: (path, record) => {
      records.push({ path, record: JSON.parse(JSON.stringify(record)) as ProcessRecord });
    },
    join,
    ...overrides,
  };

  return {
    deps,
    fake,
    records,
    calls,
    hooks,
    wrapped: () => {
      const wrapped = deps.global[wrappedNodeTest];
      assert.ok(wrapped, 'the hook published no wrapped node:test');

      return wrapped;
    },
    exit: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

const OUT = join('/tmp', 'out');

/** Passes node:test's events for a test to the reporting function the hook installed. */
function report(deps: HookDependencies, name: string, outcome: 'pass' | 'fail'): void {
  const recordEvent = deps.global[reporting];
  assert.ok(recordEvent, 'the hook installed no reporting function');
  const error = { message: `${name} failed` };

  const details = { type: 'test', duration_ms: 2, ...(outcome === 'fail' && { error }) } as const;

  for (const event of reported(name, 0, outcome, details)) {
    recordEvent(event);
  }
}

describe('install', () => {
  it('does nothing when the runner did not start the process tree', () => {
    const { deps, calls } = harness({ [ENV.file]: TEST_FILE });

    assert.equal(install(deps), false);
    assert.deepEqual(deps.global, {});
    assert.deepEqual(calls, []);
  });

  it('does nothing when a hook is already installed in the process', () => {
    const { deps, calls } = harness({ [ENV.out]: OUT, [ENV.file]: TEST_FILE });

    assert.equal(install(deps), true);

    calls.length = 0;

    assert.equal(install(deps), false);
    assert.deepEqual(calls, []);
  });

  it('marks the process with a symbol that every copy of the hook shares', () => {
    const { deps } = harness({ [ENV.out]: OUT });
    install(deps);

    assert.equal(deps.global[installed], true);
    assert.equal(installed, Symbol.for('thermos.stryker-node-test-runner.hook'));
    assert.equal(reporting, Symbol.for('thermos.stryker-node-test-runner.reporting'));
    assert.equal(wrappedNodeTest, Symbol.for('thermos.stryker-node-test-runner.node-test'));
  });

  it('keeps an existing Stryker namespace', () => {
    const ns: StrykerNamespace = { mutantCoverage: { static: { 1: 1 }, perTest: {} } };
    const { deps } = harness({ [ENV.out]: OUT });
    deps.global.__stryker__ = ns;
    install(deps);

    assert.equal(deps.global.__stryker__, ns);
    assert.deepEqual(ns.mutantCoverage, { static: { 1: 1 }, perTest: {} });
  });

  it('sets the hit limit and starts counting when the limit is positive', () => {
    const { deps } = harness({ [ENV.out]: OUT, [ENV.hitLimit]: '25' });
    install(deps);

    assert.equal(deps.global.__stryker__?.hitLimit, 25);
    assert.equal(deps.global.__stryker__?.hitCount, 0);
  });

  for (const hitLimit of [undefined, '0', 'none']) {
    it(`counts no hits with the hit limit ${String(hitLimit)}`, () => {
      const { deps, records, exit } = harness({ [ENV.out]: OUT, [ENV.hitLimit]: hitLimit });
      install(deps);
      exit();

      assert.equal(deps.global.__stryker__?.hitLimit, undefined);
      assert.equal(deps.global.__stryker__?.hitCount, undefined);
      assert.ok(!('hitCount' in (records[0]?.record ?? {})));
    });
  }

  it('attributes the process to the test that started it', () => {
    const { deps } = harness({ [ENV.out]: OUT, [ENV.current]: `${TEST_FILE} > spawns` }, { mainFile: '/other.mjs' });
    install(deps);

    assert.equal(deps.global.__stryker__?.currentTestId, `${TEST_FILE} > spawns`);
  });

  for (const current of [undefined, '']) {
    it(`attributes the process to no test when the current test is ${JSON.stringify(current)}`, () => {
      const { deps } = harness({ [ENV.out]: OUT, [ENV.current]: current });
      deps.global.__stryker__ = { currentTestId: 'stale' };
      install(deps);

      assert.equal(deps.global.__stryker__.currentTestId, undefined);
    });
  }

  it('wraps node:test in the process that runs the test file, and makes imports of node:test give it', async () => {
    const { deps, fake, calls, hooks, wrapped } = harness({ [ENV.out]: OUT, [ENV.file]: TEST_FILE });
    install(deps);

    assert.deepEqual(calls, ['nodeTest', 'registerHooks', 'onExit']);
    assert.equal(hooks.length, 1);
    const names = Object.keys((await importRedirected(hooks[0] as ModuleHooks, wrapped())).module);
    assert.deepEqual(names.sort(), ['default', ...Object.keys(fake.module)].sort());

    const seen: unknown[] = [];
    wrapped().it('runs', () => {
      seen.push(deps.global.__stryker__?.currentTestId);
    });
    await bodyOf(fake.registrations, 'runs')(testContext());

    assert.deepEqual(seen, [`${TEST_FILE} > runs`]);
  });

  for (const [description, env, mainFile] of [
    ['a process the tests spawned', { [ENV.file]: TEST_FILE }, '/repo/child.mjs'],
    ['a process without a main file', { [ENV.file]: TEST_FILE }, undefined],
    ['a run without a test file', {}, undefined],
    ['a run without a test file, from a main file', {}, TEST_FILE],
  ] as const) {
    it(`leaves node:test and its reporter alone in ${description}`, () => {
      const { deps, calls } = harness({ [ENV.out]: OUT, ...env }, { mainFile });

      assert.equal(install(deps), true);
      assert.deepEqual(calls, ['onExit']);
      assert.equal(deps.global[reporting], undefined);
      assert.equal(deps.global[wrappedNodeTest], undefined);
    });
  }

  it('records the tests node:test reports in a file named after the process', () => {
    const { deps, records, exit } = harness({ [ENV.out]: OUT, [ENV.file]: TEST_FILE, [ENV.dryRun]: 'false' });
    install(deps);
    report(deps, 'passes', 'pass');
    report(deps, 'fails', 'fail');

    exit();

    assert.deepEqual(records, [
      {
        path: join(OUT, '4321.json'),
        record: {
          tests: [
            { id: `${TEST_FILE} > passes`, status: 'passed', timeSpentMs: 2 },
            { id: `${TEST_FILE} > fails`, status: 'failed', failureMessage: 'fails failed', timeSpentMs: 2 },
          ],
        },
      },
    ]);
  });

  it('activates the mutant the runner names for runtime activation once a test starts', async () => {
    const { deps, fake, wrapped } = harness({ [ENV.out]: OUT, [ENV.file]: TEST_FILE, [ENV.activeMutant]: '5' });
    install(deps);

    assert.equal(deps.global.__stryker__?.activeMutant, undefined);

    wrapped().it('runs', () => {});
    await bodyOf(fake.registrations, 'runs')(testContext());

    assert.equal(deps.global.__stryker__?.activeMutant, '5');
  });

  it('runs only the filtered tests', async () => {
    const { deps, fake, wrapped } = harness({
      [ENV.out]: OUT,
      [ENV.file]: TEST_FILE,
      [ENV.filter]: JSON.stringify([`${TEST_FILE} > wanted`]),
    });
    const ran: string[] = [];
    install(deps);
    wrapped().it('wanted', () => {
      ran.push('wanted');
    });
    wrapped().it('unwanted', () => {
      ran.push('unwanted');
    });
    await bodyOf(fake.registrations, 'wanted')(testContext());
    await bodyOf(fake.registrations, 'unwanted')(testContext());

    assert.deepEqual(ran, ['wanted']);
  });

  for (const bail of ['true', 'false', undefined]) {
    it(`${bail === 'true' ? 'skips' : 'runs'} later tests with bail ${String(bail)}; children never bail`, async () => {
      const env = { [ENV.out]: OUT, [ENV.file]: TEST_FILE, [ENV.bail]: bail };
      const { deps, fake, wrapped } = harness(env);
      const ran: string[] = [];
      install(deps);
      wrapped().it('later', () => {
        ran.push('later');
      });
      report(deps, 'fails', 'fail');
      await bodyOf(fake.registrations, 'later')(testContext());

      assert.deepEqual(ran, bail === 'true' ? [] : ['later']);
      assert.ok(!(ENV.bail in env));
    });
  }

  it('writes the hit count and, only in the dry run, the mutant coverage', () => {
    const coverage = { static: { 1: 2 }, perTest: { [`${TEST_FILE} > t`]: { 3: 1 } } };
    const written = ['true', 'false', undefined].map((dryRun) => {
      const { deps, records, exit } = harness({ [ENV.out]: OUT, [ENV.dryRun]: dryRun, [ENV.hitLimit]: '9' });
      install(deps);
      const ns = deps.global.__stryker__ as StrykerNamespace;
      ns.mutantCoverage = coverage;
      ns.hitCount = 7;
      exit();

      return records[0]?.record;
    });

    assert.deepEqual(written, [
      { tests: [], hitCount: 7, mutantCoverage: coverage },
      { tests: [], hitCount: 7 },
      { tests: [], hitCount: 7 },
    ]);
  });
});

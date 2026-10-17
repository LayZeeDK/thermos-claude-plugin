import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ENV,
  install,
  installed,
  wrapNodeTest,
  type HookDependencies,
  type NodeTestModule,
  type ProcessRecord,
  type RecordedTest,
  type StrykerNamespace,
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
 * instead of throwing.
 */
function fakeNodeTest() {
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
  const withShorthands = (kind: string) =>
    Object.assign(register(kind), {
      skip: register(`${kind}.skip`),
      todo: register(`${kind}.todo`),
      only: register(`${kind}.only`),
      mock: `${kind}.mock`,
    });
  const module: NodeTestModule = {
    describe: withShorthands('describe'),
    suite: withShorthands('suite'),
    it: withShorthands('it'),
    test: withShorthands('test'),
  };

  return { module, registrations, suiteResults };
}

/** Returns the body the wrapper registered for the test with this name. */
function bodyOf(registrations: Registration[], name: string): (this: unknown, ...args: unknown[]) => Promise<unknown> {
  const registration = registrations.find((candidate) => candidate.name === name);
  assert.ok(registration, `${name} was not registered`);
  const body = registration.rest.find((arg) => typeof arg === 'function') as Fn;

  return async function (this: unknown, ...args: unknown[]) {
    return body.apply(this, args);
  };
}

/** Wraps a fake node:test with the given filter and bail setting and a clock that advances 5 ms per reading. */
function wrapped(filter?: string[], bail = false) {
  const fake = fakeNodeTest();
  const ns: StrykerNamespace = {};
  const env: Record<string, string | undefined> = {};
  const tests: RecordedTest[] = [];
  let clock = 100;
  wrapNodeTest({
    ns,
    testFile: TEST_FILE,
    tests,
    filter: filter && new Set(filter),
    bail,
    env,
    now: () => (clock += 5),
    nodeTest: fake.module,
  });

  return { ...fake, ns, env, tests };
}

describe('wrapNodeTest', () => {
  it('names tests after the file, the enclosing suites, and the test, for every node:test function', async () => {
    const { module, tests, registrations } = wrapped();
    module.describe('outer', () => {
      module.suite('inner', () => {
        module.it('first', () => {});
      });
      module.test('second', () => {});
    });
    module.suite('sibling', () => {
      module.it('third', () => {});
    });
    module.test('top', () => {});

    for (const name of ['first', 'second', 'third', 'top']) {
      await bodyOf(registrations, name)();
    }

    assert.deepEqual(
      tests.map((test) => test.id),
      [
        `${TEST_FILE} > outer > inner > first`,
        `${TEST_FILE} > outer > second`,
        `${TEST_FILE} > sibling > third`,
        `${TEST_FILE} > top`,
      ],
    );
  });

  it('leaves the suite after a suite body throws', async () => {
    const { module, tests, registrations, suiteResults } = wrapped();
    const failure = new Error('broken suite');
    module.describe('broken', () => {
      throw failure;
    });
    module.it('after', () => {});

    await bodyOf(registrations, 'after')();

    assert.equal(suiteResults[0], failure);
    assert.deepEqual(
      tests.map((test) => test.id),
      [`${TEST_FILE} > after`],
    );
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

    const result = await bodyOf(registrations, 'case').call('test context', 'done');

    assert.deepEqual(testCall, { self: 'test context', args: ['done'] });
    assert.equal(result, 'test body result');
  });

  it('registers tests and suites without a body unchanged', () => {
    const { module, registrations, tests } = wrapped();
    module.describe('empty suite');
    module.it('empty test', { timeout: 5 });

    assert.deepEqual(
      registrations.map(({ name, rest }) => ({ name, rest })),
      [
        { name: 'empty suite', rest: [] },
        { name: 'empty test', rest: [{ timeout: 5 }] },
      ],
    );
    assert.deepEqual(tests, []);
  });

  it('keeps the other properties of the node:test functions', () => {
    const { module } = wrapped();

    for (const kind of ['describe', 'suite', 'it', 'test'] as const) {
      assert.equal((module[kind] as unknown as { mock: string }).mock, `${kind}.mock`);
    }
  });

  it('records a skipped test as skipped when it is registered, and never runs it', () => {
    const { module, registrations, tests } = wrapped();
    const run = () => assert.fail('ran a skipped test');
    module.describe('suite', () => {
      module.it('option', { skip: true }, run);
    });
    module.test('reason', { skip: 'not on this platform' }, run);
    module.it('skipped todo', { skip: true, todo: true }, run);
    module.it.skip('it.skip', run);
    module.test.skip('test.skip', run);
    module.it('not skipped', { skip: false }, () => {});

    assert.deepEqual(tests, [
      { id: `${TEST_FILE} > suite > option`, status: 'skipped', timeSpentMs: 0 },
      { id: `${TEST_FILE} > reason`, status: 'skipped', timeSpentMs: 0 },
      { id: `${TEST_FILE} > skipped todo`, status: 'skipped', timeSpentMs: 0 },
      { id: `${TEST_FILE} > it.skip`, status: 'skipped', timeSpentMs: 0 },
      { id: `${TEST_FILE} > test.skip`, status: 'skipped', timeSpentMs: 0 },
    ]);
    assert.deepEqual(
      registrations.map(({ kind, name }) => `${kind} ${name}`),
      [
        'describe suite',
        'it option',
        'test reason',
        'it skipped todo',
        'it.skip it.skip',
        'test.skip test.skip',
        'it not skipped',
      ],
    );
  });

  it('runs a todo test but records it as skipped whatever its outcome, so it never bails', async () => {
    const { module, registrations, tests } = wrapped(undefined, true);
    const failure = new Error('not done yet');
    const ran: string[] = [];
    const fails = (name: string) => () => {
      ran.push(name);
      throw failure;
    };
    module.it('option', { todo: 'later' }, fails('option'));
    module.it.todo('it.todo', fails('it.todo'));
    module.test.todo('test.todo', () => {
      ran.push('test.todo');
    });
    module.describe('todo suite', { todo: true }, () => {
      module.it('inside', fails('inside'));
    });
    module.it.todo('without a body');
    module.it('options without a body', { todo: true });
    module.it('after', () => {
      ran.push('after');
    });

    for (const name of ['option', 'it.todo', 'inside']) {
      await assert.rejects(bodyOf(registrations, name)(), (error) => error === failure);
    }

    for (const name of ['test.todo', 'after']) {
      await bodyOf(registrations, name)();
    }

    assert.deepEqual(ran, ['option', 'it.todo', 'inside', 'test.todo', 'after']);
    assert.deepEqual(tests, [
      { id: `${TEST_FILE} > without a body`, status: 'skipped', timeSpentMs: 0 },
      { id: `${TEST_FILE} > options without a body`, status: 'skipped', timeSpentMs: 0 },
      { id: `${TEST_FILE} > option`, status: 'skipped', timeSpentMs: 5 },
      { id: `${TEST_FILE} > it.todo`, status: 'skipped', timeSpentMs: 5 },
      { id: `${TEST_FILE} > todo suite > inside`, status: 'skipped', timeSpentMs: 5 },
      { id: `${TEST_FILE} > test.todo`, status: 'skipped', timeSpentMs: 5 },
      { id: `${TEST_FILE} > after`, status: 'passed', timeSpentMs: 5 },
    ]);
  });

  it('records a passing test with the time it took', async () => {
    const { module, registrations, tests } = wrapped();
    module.it('passes', () => {});

    await bodyOf(registrations, 'passes')();

    assert.deepEqual(tests, [{ id: `${TEST_FILE} > passes`, status: 'passed', timeSpentMs: 5 }]);
  });

  it('records a failing test with its message and rethrows the error', async () => {
    const { module, registrations, tests } = wrapped();
    const failure = new Error('expected 1 to be 2');
    module.it('fails', () => {
      throw failure;
    });
    module.it('rejects', async () => {
      throw failure;
    });

    await assert.rejects(bodyOf(registrations, 'fails')(), (error) => error === failure);
    await assert.rejects(bodyOf(registrations, 'rejects')(), (error) => error === failure);

    assert.deepEqual(tests, [
      { id: `${TEST_FILE} > fails`, status: 'failed', failureMessage: 'expected 1 to be 2', timeSpentMs: 5 },
      { id: `${TEST_FILE} > rejects`, status: 'failed', failureMessage: 'expected 1 to be 2', timeSpentMs: 5 },
    ]);
  });

  it('records a thrown value that is not an Error as text', async () => {
    const { module, registrations, tests } = wrapped();
    module.it('throws a string', () => {
      throw 'plain text';
    });

    await assert.rejects(bodyOf(registrations, 'throws a string')(), (error) => error === 'plain text');

    assert.equal(tests[0]?.failureMessage, 'plain text');
  });

  it('records a rejection with a falsy value as a failure', async () => {
    const { module, registrations, tests } = wrapped();
    module.it('rejects with 0', async () => {
      throw 0;
    });

    await assert.rejects(bodyOf(registrations, 'rejects with 0')(), (error) => error === 0);

    assert.deepEqual(tests, [
      { id: `${TEST_FILE} > rejects with 0`, status: 'failed', failureMessage: '0', timeSpentMs: 5 },
    ]);
  });

  describe('callback-style tests', () => {
    /** The registered body itself, which node:test inspects for a `done` parameter. */
    function rawBodyOf(registrations: Registration[], name: string): Fn {
      const registration = registrations.find((candidate) => candidate.name === name);
      assert.ok(registration, `${name} was not registered`);

      return registration.rest.find((arg) => typeof arg === 'function') as Fn;
    }

    it('declares `done`, so node:test passes it, and records the test when `done` is called', () => {
      const { module, registrations, tests, ns, env } = wrapped();
      const context = {};
      const seen: unknown[] = [];
      let finish: ((error?: unknown) => void) | undefined;
      module.it('calls back', function (this: unknown, t: unknown, done: (error?: unknown) => void) {
        seen.push(this, t, ns.currentTestId, env[ENV.current]);
        finish = done;
      });
      const body = rawBodyOf(registrations, 'calls back');
      const receiver = {};
      const calls: unknown[][] = [];

      assert.equal(body.length, 2);

      body.call(receiver, context, (...args: unknown[]) => calls.push(args));

      assert.deepEqual(seen, [receiver, context, `${TEST_FILE} > calls back`, `${TEST_FILE} > calls back`]);
      assert.deepEqual(tests, []);

      finish?.();

      assert.deepEqual(calls, [[undefined]]);
      assert.deepEqual(tests, [{ id: `${TEST_FILE} > calls back`, status: 'passed', timeSpentMs: 5 }]);
      assert.equal(ns.currentTestId, undefined);
      assert.ok(!(ENV.current in env));
    });

    it('records the error passed to `done` as a failure and passes it on', () => {
      const { module, registrations, tests } = wrapped();
      const failure = new Error('called back with an error');
      module.it('fails', (_t: unknown, done: (error?: unknown) => void) => done(failure));
      module.it('passes with null', (_t: unknown, done: (error?: unknown) => void) => done(null));
      const calls: unknown[][] = [];

      for (const name of ['fails', 'passes with null']) {
        rawBodyOf(registrations, name)({}, (...args: unknown[]) => calls.push(args));
      }

      assert.deepEqual(calls, [[failure], [null]]);
      assert.deepEqual(tests, [
        { id: `${TEST_FILE} > fails`, status: 'failed', failureMessage: 'called back with an error', timeSpentMs: 5 },
        { id: `${TEST_FILE} > passes with null`, status: 'passed', timeSpentMs: 5 },
      ]);
    });

    it('records a synchronous throw as a failure and rethrows it', () => {
      const { module, registrations, tests, ns } = wrapped();
      module.it('throws', (_t: unknown, _done: unknown) => {
        throw 0;
      });

      assert.throws(
        () => rawBodyOf(registrations, 'throws')({}, () => {}),
        (error) => error === 0,
      );

      assert.deepEqual(tests, [{ id: `${TEST_FILE} > throws`, status: 'failed', failureMessage: '0', timeSpentMs: 5 }]);
      assert.equal(ns.currentTestId, undefined);
    });
  });

  it('sets the current test id in the namespace and the environment while the test runs', async () => {
    const { module, registrations, ns, env } = wrapped();
    const seen: unknown[] = [];
    module.it('observes', () => {
      seen.push(ns.currentTestId, env[ENV.current]);
    });

    await bodyOf(registrations, 'observes')();

    assert.deepEqual(seen, [`${TEST_FILE} > observes`, `${TEST_FILE} > observes`]);
  });

  it('clears the current test id after a test, also after a failure', async () => {
    const { module, registrations, ns, env } = wrapped();
    module.it('passes', () => {});
    module.it('fails', () => {
      throw new Error('no');
    });

    await bodyOf(registrations, 'passes')();

    assert.equal(ns.currentTestId, undefined);
    assert.ok(!(ENV.current in env));

    await assert.rejects(bodyOf(registrations, 'fails')());

    assert.equal(ns.currentTestId, undefined);
    assert.ok(!(ENV.current in env));
  });

  it('skips the bodies of tests outside the filter and runs the others', async () => {
    const { module, registrations, tests, ns } = wrapped([`${TEST_FILE} > group > wanted`]);
    const ran: string[] = [];
    module.describe('group', () => {
      module.it('wanted', () => {
        ran.push('wanted');
      });
      module.it('unwanted', () => {
        ran.push('unwanted');
      });
    });
    module.test('other', () => {
      ran.push('other');
    });

    for (const name of ['wanted', 'unwanted', 'other']) {
      await bodyOf(registrations, name)();
    }

    assert.deepEqual(ran, ['wanted']);
    assert.deepEqual(
      tests.map((test) => test.id),
      [`${TEST_FILE} > group > wanted`],
    );
    assert.equal(ns.currentTestId, undefined);
  });

  it('runs every test of the file when the filter names the file itself', async () => {
    const { module, registrations, tests } = wrapped([TEST_FILE]);
    module.describe('group', () => {
      module.it('first', () => {});
    });
    module.test('second', () => {});

    for (const name of ['first', 'second']) {
      await bodyOf(registrations, name)();
    }

    assert.deepEqual(
      tests.map((test) => test.id),
      [`${TEST_FILE} > group > first`, `${TEST_FILE} > second`],
    );
  });

  for (const bail of [true, false]) {
    it(`${bail ? 'skips' : 'runs'} the tests after a failure with bail ${bail ? 'on' : 'off'}`, async () => {
      const { module, registrations, tests } = wrapped(undefined, bail);
      const ran: string[] = [];
      module.it('passes', () => {
        ran.push('passes');
      });
      module.it('fails', () => {
        ran.push('fails');
        throw new Error('no');
      });
      module.it('later', () => {
        ran.push('later');
      });
      module.it('calls back later', (_t: unknown, done: () => void) => {
        ran.push('calls back later');
        done();
      });
      const calls: unknown[][] = [];

      await bodyOf(registrations, 'passes')();
      await assert.rejects(bodyOf(registrations, 'fails')());
      await bodyOf(registrations, 'later')();
      await bodyOf(registrations, 'calls back later')({}, (...args: unknown[]) => calls.push(args));

      const all = ['passes', 'fails', 'later', 'calls back later'];
      assert.deepEqual(ran, bail ? all.slice(0, 2) : all);
      assert.deepEqual(
        tests.map((test) => test.id),
        ran.map((name) => `${TEST_FILE} > ${name}`),
      );
      assert.deepEqual(calls, [bail ? [] : [undefined]]);
    });
  }
});

interface Harness {
  deps: HookDependencies;
  fake: ReturnType<typeof fakeNodeTest>;
  records: { path: string; record: ProcessRecord }[];
  calls: string[];
  exit: () => void;
}

/** Hook dependencies with fakes, for a process whose main file is the test file unless `mainFile` says otherwise. */
function harness(env: Record<string, string | undefined>, overrides: Partial<HookDependencies> = {}): Harness {
  const fake = fakeNodeTest();
  const unwrappedIt = fake.module.it;
  const records: Harness['records'] = [];
  const calls: string[] = [];
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
    publishNodeTest: () => {
      calls.push(fake.module.it === unwrappedIt ? 'publishNodeTest before wrapping' : 'publishNodeTest');
    },
    onExit: (listener) => {
      calls.push('onExit');
      listeners.push(listener);
    },
    writeRecord: (path, record) => {
      records.push({ path, record: JSON.parse(JSON.stringify(record)) as ProcessRecord });
    },
    now: () => 0,
    join,
    ...overrides,
  };

  return {
    deps,
    fake,
    records,
    calls,
    exit: () => {
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

const OUT = join('/tmp', 'out');

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

  it('wraps node:test, then publishes it, in the process that runs the test file', async () => {
    const { deps, fake, calls } = harness({ [ENV.out]: OUT, [ENV.file]: TEST_FILE });
    install(deps);

    assert.deepEqual(calls, ['nodeTest', 'publishNodeTest', 'onExit']);

    fake.module.it('runs', () => {});
    await bodyOf(fake.registrations, 'runs')();

    assert.equal(deps.global.__stryker__?.currentTestId, undefined);
  });

  for (const [description, env, mainFile] of [
    ['a process the tests spawned', { [ENV.file]: TEST_FILE }, '/repo/child.mjs'],
    ['a process without a main file', { [ENV.file]: TEST_FILE }, undefined],
    ['a run without a test file', {}, undefined],
    ['a run without a test file, from a main file', {}, TEST_FILE],
  ] as const) {
    it(`leaves node:test alone in ${description}`, () => {
      const { deps, calls } = harness({ [ENV.out]: OUT, ...env }, { mainFile });

      assert.equal(install(deps), true);
      assert.deepEqual(calls, ['onExit']);
    });
  }

  it('records the tests of the test file in a file named after the process', async () => {
    let clock = 0;
    const { deps, fake, records, exit } = harness(
      { [ENV.out]: OUT, [ENV.file]: TEST_FILE, [ENV.dryRun]: 'false' },
      { now: () => (clock += 3) },
    );
    install(deps);
    fake.module.it('passes', () => {});
    fake.module.it('fails', () => {
      throw new Error('nope');
    });
    await bodyOf(fake.registrations, 'passes')();
    await assert.rejects(bodyOf(fake.registrations, 'fails')());

    exit();

    assert.deepEqual(records, [
      {
        path: join(OUT, '4321.json'),
        record: {
          tests: [
            { id: `${TEST_FILE} > passes`, status: 'passed', timeSpentMs: 3 },
            { id: `${TEST_FILE} > fails`, status: 'failed', failureMessage: 'nope', timeSpentMs: 3 },
          ],
        },
      },
    ]);
  });

  it('runs only the filtered tests', async () => {
    const { deps, fake, records, exit } = harness({
      [ENV.out]: OUT,
      [ENV.file]: TEST_FILE,
      [ENV.filter]: JSON.stringify([`${TEST_FILE} > wanted`]),
    });
    const ran: string[] = [];
    install(deps);
    fake.module.it('wanted', () => {
      ran.push('wanted');
    });
    fake.module.it('unwanted', () => {
      ran.push('unwanted');
    });
    await bodyOf(fake.registrations, 'wanted')();
    await bodyOf(fake.registrations, 'unwanted')();
    exit();

    assert.deepEqual(ran, ['wanted']);
    assert.deepEqual(
      records[0]?.record.tests.map((test) => test.id),
      [`${TEST_FILE} > wanted`],
    );
  });

  for (const bail of ['true', 'false', undefined]) {
    it(`${bail === 'true' ? 'skips' : 'runs'} later tests with bail ${String(bail)}; children never bail`, async () => {
      const env = { [ENV.out]: OUT, [ENV.file]: TEST_FILE, [ENV.bail]: bail };
      const { deps, fake } = harness(env);
      const ran: string[] = [];
      install(deps);
      fake.module.it('fails', () => {
        throw new Error('no');
      });
      fake.module.it('later', () => {
        ran.push('later');
      });
      await assert.rejects(bodyOf(fake.registrations, 'fails')());
      await bodyOf(fake.registrations, 'later')();

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

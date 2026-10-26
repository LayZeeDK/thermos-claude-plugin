import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { InstrumenterContext, Position } from '@stryker-mutator/api/core';

import { testEach } from '../test-each/test-each.ts';
import { testFor } from '../test-each/test-for.ts';
import {
  ENV,
  install,
  installed,
  recordEvents,
  redirectNodeTest,
  reporting,
  testId,
  uniqueIds,
  watchdog,
  wrappedNodeTest,
  writesAllowed,
  type HookDependencies,
  type ModuleHooks,
  type NodeTestModule,
  type ProcessRecord,
  type RecordedTest,
  type TestEvent,
} from './hook-core.ts';
import { bodyOf, fakeNodeTest, TEST_FILE, testContext, type Fn } from './hook-core.fixtures.ts';

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

function record(
  events: TestEvent[],
  positions = new Map<string, Position>(),
  diagnostics: string[] = [],
): RecordedTest[] {
  const tests: RecordedTest[] = [];
  const recordEvent = recordEvents(TEST_FILE, tests, positions, diagnostics);

  for (const event of events) {
    recordEvent(event);
  }

  return tests;
}

describe('testId', () => {
  testFor([
    ['a > b', `${TEST_FILE} > a \\> b`],
    ['x > > y', `${TEST_FILE} > x \\> \\> y`],
    ['> a', `${TEST_FILE} > \\> a`],
    ['a >', `${TEST_FILE} > a \\>`],
    ['>', `${TEST_FILE} > \\>`],
    ['a \\ > b', `${TEST_FILE} > a \\\\ \\> b`],
  ] as const)('escapes `>` and `\\` in a name whose `>` could form the separator: %j', ([name, id]) => {
    assert.equal(testId(TEST_FILE, name), id);
  });

  testEach(['a name', 'a \\ b', 'a \\> b', '<anonymous>', 'a -> b', 'a >b', 'a> b', ' >b', 'b> '])(
    'leaves a name whose `>` cannot form the separator as it is: %j',
    (name) => {
      assert.equal(testId(TEST_FILE, name), `${TEST_FILE} > ${name}`);
    },
  );
});

describe('uniqueIds', () => {
  it('numbers the suites and tests that would share an id from 2, in the order they are named', () => {
    const idOf = uniqueIds();

    assert.deepEqual(
      [
        idOf(TEST_FILE, 'works'),
        idOf(TEST_FILE, 'works'),
        idOf(TEST_FILE, 'works (2)'),
        idOf(TEST_FILE, 'works'),
        idOf(testId(TEST_FILE, 's'), 'works'),
      ],
      [
        `${TEST_FILE} > works`,
        `${TEST_FILE} > works (2)`,
        `${TEST_FILE} > works (2) (2)`,
        `${TEST_FILE} > works (3)`,
        `${TEST_FILE} > s > works`,
      ],
    );
  });
});

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

  it('records where the wrapper found that a test is declared', () => {
    const positions = new Map([[`${TEST_FILE} > declared`, { line: 2, column: 0 }]]);

    assert.deepEqual(
      record(
        [...reported('declared', 0, 'pass', testDetails), ...reported('unknown', 0, 'pass', testDetails)],
        positions,
      ),
      [
        { id: `${TEST_FILE} > declared`, status: 'passed', timeSpentMs: 1.5, startPosition: { line: 2, column: 0 } },
        { id: `${TEST_FILE} > unknown`, status: 'passed', timeSpentMs: 1.5 },
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

  it('records a suite only when it fails by itself or is skipped, not when it passes or a test inside it fails', () => {
    const suiteFailure = (failureType: string, message: string, cause: unknown) => ({
      ...suiteDetails,
      error: { failureType, message, cause },
    });

    assert.deepEqual(
      record([
        ...reported('passes', 0, 'pass', suiteDetails),
        ...reported('fails inside', 0, 'fail', suiteFailure('subtestsFailed', '1 subtest failed', '1 subtest failed')),
        ...reported('before', 0, 'fail', suiteFailure('hookFailed', 'failed running before hook', new Error('before'))),
        ...reported('skipped', 0, 'pass', suiteDetails, { skip: true }),
        ...reported('skipped with a reason', 0, 'pass', suiteDetails, { skip: 'not here' }),
      ]),
      [
        { id: `${TEST_FILE} > before`, status: 'failed', failureMessage: 'before', timeSpentMs: 3 },
        { id: `${TEST_FILE} > skipped`, status: 'skipped', timeSpentMs: 3 },
        { id: `${TEST_FILE} > skipped with a reason`, status: 'skipped', timeSpentMs: 3 },
      ],
    );
  });

  it('records the failure of the test file itself, from an `after` hook outside any suite, as that hook', () => {
    const error = { failureType: 'hookFailed', message: 'after failure', cause: new Error('after failure') };

    assert.deepEqual(
      record([
        ...reported('passes', 0, 'pass', testDetails),
        { type: 'test:fail', data: { name: TEST_FILE, nesting: 0, details: { duration_ms: 4, error } } },
      ]),
      [
        { id: `${TEST_FILE} > passes`, status: 'passed', timeSpentMs: 1.5 },
        { id: `${TEST_FILE} > "after" hook`, status: 'failed', failureMessage: 'after failure', timeSpentMs: 4 },
      ],
    );
  });

  it('tells same-named suites and tests of one parent apart in the order node:test reports them, as the wrapper does', () => {
    const suite = (name: string, ...inside: TestEvent[]): TestEvent[] => [
      { type: 'test:start', data: { name, nesting: 0 } },
      ...inside,
      { type: 'test:pass', data: { name, nesting: 0, details: suiteDetails } },
    ];

    assert.deepEqual(
      record([
        ...suite('s', ...reported('works', 1, 'pass', testDetails), ...reported('works', 1, 'pass', testDetails)),
        ...suite('s', ...reported('works', 1, 'pass', testDetails)),
        ...reported('a > b', 0, 'pass', testDetails),
      ]).map(({ id }) => id),
      [`${TEST_FILE} > s > works`, `${TEST_FILE} > s > works (2)`, `${TEST_FILE} > s (2) > works`, `${TEST_FILE} > a \\> b`],
    );
  });

  it('keeps the diagnostics of errors raised after a test ended, and no others', () => {
    const late =
      'Error: Test "late" at a.test.mjs:1:1 generated asynchronous activity after the test ended. This activity ' +
      'created the error "Error: boom" and would have caused the test to fail, but instead triggered an ' +
      'uncaughtException event.';
    const diagnostic = (message: string): TestEvent => ({
      type: 'test:diagnostic',
      data: { name: '', nesting: 0, message },
    });
    const diagnostics: string[] = [];

    const tests = record(
      [
        diagnostic(late),
        diagnostic('tests 1'),
        { type: 'test:stdout', data: { name: '', nesting: 0, message: late } },
        diagnostic(`${late} Again.`),
        ...reported('late', 0, 'pass', testDetails),
      ],
      new Map(),
      diagnostics,
    );

    assert.deepEqual(diagnostics, [late, `${late} Again.`]);
    assert.equal(tests.length, 1);
  });

  it("records where the wrapper found the test file's failing `after` hook", () => {
    const error = { failureType: 'hookFailed', message: 'after failure' };
    const positions = new Map([[`${TEST_FILE} > "after" hook`, { line: 2, column: 4 }]]);

    assert.deepEqual(
      record([{ type: 'test:fail', data: { name: TEST_FILE, nesting: 0, details: { duration_ms: 4, error } } }], positions),
      [
        {
          id: `${TEST_FILE} > "after" hook`,
          status: 'failed',
          failureMessage: 'after failure',
          timeSpentMs: 4,
          startPosition: { line: 2, column: 4 },
        },
      ],
    );
  });
});

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
    const source = `${sourceFor(['node', 'import'])}\n// ${randomUUID()}`;
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
  hooks: ModuleHooks[];
  wrapped: () => NodeTestModule;
  /** Adds an exit listener as the test file would, after the hook's. */
  onExit: (listener: () => void) => void;
  /** Runs the listeners as Node.js does: `beforeExit` on a natural end, then the exit listeners there are then. */
  exit: (options?: { natural: boolean }) => void;
  /** The codes the hook ended the process with, `undefined` for node:test's own. */
  exits: (number | undefined)[];
  /** The timers the hook set, by delay, which a test fires by calling them. */
  timers: { ms: number; fire: () => void }[];
  /** What `process.getActiveResourcesInfo()` lists, to which a test adds what its tests open. */
  resources: string[];
}

function harness(env: Record<string, string | undefined>, overrides: Partial<HookDependencies> = {}): Harness {
  const fake = fakeNodeTest();
  const records: Harness['records'] = [];
  const calls: string[] = [];
  const hooks: ModuleHooks[] = [];
  const listeners: (() => void)[] = [];
  const beforeExitListeners: (() => void)[] = [];
  const exits: Harness['exits'] = [];
  const timers: Harness['timers'] = [];
  const resources = ['PipeWrap'];
  const deps: HookDependencies = {
    env,
    mainFile: TEST_FILE,
    pid: 4321,
    threadId: 0,
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
    offExit: (listener) => {
      calls.push('offExit');
      listeners.splice(listeners.lastIndexOf(listener), 1);
    },
    onBeforeExit: (listener) => {
      beforeExitListeners.push(listener);
    },
    writeRecord: (path, record) => {
      records.push({ path, record: JSON.parse(JSON.stringify(record)) as ProcessRecord });
    },
    exit: (code) => {
      exits.push(code);
    },
    activeResources: () => [...resources],
    later: (fire, ms) => {
      timers.push({ ms, fire });
    },
    canWriteRecords: true,
    peakMemoryMB: () => 123,
    canWatchMemory: true,
    watchMemory: (options) => {
      calls.push(`watchMemory ${JSON.stringify(options)}`);

      return 'the watchdog';
    },
    callSites: () => [],
    ...overrides,
  };

  return {
    deps,
    fake,
    records,
    calls,
    hooks,
    exits,
    timers,
    resources,
    wrapped: () => {
      const wrapped = deps.global[wrappedNodeTest];
      assert.ok(wrapped, 'the hook published no wrapped node:test');

      return wrapped;
    },
    onExit: (listener) => {
      listeners.push(listener);
    },
    exit: ({ natural } = { natural: true }) => {
      for (const listener of natural ? [...beforeExitListeners] : []) {
        listener();
      }

      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}

const OUT = join('/tmp', 'out');

/** The `after` hooks registered with node:test, in order; the hook's own comes first. */
function afterHooks(fake: ReturnType<typeof fakeNodeTest>): Fn[] {
  return fake.registrations.filter(({ kind }) => kind === 'after').map(({ rest }) => rest[0] as Fn);
}

/** A test file whose test, `name`, has run its body and been reported. */
async function ranAndReported(h: Harness, name: string, outcome: 'pass' | 'fail'): Promise<void> {
  h.wrapped().it(name, () => {});
  await bodyOf(h.fake.registrations, name)(testContext());
  report(h.deps, name, outcome);
}

function report(deps: HookDependencies, name: string, outcome: 'pass' | 'fail'): void {
  const recordEvent = deps.global[reporting];
  assert.ok(recordEvent, 'the hook installed no reporting function');
  const error = { message: `${name} failed` };

  const details = { type: 'test', duration_ms: 2, ...(outcome === 'fail' && { error }) } as const;

  for (const event of reported(name, 0, outcome, details)) {
    recordEvent(event);
  }
}

describe('writesAllowed', () => {
  testFor([
    ['outside the permission model', undefined, true],
    ['under the permission model with write access', true, true],
    ['under the permission model without write access', false, false],
  ] as const)('lets a process write its record %s, or not', ([, allowed, expected]) => {
    const asked: [string, string | undefined][] = [];
    const permission =
      allowed === undefined
        ? undefined
        : {
            has: (scope: string, reference?: string) => {
              asked.push([scope, reference]);

              return allowed;
            },
          };

    assert.equal(writesAllowed(permission, OUT), expected);
    assert.deepEqual(asked, allowed === undefined ? [] : [['fs.write', OUT]]);
  });
});

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
    assert.equal(watchdog, Symbol.for('thermos.stryker-node-test-runner.watchdog'));
  });

  it('keeps an existing Stryker namespace', () => {
    const ns: InstrumenterContext = { mutantCoverage: { static: { 1: 1 }, perTest: {} } };
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

  it("watches the process's memory when the memory limit is positive, with a record of its own in the out directory", () => {
    const { deps, calls } = harness({ [ENV.out]: OUT, [ENV.memoryLimit]: '1500' });
    install(deps);

    const options = {
      workerData: { limitMB: 1500, recordPath: join(OUT, '4321.memory.json') },
      execArgv: [],
      env: {},
    };
    assert.deepEqual(calls, [`watchMemory ${JSON.stringify(options)}`, 'onExit']);
    assert.equal(deps.global[watchdog], 'the watchdog');
  });

  testFor([
    ['', {}, {}],
    [', except the compile cache when the process has one', { NODE_COMPILE_CACHE: 'cache' }, { NODE_COMPILE_CACHE: 'cache' }],
  ] as const)("starts the memory watchdog without the process's environment%s", ([, env, expected]) => {
    const started: unknown[] = [];
    const { deps } = harness(
      { [ENV.out]: OUT, [ENV.memoryLimit]: '1500', NODE_OPTIONS: '--require x.cjs', ...env },
      { watchMemory: (options) => started.push(options.env) },
    );
    install(deps);

    assert.deepEqual(started, [expected]);
  });

  it('watches no memory in a thread that may not start the watchdog', () => {
    const { deps, calls } = harness({ [ENV.out]: OUT, [ENV.memoryLimit]: '1500' }, { canWatchMemory: false });
    install(deps);

    assert.deepEqual(calls, ['onExit']);
    assert.equal(deps.global[watchdog], undefined);
  });

  testEach([undefined, '0', 'none'])('watches no memory with the memory limit %s', (memoryLimit) => {
    const { deps, calls } = harness({ [ENV.out]: OUT, [ENV.memoryLimit]: memoryLimit });
    install(deps);

    assert.deepEqual(calls, ['onExit']);
  });

  testEach([undefined, '0', 'none'])('counts no hits with the hit limit %s', (hitLimit) => {
    const { deps, records, exit } = harness({ [ENV.out]: OUT, [ENV.hitLimit]: hitLimit });
    install(deps);
    exit();

    assert.equal(deps.global.__stryker__?.hitLimit, undefined);
    assert.equal(deps.global.__stryker__?.hitCount, undefined);
    assert.ok(!('hitCount' in (records[0]?.record ?? {})));
  });

  it('attributes the process to the test that started it', () => {
    const { deps } = harness({ [ENV.out]: OUT, [ENV.current]: `${TEST_FILE} > spawns` }, { mainFile: '/other.mjs' });
    install(deps);

    assert.equal(deps.global.__stryker__?.currentTestId, `${TEST_FILE} > spawns`);
  });

  testEach([undefined, ''])('attributes the process to no test when the current test is %j', (current) => {
    const { deps } = harness({ [ENV.out]: OUT, [ENV.current]: current });
    deps.global.__stryker__ = { currentTestId: 'stale' };
    install(deps);

    assert.equal(deps.global.__stryker__.currentTestId, undefined);
  });

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

  testFor([
    ['a process the tests spawned', { [ENV.file]: TEST_FILE }, '/repo/child.mjs'],
    ['a process without a main file', { [ENV.file]: TEST_FILE }, undefined],
    ['a run without a test file', {}, undefined],
    ['a run without a test file, from a main file', {}, TEST_FILE],
  ] as const)('leaves node:test and its reporter alone in %s', ([, env, mainFile]) => {
    const { deps, calls } = harness({ [ENV.out]: OUT, ...env }, { mainFile });

    assert.equal(install(deps), true);
    assert.deepEqual(calls, ['onExit']);
    assert.equal(deps.global[reporting], undefined);
    assert.equal(deps.global[wrappedNodeTest], undefined);
  });

  it("records the tests node:test reports in a file named after the process, marked as the test file's", () => {
    const { deps, records, exit } = harness({ [ENV.out]: OUT, [ENV.file]: TEST_FILE, [ENV.dryRun]: 'false' });
    install(deps);
    report(deps, 'passes', 'pass');
    report(deps, 'fails', 'fail');

    exit();

    assert.deepEqual(records, [
      {
        path: join(OUT, '4321.0.json'),
        record: {
          main: true,
          tests: [
            { id: `${TEST_FILE} > passes`, status: 'passed', timeSpentMs: 2 },
            { id: `${TEST_FILE} > fails`, status: 'failed', failureMessage: 'fails failed', timeSpentMs: 2 },
          ],
        },
      },
    ]);
  });

  it("writes a worker thread's record to a file of its own, never as the test file's", () => {
    const { deps, records, exit } = harness({ [ENV.out]: OUT, [ENV.file]: TEST_FILE }, { threadId: 3 });
    install(deps);

    exit();

    assert.deepEqual(
      records.map(({ path, record }) => [path, record.main]),
      [[join(OUT, '4321.3.json'), undefined]],
    );
  });

  it('writes no record in a process that may not write one', () => {
    const { deps, records, exit } = harness({ [ENV.out]: OUT, [ENV.file]: TEST_FILE }, { canWriteRecords: false });
    install(deps);
    report(deps, 'passes', 'pass');

    exit();

    assert.deepEqual(records, []);
  });

  testFor([
    ['after the exit listeners of the tests, when it ends by itself', true, { exit: 1 }],
    ['before the exit listeners of the tests, when it ends through process.exit()', false, {}],
  ] as const)('writes the record once, %s', ([, natural, exitHits]) => {
    const { deps, records, calls, exit, onExit } = harness({ [ENV.out]: OUT, [ENV.dryRun]: 'true' });
    install(deps);
    const coverage = { static: {}, perTest: {} };
    deps.global.__stryker__!.mutantCoverage = coverage;
    onExit(() => {
      Object.assign(coverage.static, { exit: 1 });
    });
    calls.length = 0;

    exit({ natural });

    assert.deepEqual(
      records.map(({ record }) => record.mutantCoverage),
      [{ static: exitHits, perTest: {} }],
    );
    assert.deepEqual(calls, natural ? ['offExit', 'onExit'] : []);
  });

  it('writes the diagnostics of errors raised after a test ended', () => {
    const { deps, records, exit } = harness({ [ENV.out]: OUT, [ENV.file]: TEST_FILE });
    const message = 'Error: Test "t" at a.test.mjs:1:1 generated asynchronous activity after the test ended.';
    install(deps);
    deps.global[reporting]?.({ type: 'test:diagnostic', data: { name: '', nesting: 0, message } });

    exit();

    assert.deepEqual(records[0]?.record, { main: true, tests: [], diagnostics: [message] });
  });

  const summary: TestEvent = { type: 'test:summary', data: { name: '', nesting: 0 } };

  testFor([
    ['marks the record unfinished when it ends through process.exit() before', false, [], { unfinished: true }],
    ['leaves the record as it is when it ends through process.exit() after', false, [summary], {}],
    ['leaves the record as it is when it ends by itself without', true, [], {}],
  ] as const)(
    "%s node:test's summary",
    ([, natural, last, unfinished]) => {
      const { deps, records, exit, wrapped } = harness({ [ENV.out]: OUT, [ENV.file]: TEST_FILE });
      install(deps);
      wrapped().it('passes', () => {});
      report(deps, 'passes', 'pass');

      for (const event of last) {
        deps.global[reporting]?.(event);
      }

      exit({ natural });

      assert.deepEqual(records[0]?.record, {
        main: true,
        tests: [{ id: `${TEST_FILE} > passes`, status: 'passed', timeSpentMs: 2 }],
        ...unfinished,
      });
    },
  );

  it('records where the test file declares a test, named by URL as an ES module or by path as CommonJS', () => {
    const file = resolve(TEST_FILE);
    const other = pathToFileURL(resolve('/repo', 'other.ts')).href;
    const startPositions = [pathToFileURL(file).href, file, other].map((scriptName) => {
      const { deps, records, exit, wrapped } = harness(
        { [ENV.out]: OUT, [ENV.file]: file },
        { mainFile: file, callSites: () => [{ scriptName, lineNumber: 3, columnNumber: 5 }] },
      );
      install(deps);
      wrapped().it('declared', () => {});
      report(deps, 'declared', 'pass');
      exit();

      return records[0]?.record.tests[0]?.startPosition;
    });

    assert.deepEqual(startPositions, [{ line: 2, column: 4 }, { line: 2, column: 4 }, undefined]);
  });

  testFor([
    ['the source-mapped call sites, when one is in the test file', TEST_FILE, [true], { line: 6, column: 6 }],
    ['the call sites as they are, when no source-mapped one is', join('/repo', 'src', 'a.ts'), [true, false], { line: 2, column: 4 }],
  ] as const)('records the position from %s', ([, mappedFile, reads, startPosition]) => {
    const sourceMaps: boolean[] = [];
    const { deps, records, exit, wrapped } = harness(
      { [ENV.out]: OUT, [ENV.file]: TEST_FILE },
      {
        callSites: (frameCount, { sourceMap }) => {
          assert.equal(frameCount, 64);
          sourceMaps.push(sourceMap);

          return sourceMap
            ? [
                { scriptName: join('/repo', 'helper.ts'), lineNumber: 1, columnNumber: 1 },
                { scriptName: mappedFile, lineNumber: 7, columnNumber: 7 },
              ]
            : [{ scriptName: TEST_FILE, lineNumber: 3, columnNumber: 5 }];
        },
      },
    );
    install(deps);
    wrapped().it('declared', () => {});
    report(deps, 'declared', 'pass');
    exit();

    assert.deepEqual(records[0]?.record.tests[0]?.startPosition, startPosition);
    assert.deepEqual(sourceMaps, reads);
  });

  it('activates the mutant the runner names for runtime activation once a test starts', async () => {
    const { deps, fake, wrapped } = harness({ [ENV.out]: OUT, [ENV.file]: TEST_FILE, [ENV.activeMutant]: '5' });
    install(deps);

    assert.equal(deps.global.__stryker__?.activeMutant, undefined);

    wrapped().it('runs', () => {});
    await bodyOf(fake.registrations, 'runs')(testContext());

    assert.equal(deps.global.__stryker__?.activeMutant, '5');
  });

  it('runs only the filtered tests', () => {
    const { deps, fake, wrapped } = harness({
      [ENV.out]: OUT,
      [ENV.file]: TEST_FILE,
      [ENV.filter]: JSON.stringify([`${TEST_FILE} > wanted`]),
    });
    install(deps);
    wrapped().it('wanted', () => {});
    wrapped().it('unwanted', () => {});

    assert.deepEqual(
      fake.registrations
        .filter(({ kind }) => kind === 'test')
        .map(({ name, rest }) => [name, (rest[0] as { skip?: true }).skip]),
      [
        ['wanted', undefined],
        ['unwanted', true],
      ],
    );
  });

  const bails = ['true', 'false', undefined].map((bail) => ({ bail, verb: bail === 'true' ? 'skips' : 'runs' }));

  testEach(bails)('$verb later tests with bail $bail; children never bail', async ({ bail }) => {
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

  describe('a process that outlives its tests', () => {
    const env = { [ENV.out]: OUT, [ENV.file]: TEST_FILE };

    it("registers a root `after` hook with node:test itself at the test file's first registration, before it", () => {
      const h = harness(env);
      install(h.deps);

      assert.deepEqual(h.fake.registrations, []);

      h.wrapped().after(() => {});
      h.wrapped().it('passes', () => {});

      assert.deepEqual(
        h.fake.registrations.map(({ kind, self }) => [kind, self === h.fake.module]),
        [
          ['after', true],
          ['after', false],
          ['test', false],
        ],
      );
    });

    it('ends a file whose test failed with exit code 1 once its tests finish, and does not mark it unfinished', async () => {
      const h = harness(env);
      install(h.deps);
      await ranAndReported(h, 'passes', 'pass');
      await ranAndReported(h, 'fails', 'fail');

      assert.deepEqual(h.exits, []);

      afterHooks(h.fake)[0]?.();
      h.exit({ natural: false });

      assert.deepEqual(h.exits, [1]);
      assert.deepEqual(h.records[0]?.record, {
        main: true,
        tests: [
          { id: `${TEST_FILE} > passes`, status: 'passed', timeSpentMs: 2 },
          { id: `${TEST_FILE} > fails`, status: 'failed', failureMessage: 'fails failed', timeSpentMs: 2 },
        ],
      });
    });

    it('ends a failed file only once node:test has reported each top-level suite and test, which comes last', () => {
      const h = harness(env);
      install(h.deps);
      h.wrapped().it('fails', () => {});
      h.wrapped().describe('suite', () => {
        h.wrapped().it('inner', () => {});
      });
      afterHooks(h.fake)[0]?.();
      report(h.deps, 'fails', 'fail');
      h.deps.global[reporting]?.({
        type: 'test:pass',
        data: { name: 'inner', nesting: 1, details: { type: 'test', duration_ms: 1 } },
      });
      // A failing root hook, reported as a failure of the file itself.
      h.deps.global[reporting]?.({
        type: 'test:fail',
        data: { name: TEST_FILE, nesting: 0, details: { duration_ms: 1, error: { message: 'hook failed' } } },
      });
      // node:test reports that a suite completed before it reports its result.
      h.deps.global[reporting]?.({
        type: 'test:complete',
        data: { name: 'suite', nesting: 0, details: { type: 'suite', duration_ms: 1 } },
      });

      assert.deepEqual(h.exits, []);

      h.deps.global[reporting]?.({
        type: 'test:pass',
        data: { name: 'suite', nesting: 0, details: { type: 'suite', duration_ms: 1 } },
      });

      assert.deepEqual(h.exits, [1]);
    });

    it('ends no file whose tests all passed before the grace ends', async () => {
      const h = harness(env);
      install(h.deps);
      await ranAndReported(h, 'passes', 'pass');
      afterHooks(h.fake)[0]?.();
      report(h.deps, 'passes', 'pass');

      assert.deepEqual(h.exits, []);
      assert.deepEqual(
        h.timers.map(({ ms }) => ms),
        [30_000],
      );
    });

    testFor([
      ['the default of', undefined, 30_000],
      ['the default of, for 0,', '0', 30_000],
      ['250 ms, as set in', '250', 250],
    ] as const)('waits %s the held-open variable', ([, heldOpen, ms]) => {
      const h = harness({ ...env, [ENV.heldOpen]: heldOpen });
      install(h.deps);
      h.wrapped().it('passes', () => {});
      afterHooks(h.fake)[0]?.();

      assert.deepEqual(
        h.timers.map((timer) => timer.ms),
        [ms],
      );
    });

    testFor([
      ['node:test reported every top-level test', true, { heldOpen: ['TCPServerWrap', 'PipeWrap'] }],
      ['a top-level test was not reported', false, { unfinished: true, heldOpen: ['TCPServerWrap', 'PipeWrap'] }],
    ] as const)(
      "ends a file still alive when the grace ends with node:test's exit code, naming what its tests opened, when %s",
      async ([, reported, marks]) => {
        const h = harness(env);
        install(h.deps);
        h.wrapped().it('passes', () => {});
        await bodyOf(h.fake.registrations, 'passes')(testContext());

        if (reported) {
          report(h.deps, 'passes', 'pass');
        }

        afterHooks(h.fake)[0]?.();
        h.resources.push('TCPServerWrap', 'PipeWrap');
        h.timers[0]?.fire();
        h.exit({ natural: false });

        assert.deepEqual(h.exits, [undefined]);
        assert.deepEqual(h.records[0]?.record, {
          main: true,
          tests: reported ? [{ id: `${TEST_FILE} > passes`, status: 'passed', timeSpentMs: 2 }] : [],
          ...marks,
        });
      },
    );

    it('names only what the tests opened, also when something the process had before is gone', () => {
      const h = harness(env);
      install(h.deps);
      h.wrapped().it('passes', () => {});
      afterHooks(h.fake)[0]?.();
      h.resources.splice(0, h.resources.length, 'TCPServerWrap', 'Timeout');
      h.timers[0]?.fire();
      h.exit({ natural: false });

      assert.deepEqual(h.records[0]?.record.heldOpen, ['TCPServerWrap', 'Timeout']);
    });

    it("starts the grace once the test file's root `after` hooks have settled, also one added while they run", async () => {
      const h = harness(env);
      install(h.deps);
      let resolveFirst = () => {};
      h.wrapped().after(() => new Promise<void>((resolve) => (resolveFirst = resolve)));
      h.wrapped().after(() => {});
      const [finished, first, second] = afterHooks(h.fake);
      await ranAndReported(h, 'fails', 'fail');

      finished?.();
      const firstDone = first?.() as Promise<unknown>;
      h.wrapped().after(() => {});
      const [, , , added] = afterHooks(h.fake);
      resolveFirst();
      await firstDone;
      await second?.();

      assert.deepEqual([h.timers.length, h.exits], [0, []]);

      await added?.();

      assert.deepEqual([h.timers.length, h.exits], [1, [1]]);
    });

    testFor([
      ['throws', (): unknown => {
        throw new Error('after failed');
      }],
      ['rejects', (): unknown => Promise.reject(new Error('after failed'))],
    ] as const)('stops waiting at a root `after` hook that %s, as node:test runs none after it', async ([, hook]) => {
      const h = harness(env);
      install(h.deps);
      h.wrapped().after(hook);
      h.wrapped().after(() => {});
      const [finished, failing] = afterHooks(h.fake);

      finished?.();
      await assert.rejects(async () => failing?.(), { message: 'after failed' });

      assert.equal(h.timers.length, 1);
    });

    testFor([
      ['with no error, once it calls back', undefined],
      ['with an error, stopping the wait', new Error('after failed')],
    ] as const)('passes a callback hook its `done` and settles %s', ([, error]) => {
      const h = harness(env);
      install(h.deps);
      const passed: unknown[] = [];
      let callBack = () => {};
      h.wrapped().after(((_context: unknown, done: (error?: unknown) => void) => {
        callBack = () => done(error);
      }) as Fn);
      h.wrapped().after(() => {});
      const [finished, callbackHook] = afterHooks(h.fake);

      assert.equal(callbackHook?.length, 2);

      finished?.();
      callbackHook?.({}, (given: unknown) => passed.push(given));

      assert.equal(h.timers.length, 0);

      callBack();

      assert.deepEqual([h.timers.length, passed], [error ? 1 : 0, [error]]);
    });

    it("starts the grace only once its own root `after` hook has run, as one added inside another hook runs earlier", async () => {
      const h = harness(env);
      install(h.deps);
      h.wrapped().after(() => {});
      const [finished, early] = afterHooks(h.fake);
      await early?.();

      assert.equal(h.timers.length, 0);

      finished?.();

      assert.equal(h.timers.length, 1);
    });

    const fileFailure = { type: 'test:fail', data: { name: TEST_FILE, nesting: 0, details: { duration_ms: 1 } } } as const;

    testFor([
      ['starts', 'node:test reports the file failed once the tests finished', false, fileFailure, 1],
      ['does not start', 'node:test reports the file failed before the tests finished', true, fileFailure, 0],
      ['does not start', 'a nested failure has no type', false, { ...fileFailure, data: { ...fileFailure.data, nesting: 1 } }, 0],
      ['does not start', 'the file passed', false, { ...fileFailure, type: 'test:pass' }, 0],
      [
        'does not start',
        'a top-level test failed',
        false,
        { ...fileFailure, data: { ...fileFailure.data, details: { type: 'test', duration_ms: 1 } } },
        0,
      ],
    ] as const)(
      '%s the grace at a root `after` hook that never settles when %s, as node:test times out such a hook',
      ([, , early, event, timers]) => {
        const h = harness(env);
        install(h.deps);
        h.wrapped().after(() => new Promise(() => {}));
        const [finished] = afterHooks(h.fake);

        if (early) {
          h.deps.global[reporting]?.(event);
        }

        finished?.();

        if (!early) {
          h.deps.global[reporting]?.(event);
        }

        assert.equal(h.timers.length, timers);
      },
    );

    it('starts the grace once, whatever settles after it started', () => {
      const h = harness(env);
      install(h.deps);
      h.wrapped().after(() => {
        throw new Error('after failed');
      });
      h.wrapped().after(() => {});
      const [finished, failing, later] = afterHooks(h.fake);

      finished?.();
      assert.throws(() => failing?.());
      later?.();
      finished?.();

      assert.equal(h.timers.length, 1);
    });

    it('waits for no `after` hook of a suite, nor one registered without a function', () => {
      const h = harness(env);
      install(h.deps);
      h.wrapped().describe('suite', () => {
        h.wrapped().after(() => {});
      });
      h.wrapped().after();
      afterHooks(h.fake)[0]?.();

      assert.equal(h.timers.length, 1);
    });
  });

  it('writes the hit count and, only in the dry run, the mutant coverage and the peak memory', () => {
    const coverage = { static: { 1: 2 }, perTest: { [`${TEST_FILE} > t`]: { 3: 1 } } };
    const written = ['true', 'false', undefined].map((dryRun) => {
      const { deps, records, exit } = harness({ [ENV.out]: OUT, [ENV.dryRun]: dryRun, [ENV.hitLimit]: '9' });
      install(deps);
      const ns = deps.global.__stryker__;
      assert.ok(ns);
      ns.mutantCoverage = coverage;
      ns.hitCount = 7;
      exit();

      return records[0]?.record;
    });

    assert.deepEqual(written, [
      { tests: [], hitCount: 7, mutantCoverage: coverage, peakMemoryMB: 123 },
      { tests: [], hitCount: 7 },
      { tests: [], hitCount: 7 },
    ]);
  });
});

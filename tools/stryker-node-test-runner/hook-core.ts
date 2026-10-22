// The logic hook.ts installs into every process of a node:test run under Stryker. Its dependencies are
// parameters, so tests can drive it in-process.
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InstrumenterContext, MutantCoverage, Position } from '@stryker-mutator/api/core';

/**
 * The id of a suite or test: its parent's id, which for a suite or test outside any is the test file, and its name.
 * A name with a `>` that could form the separator, inside the name or with the separator next to it, has each `>` and
 * `\` escaped with `\`, so the separator only ever joins names. Other names, such as `<anonymous>`, stay as they are.
 */
export function testId(parent: string, name: string): string {
  return `${parent} > ${/(^| )>( |$)/.test(name) ? name.replace(/[\\>]/g, '\\$&') : name}`;
}

/**
 * Returns a function that gives each suite or test its id, numbering from 2 those that would share an id with one
 * named before them, as in `works (2)`. node:test reports suites and tests in the order they are declared, so the
 * wrapper and the reporter number them alike.
 */
export function uniqueIds(): (parent: string, name: string) => string {
  const used = new Set<string>();

  return (parent, name) => {
    const base = testId(parent, name);

    // One of the first `used.size + 1` candidates is free, so the search ends at the bound at the latest.
    for (let count = 1; count <= used.size + 1; count++) {
      const id = count === 1 ? base : `${base} (${count})`;

      if (!used.has(id)) {
        used.add(id);

        return id;
      }
    }

    return base;
  };
}

/** Whether `id` is the id of `scope` or of a suite or test inside it. */
export function within(id: string, scope: string): boolean {
  return id === scope || id.startsWith(`${scope} > `);
}

/** A test as the hook records it. */
export interface RecordedTest {
  /**
   * The test file's absolute path, the names of the enclosing suites and, for a subtest, tests, and the test's name,
   * joined by ` > `.
   */
  id: string;
  /** Skipped tests include todo tests, which run but whose outcome node:test ignores. */
  status: 'passed' | 'failed' | 'skipped';
  failureMessage?: string;
  timeSpentMs: number;
  /** Where the test file declares the suite or test, directly or through a helper it calls. */
  startPosition?: Position;
}

/** A function call on the stack: its file path and its 1-based position. */
export interface CallSite {
  file: string;
  line: number;
  column: number;
}

/** What the hook writes for one process when it exits. */
export interface ProcessRecord {
  /** Set for the process that runs the test file. */
  main?: true;
  /** Tests this process ran; empty for processes the tests spawned. */
  tests: RecordedTest[];
  hitCount?: number;
  /** Only written during the dry run. */
  mutantCoverage?: MutantCoverage;
  /** What node:test reported about errors raised after their test ended, which fail the file outside any test. */
  diagnostics?: string[];
  /**
   * Set for the test file's process when it exited before node:test finished: the file declared a suite or test, and
   * node:test never reported its summary, as when a test calls `process.exit()`.
   */
  unfinished?: true;
}

/** What node:test has done in the test file's process. */
export interface Progress {
  /** Whether the test file declared a suite or test, after which node:test reports a summary once every test ended. */
  declared: boolean;
  summarized: boolean;
}

type Body = (this: unknown, ...args: unknown[]) => unknown;
type Registrar = (this: unknown, name: string, ...rest: unknown[]) => unknown;
type HookRegistrar = (this: unknown, hook: Body, ...rest: unknown[]) => unknown;
/**
 * A node:test function with its shorthands, which do not call the function itself. Tests have `expectFailure` from
 * Node.js 24.
 */
type Register = Registrar & { skip: Registrar; todo: Registrar; only: Registrar; expectFailure?: Registrar };
/** The part of the context node:test passes to a test's body that the hook uses. */
interface TestContext {
  skip(): void;
  /** Registers a subtest. */
  test: Registrar;
}

/** The part of a node:test reporter event that the hook reads. */
export interface TestEvent {
  type: string;
  data: {
    name: string;
    /** How many suites and tests enclose the test. */
    nesting: number;
    skip?: unknown;
    todo?: unknown;
    /** Present on `test:diagnostic`. */
    message?: string;
    /** Present on `test:pass` and `test:fail`. */
    details?: {
      /** Absent when the test file itself fails. */
      type?: 'suite' | 'test';
      duration_ms: number;
      error?: { failureType?: string; message: string; cause?: unknown };
    };
  };
}

/** The node:test module: its `test` function, which carries the other functions the hook wraps. */
export type NodeTestModule = Register & {
  describe: Register;
  suite: Register;
  it: Register;
  test: Register;
  before: HookRegistrar;
  beforeEach: HookRegistrar;
  after: HookRegistrar;
  afterEach: HookRegistrar;
};

/** The name of the test that stands for a failing `after` hook outside any suite, which fails the test file. */
const AFTER_HOOK = '"after" hook';

/** Environment variables shared between the runner and the hook. */
export const ENV = {
  out: 'STRYKER_NODE_TEST_OUT',
  file: 'STRYKER_NODE_TEST_FILE',
  dryRun: 'STRYKER_NODE_TEST_DRY_RUN',
  hitLimit: 'STRYKER_NODE_TEST_HIT_LIMIT',
  current: 'STRYKER_NODE_TEST_CURRENT',
  filter: 'STRYKER_NODE_TEST_FILTER',
  bail: 'STRYKER_NODE_TEST_BAIL',
  /** The mutant the hook activates once the tests start, when Stryker asks for runtime activation. */
  activeMutant: 'STRYKER_NODE_TEST_ACTIVE_MUTANT',
} as const;

/** Stryker's variable for the active mutant, which instrumented code reads when it loads. */
export const ACTIVE_MUTANT_ENV = '__STRYKER_ACTIVE_MUTANT__';

export interface HookDependencies {
  env: Record<string, string | undefined>;
  /** `process.argv[1]`, resolved to an absolute path. */
  mainFile: string | undefined;
  pid: number;
  global: {
    __stryker__?: InstrumenterContext;
    [installed]?: true;
    [reporting]?: (event: TestEvent) => void;
    [wrappedNodeTest]?: NodeTestModule;
  };
  nodeTest: () => NodeTestModule;
  registerHooks: (hooks: ModuleHooks) => unknown;
  onExit: (listener: () => void) => void;
  writeRecord: (path: string, record: ProcessRecord) => void;
  /** The function calls on the stack, innermost first, as `util.getCallSites` gives them. */
  callSites: (
    frameCount: number,
    options: { sourceMap: boolean },
  ) => { scriptName: string; lineNumber: number; columnNumber: number }[];
}

/**
 * How many calls of the stack the hook reads to find where the test file declares a suite or test. getCallSites reads
 * 10 by default, fewer than a declaration through a few helpers takes.
 */
const CALL_SITE_FRAMES = 64;

/** Marks a process whose hook is installed, so a second copy of the hook (a runner under test) stays inactive. */
export const installed = Symbol.for('thermos.stryker-node-test-runner.hook');

/** Where the hook of a test file's process leaves the function that the runner's reporter passes events to. */
export const reporting = Symbol.for('thermos.stryker-node-test-runner.reporting');

/** Where the hook of a test file's process keeps the wrapped node:test module that imports of node:test give. */
export const wrappedNodeTest = Symbol.for('thermos.stryker-node-test-runner.node-test');

/**
 * Installs the hook when the runner started this process tree. Returns whether it installed.
 */
export function install(deps: HookDependencies): boolean {
  const outDir = deps.env[ENV.out];

  if (!outDir || deps.global[installed]) {
    return false;
  }

  deps.global[installed] = true;
  const ns = (deps.global.__stryker__ ??= {});
  const hitLimit = Number(deps.env[ENV.hitLimit]);

  if (hitLimit > 0) {
    ns.hitLimit = hitLimit;
    ns.hitCount = 0;
  }

  ns.currentTestId = deps.env[ENV.current] || undefined;
  const bail = deps.env[ENV.bail] === 'true';
  // Processes the tests start never bail: skipping tests there would change results that the parent test checks.
  delete deps.env[ENV.bail];
  const tests: RecordedTest[] = [];
  const diagnostics: string[] = [];
  const testFile = deps.env[ENV.file];
  const main = testFile !== undefined && deps.mainFile === testFile;
  const progress: Progress = { declared: false, summarized: false };

  if (main) {
    const positions = new Map<string, Position>();
    // ES modules are named by their URL, CommonJS modules by their path.
    const callSites = (sourceMap: boolean) =>
      deps.callSites(CALL_SITE_FRAMES, { sourceMap }).map(({ scriptName, lineNumber, columnNumber }) => ({
        file: scriptName.startsWith('file:') ? fileURLToPath(scriptName) : scriptName,
        line: lineNumber,
        column: columnNumber,
      }));
    const recordEvent = recordEvents(testFile, tests, positions, diagnostics);
    deps.global[reporting] = (event) => {
      if (event.type === 'test:summary') {
        progress.summarized = true;
      }

      recordEvent(event);
    };
    const filterJson = deps.env[ENV.filter];
    const filter = filterJson ? new Set<string>(JSON.parse(filterJson) as string[]) : undefined;
    const wrapped = wrapNodeTest({
      ns,
      testFile,
      tests,
      filter,
      bail,
      activeMutant: deps.env[ENV.activeMutant],
      env: deps.env,
      positions,
      progress,
      // A source map can point at another file, such as `src/` for a test in `dist/`; the test file's own position
      // is better than none.
      callSites: () => {
        const mapped = callSites(true);

        return mapped.some(({ file }) => file === testFile) ? mapped : callSites(false);
      },
      nodeTest: deps.nodeTest(),
    });
    deps.global[wrappedNodeTest] = wrapped;
    deps.registerHooks(redirectNodeTest(Object.keys(wrapped)));
  }

  deps.onExit(() => {
    const dryRun = deps.env[ENV.dryRun] === 'true';
    deps.writeRecord(join(outDir, `${deps.pid}.json`), {
      ...(main && { main }),
      tests,
      hitCount: ns.hitCount,
      mutantCoverage: dryRun ? ns.mutantCoverage : undefined,
      ...(diagnostics.length > 0 && { diagnostics }),
      ...(progress.declared && !progress.summarized && { unfinished: true }),
    });
  });

  return true;
}

/**
 * What node:test's diagnostic of an error raised after its test ended says. node:test reports it when such an error
 * reaches its `uncaughtException` or `unhandledRejection` handler (`createProcessEventHandler` in
 * `lib/internal/test_runner/harness.js`).
 */
const LATE_ACTIVITY = 'generated asynchronous activity after the test ended';

/**
 * Returns a function that records the tests of one test file from node:test's reporter events, with ids built the
 * way the wrapper builds them, and the positions the wrapper found for them. A suite is recorded only when it fails by
 * itself, such as in a `before` hook, or is skipped. node:test reports an error raised after its test ended only as a
 * diagnostic, which is kept in `diagnostics`.
 */
export function recordEvents(
  testFile: string,
  tests: RecordedTest[],
  positions: Map<string, Position>,
  diagnostics: string[],
): (event: TestEvent) => void {
  /** The id of the test or suite that started last at each nesting level. */
  const ids = new Map<number, string>();
  const idOf = uniqueIds();

  return ({ type, data }) => {
    if (type === 'test:start') {
      ids.set(data.nesting, idOf(ids.get(data.nesting - 1) ?? testFile, data.name));

      return;
    }

    if (type === 'test:diagnostic' && data.message?.includes(LATE_ACTIVITY)) {
      diagnostics.push(data.message);
    }

    if (type !== 'test:pass' && type !== 'test:fail') {
      return;
    }

    const { type: kind, duration_ms: timeSpentMs, error } = data.details!;

    // node:test never runs a skipped suite's body, so the suite stands for the tests it declares.
    if (
      kind === 'suite' &&
      data.skip === undefined &&
      (type === 'test:pass' || error?.failureType === 'subtestsFailed')
    ) {
      return;
    }

    // node:test reports a failing `after` hook of the test file as a failure of the file itself, which has no type.
    const fileHook = kind === undefined;
    const id = fileHook ? testId(testFile, AFTER_HOOK) : (ids.get(data.nesting) as string);

    const test: RecordedTest = { id, status: 'passed', timeSpentMs };
    const startPosition = positions.get(id);

    if (startPosition) {
      test.startPosition = startPosition;
    }

    // node:test runs a todo test but ignores its outcome.
    if (data.skip !== undefined || data.todo !== undefined) {
      test.status = 'skipped';
    } else if (error) {
      test.status = 'failed';
      // The cause is what the test or hook threw; a timeout, a cancellation or an unmet expectFailure has a message only.
      test.failureMessage = error.cause instanceof Error ? error.cause.message : error.message;
    }

    tests.push(test);
  };
}

export interface WrapOptions {
  ns: InstrumenterContext;
  testFile: string;
  /** The tests node:test has reported so far. */
  tests: RecordedTest[];
  /** Test ids to run; all other tests are skipped. Runs every test when absent. */
  filter: Set<string> | undefined;
  /** Whether tests that start after a test of this process failed are skipped. */
  bail: boolean;
  /**
   * The mutant to activate when the first test starts, or a `beforeEach` hook or a suite's `before` hook ahead of it;
   * it stays active for the rest of the process.
   */
  activeMutant: string | undefined;
  env: Record<string, string | undefined>;
  /** Where the test file declares each suite and test, by id, for the wrapper to fill. */
  positions: Map<string, Position>;
  /** Where the wrapper notes that the test file declared a suite or test. */
  progress: Progress;
  callSites: () => CallSite[];
  nodeTest: NodeTestModule;
}

/**
 * Returns a copy of the node:test module whose suite and test functions are wrapped so each test's id is known while
 * it runs, and so tests outside the filter, or after a failure when bailing, are skipped. Subtests that a test
 * registers with `t.test` are wrapped the same way. The test results come from node:test's reporter events, so a
 * suite's or test's id follows node:test's nesting.
 *
 * Supports synchronous suite bodies, and test bodies that return a value or a promise or that take node:test's `done`
 * callback. Bailing acts on the results node:test has reported, and node:test reports the first tests of a file only
 * once its reporters start, so a few quick tests can still run after the first failure.
 */
export function wrapNodeTest(options: WrapOptions): NodeTestModule {
  const { ns, testFile, tests, filter, bail, activeMutant, env, positions, progress, callSites, nodeTest } = options;
  const idOf = uniqueIds();
  /**
   * The id of the suite or test whose body runs. node:test makes the suite or test whose body runs, followed through
   * asynchronous calls, the parent of the suites and tests registered with its module's functions.
   */
  const running = new AsyncLocalStorage<string>();
  const parentId = () => running.getStore() ?? testFile;
  const bailed = () => bail && tests.some((test) => test.status === 'failed');
  /**
   * The tests that have started and not ended, in the order they started. The last is current, also when a subtest
   * that its parent does not await outlives the parent's body.
   */
  const active = new Set<string>();
  const setCurrent = () => {
    const id = [...active].at(-1);
    ns.currentTestId = id;

    if (id === undefined) {
      delete env[ENV.current];
    } else {
      env[ENV.current] = id;
    }
  };
  /**
   * Whether the filter selects the test, or a subtest of it, which the test must run to register. Stryker names a
   * whole test file in the filter when --testFiles limits the run.
   */
  const selected = (id: string) => !filter || filter.has(testFile) || [...filter].some((test) => within(test, id));
  /** Activates the runtime mutant, if any, for the rest of the process. */
  const activate = () => {
    // The environment variable makes the processes started from now on load with the mutant active.
    if (activeMutant !== undefined) {
      ns.activeMutant = activeMutant;
      env[ACTIVE_MUTANT_ENV] = activeMutant;
    }
  };
  /**
   * Wraps a hook registrar so it registers no hook in a suite without a selected test. Like node:test's own filters,
   * the wrapper runs such a suite's body, to register its tests as skipped, and none of its hooks. Any other hook is
   * registered as `prepare` gives it, from the hook and the suite or test whose body registers it.
   */
  const wrapHook = (
    register: HookRegistrar,
    prepare: (hook: Body, suite: string | undefined) => Body = (hook) => hook,
  ): HookRegistrar =>
    function (this: unknown, hook: Body, ...rest: unknown[]) {
      const suite = running.getStore();

      if (suite !== undefined && !selected(suite)) {
        return undefined;
      }

      return register.call(this, prepare(hook, suite), ...rest);
    };
  /** A hook that activates the mutant before it runs. */
  const activating = (hook: Body): Body => {
    const wrapped = function (this: unknown, ...args: unknown[]) {
      activate();

      return hook.apply(this, args);
    };
    // node:test passes a `done` callback to a hook that declares a parameter for it.
    Object.defineProperty(wrapped, 'length', { value: hook.length });

    return wrapped;
  };

  /**
   * Notes that the test file declares the suite or test with this id, and where. node:test takes the position from its
   * caller, which is a wrapper, so the wrapper finds it itself.
   */
  const declare = (id: string) => {
    progress.declared = true;
    const site = callSites().find(({ file }) => file === testFile);

    if (site) {
      positions.set(id, { line: site.line - 1, column: site.column - 1 });
    }
  };

  /**
   * A suite's or test's arguments as node:test reads them: an optional name, options and body. node:test names one
   * without a non-empty name after its body, or `<anonymous>`; the wrapper passes the name on, as the body it passes
   * is its own.
   */
  const parse = (args: unknown[]) => {
    const body = args.find((arg) => typeof arg === 'function') as Body | undefined;
    const options = args.find((arg) => typeof arg === 'object') as object | undefined;
    const name = typeof args[0] === 'string' && args[0] !== '' ? args[0] : body?.name || '<anonymous>';

    return { name, options, body };
  };

  /**
   * Registers a suite or test with node:test. Every one is registered with `concurrency: false`, so the tests inside
   * it run one at a time, as node:test does without `concurrency`, and coverage goes to the one current test.
   */
  const registerWith = (
    register: Registrar,
    self: unknown,
    { name, options, body }: { name: string; options: object | undefined; body: Body | undefined },
  ) => register.call(self, name, { ...options, concurrency: false }, ...(body ? [body] : []));

  const wrapSuite = (register: Registrar): Registrar =>
    function (this: unknown, ...args: unknown[]) {
      const { name, options, body } = parse(args);
      const id = idOf(parentId(), name);
      declare(id);
      const wrap = (suiteBody: Body) =>
        function (this: unknown, ...bodyArgs: unknown[]) {
          return running.run(id, () => suiteBody.apply(this, bodyArgs));
        };

      return registerWith(register, this, { name, options, body: body && wrap(body) });
    };

  /** Wraps a function that registers tests whose parent has the id `parent()`. */
  const wrapTest = (register: Registrar, parent = parentId): Registrar =>
    function (this: unknown, ...args: unknown[]) {
      const { name, options, body } = parse(args);
      const id = idOf(parent(), name);
      declare(id);
      const enter = (context: TestContext) => {
        active.add(id);
        setCurrent();
        // `t.test` registers a subtest of `t`'s test, wherever it is called.
        context.test = wrapTest(context.test, () => id);
        activate();
      };
      const leave = () => {
        active.delete(id);
        setCurrent();
      };
      const wrap = (body: Body): Body => {
        // node:test passes a `done` callback only to a function that declares a second parameter.
        if (body.length >= 2) {
          return function (this: unknown, context: unknown, done: (error?: unknown) => void) {
            if (bailed()) {
              (context as TestContext).skip();
              done();

              return;
            }

            enter(context as TestContext);

            try {
              running.run(id, () =>
                body.call(this, context, (error?: unknown) => {
                  leave();
                  done(error);
                }),
              );
            } catch (error) {
              leave();
              throw error;
            }
          } as Body;
        }

        return async function (this: unknown, ...args: unknown[]) {
          if (bailed()) {
            (args[0] as TestContext).skip();

            return;
          }

          enter(args[0] as TestContext);

          try {
            return await running.run(id, () => body.apply(this, args));
          } finally {
            leave();
          }
        };
      };

      // A test registered as skipped runs neither its body nor its beforeEach and afterEach hooks.
      const skip = !selected(id) && { skip: true };

      return registerWith(register, this, { name, options: { ...options, ...skip }, body: body && wrap(body) });
    };

  // The bodies of skipped suites and tests never run, so `skip` only notes where they are declared.
  const declareSkipped = (register: Registrar): Registrar =>
    function (this: unknown, ...args: unknown[]) {
      declare(idOf(parentId(), parse(args).name));

      return register.apply(this, args as Parameters<Registrar>);
    };
  const withShorthands = (original: Register, wrap: (register: Registrar) => Registrar): Register =>
    Object.assign(wrap(original), original, {
      skip: declareSkipped(original.skip),
      todo: wrap(original.todo),
      only: wrap(original.only),
      ...(original.expectFailure && { expectFailure: wrap(original.expectFailure) }),
    });
  // The module is node:test's `test` function, which also carries the other functions; `it` is the same function.
  const test = withShorthands(nodeTest, wrapTest);

  return Object.assign(test, {
    describe: withShorthands(nodeTest.describe, wrapSuite),
    suite: withShorthands(nodeTest.suite, wrapSuite),
    it: test,
    test,
    // A `before` hook outside any suite runs as soon as it is registered, while the file loads, like the rest of the
    // file's top level; it runs before the mutant is active.
    before: wrapHook(nodeTest.before, (hook, suite) => (suite === undefined ? hook : activating(hook))),
    beforeEach: wrapHook(nodeTest.beforeEach, activating),
    after: wrapHook(nodeTest.after, (hook, suite) => {
      // node:test reports a failing `after` hook outside any suite as a failure of the test file, at the position it
      // takes from its caller, which is this wrapper.
      if (suite === undefined) {
        declare(testId(testFile, AFTER_HOOK));
      }

      return hook;
    }),
    afterEach: wrapHook(nodeTest.afterEach),
  });
}

/** The module hooks part of `module.registerHooks` that the hook uses. */
export interface ModuleHooks {
  resolve: (
    specifier: string,
    context: { conditions: string[] },
    nextResolve: (specifier: string, context: { conditions: string[] }) => unknown,
  ) => unknown;
  load: (url: string, context: object, nextLoad: (url: string, context: object) => unknown) => unknown;
}

const WRAPPED_URL = 'thermos-stryker-node-test:node-test/';

/**
 * Module hooks that make `import 'node:test'` and `require('node:test')` give the wrapped module on
 * `globalThis[wrappedNodeTest]`, with these named exports. The default export, and what `require` returns, is
 * node:test's `test` function itself, so the built-in module cannot be wrapped in place.
 */
export function redirectNodeTest(names: string[]): ModuleHooks {
  const wrapped = `globalThis[Symbol.for(${JSON.stringify(wrappedNodeTest.description)})]`;
  const sources = {
    module: `const wrapped = ${wrapped}; export default wrapped; export const { ${names.join(', ')} } = wrapped;`,
    commonjs: `module.exports = ${wrapped};`,
  };

  return {
    resolve: (specifier, context, nextResolve) => {
      if (specifier !== 'node:test') {
        return nextResolve(specifier, context);
      }

      const format = context.conditions.includes('require') ? 'commonjs' : 'module';

      return { url: `${WRAPPED_URL}${format}`, format, shortCircuit: true };
    },
    load: (url, context, nextLoad) => {
      if (!url.startsWith(WRAPPED_URL)) {
        return nextLoad(url, context);
      }

      const format = url.slice(WRAPPED_URL.length) as keyof typeof sources;

      return { format, source: sources[format], shortCircuit: true };
    },
  };
}


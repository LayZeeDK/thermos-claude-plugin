// The logic hook.ts installs into every process of a node:test run under Stryker. Its dependencies are
// parameters, so tests can drive it in-process.

/** A test as the hook records it. */
export interface RecordedTest {
  /** The test file's absolute path, the enclosing suite names, and the test name, joined by ` > `. */
  id: string;
  /** Skipped tests include todo tests, which run but whose outcome node:test ignores. */
  status: 'passed' | 'failed' | 'skipped';
  failureMessage?: string;
  timeSpentMs: number;
}

/** Mutant coverage as Stryker's instrumented code records it. */
export interface Coverage {
  static: Record<string, number>;
  perTest: Record<string, Record<string, number>>;
}

/** What the hook writes for one process when it exits. */
export interface ProcessRecord {
  /** Tests this process ran; empty for processes the tests spawned. */
  tests: RecordedTest[];
  hitCount?: number;
  /** Only written during the dry run. */
  mutantCoverage?: Coverage;
}

/** The part of Stryker's global namespace (`globalThis.__stryker__`) the hook uses. */
export interface StrykerNamespace {
  activeMutant?: string;
  currentTestId?: string;
  mutantCoverage?: Coverage;
  hitCount?: number;
  hitLimit?: number;
}

type Body = (this: unknown, ...args: unknown[]) => unknown;
type Registrar = (this: unknown, name: string, ...rest: unknown[]) => unknown;
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
    /** Present on `test:pass` and `test:fail`. */
    details?: {
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
};

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
    __stryker__?: StrykerNamespace;
    [installed]?: true;
    [reporting]?: (event: TestEvent) => void;
    [wrappedNodeTest]?: NodeTestModule;
  };
  nodeTest: () => NodeTestModule;
  registerHooks: (hooks: ModuleHooks) => unknown;
  onExit: (listener: () => void) => void;
  writeRecord: (path: string, record: ProcessRecord) => void;
  join: (...parts: string[]) => string;
}

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
  const testFile = deps.env[ENV.file];

  if (testFile && deps.mainFile === testFile) {
    deps.global[reporting] = recordEvents(testFile, tests);
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
      nodeTest: deps.nodeTest(),
    });
    deps.global[wrappedNodeTest] = wrapped;
    deps.registerHooks(redirectNodeTest(Object.keys(wrapped)));
  }

  deps.onExit(() => {
    const dryRun = deps.env[ENV.dryRun] === 'true';
    deps.writeRecord(deps.join(outDir, `${deps.pid}.json`), {
      tests,
      hitCount: ns.hitCount,
      mutantCoverage: dryRun ? ns.mutantCoverage : undefined,
    });
  });

  return true;
}

/**
 * Returns a function that records the tests of one test file from node:test's reporter events, with ids built the
 * way the wrapper builds them. A suite is recorded only when it fails by itself, such as in a `before` hook.
 */
export function recordEvents(testFile: string, tests: RecordedTest[]): (event: TestEvent) => void {
  /** The name of the test or suite that started last at each nesting level. */
  const names = new Map<number, string>();

  return ({ type, data }) => {
    if (type === 'test:start') {
      names.set(data.nesting, data.name);

      return;
    }

    if (type !== 'test:pass' && type !== 'test:fail') {
      return;
    }

    const { type: kind, duration_ms: timeSpentMs, error } = data.details!;

    if (kind === 'suite' && (type === 'test:pass' || error?.failureType === 'subtestsFailed')) {
      return;
    }

    const enclosing = Array.from({ length: data.nesting }, (_, level) => names.get(level));
    const id = [testFile, ...enclosing, data.name].join(' > ');

    // node:test runs a todo test but ignores its outcome.
    if (data.skip !== undefined || data.todo !== undefined) {
      tests.push({ id, status: 'skipped', timeSpentMs });
    } else if (error) {
      // The cause is what the test threw; a hook failure, a timeout or an unmet expectFailure has a message only.
      const failureMessage = error.cause instanceof Error ? error.cause.message : error.message;
      tests.push({ id, status: 'failed', failureMessage, timeSpentMs });
    } else {
      tests.push({ id, status: 'passed', timeSpentMs });
    }
  };
}

export interface WrapOptions {
  ns: StrykerNamespace;
  testFile: string;
  /** The tests node:test has reported so far. */
  tests: RecordedTest[];
  /** Test ids to run; all other tests are skipped. Runs every test when absent. */
  filter: Set<string> | undefined;
  /** Whether tests that start after a test of this process failed are skipped. */
  bail: boolean;
  /** The mutant to activate when the first test starts; it stays active for the rest of the process. */
  activeMutant: string | undefined;
  env: Record<string, string | undefined>;
  nodeTest: NodeTestModule;
}

/**
 * Returns a copy of the node:test module whose suite and test functions are wrapped so each test's id is known while
 * it runs, and so tests outside the filter, or after a failure when bailing, are skipped. Subtests that a test
 * registers with `t.test` are wrapped the same way. The test results come from node:test's reporter events.
 *
 * ponytail: supports `(name, [options], fn)` calls with synchronous suite bodies, and test bodies that return a
 * value or a promise or that take node:test's `done` callback. Bailing acts on the results node:test has reported,
 * and node:test reports the first tests of a file only once its reporters start, so a few quick tests can still run
 * after the first failure.
 */
export function wrapNodeTest(options: WrapOptions): NodeTestModule {
  const { ns, testFile, tests, filter, bail, activeMutant, env, nodeTest } = options;
  const suites: string[] = [];
  const bailed = () => bail && tests.some((test) => test.status === 'failed');
  const setCurrent = (id: string | undefined) => {
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
  const selected = (id: string) =>
    !filter || filter.has(testFile) || [...filter].some((test) => test === id || test.startsWith(`${id} > `));

  const wrapSuite = (register: Registrar): Registrar =>
    function (this: unknown, name: string, ...rest: unknown[]) {
      const wrap = (body: Body) =>
        function (this: unknown, ...args: unknown[]) {
          suites.push(String(name));

          try {
            return body.apply(this, args);
          } finally {
            suites.pop();
          }
        };

      return register.call(this, name, ...rest.map((arg) => (typeof arg === 'function' ? wrap(arg as Body) : arg)));
    };

  /** Wraps a function that registers tests named after `scope()`: the file and the enclosing suites, or a test. */
  const wrapTest = (register: Registrar, scope = () => [testFile, ...suites]): Registrar =>
    function (this: unknown, name: string, ...rest: unknown[]) {
      const id = [...scope(), String(name)].join(' > ');
      /** The test that registered this one as a subtest, which is current again once this one ends. */
      let parent: string | undefined;

      const enter = (context: TestContext) => {
        parent = ns.currentTestId;
        setCurrent(id);
        context.test = wrapTest(context.test, () => [id]);

        // The environment variable makes the processes the test starts load with the mutant active.
        if (activeMutant !== undefined) {
          ns.activeMutant = activeMutant;
          env[ACTIVE_MUTANT_ENV] = activeMutant;
        }
      };
      const leave = () => setCurrent(parent);
      const wrap = (body: Body): Body => {
        if (!selected(id)) {
          return (context) => (context as TestContext).skip();
        }

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
              body.call(this, context, (error?: unknown) => {
                leave();
                done(error);
              });
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
            return await body.apply(this, args);
          } finally {
            leave();
          }
        };
      };

      return register.call(this, name, ...rest.map((arg) => (typeof arg === 'function' ? wrap(arg as Body) : arg)));
    };

  // The bodies of skipped suites and tests never run, so `skip` needs no wrapper.
  const withShorthands = (original: Register, wrap: (register: Registrar) => Registrar): Register =>
    Object.assign(wrap(original), original, {
      todo: wrap(original.todo),
      only: wrap(original.only),
      ...(original.expectFailure && { expectFailure: wrap(original.expectFailure) }),
    });
  // The module is node:test's `test` function, which also carries the other functions.
  const test = withShorthands(nodeTest, wrapTest);

  return Object.assign(test, {
    describe: withShorthands(nodeTest.describe, wrapSuite),
    suite: withShorthands(nodeTest.suite, wrapSuite),
    it: withShorthands(nodeTest.it, wrapTest),
    test,
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


// The logic hook.ts installs into every process of a node:test run under Stryker. Its dependencies are
// parameters, so tests can drive it in-process.

/** A test as the hook records it. */
export interface RecordedTest {
  /** The test file's absolute path, the enclosing suite names, and the test name, joined by ` > `. */
  id: string;
  status: 'passed' | 'failed';
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
  currentTestId?: string;
  mutantCoverage?: Coverage;
  hitCount?: number;
  hitLimit?: number;
}

type Body = (this: unknown, ...args: unknown[]) => unknown;
type Register = (this: unknown, name: string, ...rest: unknown[]) => unknown;

/** The node:test functions the hook wraps. */
export interface NodeTestModule {
  describe: Register;
  suite: Register;
  it: Register;
  test: Register;
}

/** Environment variables shared between the runner and the hook. */
export const ENV = {
  out: 'STRYKER_NODE_TEST_OUT',
  file: 'STRYKER_NODE_TEST_FILE',
  dryRun: 'STRYKER_NODE_TEST_DRY_RUN',
  hitLimit: 'STRYKER_NODE_TEST_HIT_LIMIT',
  current: 'STRYKER_NODE_TEST_CURRENT',
  filter: 'STRYKER_NODE_TEST_FILTER',
  bail: 'STRYKER_NODE_TEST_BAIL',
} as const;

export interface HookDependencies {
  env: Record<string, string | undefined>;
  /** `process.argv[1]`, resolved to an absolute path. */
  mainFile: string | undefined;
  pid: number;
  global: { __stryker__?: StrykerNamespace; [installed]?: true };
  nodeTest: () => NodeTestModule;
  publishNodeTest: () => void;
  onExit: (listener: () => void) => void;
  writeRecord: (path: string, record: ProcessRecord) => void;
  now: () => number;
  join: (...parts: string[]) => string;
}

/** Marks a process whose hook is installed, so a second copy of the hook (a runner under test) stays inactive. */
export const installed = Symbol.for('thermos.stryker-node-test-runner.hook');

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
    const filterJson = deps.env[ENV.filter];
    const filter = filterJson ? new Set<string>(JSON.parse(filterJson) as string[]) : undefined;
    wrapNodeTest({ ns, testFile, tests, filter, bail, env: deps.env, now: deps.now, nodeTest: deps.nodeTest() });
    deps.publishNodeTest();
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

export interface WrapOptions {
  ns: StrykerNamespace;
  testFile: string;
  tests: RecordedTest[];
  /** Test ids to run; the bodies of all other tests are skipped. Runs every test when absent. */
  filter: Set<string> | undefined;
  /** Whether the bodies of tests that start after a test of this process failed are skipped. */
  bail: boolean;
  env: Record<string, string | undefined>;
  now: () => number;
  nodeTest: NodeTestModule;
}

/**
 * Wraps node:test's suite and test functions so each test's id is known while it runs.
 *
 * ponytail: supports `(name, [options], fn)` calls with synchronous suite bodies, and test bodies that return a
 * value or a promise or that take node:test's `done` callback. Tests through the default export
 * (`import test from 'node:test'`) and `t.test` subtests are not attributed; add them when a test needs them.
 */
export function wrapNodeTest({ ns, testFile, tests, filter, bail, env, now, nodeTest }: WrapOptions): void {
  const suites: string[] = [];
  const bailed = () => bail && tests.some((test) => test.status === 'failed');

  for (const key of ['describe', 'suite'] as const) {
    const original = nodeTest[key];
    nodeTest[key] = Object.assign(function (this: unknown, name: string, ...rest: unknown[]) {
      const wrap = (body: Body) =>
        function (this: unknown, ...args: unknown[]) {
          suites.push(String(name));

          try {
            return body.apply(this, args);
          } finally {
            suites.pop();
          }
        };

      return original.call(this, name, ...rest.map((arg) => (typeof arg === 'function' ? wrap(arg as Body) : arg)));
    }, original);
  }

  for (const key of ['it', 'test'] as const) {
    const original = nodeTest[key];
    nodeTest[key] = Object.assign(function (this: unknown, name: string, ...rest: unknown[]) {
      const id = [testFile, ...suites, String(name)].join(' > ');
      const enter = () => {
        ns.currentTestId = id;
        env[ENV.current] = id;

        return now();
      };
      /** Records the test as passed, or as failed with `failure.error`, and leaves it. */
      const leave = (start: number, failure?: { error: unknown }) => {
        const error = failure?.error;
        tests.push(
          failure
            ? {
                id,
                status: 'failed',
                failureMessage: error instanceof Error ? error.message : String(error),
                timeSpentMs: now() - start,
              }
            : { id, status: 'passed', timeSpentMs: now() - start },
        );
        ns.currentTestId = undefined;
        delete env[ENV.current];
      };
      const wrap = (body: Body) => {
        if (filter && !filter.has(id)) {
          return () => {};
        }

        // node:test passes a `done` callback only to a function that declares a second parameter.
        if (body.length >= 2) {
          return function (this: unknown, context: unknown, done: (error?: unknown) => void) {
            if (bailed()) {
              done();

              return;
            }

            const start = enter();
            const finish = (error?: unknown) => {
              leave(start, error ? { error } : undefined);
              done(error);
            };

            try {
              body.call(this, context, finish);
            } catch (error) {
              leave(start, { error });
              throw error;
            }
          };
        }

        return async function (this: unknown, ...args: unknown[]) {
          if (bailed()) {
            return;
          }

          const start = enter();

          try {
            const result = await body.apply(this, args);
            leave(start);

            return result;
          } catch (error) {
            leave(start, { error });
            throw error;
          }
        };
      };

      return original.call(this, name, ...rest.map((arg) => (typeof arg === 'function' ? wrap(arg as Body) : arg)));
    }, original);
  }
}

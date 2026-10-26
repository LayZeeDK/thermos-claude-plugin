import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InstrumenterContext, MutantCoverage, Position } from '@stryker-mutator/api/core';

import type { MemoryLimitReached, WatchdogData } from './watchdog.ts';

export function testId(parent: string, name: string): string {
  return `${parent} > ${/(^| )>( |$)/.test(name) ? name.replace(/[\\>]/g, '\\$&') : name}`;
}

/** node:test reports in declaration order, so the wrapper and the reporter number alike. */
export function uniqueIds(): (parent: string, name: string) => string {
  const used = new Set<string>();

  return (parent, name) => {
    const base = testId(parent, name);

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

export function within(id: string, scope: string): boolean {
  return id === scope || id.startsWith(`${scope} > `);
}

export interface RecordedTest {
  id: string;
  /** Skipped tests include todo tests, which run but whose outcome node:test ignores. */
  status: 'passed' | 'failed' | 'skipped';
  failureMessage?: string;
  timeSpentMs: number;
  startPosition?: Position;
}

/** A function call on the stack: its file path and its 1-based position. */
export interface CallSite {
  file: string;
  line: number;
  column: number;
}

export interface ProcessRecord {
  main?: true;
  tests: RecordedTest[];
  hitCount?: number;
  mutantCoverage?: MutantCoverage;
  peakMemoryMB?: number;
  memoryLimitReached?: MemoryLimitReached;
  diagnostics?: string[];
  /**
   * Set when the test file's process exited before node:test's summary through process.exit() or an uncaught
   * exception, which skip `beforeExit`, unless the hook ended it once node:test had reported every top-level suite and
   * test.
   */
  unfinished?: true;
  /** What kept the test file's process alive after its tests and root `after` hooks, when the hook ended it for that. */
  heldOpen?: string[];
}

type Body = (this: unknown, ...args: unknown[]) => unknown;
type Registrar = (this: unknown, name: string, ...rest: unknown[]) => unknown;
type HookRegistrar = (this: unknown, hook?: Body, ...rest: unknown[]) => unknown;
/**
 * A node:test function with its shorthands, which do not call the function itself. Tests have `expectFailure` from
 * Node.js 24.
 */
type Register = Registrar & { skip: Registrar; todo: Registrar; only: Registrar; expectFailure?: Registrar };
interface TestContext {
  skip(): void;
  test: Registrar;
  after: HookRegistrar;
  beforeEach: HookRegistrar;
}

export interface TestEvent {
  type: string;
  data: {
    name: string;
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

const AFTER_HOOK = '"after" hook';

export const ENV = {
  out: 'STRYKER_NODE_TEST_OUT',
  file: 'STRYKER_NODE_TEST_FILE',
  dryRun: 'STRYKER_NODE_TEST_DRY_RUN',
  hitLimit: 'STRYKER_NODE_TEST_HIT_LIMIT',
  memoryLimit: 'STRYKER_NODE_TEST_MEMORY_LIMIT_MB',
  current: 'STRYKER_NODE_TEST_CURRENT',
  filter: 'STRYKER_NODE_TEST_FILTER',
  bail: 'STRYKER_NODE_TEST_BAIL',
  activeMutant: 'STRYKER_NODE_TEST_ACTIVE_MUTANT',
  heldOpen: 'STRYKER_NODE_TEST_HELD_OPEN_MS',
} as const;

/** How long the test file's process may stay alive after its tests and root `after` hooks, unless ENV.heldOpen says. */
export const HELD_OPEN_MS = 30_000;

/** Stryker's variable for the active mutant, which instrumented code reads when it loads. */
export const ACTIVE_MUTANT_ENV = '__STRYKER_ACTIVE_MUTANT__';

export interface HookDependencies {
  env: Record<string, string | undefined>;
  mainFile: string | undefined;
  pid: number;
  /** Worker threads load the hook too; 0 is the main thread. */
  threadId: number;
  global: {
    __stryker__?: InstrumenterContext;
    [installed]?: true;
    [reporting]?: (event: TestEvent) => void;
    [wrappedNodeTest]?: NodeTestModule;
    [watchdog]?: unknown;
  };
  nodeTest: () => NodeTestModule;
  registerHooks: (hooks: ModuleHooks) => unknown;
  onExit: (listener: () => void) => void;
  offExit: (listener: () => void) => void;
  /** Registers a `beforeExit` listener, which a process that ends by itself calls and `process.exit()` skips. */
  onBeforeExit: (listener: () => void) => void;
  writeRecord: (path: string, record: ProcessRecord) => void;
  /** Ends the process as `process.exit` does, with `process.exitCode` when no code is given. */
  exit: (code?: number) => void;
  /** `process.getActiveResourcesInfo`, a new array on every call. */
  activeResources: () => string[];
  /** Calls `callback` after `ms` without keeping the process alive. */
  later: (callback: () => void, ms: number) => void;
  /** Under the permission model without write access, the process runs as it would outside Stryker, with no record. */
  canWriteRecords: boolean;
  peakMemoryMB: () => number;
  /** The main thread only, as a test's worker threads load the hook too, and only where the permission model allows. */
  canWatchMemory: boolean;
  /**
   * A worker thread, as the watchdog must work while a test blocks the process: Node.js's assertion diff can fill
   * gigabytes in one synchronous call.
   */
  watchMemory: (options: { workerData: WatchdogData; execArgv: string[]; env: Record<string, string> }) => unknown;
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

export const installed = Symbol.for('thermos.stryker-node-test-runner.hook');

export const reporting = Symbol.for('thermos.stryker-node-test-runner.reporting');

export const wrappedNodeTest = Symbol.for('thermos.stryker-node-test-runner.node-test');

export const watchdog = Symbol.for('thermos.stryker-node-test-runner.watchdog');

export function writesAllowed(
  permission: { has(scope: string, reference?: string): boolean } | undefined,
  dir: string | undefined,
): boolean {
  return permission?.has('fs.write', dir) !== false;
}

export function recordName(pid: number, threadId: number): string {
  return `${pid}.${threadId}.json`;
}

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

  const memoryLimit = Number(deps.env[ENV.memoryLimit]);

  if (memoryLimit > 0 && deps.canWatchMemory) {
    const { NODE_COMPILE_CACHE } = deps.env;
    deps.global[watchdog] = deps.watchMemory({
      workerData: { limitMB: memoryLimit, recordPath: join(outDir, `${deps.pid}.memory.json`) },
      // Without the process's options, such as --require ts-node/register, which would load in the thread again, and
      // without its environment, whose NODE_OPTIONS Node.js would read for the thread: its --require preloads would
      // run there too, and --input-type=module would make the thread an ES module, which also loads the --import
      // preloads, the hook among them. Only the compile cache comes along, so the thread compiles watchdog.ts once.
      execArgv: [],
      env: NODE_COMPILE_CACHE === undefined ? {} : { NODE_COMPILE_CACHE },
    });
  }

  ns.currentTestId = deps.env[ENV.current] || undefined;
  const bail = deps.env[ENV.bail] === 'true';
  const dryRun = deps.env[ENV.dryRun] === 'true';
  delete deps.env[ENV.bail];
  const tests: RecordedTest[] = [];
  const diagnostics: string[] = [];
  const testFile = deps.env[ENV.file];
  const main = testFile !== undefined && deps.threadId === 0 && deps.mainFile === testFile;
  let summarized = false;
  let natural = false;
  let end: Ending | undefined;

  if (main) {
    const positions = new Map<string, Position>();
    const nodeTest = deps.nodeTest();
    const ends = ending(deps, tests, (hook) => nodeTest.after(hook), Number(deps.env[ENV.heldOpen]) || HELD_OPEN_MS);
    end = ends;
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
        summarized = true;
      }

      recordEvent(event);
      ends.reported(event);
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
      // A source map can point at another file, such as `src/` for a test in `dist/`; the test file's own position
      // is better than none.
      callSites: () => {
        const mapped = callSites(true);

        return mapped.some(({ file }) => file === testFile) ? mapped : callSites(false);
      },
      nodeTest,
      registering: ends.registering,
      rootAfter: ends.track,
    });
    deps.global[wrappedNodeTest] = wrapped;
    deps.registerHooks(redirectNodeTest(Object.keys(wrapped)));
  }

  const write = () => {
    if (!deps.canWriteRecords) {
      return;
    }

    const outcome = end?.outcome();
    deps.writeRecord(join(outDir, recordName(deps.pid, deps.threadId)), {
      ...(main && { main }),
      tests,
      hitCount: ns.hitCount,
      mutantCoverage: dryRun ? ns.mutantCoverage : undefined,
      peakMemoryMB: dryRun ? deps.peakMemoryMB() : undefined,
      ...(diagnostics.length > 0 && { diagnostics }),
      ...(main && !summarized && !natural && !outcome?.complete && { unfinished: true }),
      ...(outcome?.heldOpen && { heldOpen: outcome.heldOpen }),
    });
  };

  // Node.js runs no exit listener that is added while the process exits, so the record goes behind the exit listeners
  // of the tests here, where a process that ends by itself still runs code. process.exit() skips `beforeExit`.
  deps.onBeforeExit(() => {
    natural = true;
    deps.offExit(write);
    deps.onExit(write);
  });
  deps.onExit(write);

  return true;
}

export interface Ending {
  /**
   * The test file registers a suite, test or hook through node:test, `topLevel` when it is a suite or test outside any
   * other. The first registration also registers a root `after` hook of the ending's own, ahead of the file's.
   */
  registering: (topLevel: boolean) => void;
  /** Makes the ending wait for a root `after` hook of the test file to settle. */
  track: (hook: Body) => Body;
  /** node:test has reported another event. */
  reported: (event: TestEvent) => void;
  /** Whether node:test had reported every top-level suite and test when the hook ended the process, and what held it open. */
  outcome: () => { complete: boolean; heldOpen?: string[] };
}

/**
 * Ends a test file's process that outlives its tests, as a server left listening makes it. Once node:test has
 * finished every top-level suite and test and the file's root `after` hooks have settled, or one of them threw, which
 * stops the rest, a file with a failed test ends at once with exit code 1, as nothing later changes its outcome. Any
 * other file still alive `graceMs` later ends with node:test's exit code.
 *
 * node:test runs root `after` hooks in the order they were added, once every top-level suite and test has finished.
 * The ending adds its own at the file's first registration, not earlier: node:test sets itself up on its first use, and
 * an error thrown before that, while the file loads, must stay an ordinary uncaught exception.
 */
export function ending(
  deps: Pick<HookDependencies, 'exit' | 'activeResources' | 'later'>,
  tests: RecordedTest[],
  rootAfter: (hook: () => void) => void,
  graceMs: number,
): Ending {
  let declared = 0;
  let reportedTopLevel = 0;
  let hooked = false;
  let finished = false;
  let pending = 0;
  let threw = false;
  let armed = false;
  let ended: ReturnType<Ending['outcome']> = { complete: false };
  const before = deps.activeResources();
  // What the tests opened, not what the process had before they ran, such as the pipe the runner reads stderr from.
  const opened = () => {
    const resources = deps.activeResources();

    for (const resource of before) {
      const index = resources.indexOf(resource);

      if (index !== -1) {
        resources.splice(index, 1);
      }
    }

    return resources;
  };
  // node:test reports a test a little after it ends, so a failure can arrive after the hooks have settled. It reports a
  // suite after everything inside it, so once each top-level one is reported, everything is.
  const allReported = () => reportedTopLevel >= declared;
  const end = (code: number | undefined, heldOpen?: string[]) => {
    ended = { complete: allReported(), ...(heldOpen && { heldOpen }) };
    deps.exit(code);
  };
  const check = () => {
    if (armed && allReported() && tests.some((test) => test.status === 'failed')) {
      end(1);
    }
  };
  // An `after` hook added inside another hook counts as a root one but runs when that hook ends, before the ending's own
  // root `after` hook says that node:test has finished the tests.
  const settled = () => {
    if (!finished || armed || (pending > 0 && !threw)) {
      return;
    }

    armed = true;
    deps.later(() => end(undefined, opened()), graceMs);
    check();
  };
  const settle = (failed: boolean) => {
    pending--;
    threw ||= failed;
    settled();
  };

  return {
    registering: (topLevel) => {
      if (!hooked) {
        hooked = true;
        rootAfter(() => {
          finished = true;
          settled();
        });
      }

      if (topLevel) {
        declared++;
      }
    },
    track: (hook) => {
      pending++;
      const callback = hook.length >= 2;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        try {
          if (!callback) {
            return Promise.resolve(hook.apply(this, args)).then(
              () => settle(false),
              (error: unknown) => {
                settle(true);
                throw error;
              },
            );
          }

          const done = args[1] as (error?: unknown) => void;
          args[1] = (error?: unknown) => {
            settle(Boolean(error));
            done(error);
          };

          return hook.apply(this, args);
        } catch (error) {
          settle(true);
          throw error;
        }
      };
      Object.defineProperty(wrapped, 'length', { value: hook.length });

      return wrapped;
    },
    reported: ({ type, data }) => {
      // A failing root hook is reported as a failure of the file itself, which has no type.
      if ((type === 'test:pass' || type === 'test:fail') && data.nesting === 0 && data.details?.type !== undefined) {
        reportedTopLevel++;
      }

      // Also a root `after` hook that node:test ended by its timeout, whose function never settles; node:test runs none
      // after it.
      if (finished && type === 'test:fail' && data.nesting === 0 && data.details?.type === undefined) {
        threw = true;
        settled();
      }

      check();
    },
    outcome: () => ended,
  };
}

/**
 * What node:test's diagnostic of an error raised after its test ended says. node:test reports it when such an error
 * reaches its `uncaughtException` or `unhandledRejection` handler (`createProcessEventHandler` in
 * `lib/internal/test_runner/harness.js`).
 */
const LATE_ACTIVITY = 'generated asynchronous activity after the test ended';

/** node:test reports an error raised after its test ended only as a diagnostic, which is kept in `diagnostics`. */
export function recordEvents(
  testFile: string,
  tests: RecordedTest[],
  positions: Map<string, Position>,
  diagnostics: string[],
): (event: TestEvent) => void {
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
  tests: RecordedTest[];
  filter: Set<string> | undefined;
  bail: boolean;
  activeMutant: string | undefined;
  env: Record<string, string | undefined>;
  positions: Map<string, Position>;
  callSites: () => CallSite[];
  nodeTest: NodeTestModule;
  /** Called before each suite, test or hook goes to node:test, `topLevel` for a suite or test outside any other. */
  registering: (topLevel: boolean) => void;
  /** Wraps a function registered as an `after` hook outside any suite, a root `after` hook of the test file. */
  rootAfter: (hook: Body) => Body;
}

/**
 * Supports synchronous suite bodies, and test bodies that return a value or a promise or that take node:test's `done`
 * callback. Bailing acts on the results node:test has reported, and node:test reports the first tests of a file only
 * once its reporters start, so a few quick tests can still run after the first failure.
 */
export function wrapNodeTest(options: WrapOptions): NodeTestModule {
  const { ns, testFile, tests, filter, bail, activeMutant, env, positions, callSites, nodeTest, registering, rootAfter } =
    options;
  const idOf = uniqueIds();
  /**
   * node:test makes the suite or test whose body runs, followed through asynchronous calls, the parent of the suites
   * and tests registered with its module's functions.
   */
  const running = new AsyncLocalStorage<string>();
  const parentId = () => running.getStore() ?? testFile;
  const bailed = () => bail && tests.some((test) => test.status === 'failed');
  // The last is current, also when a subtest that its parent does not await outlives the parent's body.
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
  const activate = () => {
    if (activeMutant !== undefined) {
      ns.activeMutant = activeMutant;
      env[ACTIVE_MUTANT_ENV] = activeMutant;
    }
  };
  /** Like node:test's own filters, a suite without a selected test runs its body and registers none of its hooks. */
  const wrapHook = (
    register: HookRegistrar,
    prepare: (hook: Body | undefined, suite: string | undefined) => Body | undefined = (hook) => hook,
  ): HookRegistrar =>
    function (this: unknown, hook?: Body, ...rest: unknown[]) {
      const suite = running.getStore();

      if (suite !== undefined && !selected(suite)) {
        return undefined;
      }

      registering(false);

      return register.call(this, prepare(hook, suite), ...rest);
    };
  /**
   * node:test's `fullName` of each suite and test, by id, and the test each `fullName` names, or none for a suite or
   * a name that several share. node:test passes a hook the context of the test it runs for, or of its suite.
   */
  const fullNames = new Map<string, string>();
  const testsByFullName = new Map<string, string | undefined>();
  const testOf = (context: unknown) => testsByFullName.get((context as { fullName: string } | undefined)?.fullName!);
  /** Makes the test that `find` names current while the hook runs, unless that test is running already. */
  const attributing = (hook: Body | undefined, find: (context: unknown) => string | undefined): Body | undefined => {
    if (typeof hook !== 'function') {
      return hook;
    }

    const callback = hook.length >= 2;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const id = find(args[0]);

      if (id === undefined || active.has(id)) {
        return hook.apply(this, args);
      }

      active.add(id);
      setCurrent();
      const end = () => {
        active.delete(id);
        setCurrent();
      };

      if (callback) {
        const done = args[1] as (error?: unknown) => void;
        args[1] = (error?: unknown) => {
          end();
          done(error);
        };
      }

      try {
        const result = hook.apply(this, args);

        return callback ? result : Promise.resolve(result).finally(end);
      } catch (error) {
        end();
        throw error;
      }
    };
    Object.defineProperty(wrapped, 'length', { value: hook.length });

    return wrapped;
  };
  const activating = (hook: Body | undefined): Body | undefined => {
    // node:test registers a hook without a function, as one that does nothing.
    if (typeof hook !== 'function') {
      return hook;
    }

    const wrapped = function (this: unknown, ...args: unknown[]) {
      activate();

      return hook.apply(this, args);
    };
    // node:test passes a `done` callback to a hook that declares a parameter for it.
    Object.defineProperty(wrapped, 'length', { value: hook.length });

    return wrapped;
  };

  /** node:test takes the position from its caller, which is a wrapper, so the wrapper finds it itself. */
  const declare = (id: string) => {
    const site = callSites().find(({ file }) => file === testFile);

    if (site) {
      positions.set(id, { line: site.line - 1, column: site.column - 1 });
    }
  };
  const named = (parent: string, name: string, test: boolean) => {
    registering(parent === testFile);
    const id = idOf(parent, name);
    const fullName = parent === testFile ? name : `${fullNames.get(parent)} > ${name}`;
    fullNames.set(id, fullName);
    testsByFullName.set(fullName, test && !testsByFullName.has(fullName) ? id : undefined);
    declare(id);

    return id;
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
      const parsed = parse(args);
      const id = named(parentId(), parsed.name, false);
      const wrap = (suiteBody: Body) =>
        function (this: unknown, ...bodyArgs: unknown[]) {
          return running.run(id, () => suiteBody.apply(this, bodyArgs));
        };

      return registerWith(register, this, { ...parsed, body: parsed.body && wrap(parsed.body) });
    };

  const wrapTest = (register: Registrar, parent = parentId): Registrar =>
    function (this: unknown, ...args: unknown[]) {
      const parsed = parse(args);
      const { options, body } = parsed;
      const id = named(parent(), parsed.name, true);
      /**
       * The test stays current until its body ends and node:test has run its afterEach hooks, whichever is later, as
       * node:test waits for the test's subtests and plan in between. Its `t.after` hooks run after that.
       */
      const enter = (context: TestContext) => {
        active.add(id);
        setCurrent();
        let open = 2;
        const leave = () => {
          if (--open === 0) {
            active.delete(id);
            setCurrent();
          }
        };
        const { after, beforeEach } = context;
        after.call(context, leave);
        // `t.test` registers a subtest of `t`'s test, wherever it is called.
        context.test = wrapTest(context.test, () => id);
        context.after = (hook, ...rest) => after.call(context, attributing(hook, () => id), ...rest);
        context.beforeEach = (hook, ...rest) => beforeEach.call(context, attributing(hook, testOf), ...rest);
        activate();

        return leave;
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

            const leave = enter(context as TestContext);

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

          const leave = enter(args[0] as TestContext);

          try {
            return await running.run(id, () => body.apply(this, args));
          } finally {
            leave();
          }
        };
      };

      // A test registered as skipped runs neither its body nor its beforeEach and afterEach hooks.
      const skip = !selected(id) && { skip: true };

      return registerWith(register, this, { ...parsed, options: { ...options, ...skip }, body: body && wrap(body) });
    };

  // The bodies of skipped suites and tests never run, so `skip` only notes where they are declared.
  const declareSkipped = (register: Registrar): Registrar =>
    function (this: unknown, ...args: unknown[]) {
      registering(parentId() === testFile);
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
    beforeEach: wrapHook(nodeTest.beforeEach, (hook) => attributing(activating(hook), testOf)),
    after: wrapHook(nodeTest.after, (hook, suite) => {
      // node:test reports a failing `after` hook outside any suite as a failure of the test file, at the position it
      // takes from its caller, which is this wrapper.
      const attributed = attributing(hook, testOf);

      if (suite !== undefined) {
        return attributed;
      }

      declare(testId(testFile, AFTER_HOOK));

      return typeof attributed === 'function' ? rootAfter(attributed) : attributed;
    }),
    afterEach: wrapHook(nodeTest.afterEach),
  });
}

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


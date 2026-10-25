import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { testFor } from '../test-each/test-for.ts';
import {
  ENV,
  installed,
  reporting,
  type HookDependencies,
  type ProcessRecord,
  type TestEvent,
  watchdog,
} from './hook-core.ts';
import { fixture, GROWS, HOOK_URL, REPORTER_ARG, shareCompileCache } from './index.fixtures.ts';
import reporter from './reporter.ts';

// Loaded here, outside any test, the hook stays inactive (the runner did not start this process, or its own hook is
// installed), and Stryker counts the hook's mutants as covered by every test, including those that run it in a child.
await import('./hook.ts');

shareCompileCache();

/**
 * Loads a fresh copy of hook.ts into this process as if the runner had started it, with its own output directory, no
 * test file and the hook variables in `env`, then restores this process's hook state. Returns the `exit` and
 * `beforeExit` listeners the copy added, detached.
 */
async function loadRunnerStartedHook(
  outDir: string,
  env: Record<string, string> = {},
): Promise<Record<'exit' | 'beforeExit', (() => void)[]>> {
  const global = globalThis as HookDependencies['global'];
  const previousMark = global[installed];
  // The current test id stays, so the copy leaves this process's attribution of coverage alone.
  const previousEnv = Object.values(ENV)
    .filter((key) => key !== ENV.current)
    .map((key) => [key, process.env[key]] as const);
  const events = ['exit', 'beforeExit'] as const;
  // Typed as a plain emitter, which takes either event name.
  const emitter: EventEmitter = process;
  const listeners = new Set(events.flatMap((event) => emitter.listeners(event)));

  for (const [key] of previousEnv) {
    delete process.env[key];
  }

  Object.assign(process.env, { [ENV.out]: outDir, ...env });
  delete global[installed];

  try {
    // A query of its own makes each load run the hook's module again.
    await import(`${HOOK_URL}?runner-started-${randomUUID()}`);
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    if (previousMark) {
      global[installed] = previousMark;
    } else {
      delete global[installed];
    }
  }

  const detach = (event: (typeof events)[number]) => {
    const added = emitter.listeners(event).filter((listener) => !listeners.has(listener)) as (() => void)[];

    for (const listener of added) {
      emitter.removeListener(event, listener);
    }

    return added;
  };

  return { exit: detach('exit'), beforeExit: detach('beforeExit') };
}

function tempDir(t: TestContext): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'hook-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
}

/**
 * Runs `node --import hook.ts --test-reporter=reporter.ts ...args` as the runner would, with only the hook's own
 * variables set. It keeps Stryker's active mutant, so a mutant in hook.ts reaches the process that loads it.
 */
function runWithHook(args: string[], env: Record<string, string>): Promise<{ code: number | null; pid: number }> {
  const base = { ...process.env };

  for (const key of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', ...Object.values(ENV)]) {
    delete base[key];
  }

  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', HOOK_URL, REPORTER_ARG, ...args], {
      env: { ...base, ...env },
      stdio: 'ignore',
    });
    child.on('error', fail);
    child.on('close', (code) => done({ code, pid: child.pid as number }));
  });
}

function readRecords(outDir: string): Record<string, ProcessRecord> {
  return Object.fromEntries(
    readdirSync(outDir).map((name) => [name, JSON.parse(readFileSync(join(outDir, name), 'utf8')) as ProcessRecord]),
  );
}

describe('hook', () => {
  it('writes the record of a process the runner started when the process exits', async (t) => {
    const outDir = tempDir(t);
    // The copy removes the bail variable as the hook does; loading it must leave this process's environment alone.
    const bail = process.env[ENV.bail];
    process.env[ENV.bail] = 'true';
    t.after(() => {
      if (bail === undefined) {
        delete process.env[ENV.bail];
      } else {
        process.env[ENV.bail] = bail;
      }
    });
    const hookEnv = () => Object.fromEntries(Object.values(ENV).map((key) => [key, process.env[key]]));
    const before = hookEnv();
    const added = await loadRunnerStartedHook(outDir);

    assert.deepEqual(hookEnv(), before);
    assert.deepEqual([added.exit.length, added.beforeExit.length], [1, 1]);

    added.exit[0]?.();

    // Only the tests: the hit count and coverage come from this process's namespace, which a Stryker run also uses.
    const records = readRecords(outDir);
    assert.deepEqual(Object.keys(records), [`${process.pid}.json`]);
    assert.deepEqual(records[`${process.pid}.json`]?.tests, []);
  });

  it('starts the memory watchdog, survives its failure, and records the peak memory, when the runner asks', async (t) => {
    const outDir = tempDir(t);
    const global = globalThis as HookDependencies['global'];
    const unref = t.mock.method(Worker.prototype, 'unref');

    const added = await loadRunnerStartedHook(outDir, { [ENV.dryRun]: 'true', [ENV.memoryLimit]: '1000000' });

    const watching = global[watchdog];
    assert.ok(watching instanceof Worker, String(watching));
    t.after(() => watching.terminate());
    // An unref'd watchdog leaves the process to end when its own work does.
    assert.deepEqual(
      unref.mock.calls.map((call) => call.this),
      [watching],
    );
    assert.doesNotThrow(() => watching.emit('error', new Error('preload failed')));

    const rssMB = Math.floor(process.memoryUsage.rss() / 1048576);
    added.exit[0]?.();
    const peakMB = readRecords(outDir)[`${process.pid}.json`]?.peakMemoryMB;
    assert.ok(peakMB !== undefined && Number.isInteger(peakMB) && peakMB >= rssMB && peakMB < 100_000, String(peakMB));
  });

  it('records the tests and coverage of the test file it runs in, in a file named after the process', async (t) => {
    const dir = tempDir(t);
    const outDir = tempDir(t);
    const testFile = join(dir, 'fixture.test.mjs');
    writeFileSync(
      testFile,
      fixture("it('covers', () => { cover('fixture-1'); });"),
    );

    const { code, pid } = await runWithHook([testFile], {
      [ENV.out]: outDir,
      [ENV.file]: testFile,
      [ENV.dryRun]: 'true',
    });

    assert.equal(code, 0);
    const records = readRecords(outDir);
    assert.deepEqual(Object.keys(records), [`${pid}.json`]);
    const record = records[`${pid}.json`];
    assert.ok(record);
    const id = `${testFile} > covers`;
    assert.deepEqual(
      record.tests.map(({ id, status }) => ({ id, status })),
      [{ id, status: 'passed' }],
    );
    assert.equal(typeof record.tests[0]?.timeSpentMs, 'number');
    assert.ok((record.tests[0]?.timeSpentMs ?? -1) >= 0);
    assert.equal(record.mutantCoverage?.perTest[id]?.['fixture-1'], 1);
  });

  it("attributes tests declared through node:test's default export and through require", async (t) => {
    const dir = tempDir(t);
    const outDir = tempDir(t);
    const testFile = join(dir, 'fixture.test.mjs');
    writeFileSync(
      testFile,
      [
        "import test from 'node:test';",
        "import { createRequire } from 'node:module';",
        'const required = createRequire(import.meta.url)(\'node:test\');',
        'const cover = () => {',
        '  const ns = globalThis.__stryker__;',
        '  ns.mutantCoverage ??= { static: {}, perTest: {} };',
        "  ns.mutantCoverage.perTest[ns.currentTestId] = { 'fixture-1': 1 };",
        '};',
        "test('default export', cover);",
        "test.describe('suite', () => { test.it('nested', cover); });",
        "required('required', cover);",
        "required.it('required it', cover);",
        '',
      ].join('\n'),
    );

    const { code, pid } = await runWithHook([testFile], {
      [ENV.out]: outDir,
      [ENV.file]: testFile,
      [ENV.dryRun]: 'true',
    });

    assert.equal(code, 0);
    const record = readRecords(outDir)[`${pid}.json`];
    const ids = ['default export', 'suite > nested', 'required', 'required it'].map((name) => `${testFile} > ${name}`);
    assert.deepEqual(
      record?.tests.map(({ id, startPosition }) => ({ id, startPosition })),
      [
        { id: ids[0], startPosition: { line: 8, column: 0 } },
        { id: ids[1], startPosition: { line: 9, column: 36 } },
        { id: ids[2], startPosition: { line: 10, column: 0 } },
        { id: ids[3], startPosition: { line: 11, column: 9 } },
      ],
    );
    assert.deepEqual(Object.keys(record?.mutantCoverage?.perTest ?? {}), ids);
  });

  testFor([
    ['ends by itself', '', {}],
    ['ends through process.exit()', 'process.exit(0);\n', { unfinished: true }],
  ] as const)('marks the record of a test file that %s without tests as unfinished or not', async ([, exits, unfinished], t) => {
    const dir = tempDir(t);
    const outDir = tempDir(t);
    const testFile = join(dir, 'fixture.test.mjs');
    writeFileSync(testFile, `import 'node:test';\n${exits}`);

    const { code, pid } = await runWithHook([testFile], { [ENV.out]: outDir, [ENV.file]: testFile });

    assert.equal(code, 0);
    assert.deepEqual(readRecords(outDir)[`${pid}.json`], { main: true, tests: [], ...unfinished });
  });

  it('records where a CommonJS test file declares its tests', async (t) => {
    const dir = tempDir(t);
    const outDir = tempDir(t);
    const testFile = join(dir, 'fixture.test.cjs');
    writeFileSync(testFile, "const { it } = require('node:test');\n\n  it('passes', () => {});\n");

    const { code, pid } = await runWithHook([testFile], { [ENV.out]: outDir, [ENV.file]: testFile });

    assert.equal(code, 0);
    assert.deepEqual(readRecords(outDir)[`${pid}.json`]?.tests[0]?.startPosition, { line: 2, column: 2 });
  });

  /** A test file whose source map sends line 2, the `it` call, to line 41, column 3 of `source`. */
  const mapped = (source: string) => {
    const map = { version: 3, sources: [source], names: [], mappings: ';AAwCE' };

    return (
      "import { it } from 'node:test';\nit('mapped', () => {});\n" +
      `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`
    );
  };

  testFor([
    [
      'a loader transpiled, through its source map',
      'fixture.test.mjs',
      mapped('fixture.test.mjs'),
      { line: 40, column: 2 },
    ],
    [
      'was compiled from another file, in the test file itself',
      'fixture.test.mjs',
      mapped('../src/fixture.test.ts'),
      { line: 1, column: 0 },
    ],
    [
      'type stripping kept',
      'fixture.test.ts',
      "import { it } from 'node:test';\nconst typed: number = 1; it('stripped', () => {});\n",
      { line: 1, column: 25 },
    ],
  ] as const)('records where the source declares a test that %s', async ([, name, source, position], t) => {
    const dir = tempDir(t);
    const outDir = tempDir(t);
    // A loader such as tsx turns source maps on this way, so stack traces are mapped and raw call sites are not.
    const maps = join(dir, 'maps.mjs');
    writeFileSync(maps, 'process.setSourceMapsEnabled(true);\n');
    const testFile = join(dir, name);
    writeFileSync(testFile, source);

    const args = ['--import', pathToFileURL(maps).href, testFile];
    const { code, pid } = await runWithHook(args, { [ENV.out]: outDir, [ENV.file]: testFile });

    assert.equal(code, 0);
    assert.deepEqual(readRecords(outDir)[`${pid}.json`]?.tests[0]?.startPosition, position);
  });

  it('records where the test file declares a test through helpers many calls deep', async (t) => {
    const dir = tempDir(t);
    const outDir = tempDir(t);
    const levels = Array.from({ length: 12 }, (_, level) => `export const level${level} = () => level${level + 1}();`);
    writeFileSync(
      join(dir, 'helper.mjs'),
      ["import { it } from 'node:test';", ...levels, "export const level12 = () => it('deep', () => {});", ''].join('\n'),
    );
    const testFile = join(dir, 'fixture.test.mjs');
    writeFileSync(testFile, "import { level0 } from './helper.mjs';\n\n  level0();\n");

    const { code, pid } = await runWithHook([testFile], { [ENV.out]: outDir, [ENV.file]: testFile });

    assert.equal(code, 0);
    assert.deepEqual(readRecords(outDir)[`${pid}.json`]?.tests[0]?.startPosition, { line: 2, column: 2 });
  });

  it('records the results node:test reports, also of hooks, runtime skips and todo tests', async (t) => {
    const dir = tempDir(t);
    const outDir = tempDir(t);
    const testFile = join(dir, 'fixture.test.mjs');
    writeFileSync(
      testFile,
      [
        "import { afterEach, describe, it } from 'node:test';",
        "describe('suite', () => {",
        "  afterEach(() => { throw new Error('afterEach failure'); });",
        "  it('passes, then its hook fails', () => {});",
        '});',
        "it('skips itself', (t) => { t.skip(); });",
        "it('is todo', (t) => { t.todo(); throw new Error('not done'); });",
        '',
      ].join('\n'),
    );

    const { code, pid } = await runWithHook([testFile], { [ENV.out]: outDir, [ENV.file]: testFile });

    assert.equal(code, 1);
    assert.deepEqual(
      readRecords(outDir)[`${pid}.json`]?.tests.map(({ id, status, failureMessage }) => ({
        id,
        status,
        failureMessage,
      })),
      [
        {
          id: `${testFile} > suite > passes, then its hook fails`,
          status: 'failed',
          failureMessage: 'afterEach failure',
        },
        { id: `${testFile} > skips itself`, status: 'skipped', failureMessage: undefined },
        { id: `${testFile} > is todo`, status: 'skipped', failureMessage: undefined },
      ],
    );
  });

  it('records a process without a main file, such as node -e', async (t) => {
    const outDir = tempDir(t);

    const { code, pid } = await runWithHook(['-e', 'process.exitCode = 0'], {
      [ENV.out]: outDir,
      [ENV.file]: join(outDir, 'some.test.mjs'),
    });

    assert.equal(code, 0);
    assert.deepEqual(readRecords(outDir), { [`${pid}.json`]: { tests: [] } });
  });

  testFor([
    ['', {}],
    // The watchdog's thread then runs as an ES module, which has no require.
    [' run as an ES module', { NODE_OPTIONS: '--input-type=module' }],
  ] as const)(
    "ends a process%s that holds more memory than the memory limit, leaving the watchdog's record with both numbers",
    async ([, env], t) => {
      const outDir = tempDir(t);

      const { code, pid } = await runWithHook(['-e', GROWS], {
        [ENV.out]: outDir,
        [ENV.memoryLimit]: '200',
        ...env,
      });

      assert.notEqual(code, 0);
      const records = readRecords(outDir);
      assert.deepEqual(Object.keys(records), [`${pid}.memory.json`]);
      const { tests, memoryLimitReached } = records[`${pid}.memory.json`] as ProcessRecord;
      assert.deepEqual(tests, []);
      assert.equal(memoryLimitReached?.limitMB, 200);
      assert.ok(memoryLimitReached.rssMB > 200 && memoryLimitReached.rssMB < 400, String(memoryLimitReached.rssMB));
    },
  );

  it("keeps the record of a process run as an ES module with a memory limit that exits by itself, untouched by the watchdog's thread", async (t) => {
    const outDir = tempDir(t);
    // Run as an ES module, the watchdog's thread loads the hook that NODE_OPTIONS names, as in a Stryker run, and its
    // record would lack the hit count that only the main thread sets.
    const script = 'globalThis.__stryker__.hitCount = 42; setTimeout(() => {}, 500);';

    const { code, pid } = await runWithHook(['-e', script], {
      [ENV.out]: outDir,
      [ENV.memoryLimit]: '1500',
      NODE_OPTIONS: `--input-type=module --import ${JSON.stringify(HOOK_URL)}`,
    });

    assert.equal(code, 0);
    assert.deepEqual(readRecords(outDir), { [`${pid}.json`]: { tests: [], hitCount: 42 } });
  });

  it('records the most memory the process held in MB, in the dry run', async (t) => {
    const outDir = tempDir(t);

    const { pid } = await runWithHook(['-e', 'new Int32Array(25e6).fill(1);'], {
      [ENV.out]: outDir,
      [ENV.dryRun]: 'true',
    });

    const peakMB = readRecords(outDir)[`${pid}.json`]?.peakMemoryMB;
    assert.ok(Number.isInteger(peakMB) && (peakMB as number) >= 100 && (peakMB as number) < 1000, String(peakMB));
  });

  it("watches memory from the main thread only, not from a test's own worker threads", async (t) => {
    const dir = tempDir(t);
    const outDir = tempDir(t);
    const symbol = `Symbol.for(${JSON.stringify(watchdog.description)})`;
    writeFileSync(
      join(dir, 'worker.mjs'),
      `import { parentPort } from 'node:worker_threads';\nparentPort.postMessage(globalThis[${symbol}] !== undefined);\n`,
    );
    // A file, as a worker thread takes the process's options and refuses --input-type.
    writeFileSync(
      join(dir, 'main.mjs'),
      [
        "import { Worker } from 'node:worker_threads';",
        `const inMain = globalThis[${symbol}] !== undefined;`,
        "const worker = new Worker(new URL('./worker.mjs', import.meta.url));",
        "worker.on('message', (inWorker) => {",
        '  process.exitCode = inMain && !inWorker ? 0 : 1;',
        '  worker.terminate();',
        '});',
        '',
      ].join('\n'),
    );

    const { code } = await runWithHook([join(dir, 'main.mjs')], {
      [ENV.out]: outDir,
      [ENV.memoryLimit]: '1500',
    });

    assert.equal(code, 0);
  });

  it('loads a --require preload once, not again in the memory watchdog', async (t) => {
    const dir = tempDir(t);
    const outDir = tempDir(t);
    writeFileSync(join(dir, 'count.cjs'), "require('node:fs').appendFileSync(__dirname + '/loads.txt', 'load\\n');\n");

    const { code } = await runWithHook(['--require', join(dir, 'count.cjs'), '-e', 'setTimeout(() => {}, 500);'], {
      [ENV.out]: outDir,
      [ENV.memoryLimit]: '1500',
    });

    assert.equal(code, 0);
    assert.equal(readFileSync(join(dir, 'loads.txt'), 'utf8'), 'load\n');
  });

  it('runs a process whose NODE_OPTIONS preload cannot run in a worker with a memory limit', async (t) => {
    const dir = tempDir(t);
    const outDir = tempDir(t);
    // process.chdir throws in a worker thread, which loads the preloads that NODE_OPTIONS names too.
    writeFileSync(join(dir, 'chdir.cjs'), 'process.chdir(__dirname);\n');

    const { code, pid } = await runWithHook(['-e', 'setTimeout(() => {}, 500);'], {
      [ENV.out]: outDir,
      [ENV.memoryLimit]: '1500',
      NODE_OPTIONS: `--require ${JSON.stringify(join(dir, 'chdir.cjs'))}`,
    });

    assert.equal(code, 0);
    assert.deepEqual(readRecords(outDir), { [`${pid}.json`]: { tests: [] } });
  });

  it('runs a process under the permission model without workers with a memory limit as it would without one', async (t) => {
    const outDir = tempDir(t);
    const args = ['--permission', '--allow-fs-read=*', '--allow-fs-write=*', '-e', 'setTimeout(() => {}, 500);'];

    const { code, pid } = await runWithHook(args, { [ENV.out]: outDir, [ENV.memoryLimit]: '1500' });

    assert.equal(code, 0);
    assert.deepEqual(readRecords(outDir), { [`${pid}.json`]: { tests: [] } });
  });
});

describe('reporter', () => {
  it('passes each event to the hook of the test file, and ignores the events of other processes', () => {
    const global = globalThis as HookDependencies['global'];
    const previous = global[reporting];
    const events: TestEvent[] = [];
    const errors: unknown[] = [];
    const event = (name: string): TestEvent => ({ type: 'test:start', data: { name, nesting: 0 } });
    reporter.on('error', (error) => errors.push(error));

    try {
      global[reporting] = (received) => events.push(received);
      reporter.write(event('first'));
      reporter.write(event('second'));
      delete global[reporting];
      reporter.write(event('elsewhere'));
    } finally {
      global[reporting] = previous;
    }

    assert.deepEqual(events, [event('first'), event('second')]);
    assert.deepEqual(errors, []);
  });
});

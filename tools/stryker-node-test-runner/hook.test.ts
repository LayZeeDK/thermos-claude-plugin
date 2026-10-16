import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { ENV, installed, type HookDependencies, type ProcessRecord } from './hook-core.ts';

const HOOK_URL = pathToFileURL(join(import.meta.dirname, 'hook.ts')).href;

// Loaded here, outside any test, the hook stays inactive (the runner did not start this process, or its own hook is
// installed), and Stryker counts the hook's mutants as covered by every test, including those that run it in a child.
await import('./hook.ts');

/**
 * Loads a fresh copy of hook.ts into this process as if the runner had started it, with its own output directory and
 * no test file, then restores this process's hook state. Returns the exit listeners the copy added, detached.
 */
async function loadRunnerStartedHook(outDir: string): Promise<(() => void)[]> {
  const global = globalThis as HookDependencies['global'];
  const previousMark = global[installed];
  // The current test id stays, so the copy leaves this process's attribution of coverage alone.
  const previousEnv = [ENV.out, ENV.file, ENV.dryRun, ENV.hitLimit, ENV.filter].map(
    (key) => [key, process.env[key]] as const,
  );
  const listeners = new Set(process.listeners('exit'));

  for (const [key] of previousEnv) {
    delete process.env[key];
  }

  process.env[ENV.out] = outDir;
  delete global[installed];

  try {
    await import(`${HOOK_URL}?runner-started`);
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

  const added = process.listeners('exit').filter((listener) => !listeners.has(listener)) as (() => void)[];

  for (const listener of added) {
    process.removeListener('exit', listener);
  }

  return added;
}

/** Creates an empty directory that is removed after the test. */
function tempDir(t: TestContext): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'hook-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
}

/**
 * Runs `node --import hook.ts ...args` as the runner would, with only the hook's own variables set. It keeps
 * Stryker's active mutant, so a mutant in hook.ts reaches the process that loads it.
 */
function runWithHook(args: string[], env: Record<string, string>): Promise<{ code: number | null; pid: number }> {
  const base = { ...process.env };

  for (const key of ['NODE_OPTIONS', ...Object.values(ENV)]) {
    delete base[key];
  }

  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--import', HOOK_URL, ...args], {
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
    const added = await loadRunnerStartedHook(outDir);

    assert.equal(added.length, 1);

    added[0]?.();

    // Only the tests: the hit count and coverage come from this process's namespace, which a Stryker run also uses.
    const records = readRecords(outDir);
    assert.deepEqual(Object.keys(records), [`${process.pid}.json`]);
    assert.deepEqual(records[`${process.pid}.json`]?.tests, []);
  });

  it('records the tests and coverage of the test file it runs in, in a file named after the process', async (t) => {
    const dir = tempDir(t);
    const outDir = join(dir, 'out');
    mkdirSync(outDir);
    const testFile = join(dir, 'fixture.test.mjs');
    writeFileSync(
      testFile,
      [
        "import { it } from 'node:test';",
        "it('covers', () => {",
        '  const ns = globalThis.__stryker__;',
        '  ns.mutantCoverage ??= { static: {}, perTest: {} };',
        "  ns.mutantCoverage.perTest[ns.currentTestId] = { 'fixture-1': 1 };",
        '});',
        '',
      ].join('\n'),
    );

    const { code, pid } = await runWithHook([testFile], {
      [ENV.out]: outDir,
      [ENV.file]: testFile,
      [ENV.dryRun]: 'true',
    });

    assert.equal(code, 0);
    const records = readRecords(outDir);
    assert.deepEqual(Object.keys(records), [`${pid}.json`]);
    const record = records[`${pid}.json`] as ProcessRecord;
    const id = `${testFile} > covers`;
    assert.deepEqual(
      record.tests.map(({ id, status }) => ({ id, status })),
      [{ id, status: 'passed' }],
    );
    assert.equal(typeof record.tests[0]?.timeSpentMs, 'number');
    assert.ok((record.tests[0]?.timeSpentMs ?? -1) >= 0);
    assert.equal(record.mutantCoverage?.perTest[id]?.['fixture-1'], 1);
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
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, run, type TestContext } from 'node:test';

import ts from 'typescript';

const TEST_EACH = new URL('./test-each.ts', import.meta.url).href;
const TEST_FOR = new URL('./test-for.ts', import.meta.url).href;

export const SIGNATURES = {
  name: 'TypeError',
  message:
    'testEach and testFor tables take (name, fn), (name, fn, timeout) or (name, options, fn); ' +
    'pass options as the second argument and a single function.',
};

/** A test node:test reported: its outcome, its skip and todo marks, and the message of the error it failed with. */
export interface Reported {
  name: string;
  outcome: 'pass' | 'fail';
  skip?: true;
  todo?: true;
  error?: string;
}

/** Fails the test with its arguments as JSON, so the error tells what the test's body got. */
export function report(...args: unknown[]): never {
  throw new Error(JSON.stringify(args));
}

declare module 'node:test' {
  namespace test {
    interface TestContextAssert {
      /**
       * Runs a test file that calls `cases` and asserts that node:test reports `expected`, in order. The file has
       * `testEach`, `testFor` and `report` and nothing else of the caller's, so `cases` can use only those and globals.
       * With `only`, node:test runs only the tests marked only.
       */
      reports(cases: () => void, expected: Reported[], options?: { only?: boolean }): Promise<void>;
    }
  }
}

assert.register(
  'reports',
  async function (this: TestContext, cases: () => void, expected: Reported[], options: { only?: boolean } = {}) {
    this.assert.deepStrictEqual(await reported(cases, options.only), expected);
  },
);

async function reported(cases: () => void, only = false): Promise<Reported[]> {
  const captured = capturedNames(String(cases));

  if (captured.length > 0) {
    throw new Error(
      `t.assert.reports cases can use only testEach, testFor, report and globals, not ${captured.join(', ')}.`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), 'test-each-'));
  // run() runs no files from inside a test file, which node:test marks with this variable.
  const context = process.env.NODE_TEST_CONTEXT;

  try {
    const file = join(dir, 'cases.test.mjs');
    writeFileSync(
      file,
      [
        `import { testEach } from ${JSON.stringify(TEST_EACH)};`,
        `import { testFor } from ${JSON.stringify(TEST_FOR)};`,
        String(report),
        `(${cases})();`,
      ].join('\n'),
    );
    delete process.env.NODE_TEST_CONTEXT;
    const tests: Reported[] = [];

    for await (const event of run({ files: [file], only })) {
      if (event.type === 'test:pass' || event.type === 'test:fail') {
        const { name, skip, todo, details } = event.data;
        const error = (details as { error?: Error & { cause?: Error } }).error;
        tests.push({
          name,
          outcome: event.type === 'test:pass' ? 'pass' : 'fail',
          ...(skip !== undefined && { skip: true }),
          ...(todo !== undefined && { todo: true }),
          ...(error && { error: error.cause?.message ?? error.message }),
        });
      }
    }

    return tests;
  } finally {
    if (context !== undefined) {
      process.env.NODE_TEST_CONTEXT = context;
    }

    rmSync(dir, { recursive: true, force: true });
  }
}

const CASES_FILE = 'cases.ts';
const COMPILER_OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  target: ts.ScriptTarget.ES2023,
  lib: ['lib.es2023.d.ts'],
  types: ['node'],
};
const host = ts.createCompilerHost(COMPILER_OPTIONS);
const libraries = new Map<string, ts.SourceFile | undefined>();

/**
 * The names `source` uses that neither it nor the test file that `reported` writes declares, which the TypeScript
 * checker reports as names it cannot find. The library files are parsed once and shared by every call.
 */
function capturedNames(source: string): string[] {
  const text = `declare const testEach: any, testFor: any, report: any;\n(${source})();\n`;
  const program = ts.createProgram([CASES_FILE], COMPILER_OPTIONS, {
    ...host,
    getSourceFile: (name, version) => {
      if (name === CASES_FILE) {
        return ts.createSourceFile(name, text, ts.ScriptTarget.ES2023);
      }

      if (!libraries.has(name)) {
        libraries.set(name, host.getSourceFile(name, version));
      }

      return libraries.get(name);
    },
  });
  const unknown = program
    .getSemanticDiagnostics(program.getSourceFile(CASES_FILE))
    // Cannot find name 'x', and the same with a suggestion.
    .filter((diagnostic) => diagnostic.code === 2304 || diagnostic.code === 2552);

  const names = unknown.map((diagnostic) => text.slice(diagnostic.start, diagnostic.start! + diagnostic.length!));

  return [...new Set(names)];
}

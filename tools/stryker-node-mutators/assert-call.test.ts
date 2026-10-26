import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { testEach } from '../test-each/test-each.ts';
import { assertCall } from './assert-call.ts';
import { mutantsOf } from './mutants-of.fixtures.ts';

const THROW = 'throw new Error("Stryker: assertion reached");';
const THROWING_CALL = '(() => { throw new Error("Stryker: assertion reached"); })()';
const THROWING = `true ? ${THROWING_CALL}`;
const REJECTED = 'true ? Promise.reject(new Error("Stryker: assertion reached"))';
const STRICT = "import assert from 'node:assert/strict';\n";
const TEST = "import { it } from 'node:test';\n";
const CHAINED = [
  "import type { TestContext } from 'node:test';",
  'function check(t: TestContext, p: Promise<void>) {',
  '  return t.assert.rejects(p);',
  '}',
  'export const chained = (t: TestContext) => check(t, Promise.resolve()).then(() => 1);',
].join('\n');
const SAMPLE = fileURLToPath(new URL('./type-check.sample.ts', import.meta.url)).replaceAll('\\', '/');

/** The messages of the errors that type checking `source` with the repository's compiler options reports. */
function typeErrors(source: string): string[] {
  const config = ts.getParsedCommandLineOfConfigFile(fileURLToPath(new URL('../../tsconfig.json', import.meta.url)), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  assert.ok(config);
  const { options } = config;
  const host = ts.createCompilerHost(options);
  const { fileExists, getSourceFile, readFile } = host;
  host.fileExists = (name) => name === SAMPLE || fileExists(name);
  host.readFile = (name) => (name === SAMPLE ? source : readFile(name));
  host.getSourceFile = (name, ...rest) =>
    name === SAMPLE ? ts.createSourceFile(name, source, ts.ScriptTarget.Latest) : getSourceFile(name, ...rest);

  return ts
    .getPreEmitDiagnostics(ts.createProgram([SAMPLE], options, host))
    .map(({ messageText }) => ts.flattenDiagnosticMessageText(messageText, '\n'));
}

describe('AssertCall', () => {
  testEach([
    ['a default import', `${STRICT}assert.equal(1, 1);`],
    ['a default import called itself', "import assert from 'node:assert';\nassert(true);"],
    ['a namespace import', "import * as assert from 'assert';\nassert.ok(true);"],
    ['a named import', "import { strictEqual } from 'assert/strict';\nstrictEqual(1, 1);"],
    ['a renamed import', "import { deepStrictEqual as same } from 'node:assert';\nsame([], []);"],
    ['the strict import', "import { strict as assert } from 'node:assert';\nassert.equal(1, 1);"],
    ['a method of the strict member', "import assert from 'node:assert';\nassert.strict.equal(1, 1);"],
    ['an awaited assertion', `${STRICT}await assert.rejects(Promise.reject(new Error('x')));`],
    ["the test context's assert", `${TEST}it('works', (t) => {\n  t.assert.ok(true);\n});`],
  ])('makes the statement of %s throw once it has run', async (_title, source) => {
    const statement = source
      .split('\n')
      .findLast((line) => !line.startsWith('}'))
      ?.trim();

    assert.deepEqual(await mutantsOf(assertCall, source), [`{ ${statement} ${THROW} }`]);
  });

  testEach([
    ["an arrow function's body", `${STRICT}[1].forEach((n) => assert.ok(n));`, `${THROWING} : assert.ok(n)`],
    [
      "the test context's assert as an arrow function's body",
      `${TEST}it('works', (t) => t.assert.ok(true));`,
      `${THROWING} : t.assert.ok(true)`,
    ],
    [
      "rejects as an arrow function's body",
      `${TEST}it('works', (t) => t.assert.rejects(load()));`,
      `${REJECTED} : t.assert.rejects(load())`,
    ],
    [
      "an awaited rejects as an arrow function's body",
      `${STRICT}const check = async () => await assert.rejects(load());`,
      `${REJECTED} : assert.rejects(load())`,
    ],
    ['a returned assertion', `${STRICT}function check(x: unknown) {\n  return assert.ok(x);\n}`, `${THROWING} : assert.ok(x)`],
    // fastify/test/register.test.js:123
    [
      "the test context's returned rejects",
      'function check(t: any, p: Promise<void>) {\n  return t.assert.rejects(p);\n}',
      `${REJECTED} : t.assert.rejects(p)`,
    ],
    [
      'a returned awaited doesNotReject',
      `${STRICT}async function check(p: Promise<void>) {\n  return await assert.doesNotReject(p);\n}`,
      `${REJECTED} : assert.doesNotReject(p)`,
    ],
  ])('makes %s fail in its place, keeping the call only for its type', async (_title, source, expected) => {
    assert.deepEqual(await mutantsOf(assertCall, source), [`(${expected})`]);
  });

  testEach([
    ['a returned rejects whose caller chains it', CHAINED, 't.assert.rejects(p)'],
    [
      'a returned assertion whose caller keeps its value',
      `${STRICT}function check(x: unknown) {\n  return assert.ok(x);\n}\nexport const kept: void = check(1);`,
      'assert.ok(x)',
    ],
  ])('keeps the inferred return type of %s', async (_title, source, call) => {
    const [replacement] = await mutantsOf(assertCall, source);

    assert.deepEqual(typeErrors(source), []);
    assert.deepEqual(typeErrors(source.replace(call, replacement)), []);
  });

  it('finds the type error of a returned call that only throws, which the conditional avoids', () => {
    assert.deepEqual(typeErrors(CHAINED.replace('t.assert.rejects(p)', THROWING_CALL)), [
      "Property 'then' does not exist on type 'never'.",
    ]);
  });

  testEach([
    ['assert.fail', `${STRICT}assert.fail('never');`],
    ['a named import of fail', "import { fail } from 'node:assert';\nfail('never');"],
    ['a renamed import of fail', "import { fail as never } from 'node:assert';\nnever();"],
    ['an import of fail by a string name', "import { 'fail' as never } from 'node:assert';\nnever();"],
    ["the test context's fail", `${TEST}it('works', (t) => {\n  t.assert.fail('never');\n});`],
    ["an arrow function's body", `${STRICT}[1].forEach(() => assert.fail('never'));`],
    ['a returned value', `${STRICT}function never() {\n  return assert.fail('never');\n}`],
  ])('leaves %s, which fails already', async (_title, source) => {
    assert.deepEqual(await mutantsOf(assertCall, source), []);
  });

  testEach([
    ['console.assert', 'console.assert(true);'],
    ['a function of its own named assert', 'function assert(value: unknown) {}\nassert(true);'],
    ['an assert of another library', "import { assert } from 'chai';\nassert.ok(true);"],
    ['an assert member of a constant', 'const t = { assert: { ok(value: unknown) {} } };\nt.assert.ok(true);'],
    ['an assert member of a global', 't.assert.ok(true);'],
    ['another member of the test context', `${TEST}it('works', (t) => {\n  t.mock.reset();\n});`],
    ['a method of the test context', `${TEST}it('works', (t) => {\n  t.diagnostic('x');\n});`],
    ['an assert member of a member of a parameter', 'function check(x: any) {\n  x.t.assert.ok(true);\n}'],
    ['an assertion whose value is used', `${STRICT}const result = assert.ok(true);`],
    ['an assertion that is named but not called', `${STRICT}assert.ok;`],
    ['an assertion reached through an array', `${STRICT}[assert][0].ok(true);`],
    ['a computed method of node:assert', `${STRICT}assert[method](true);`],
    [
      "a computed method of the test context's assert",
      'function check(t: any, p: Promise<void>) {\n  return t.assert[method](p);\n}',
    ],
    ['a computed assert of the test context', `${TEST}it('works', (t) => {\n  t[assert].ok(true);\n});`],
    ["another call that is an arrow function's body", '[1].forEach((n) => console.log(n));'],
    // pino-pretty/test/cli.test.js:20
    ["the test context's fail passed as a value", `${TEST}it('works', (t) => {\n  child.on('error', t.assert.fail);\n});`],
    // fastify/test/inject.test.js:288
    ["the test context's fail bound", `${TEST}it('works', (t) => {\n  t.assert.fail.bind(t, 'never');\n});`],
    // fastify/test/hooks.test.js:3279, fast-json-stringify/test/typesArray.test.js:255
    ["tap's fail and equal on the test context", `${TEST}it('works', (t) => {\n  t.fail('should throw');\n  t.equal(1, 1);\n});`],
    // pino-pretty/test/error-objects.test.js:38
    ["the test context's plan", `${TEST}it('works', (t) => {\n  t.plan(2);\n});`],
    // pino-pretty/test/cli-rc.test.js:213
    [
      'a function of another library given the test context',
      `${TEST}import { match } from '@jsumners/assert-match';\nit('works', (t) => {\n  match(data, 'Error', t);\n});`,
    ],
    [
      'a constant that shadows the test context',
      `${TEST}it('works', (t) => {\n  [1].forEach(() => {\n    const t = { assert: { ok(value: unknown) {} } };\n    t.assert.ok(true);\n  });\n});`,
    ],
  ])('leaves %s alone', async (_title, source) => {
    assert.deepEqual(await mutantsOf(assertCall, source), []);
  });
});

import assert from 'node:assert/strict';
import { describe } from 'node:test';

import { testEach } from '../test-each/test-each.ts';
import { assertLiveness } from './assert-liveness.ts';
import { mutantsOf } from './mutants-of.fixtures.ts';

const THROW = 'throw new Error("Stryker: assertion reached");';
const THROWING_CALL = '(() => { throw new Error("Stryker: assertion reached"); })()';
const STRICT = "import assert from 'node:assert/strict';\n";
const TEST = "import { it } from 'node:test';\n";

describe('AssertLiveness', () => {
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
  ])('makes the statement of %s throw', async (_title, source) => {
    assert.deepEqual(await mutantsOf(assertLiveness, source), [THROW]);
  });

  testEach([
    ['an assertion', `${STRICT}[1].forEach((n) => assert.ok(n));`],
    ["the test context's assert", `${TEST}it('works', (t) => t.assert.ok(true));`],
    ['an awaited assertion', `${STRICT}const check = async () => await assert.rejects(Promise.reject(new Error('x')));`],
  ])("makes %s that is an arrow function's body a call that throws", async (_title, source) => {
    assert.deepEqual(await mutantsOf(assertLiveness, source), [THROWING_CALL]);
  });

  testEach([
    ['assert.fail', `${STRICT}assert.fail('never');`],
    ['a named import of fail', "import { fail } from 'node:assert';\nfail('never');"],
    ['a renamed import of fail', "import { fail as never } from 'node:assert';\nnever();"],
    ['an import of fail by a string name', "import { 'fail' as never } from 'node:assert';\nnever();"],
    ["the test context's fail", `${TEST}it('works', (t) => {\n  t.assert.fail('never');\n});`],
    ["an arrow function's body", `${STRICT}[1].forEach(() => assert.fail('never'));`],
  ])('leaves %s, which fails already', async (_title, source) => {
    assert.deepEqual(await mutantsOf(assertLiveness, source), []);
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
    ['an assertion reached through an array', `${STRICT}[assert][0].ok(true);`],
    ["another call that is an arrow function's body", '[1].forEach((n) => console.log(n));'],
  ])('leaves %s alone', async (_title, source) => {
    assert.deepEqual(await mutantsOf(assertLiveness, source), []);
  });
});

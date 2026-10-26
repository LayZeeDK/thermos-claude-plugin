import assert from 'node:assert/strict';
import { describe } from 'node:test';

import { testEach } from '../test-each/test-each.ts';
import { assertValidator } from './assert-validator.ts';
import { mutantsOf } from './mutants-of.fixtures.ts';

const THROWS = '() => { throw new Error("Stryker"); }';
const REJECTS = 'Promise.reject(new Error("Stryker"))';
const STRICT = "import assert from 'node:assert/strict';\n";

describe('AssertValidator', () => {
  testEach([
    ['assert.throws', `${STRICT}assert.throws(() => parse(''), /empty/);`, [THROWS]],
    ['assert.throws without a validator', `${STRICT}assert.throws(() => parse(''));`, [THROWS]],
    ['assert.rejects', `${STRICT}await assert.rejects(load(), { message: 'gone' });`, [REJECTS]],
    ['a named import of throws', "import { throws } from 'node:assert';\nthrows(f, TypeError);", [THROWS]],
    ['a renamed import of rejects', "import { rejects as fails } from 'assert';\nawait fails(p, Error);", [REJECTS]],
    ["the test context's throws", 'function check(t: any) {\n  t.assert.throws(f, /x/);\n}', [THROWS]],
    ["the test context's rejects", 'async function check(t: any) {\n  await t.assert.rejects(p);\n}', [REJECTS]],
    ['an assertion whose value is used', `${STRICT}const done = assert.rejects(p);`, [REJECTS]],
    ['a subject that is a call, and not its arguments', `${STRICT}assert.throws(wrap(f));`, [THROWS]],
  ])('replaces what %s checks, and only that', async (_title, source, expected) => {
    assert.deepEqual(await mutantsOf(assertValidator, source), expected);
  });

  testEach([
    ['a spread', `${STRICT}assert.throws(...args);`],
    ['assert.doesNotThrow', `${STRICT}assert.doesNotThrow(f);`],
    ['assert.doesNotReject', `${STRICT}await assert.doesNotReject(p);`],
    ['another assertion', `${STRICT}assert.equal(f, g);`],
    ['a throws of its own', 'function throws(f: unknown) {}\nthrows(f);'],
    ['a throws of another library', "import { assert } from 'chai';\nassert.throws(f);"],
    ['an array element in first place', `${STRICT}[assert.throws, f];`],
  ])('leaves %s alone', async (_title, source) => {
    assert.deepEqual(await mutantsOf(assertValidator, source), []);
  });
});

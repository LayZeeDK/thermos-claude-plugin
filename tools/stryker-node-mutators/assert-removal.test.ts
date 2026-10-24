import assert from 'node:assert/strict';
import { describe } from 'node:test';

import { testEach } from '../test-each/test-each.ts';
import { assertRemoval } from './assert-removal.ts';
import { resolveFromCore } from './install.ts';
import { mutantsOf } from './mutants-of.fixtures.ts';
import { isOwn, toNodeMutator } from './operator.ts';

const STRICT = "import assert from 'node:assert/strict';\n";

describe('AssertRemoval', () => {
  testEach([
    ['a default import', `${STRICT}assert.equal(state, 'ready');`],
    ['a default import called itself', "import assert from 'node:assert';\nassert(ready);"],
    ['a namespace import', "import * as assert from 'assert';\nassert.ok(ready);"],
    ['a renamed import', "import { strictEqual as same } from 'assert/strict';\nsame(state, 'ready');"],
    ['fail, which marks code that never runs', `${STRICT}assert.fail('unreachable');`],
    ['an awaited assertion', `${STRICT}await assert.rejects(promise);`],
  ])('removes the statement of %s', async (_title, source) => {
    assert.deepEqual(await mutantsOf(assertRemoval, source), [';']);
  });

  testEach([
    ['console.assert', 'console.assert(ready);'],
    ['an assert of another library', "import { assert } from 'chai';\nassert.ok(ready);"],
    ['a function of its own named assert', 'function assert(value: unknown) {}\nassert(ready);'],
    ["a test context's assert", "function check(t: any) {\n  t.assert.ok(ready);\n}"],
    ['an assertion whose value is used', `${STRICT}const result = assert.ok(ready);`],
    ['an assertion reached through an array', `${STRICT}[assert][0].ok(ready);`],
    ['a statement that is no call', `${STRICT}assert;`],
  ])('leaves %s alone', async (_title, source) => {
    assert.deepEqual(await mutantsOf(assertRemoval, source), []);
  });

  testEach([
    ['whose arguments Stryker mutates, and which Stryker alone keeps', `${STRICT}assert.equal(state, 'ready');`, []],
    [
      'whose arguments Stryker leaves, and which Stryker alone removes',
      "import assert from 'node:assert';\nassert(ready);",
      ['CallExpression'],
    ],
  ])(
    "gives an assertion %s exactly one removal next to Stryker's mutators, its own",
    async (_title, source, alone) => {
      const instrumenter = await resolveFromCore();
      const builtIns = instrumenter.allMutators.filter((mutator) => !isOwn(mutator));
      /** The mutators that remove the statement of `source`. */
      const removals = async (mutators: typeof builtIns) =>
        (await instrumenter.instrument([{ name: 'sample.ts', content: source }], mutators))
          .filter(({ replacement }) => replacement === ';')
          .map(({ mutatorName }) => mutatorName);

      assert.deepEqual(
        [await removals(builtIns), await removals([...builtIns, toNodeMutator(assertRemoval, instrumenter.types)])],
        [alone, ['AssertRemoval']],
      );
    },
  );
});

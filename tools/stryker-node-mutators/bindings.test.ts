import assert from 'node:assert/strict';
import { describe } from 'node:test';

import { testEach } from '../test-each/test-each.ts';
import { assertMethod } from './bindings.ts';
import { mutantsOf } from './mutants-of.fixtures.ts';
import type { Operator } from './operator.ts';

const probe: Operator = {
  name: 'Probe',
  sample: '',
  *mutate(path, t) {
    const method = path.isCallExpression() ? assertMethod(path, path.node.callee) : undefined;

    if (method !== undefined) {
      yield t.stringLiteral(method);
    }
  },
};

describe('assertMethod', () => {
  testEach([
    ['a call of the default import', "import assert from 'node:assert';\nassert(x);", ['"ok"']],
    ['a method of the default import', "import assert from 'node:assert/strict';\nassert.equal(x, 1);", ['"equal"']],
    ['a named import', "import { throws } from 'assert';\nthrows(f);", ['"throws"']],
    ['a renamed import', "import { rejects as fails } from 'assert/strict';\nfails(p);", ['"rejects"']],
    ['a method of a member', "import * as assert from 'node:assert';\nassert.strict.fail();", ['"fail"']],
    ["the test context's assert", 'function check(t: any) {\n  t.assert.match(x, /y/);\n}', ['"match"']],
    ['a computed method', "import assert from 'node:assert';\nassert['equal'](x, 1);", []],
    ['another module', "import assert from 'other';\nassert.equal(x, 1);", []],
    ['a function of its own', 'function assert(x: unknown) {}\nassert(x);', []],
  ])('finds the method of %s', async (_title, source, expected) => {
    assert.deepEqual(await mutantsOf(probe, source), expected);
  });
});

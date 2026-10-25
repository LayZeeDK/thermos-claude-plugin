import { assertMethod } from './bindings.ts';
import type { Operator } from './operator.ts';

const MESSAGE = 'Stryker';

/**
 * Makes the code that `assert.throws` or `assert.rejects` checks throw an unrelated error, so a survivor is a
 * validator that accepts any error.
 */
export const assertValidator: Operator = {
  name: 'AssertValidator',
  sample: "import assert from 'node:assert/strict';\n\nassert.throws(() => {}, /x/);\n",
  *mutate(path, t) {
    const call = path.parent;

    if (!path.isExpression() || path.key !== 0 || call.type !== 'CallExpression') {
      return;
    }

    const method = assertMethod(path, call.callee);
    const error = t.newExpression(t.identifier('Error'), [t.stringLiteral(MESSAGE)]);

    if (method === 'throws') {
      yield t.arrowFunctionExpression([], t.blockStatement([t.throwStatement(error)]));
    }

    if (method === 'rejects') {
      yield t.callExpression(t.memberExpression(t.identifier('Promise'), t.identifier('reject')), [error]);
    }
  },
};

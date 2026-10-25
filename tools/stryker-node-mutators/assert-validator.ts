import { assertMethod } from './bindings.ts';
import type { Operator } from './operator.ts';

const MESSAGE = 'Stryker';

/**
 * Replaces what `assert.throws` or `assert.rejects` checks with a function that throws, or a promise that rejects,
 * an unrelated error, so that a mutant that survives is a validator that accepts any error: none, a bare `Error`, or
 * one that only returns true. A missing validator is no reason to skip; that is the survivor to find.
 */
export const assertValidator: Operator = {
  name: 'AssertValidator',
  // A statement whose value is discarded with void, which AssertLiveness leaves.
  sample: "import assert from 'node:assert/strict';\n\nvoid assert.throws(() => {}, /x/);\n",
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

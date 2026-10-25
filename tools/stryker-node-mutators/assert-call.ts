import type { NodePath, types } from '@babel/core';

import { assertMethod } from './bindings.ts';
import type { BabelTypes, Operator } from './operator.ts';

const MESSAGE = 'Stryker: assertion reached';
const ASYNC_METHODS: ReadonlySet<string> = new Set(['rejects', 'doesNotReject']);

/**
 * FailureAddition: makes an assertion fail, so a survivor is a check whose failure nothing sees. A check that never
 * runs reaches no coverage, so its mutant comes out NoCoverage instead.
 * An assertion statement keeps its call ahead of the `throw`, so it fails right after it runs and the code after it
 * keeps the types it narrows. An assertion that is an arrow function's body or a returned value fails in its place
 * instead, through the channel the real check uses: a rejected promise for `rejects` and `doesNotReject`, a throw for
 * the others. There the original call is kept only for its type and never runs.
 */
export const assertCall: Operator = {
  name: 'AssertCall',
  sample: 'export function check(t: any) {\n  t.assert.ok(true);\n}\n',
  *mutate(path, t) {
    if (path.isExpressionStatement() && assertion(path, awaited(path.node.expression)) !== undefined) {
      yield t.blockStatement([t.cloneNode(path.node), t.throwStatement(error(t))]);
    }

    if (path.isCallExpression() && isTail(path)) {
      const method = assertion(path, path.node);

      if (method !== undefined) {
        yield t.conditionalExpression(t.booleanLiteral(true), failure(t, method), t.cloneNode(path.node));
      }
    }
  },
};

function error(t: BabelTypes): types.NewExpression {
  return t.newExpression(t.identifier('Error'), [t.stringLiteral(MESSAGE)]);
}

function failure(t: BabelTypes, method: string): types.CallExpression {
  if (ASYNC_METHODS.has(method)) {
    return t.callExpression(t.memberExpression(t.identifier('Promise'), t.identifier('reject')), [error(t)]);
  }

  return t.callExpression(t.arrowFunctionExpression([], t.blockStatement([t.throwStatement(error(t))])), []);
}

function awaited(expression: types.Expression): types.Expression {
  return expression.type === 'AwaitExpression' ? expression.argument : expression;
}

function isTail(path: NodePath): boolean {
  const value = path.parent.type === 'AwaitExpression' ? path.parentPath : path;

  return value.parent.type === 'ArrowFunctionExpression' || value.parent.type === 'ReturnStatement';
}

function assertion(path: NodePath, node: types.Expression): string | undefined {
  if (node.type !== 'CallExpression') {
    return undefined;
  }

  const method = assertMethod(path, node.callee);

  return method === 'fail' ? undefined : method;
}

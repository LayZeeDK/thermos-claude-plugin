import type { NodePath, types } from '@babel/core';

import { assertMethod } from './bindings.ts';
import type { BabelTypes, Operator } from './operator.ts';

const MESSAGE = 'Stryker: assertion reached';

/**
 * Makes an assertion fail right after it runs, so a survivor is a check that never runs or whose failure nothing sees.
 * An assertion statement keeps its call ahead of the `throw`, so the code after it keeps the types it narrows.
 */
export const assertLiveness: Operator = {
  name: 'AssertLiveness',
  sample: 'export function check(t: any) {\n  t.assert.ok(true);\n}\n',
  *mutate(path, t) {
    if (path.isExpressionStatement() && isAssertion(path, awaited(path.node.expression))) {
      yield t.blockStatement([t.cloneNode(path.node), t.throwStatement(error(t))]);
    }

    if (path.isCallExpression() && isArrowBody(path) && isAssertion(path, path.node)) {
      yield t.callExpression(t.arrowFunctionExpression([], t.blockStatement([t.throwStatement(error(t))])), []);
    }
  },
};

function error(t: BabelTypes): types.NewExpression {
  return t.newExpression(t.identifier('Error'), [t.stringLiteral(MESSAGE)]);
}

function awaited(expression: types.Expression): types.Expression {
  return expression.type === 'AwaitExpression' ? expression.argument : expression;
}

function isArrowBody(path: NodePath): boolean {
  const body = path.parent.type === 'AwaitExpression' ? path.parentPath : path;

  return body.parent.type === 'ArrowFunctionExpression';
}

function isAssertion(path: NodePath, node: types.Expression): boolean {
  if (node.type !== 'CallExpression') {
    return false;
  }

  const method = assertMethod(path, node.callee);

  return method !== undefined && method !== 'fail';
}

import type { NodePath, types } from '@babel/core';

import { calleeRoot, importOf, NODE_ASSERT } from './bindings.ts';
import type { BabelTypes, Operator } from './operator.ts';

const MESSAGE = 'Stryker: assertion reached';

/**
 * Makes an assertion of a test fail where it stands, so that a mutant that survives is a check that never runs or
 * whose failure nothing sees. An assertion statement becomes a `throw`; an assertion that is an arrow function's body
 * becomes a call of a function that throws. `fail` is left alone: it fails already, where a test meant it never to run.
 */
export const assertLiveness: Operator = {
  name: 'AssertLiveness',
  sample: 'export function check(t: any) {\n  t.assert.ok(true);\n}\n',
  *mutate(path, t) {
    if (path.isExpressionStatement() && isAssertion(path, awaited(path.node.expression))) {
      yield t.throwStatement(error(t));
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

/**
 * Whether `node` calls `node:assert`, through any import of it, or the `assert` of node:test's test context, which a
 * test gets as a parameter.
 */
function isAssertion(path: NodePath, node: types.Expression): boolean {
  if (node.type !== 'CallExpression') {
    return false;
  }

  const { callee } = node;
  const root = calleeRoot(callee);

  if (root === undefined) {
    return false;
  }

  const from = importOf(path, root.name);
  const method = callee === root ? from?.imported : propertyName(callee);

  if (method === 'fail') {
    return false;
  }

  return from === undefined ? isTestContextAssert(path, callee, root) : NODE_ASSERT.has(from.source);
}

/** Whether `callee` is `t.assert.<method>` with `t` a parameter. */
function isTestContextAssert(path: NodePath, callee: types.Node, root: types.Identifier): boolean {
  return (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'MemberExpression' &&
    callee.object.object === root &&
    propertyName(callee.object) === 'assert' &&
    path.scope.getBinding(root.name)?.kind === 'param'
  );
}

function propertyName(member: types.Node): string | undefined {
  return member.type === 'MemberExpression' && member.property.type === 'Identifier' ? member.property.name : undefined;
}

import { calleeRoot, importOf, NODE_ASSERT } from './bindings.ts';
import type { Operator } from './operator.ts';

/**
 * Removes a `node:assert` statement from production code, where it guards an invariant. Stryker's CallExpression
 * mutator removes a call statement only when no other mutant shares it, so it skips every assertion whose arguments
 * it mutates; once this operator's mutant shares the statement, it skips the rest, and each assertion keeps exactly
 * one removal. A mutant that survives is an invariant that no test breaks: a missing test, or a guard against what no
 * caller can do, which a `// Stryker disable` comment then says.
 */
export const assertRemoval: Operator = {
  name: 'AssertRemoval',
  // fail, which AssertLiveness leaves.
  sample: "import assert from 'node:assert/strict';\n\nassert.fail('unreachable');\n",
  *mutate(path, t) {
    if (!path.isExpressionStatement()) {
      return;
    }

    const { expression } = path.node;
    const call = expression.type === 'AwaitExpression' ? expression.argument : expression;
    const root = call.type === 'CallExpression' ? calleeRoot(call.callee) : undefined;
    const source = root && importOf(path, root.name)?.source;

    if (source !== undefined && NODE_ASSERT.has(source)) {
      yield t.emptyStatement();
    }
  },
};

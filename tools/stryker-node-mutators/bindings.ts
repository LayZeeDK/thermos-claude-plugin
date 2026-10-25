import type { NodePath, types } from '@babel/core';

/** The module names under which Node.js serves `node:assert`. */
export const NODE_ASSERT: ReadonlySet<string> = new Set(['node:assert', 'node:assert/strict', 'assert', 'assert/strict']);

/** Where a binding comes from: the module, and for a named import the name that the module exports. */
export interface ImportOf {
  readonly source: string;
  readonly imported: string | undefined;
}

/**
 * The import that binds `name` in the scope of `path`, or `undefined` when no import binds it. Only ES module `import`
 * declarations count: the operators support ES modules, not CommonJS's `require`.
 */
export function importOf(path: NodePath, name: string): ImportOf | undefined {
  const bound = path.scope.getBinding(name)?.path;
  const declaration = bound?.parent;

  if (declaration?.type !== 'ImportDeclaration') {
    return undefined;
  }

  // An import declaration binds names only through its specifiers.
  const specifier = bound!.node;

  return {
    source: declaration.source.value,
    imported: specifier.type === 'ImportSpecifier' ? exportedName(specifier.imported) : undefined,
  };
}

function exportedName(imported: types.Identifier | types.StringLiteral): string {
  return imported.type === 'Identifier' ? imported.name : imported.value;
}

/**
 * The method that a call of `callee` makes on `node:assert`, through any import of it, or on the `assert` of
 * node:test's test context, which a test gets as a parameter: `ok` for a call of the module itself, and `undefined`
 * when the call asserts nothing or names its method by a computed key.
 */
export function assertMethod(path: NodePath, callee: types.Node): string | undefined {
  const root = calleeRoot(callee);

  if (root === undefined) {
    return undefined;
  }

  const from = importOf(path, root.name);

  if (from === undefined) {
    return isTestContextAssert(path, callee, root) ? propertyName(callee) : undefined;
  }

  if (!NODE_ASSERT.has(from.source)) {
    return undefined;
  }

  return callee === root ? (from.imported ?? 'ok') : propertyName(callee);
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

/** The identifier at the root of a callee such as `assert.strict.equal`, or `undefined` for one such as `f()()`. */
export function calleeRoot(callee: types.Node): types.Identifier | undefined {
  let node = callee;

  while (node.type === 'MemberExpression') {
    node = node.object;
  }

  return node.type === 'Identifier' ? node : undefined;
}

import type { NodePath, types } from '@babel/core';

/** The module names under which Node.js serves `node:assert`. */
export const NODE_ASSERT: ReadonlySet<string> = new Set(['node:assert', 'node:assert/strict', 'assert', 'assert/strict']);

/** Where a binding comes from: the module, and for a named import the name that the module exports. */
export interface ImportOf {
  readonly source: string;
  readonly imported: string | undefined;
}

/** The import that binds `name` in the scope of `path`, or `undefined` when no import binds it. */
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

/** The identifier at the root of a callee such as `assert.strict.equal`, or `undefined` for one such as `f()()`. */
export function calleeRoot(callee: types.Node): types.Identifier | undefined {
  let node = callee;

  while (node.type === 'MemberExpression') {
    node = node.object;
  }

  return node.type === 'Identifier' ? node : undefined;
}

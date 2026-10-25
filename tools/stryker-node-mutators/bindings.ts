import type { NodePath, types } from '@babel/core';

export const NODE_ASSERT: ReadonlySet<string> = new Set(['node:assert', 'node:assert/strict', 'assert', 'assert/strict']);

export interface ImportOf {
  readonly source: string;
  readonly imported: string | undefined;
}

/** Only ES module `import` declarations count: the operators do not read CommonJS `require`. */
export function importOf(path: NodePath, name: string): ImportOf | undefined {
  const bound = path.scope.getBinding(name)?.path;
  const declaration = bound?.parent;

  if (declaration?.type !== 'ImportDeclaration') {
    return undefined;
  }

  const specifier = bound!.node;

  return {
    source: declaration.source.value,
    imported: specifier.type === 'ImportSpecifier' ? exportedName(specifier.imported) : undefined,
  };
}

function exportedName(imported: types.Identifier | types.StringLiteral): string {
  return imported.type === 'Identifier' ? imported.name : imported.value;
}

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

export function calleeRoot(callee: types.Node): types.Identifier | undefined {
  let node = callee;

  // The loop advances in its header, so that no mutant empties its step and loops forever.
  for (; node.type === 'MemberExpression'; node = node.object) {}

  return node.type === 'Identifier' ? node : undefined;
}

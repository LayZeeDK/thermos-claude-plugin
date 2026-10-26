import type { NodePath, types } from '@babel/core';

export type BabelTypes = typeof types;

/** A mutation operator, free of Stryker: it maps a Babel path to replacement nodes. */
export interface Operator {
  /**
   * Letters only, as Stryker's directives match no other character; PascalCase, like Stryker's own mutators. Reports
   * show it, and `excludedMutations` and `// Stryker disable` comments select the operator by it.
   */
  readonly name: string;
  /** A TypeScript module in which the operator makes a mutant; the install's self-check instruments it. */
  readonly sample: string;
  mutate(path: NodePath, t: BabelTypes): Iterable<types.Node>;
}

/** The shape of Stryker's `NodeMutator`, which the instrumenter's exports keep out of reach. */
export interface NodeMutatorLike {
  readonly name: string;
  mutate(path: NodePath, context: { isExpressionContext: boolean }): Iterable<types.Node>;
}

export const OWN = Symbol.for('stryker-node-mutators');

export interface OwnMutator extends NodeMutatorLike {
  readonly [OWN]: true;
}

/** Yields nothing where Stryker's instrumenter allows no statement, such as a Vue template's expression. */
export function toNodeMutator(operator: Operator, t: BabelTypes): OwnMutator {
  return {
    name: operator.name,
    [OWN]: true,
    *mutate(path, { isExpressionContext }) {
      if (!isExpressionContext) {
        yield* operator.mutate(path, t);
      }
    },
  };
}

export function isOwn(mutator: NodeMutatorLike): boolean {
  return OWN in mutator;
}

import type { NodePath, types } from '@babel/core';

export type BabelTypes = typeof types;

/** A mutation operator, free of Stryker: it maps a Babel path to replacement nodes. */
export interface Operator {
  /**
   * PascalCase letters only, as Stryker's directives match no other character. Reports show it, and
   * `excludedMutations` and `// Stryker disable` comments select the operator by it.
   */
  readonly name: string;
  /** A whole TypeScript module in which the operator finds at least one mutant; install's self-check needs it. */
  readonly sample: string;
  mutate(path: NodePath, t: BabelTypes): Iterable<types.Node>;
}

/** The shape of Stryker's `NodeMutator`, which the instrumenter's exports keep out of reach. */
export interface NodeMutatorLike {
  readonly name: string;
  mutate(path: NodePath, context: { isExpressionContext: boolean }): Iterable<types.Node>;
}

/** Marks the mutators this package made, also when two copies of the package run in one process. */
export const OWN = Symbol.for('stryker-node-mutators');

export interface OwnMutator extends NodeMutatorLike {
  readonly [OWN]: true;
}

/**
 * The `NodeMutator` for `operator`, building nodes with `t`. It yields nothing in a script that is an expression, such
 * as a Vue template's, where a statement cannot go.
 */
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

/** Whether this package made `mutator`. */
export function isOwn(mutator: NodeMutatorLike): boolean {
  return OWN in mutator;
}

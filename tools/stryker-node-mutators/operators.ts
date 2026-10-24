import type { Operator } from './operator.ts';

/** The operators that mutate production code, next to Stryker's own mutators. */
export const productionOperators: readonly Operator[] = [];

/** The operators that mutate test code, in place of Stryker's own mutators. */
export const testOperators: readonly Operator[] = [];

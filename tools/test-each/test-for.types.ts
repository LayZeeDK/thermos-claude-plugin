// Checked by `npm run typecheck` and never run, as no test file imports it:
// the callbacks get the types of the cases, as in Vitest.
import type { TestContext } from 'node:test';

import { testFor } from './test-for.ts';

testFor([
  [1, 'a'],
  [2, 'b'],
] as const)('tuple', ([n, s], t) => {
  n satisfies 1 | 2;
  s satisfies 'a' | 'b';
  t satisfies TestContext;
});
testFor([1, 2])('scalar', (n, t) => {
  n satisfies number;
  t.diagnostic('');
});
testFor`a | b ${1} | ${2}`('template', (row, t) => {
  void row.anything;
  t satisfies TestContext;
});
testFor([1])('timeout', () => {}, 100);
testFor([1])('options', { fails: true }, (n) => {
  // @ts-expect-error The case is a number.
  n.toUpperCase();
});

// Checked by `npm run typecheck` and never run, as no test file imports it:
// the callbacks get the types of the cases, as in Vitest.
import type { TestContext } from 'node:test';

import { testEach } from './test-each.ts';

testEach([
  [1, 'a'],
  [2, 'b'],
] as const)('tuple', (n, s) => {
  n satisfies 1 | 2;
  s satisfies 'a' | 'b';
});
testEach([
  [1, 'a'],
  [2, 'b'],
])('array', (n, s) => {
  n satisfies number;
  // @ts-expect-error The second value is a string.
  s satisfies number;
});
testEach([{ a: 1 }, { a: 2 }])('object', (row) => {
  row.a satisfies number;
  // @ts-expect-error The rows have no b.
  void row.b;
});
testEach([1, 2])('scalar', (n) => {
  n satisfies number;
});
// @ts-expect-error Every argument is a value of the case.
testEach([1, 2])('extra', (n, extra: string) => {});
testEach`a | b ${1} | ${2}`('template', (row) => {
  void row.anything;
});
testEach([1])('timeout', () => {}, 100);
testEach([1])('options', { timeout: 100, fails: true, skip: 'reason' }, () => {});
testEach([1])('todo');
// @ts-expect-error The options go before the function.
testEach([1])('options last', () => {}, { timeout: 100 });
// @ts-expect-error A test of testEach gets no context.
testEach([1])('context', (n: number, t: TestContext) => {});

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: [
    '.claude/skills/**/*.ts',
    'tools/**/*.ts',
    '!.claude/skills/**/*.test.ts',
    '!tools/**/*.test.ts',
    '!tools/**/*.fixtures.ts',
    '!tools/**/*.bench.ts',
    '!tools/**/*.types.ts',
  ],
  plugins: ['@stryker-mutator/*', './tools/stryker-node-test-runner/index.ts'],
  testRunner: 'node-test',
  nodeTest: { testFiles: ['.claude/skills/**/*.test.ts', 'tools/**/*.test.ts'] },
  checkers: ['typescript'],
  // Stryker sizes each mutant's timeout from the unloaded dry run; at the default concurrency the loaded runs cross
  // it. Infinite loops are caught by the hit limit first, so a larger allowance costs nothing.
  timeoutMS: 15_000,
  reporters: ['clear-text', 'progress'],
  thresholds: { high: 100, low: 100, break: 100 },
};

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: [
    '.claude/skills/**/*.ts',
    'tools/**/*.ts',
    '!.claude/skills/**/*.test.ts',
    '!tools/**/*.test.ts',
    '!tools/**/*.bench.ts',
    '!tools/**/*.types.ts',
  ],
  plugins: ['@stryker-mutator/*', './tools/stryker-node-test-runner/index.ts'],
  testRunner: 'node-test',
  nodeTest: { testFiles: ['.claude/skills/**/*.test.ts', 'tools/**/*.test.ts'] },
  checkers: ['typescript'],
  reporters: ['clear-text', 'progress'],
  thresholds: { high: 100, low: 100, break: 100 },
};

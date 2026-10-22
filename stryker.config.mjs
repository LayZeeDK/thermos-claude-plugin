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
    // Test files call testEach and testFor while they load, so their mutants are static and each would run the whole
    // suite. stryker.test-each.config.mjs mutation-tests them against their own tests instead.
    '!tools/test-each/**',
    // slice-map.ts is module-level data, so its mutants are static too, and against the whole suite some time out.
    // stryker.generator.config.mjs mutation-tests the generator against its own tests instead.
    '!tools/thermos-experimental-generator/**',
  ],
  plugins: ['@stryker-mutator/*', './tools/stryker-node-test-runner/index.ts'],
  testRunner: 'node-test',
  nodeTest: { testFiles: ['.claude/skills/**/*.test.ts', 'tools/**/*.test.ts'] },
  checkers: ['typescript'],
  reporters: ['clear-text', 'progress'],
  thresholds: { high: 100, low: 100, break: 100 },
};

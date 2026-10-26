import base from './stryker.config.mjs';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    'tools/test-each/**/*.ts',
    '!tools/test-each/**/*.test.ts',
    '!tools/test-each/**/*.fixtures.ts',
    '!tools/test-each/**/*.types.ts',
  ],
  lzNodeTest: { testFiles: ['tools/test-each/**/*.test.ts'] },
};

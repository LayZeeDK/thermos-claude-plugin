import base from './stryker.config.mjs';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: ['tools/thermos-experimental-generator/**/*.ts', '!tools/thermos-experimental-generator/**/*.test.ts'],
  nodeTest: { testFiles: ['tools/thermos-experimental-generator/**/*.test.ts'] },
};

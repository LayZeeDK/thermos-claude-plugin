import base from './stryker.config.mjs';

// The replace install has to run after stryker.config.mjs's add install ends, and an ES module's sibling static
// import starts before an earlier sibling's top-level await settles.
await import('./tools/stryker-node-mutators/test-code.ts');

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...base,
  mutate: [
    '.claude/skills/**/*.test.ts',
    'tools/**/*.test.ts',
    // Its t.assert.reports cases allow only the globals they name in the source of their own callbacks, and
    // instrumentation adds Stryker's.
    '!tools/test-each/register.test.ts',
  ],
};

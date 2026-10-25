import base from './stryker.config.mjs';

// The test-code install replaces the whole mutator list, so it has to run once stryker.config.mjs has added the
// production operators. A sibling static import would start before that install ends, so this one waits in the body.
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

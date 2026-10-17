// Kept apart from index.test.ts: the runner runs test files in path order and stops at the first failing file, so
// mutants in these module-level declarations, which run every test, are killed before the slow runner tests start.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PluginKind } from '@stryker-mutator/api/plugin';
import ajvModule from 'ajv';

import { NodeTestRunner, strykerPlugins, strykerValidationSchema } from './index.ts';

describe('plugin declaration', () => {
  it('declares the node-test test runner', () => {
    assert.deepEqual(strykerPlugins, [
      { kind: PluginKind.TestRunner, name: 'node-test', injectableClass: NodeTestRunner },
    ]);
  });

  it('validates the nodeTest options with a JSON schema', () => {
    const validate = new ajvModule.default({ allErrors: true, strict: false }).compile(strykerValidationSchema);

    for (const options of [
      {},
      { nodeTest: {} },
      { nodeTest: { testFiles: ['a.test.ts', 'b/*.test.ts'] } },
      { nodeTest: { nodeArgs: ['--enable-source-maps', '--stack-size=900'] } },
    ]) {
      assert.ok(validate(options), JSON.stringify(options));
    }

    for (const options of [
      { nodeTest: '*.test.ts' },
      { nodeTest: { testFiles: '*.test.ts' } },
      { nodeTest: { testFiles: [1] } },
      { nodeTest: { testfiles: ['*.test.ts'] } },
      { nodeTest: { nodeArgs: '--enable-source-maps' } },
      { nodeTest: { nodeArgs: [1] } },
    ]) {
      assert.ok(!validate(options), JSON.stringify(options));
    }
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PluginKind } from '@stryker-mutator/api/plugin';
import ajvModule from 'ajv';

import { testEach } from '../test-each/test-each.ts';
import { NodeTestRunner, strykerPlugins, strykerValidationSchema } from './index.ts';

function validator() {
  return new ajvModule.default({ allErrors: true, strict: false }).compile(strykerValidationSchema);
}

describe('plugin declaration', () => {
  it('declares the node-test test runner', () => {
    assert.deepEqual(strykerPlugins, [
      { kind: PluginKind.TestRunner, name: 'node-test', injectableClass: NodeTestRunner },
    ]);
  });

  testEach([
    {},
    { nodeTest: {} },
    { nodeTest: { testFiles: ['a.test.ts', 'b/*.test.ts'] } },
    { nodeTest: { nodeArgs: ['--enable-source-maps', '--stack-size=900'] } },
    { nodeTest: { maxMemoryMB: 1500 } },
  ])('accepts the options %j', (options) => {
    assert.ok(validator()(options));
  });

  testEach([
    { nodeTest: '*.test.ts' },
    { nodeTest: { testFiles: '*.test.ts' } },
    { nodeTest: { testFiles: [1] } },
    { nodeTest: { testfiles: ['*.test.ts'] } },
    { nodeTest: { nodeArgs: '--enable-source-maps' } },
    { nodeTest: { nodeArgs: [1] } },
    { nodeTest: { maxMemoryMB: '1500' } },
    { nodeTest: { maxMemoryMB: 0 } },
    { nodeTest: { maxMemoryMB: 1.5 } },
  ])('rejects the options %j', (options) => {
    assert.ok(!validator()(options));
  });
});

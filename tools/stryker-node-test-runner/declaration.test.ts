import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { PluginKind } from '@stryker-mutator/api/plugin';
import ajvModule from 'ajv';

import { testEach } from '../test-each/test-each.ts';
import { MIN_NODE_VERSION, NodeTestRunner, strykerPlugins, strykerValidationSchema } from './index.ts';

/** Stryker validates its options with these settings, and merges the properties of each plugin's schema into its own. */
function validator() {
  return new ajvModule.default({ useDefaults: true, allErrors: true, strict: false }).compile({
    type: 'object',
    properties: strykerValidationSchema.properties,
  });
}

describe('plugin declaration', () => {
  it('declares the lz-node-test test runner', () => {
    assert.deepEqual(strykerPlugins, [
      { kind: PluginKind.TestRunner, name: 'lz-node-test', injectableClass: NodeTestRunner },
    ]);
  });

  testEach([
    {},
    { lzNodeTest: {} },
    { lzNodeTest: { testFiles: ['a.test.ts', 'b/*.test.ts'] } },
    { lzNodeTest: { nodeArgs: ['--enable-source-maps', '--stack-size=900'] } },
    { lzNodeTest: { maxMemoryMB: 1500 } },
  ])('accepts the options %j', (options) => {
    assert.ok(validator()(options));
  });

  testEach([
    { lzNodeTest: '*.test.ts' },
    { lzNodeTest: { testFiles: '*.test.ts' } },
    { lzNodeTest: { testFiles: [1] } },
    { lzNodeTest: { testfiles: ['*.test.ts'] } },
    { lzNodeTest: { nodeArgs: '--enable-source-maps' } },
    { lzNodeTest: { nodeArgs: [1] } },
    { lzNodeTest: { maxMemoryMB: '1500' } },
    { lzNodeTest: { maxMemoryMB: 0 } },
    { lzNodeTest: { maxMemoryMB: 1.5 } },
  ])('rejects the options %j', (options) => {
    assert.ok(!validator()(options));
  });

  it('supports the Node.js versions that package.json supports', () => {
    const { engines } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      engines: { node: string };
    };

    assert.equal(engines.node, `>=${MIN_NODE_VERSION.join('.')}`);
  });

  testEach([
    [{}, { lzNodeTest: { testFiles: ['**/*.test.ts'], nodeArgs: [] } }],
    [{ lzNodeTest: { maxMemoryMB: 1500 } }, { lzNodeTest: { testFiles: ['**/*.test.ts'], nodeArgs: [], maxMemoryMB: 1500 } }],
    [{ lzNodeTest: { testFiles: ['a.test.ts'], nodeArgs: ['--enable-source-maps'] } }, { lzNodeTest: { testFiles: ['a.test.ts'], nodeArgs: ['--enable-source-maps'] } }],
  ])('fills in the defaults of %j', (options, filled) => {
    assert.ok(validator()(options));
    assert.deepEqual(options, filled);
  });
});

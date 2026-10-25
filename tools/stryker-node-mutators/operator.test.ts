import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NodePath, types } from '@babel/core';

import { testEach } from '../test-each/test-each.ts';
import { OWN, isOwn, toNodeMutator, type BabelTypes, type Operator } from './operator.ts';

const NODE = { type: 'EmptyStatement' } as types.Node;

/** An operator that yields `NODE` for any path. */
const operator: Operator = {
  name: 'Alpha',
  sample: '',
  *mutate() {
    yield NODE;
  },
};

describe('OWN', () => {
  it('is the same symbol in every copy of the package', () => {
    assert.equal(OWN, Symbol.for('stryker-node-mutators'));
  });
});

describe('toNodeMutator', () => {
  testEach([
    [false, [NODE]],
    [true, []],
  ])('gives, where isExpressionContext is %s, %j', (isExpressionContext, nodes) => {
    const mutator = toNodeMutator(operator, {} as BabelTypes);

    assert.deepEqual([...mutator.mutate({} as NodePath, { isExpressionContext })], nodes);
    assert.equal(isOwn(mutator), true);
  });
});

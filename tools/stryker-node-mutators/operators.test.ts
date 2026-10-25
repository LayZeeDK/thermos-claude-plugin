import assert from 'node:assert/strict';
import { describe } from 'node:test';

import { testEach } from '../test-each/test-each.ts';
import { operatorsFor, productionOperators, testOperators } from './operators.ts';

describe('the catalogues', () => {
  testEach([
    ['production', productionOperators, ['NodeTimerDelay', 'NodeEventName']],
    ['test', testOperators, ['AssertLiveness', 'AssertValidator']],
  ])('name the %s operators', (_title, operators, names) => {
    assert.deepEqual(
      operators.map(({ name }) => name),
      names,
    );
  });
});

describe('operatorsFor', () => {
  testEach([
    ['tools/runner/process-end.test.ts', testOperators],
    ['tools/runner/process-end.ts', productionOperators],
    ['tools/runner/index.fixtures.ts', productionOperators],
    ['tools/runner/test.ts', productionOperators],
  ])('gives %s its catalogue', (name, operators) => {
    assert.equal(operatorsFor(name), operators);
  });
});

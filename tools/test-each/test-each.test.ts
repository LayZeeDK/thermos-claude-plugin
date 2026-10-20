import { describe, it } from 'node:test';

import { report } from './reported.fixtures.ts';
import { testEach } from './test-each.ts';

describe('testEach', () => {
  it('spreads each case into the arguments when every case is an array, with no test context', async (t) => {
    await t.assert.reports(
      () => {
        testEach([[1, 'a'], [2], []])('case %# of %s %s', report);
        testEach([])('none', report);
      },
      [
        { name: 'case 0 of 1 a', outcome: 'fail', error: '[1,"a"]' },
        { name: 'case 1 of 2 undefined', outcome: 'fail', error: '[2]' },
        { name: 'case 2 of undefined undefined', outcome: 'fail', error: '[]' },
      ],
    );
  });

  it('passes each case whole when a case is not an array, and names the tests from the spread case', async (t) => {
    await t.assert.reports(
      () => {
        testEach([[1, 2], 'x', null, { a: 1 }])('%s and %s, $a', report);
      },
      [
        { name: '1 and 2, $a', outcome: 'fail', error: '[[1,2]]' },
        { name: 'x and undefined, $a', outcome: 'fail', error: '["x"]' },
        { name: 'null and undefined, $a', outcome: 'fail', error: '[null]' },
        { name: '{ a: 1 } and undefined, 1', outcome: 'fail', error: '[{"a":1}]' },
      ],
    );
  });

  it('gives a template literal table one object per row, keyed by its first line, without a partial row', async (t) => {
    await t.assert.reports(
      () => {
        testEach`
          first | second
          ${1}  | ${'x'}
          ${2}  | ${'y'}
          ${3}
        `('$first-$second', report);
      },
      [
        { name: '1-x', outcome: 'fail', error: '[{"first":1,"second":"x"}]' },
        { name: '2-y', outcome: 'fail', error: '[{"first":2,"second":"y"}]' },
      ],
    );
  });

  it('passes a test whose body returns, and fails one whose body throws or whose promise rejects', async (t) => {
    await t.assert.reports(
      () => {
        testEach([1, 2])('case %s', (n) => {
          if (n === 2) {
            throw new Error('two');
          }
        });
        testEach([1, 2])('async %s', async (n) => {
          if (n === 2) {
            throw new Error('rejects');
          }
        });
      },
      [
        { name: 'case 1', outcome: 'pass' },
        { name: 'case 2', outcome: 'fail', error: 'two' },
        { name: 'async 1', outcome: 'pass' },
        { name: 'async 2', outcome: 'fail', error: 'rejects' },
      ],
    );
  });
});

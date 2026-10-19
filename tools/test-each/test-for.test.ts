import { describe, it } from 'node:test';

import { report } from './reported.fixtures.ts';
import { testFor } from './test-for.ts';

describe('testFor', () => {
  it("passes each case whole with the test's context, and names a missing case as no values", async (t) => {
    await t.assert.reports(
      () => {
        testFor([[1, 2], 'x', null])('%s and %s', (row, t) => report(row, t.name));
        testFor`
          a    | b
          ${1} | ${'x'}
        `('$a $b', (row, t) => report(row, t.name));
      },
      [
        { name: '1 and 2', outcome: 'fail', error: '[[1,2],"1 and 2"]' },
        { name: 'x and undefined', outcome: 'fail', error: '["x","x and undefined"]' },
        { name: 'undefined and undefined', outcome: 'fail', error: '[null,"undefined and undefined"]' },
        { name: '1 x', outcome: 'fail', error: '[{"a":1,"b":"x"},"1 x"]' },
      ],
    );
  });
});

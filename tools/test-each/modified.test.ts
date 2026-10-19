import { describe, it } from 'node:test';

import { report } from './reported.fixtures.ts';
import { testEach } from './test-each.ts';
import { testFor } from './test-for.ts';

describe('the modifiers of testEach and testFor', () => {
  it('skips, marks todo, and inverts the outcome, composed in any order', async (t) => {
    await t.assert.reports(
      () => {
        testEach.skip([1])('skip %s', report);
        testFor.todo([1])('todo %s', () => {});
        testEach.fails([1, 2])('fails %s', (n) => {
          if (n === 1) {
            throw new Error('one');
          }
        });
        testFor.fails([1])('fails async %s', async () => {
          throw new Error('rejects');
        });
        testEach.todo.fails([1])('todo fails %s', () => {});
        testEach.fails.todo([1])('fails todo %s', () => {});
      },
      [
        { name: 'skip 1', outcome: 'pass', skip: true },
        { name: 'todo 1', outcome: 'pass', todo: true },
        { name: 'fails 1', outcome: 'pass' },
        { name: 'fails 2', outcome: 'fail', error: 'The test passed, but it is marked to fail.' },
        { name: 'fails async 1', outcome: 'pass' },
        { name: 'todo fails 1', outcome: 'fail', todo: true, error: 'The test passed, but it is marked to fail.' },
        { name: 'fails todo 1', outcome: 'fail', todo: true, error: 'The test passed, but it is marked to fail.' },
      ],
    );
  });

  it('skips with skipIf a truthy condition and with runIf a falsy one, overriding an earlier skip', async (t) => {
    await t.assert.reports(
      () => {
        testEach.skipIf(1)([1])('skipIf truthy %s', () => {});
        testEach.skip.skipIf(0)([1])('skipIf falsy %s', () => {});
        testFor.runIf('')([1])('runIf falsy %s', () => {});
        testFor.skip.runIf('yes')([1])('runIf truthy %s', () => {});
        testEach.skipIf(0).fails([1])('then fails %s', report);
      },
      [
        { name: 'skipIf truthy 1', outcome: 'pass', skip: true },
        { name: 'skipIf falsy 1', outcome: 'pass' },
        { name: 'runIf falsy 1', outcome: 'pass', skip: true },
        { name: 'runIf truthy 1', outcome: 'pass' },
        { name: 'then fails 1', outcome: 'pass' },
      ],
    );
  });

  it('runs only the tests marked only when node:test runs only those', async (t) => {
    await t.assert.reports(
      () => {
        testEach.only([1])('only %s', () => {});
        testFor([2])('other %s', () => {});
      },
      [{ name: 'only 1', outcome: 'pass' }],
      { only: true },
    );
  });
});

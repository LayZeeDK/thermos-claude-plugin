import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseArguments, templateRows, type EachOptions } from './register.ts';
import { report, SIGNATURES } from './reported.fixtures.ts';
import { testEach } from './test-each.ts';
import { testFor } from './test-for.ts';

describe('the options of testEach and testFor', () => {
  it('registers todo tests without a function, also when a timeout replaces the options', async (t) => {
    await t.assert.reports(
      () => {
        testEach([1])('no function %s');
        testFor([1])('options only %s', { timeout: 100 });
        // @ts-expect-error The types take no timeout after options, which untyped callers can still pass.
        testEach([1])('options and a timeout %s', { skip: true }, 5000);
        testEach([1])('a todo reason %s', { todo: 'later' });
        testEach([1])('skipped %s', { skip: true });
      },
      [
        { name: 'no function 1', outcome: 'pass', todo: true },
        { name: 'options only 1', outcome: 'pass', todo: true },
        { name: 'options and a timeout 1', outcome: 'pass', todo: true },
        { name: 'a todo reason 1', outcome: 'pass', todo: true },
        { name: 'skipped 1', outcome: 'pass', skip: true },
      ],
    );
  });

  it('applies a timeout given as a number or in the options, and passes node:test options through', async (t) => {
    await t.assert.reports(
      () => {
        testEach([1])('number %s', () => new Promise((resolve) => setTimeout(resolve, 300)), 10);
        testFor([1])('options %s', { timeout: 10 }, () => new Promise((resolve) => setTimeout(resolve, 300)));
        testFor([1])('plan %s', { plan: 1 }, (n, t) => {
          t.assert.equal(n, 1);
        });
      },
      [
        { name: 'number 1', outcome: 'fail', error: 'test timed out after 10ms' },
        { name: 'options 1', outcome: 'fail', error: 'test timed out after 10ms' },
        { name: 'plan 1', outcome: 'pass' },
      ],
    );
  });

  it('lets a defined option override a modifier, and reads no options from a function', async (t) => {
    await t.assert.reports(
      () => {
        testEach.skip([1])('undefined %s', { skip: undefined }, report);
        testEach.skip([1])('false %s', { skip: false }, () => {});
        testEach([1])('own properties %s', Object.assign(() => {}, { skip: true }));
        testEach([1])('fails %s', { fails: true }, report);
      },
      [
        { name: 'undefined 1', outcome: 'pass', skip: true },
        { name: 'false 1', outcome: 'pass' },
        { name: 'own properties 1', outcome: 'pass' },
        { name: 'fails 1', outcome: 'pass' },
      ],
    );
  });

  it('throws before registering a test for options after a function, two functions, or null options', () => {
    assert.throws(() => testEach([1])('x', () => {}, {} as number), SIGNATURES);
    assert.throws(() => testFor([1])('x', () => {}, (() => {}) as unknown as number), SIGNATURES);
    assert.throws(() => testEach([1])('x', null as unknown as EachOptions, () => {}), SIGNATURES);
  });
});

describe('t.assert.reports', () => {
  it('rejects cases that use a name the test file it writes does not have', async (t) => {
    const captured = 1;

    await assert.rejects(
      t.assert.reports(() => {
        testEach([captured])('captured %s', report);
      }, []),
      { message: 't.assert.reports cases can use only testEach, testFor, report and globals, not captured.' },
    );
  });
});

describe('parseArguments', () => {
  const fn = () => {};

  testFor([
    ['(name, fn)', [fn, undefined], { options: {}, fn }],
    ['(name, fn, timeout)', [fn, 50], { options: { timeout: 50 }, fn }],
    ['(name, options, fn)', [{ skip: true }, fn], { options: { skip: true }, fn }],
    ['(name, options, timeout)', [{ skip: true }, 50], { options: { timeout: 50 }, fn: undefined }],
    ['(name)', [undefined, undefined], { options: {}, fn: undefined }],
  ] as const)('reads %s', ([, args, expected]) => {
    assert.deepEqual(parseArguments(args[0], args[1]), expected);
  });

  // The shapes untyped callers can pass.
  const untyped = parseArguments as (optionsOrFn: unknown, fnOrTimeout: unknown) => unknown;

  testEach([
    { shape: 'options after a function', args: [fn, {}] },
    { shape: 'two functions', args: [fn, fn] },
    { shape: 'null options', args: [null, fn] },
  ])('rejects $shape', ({ args: [optionsOrFn, fnOrTimeout] }) => {
    assert.throws(() => untyped(optionsOrFn, fnOrTimeout), SIGNATURES);
  });

  it('accepts a null after a function', () => {
    assert.deepEqual(untyped(fn, null), { options: {}, fn });
  });
});

describe('templateRows', () => {
  testEach([
    [['\n  a | b\n  ', ' | ', '\n  ', ' | ', '\n'], [1, 2, 3, 4], [{ a: 1, b: 2 }, { a: 3, b: 4 }]],
    [['first name|x\n', '|', ''], [1, 2, 3], [{ firstname: 1, x: 2 }]],
    [['a|b', '|', ''], [1], []],
    [['a\tb ', ''], [1], [{ 'a\tb': 1 }]],
  ])('reads %o with %o', (strings, values, rows) => {
    assert.deepEqual(templateRows(strings, values), rows);
  });
});

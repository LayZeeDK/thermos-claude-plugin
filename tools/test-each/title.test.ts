import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { testEach } from './test-each.ts';
import { formatName, formatTitle } from './title.ts';

const circular: { self?: unknown } = {};
circular.self = circular;
const digits = (length: number) => Array.from({ length }, (_, i) => i % 10).join('');

describe('formatName', () => {
  testEach([
    ['a string', 'case %s', 'case %s'],
    ['a named function', function named() {}, 'named'],
    ['an anonymous function', [() => {}][0], '<anonymous>'],
    ['a number', 1, '1'],
    ['undefined', undefined, 'undefined'],
    ['a symbol', Symbol('s'), 'Symbol(s)'],
  ])('names a test after %s', (_, name, expected) => {
    assert.equal(formatName(name), expected);
  });
});

describe('formatTitle', () => {
  testEach([
    ['%s', ['abc'], 'abc'],
    ['%s', [1.5], '1.5'],
    ['%s', [-0], '-0'],
    ['%s', [10n], '10n'],
    ['%s', [null], 'null'],
    ['%s', [Symbol('x')], 'Symbol(x)'],
    ['%s', [[1, 2, 3]], '1,2,3'],
    ['%s', [{ toString: () => 'custom' }], 'custom'],
    ['%s', [{ a: 1 }], '{ a: 1 }'],
    ['%s', [Object.create(null)], '[Object: null prototype] {}'],
    ['%s', [digits(50)], digits(50)],
    ['%d', ['0x10'], '16'],
    ['%d', [true], '1'],
    ['%d', [null], '0'],
    ['%d', [{}], 'NaN'],
    ['%d', [-0], '0'],
    ['%d', [10n], '10n'],
    ['%d', [Symbol('x')], 'NaN'],
    ['%i', ['12.9px'], '12'],
    ['%i', [-0], '0'],
    ['%i', [10n], '10n'],
    ['%f', ['1.5'], '1.5'],
    ['%f', [-1.5], '-1.5'],
    ['%f', [0], '0'],
    ['%f', [-0], '-0'],
    ['%f', [Number.NaN], 'NaN'],
    ['%f', [-Number.NaN], '-NaN'],
    ['%f', [10n], '10'],
    ['%f', [Symbol('x')], 'NaN'],
    ['%d %f', [1, -0], '1 -0'],
    ['%j', [{ a: [1] }], '{"a":[1]}'],
    ['%j', [undefined], 'undefined'],
    ['%j', [circular], '[Circular]'],
    ['%o', ['a'], "'a'"],
    ['%O', [{ a: 'x' }], "{ a: 'x' }"],
    ['%o', [{ a: { b: { c: { d: 1 } } } }], '{ a: { b: { c: [Object] } } }'],
    ['%c%s', ['color: red', 'b'], 'b'],
    ['%# and %$', [], '2 and 3'],
    ['100%% of %s', [1], '100% of 1'],
    ['%%# %%s', ['a'], '%# %s'],
    ['%s %s', [1], '1 undefined'],
    ['%d %d', [1], '1 NaN'],
    ['%s', [1, 2, 3], '1'],
    ['%x %s 100%', ['a'], '%x a 100%'],
  ])('formats %j with %o as %j', (template, items, expected) => {
    assert.equal(formatTitle(template, items, 2), expected);
  });

  it('throws what JSON.stringify throws for %j, unless the value is circular', () => {
    assert.throws(() => formatTitle('%j', [10n], 0), { name: 'TypeError', message: /BigInt/ });
  });

  testEach([
    ['%o', [digits(40)], `'${digits(38)}…'`],
    ['%o', [`'${digits(49)}`], `"'${digits(37)}…"`],
    ['%o', [digits(37)], `'${digits(37)}'`],
    ['%o', [Array.from({ length: 20 }, (_, i) => i)], '[ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,…'],
    ['%o', [{ a: digits(30) }], `{ a: '${digits(30)}' }`],
    ['$a', [{ a: digits(40) }], digits(40)],
    ['$a', [{ a: digits(41) }], `${digits(39)}…`],
    // A cut would split the last character, a surrogate pair, so it comes one code unit earlier.
    ['$a', [{ a: '😀'.repeat(25) }], `${'😀'.repeat(19)}…`],
    ['$a', [{ a: '\u{10000}'.repeat(25) }], `${'\u{10000}'.repeat(19)}…`],
    ['$a', [{ a: '\u{10FFFF}'.repeat(25) }], `${'\u{10FFFF}'.repeat(19)}…`],
    ['$a', [{ a: `a${'😀'.repeat(25)}` }], `a${'😀'.repeat(19)}…`],
    ['$a', [{ a: `${digits(38)}😀${digits(3)}` }], `${digits(38)}…`],
    ['$a', [{ a: `${digits(40)}😀` }], `${digits(39)}…`],
  ])('cuts %j of %o short at 40 characters as %j', (template, items, expected) => {
    assert.equal(formatTitle(template, items, 0), expected);
  });

  testEach([
    ['$a and $b', [{ a: 1, b: 'x' }], '1 and x'],
    ['$a.b, $a.c', [{ a: { b: 2 } }], '2, undefined'],
    ['$a[10][1]', [{ a: [...Array.from({ length: 10 }), ['x', 'y']] }], 'y'],
    ['$a.b', [{ a: null }], 'undefined'],
    ['$s.length', [{ s: 'abc' }], '3'],
    ['$a$b', [{ a: 1, b: 2, a$b: 3 }], '3'],
    ['$结果', [{ 结果: 'ok' }], 'ok'],
    ['$missing-$a', [{ a: 'x' }], 'undefined-x'],
    ['$a %o', [{ a: '%o' }], "%o { a: '%o' }"],
    ['%o', [{ a: '$b', b: 'yay' }], "{ a: '$b', b: 'yay' }"],
    ['$0, $1, $k1, $k2', [{ k1: 'v1' }, { k2: 'v2' }], "{ k1: 'v1' }, { k2: 'v2' }, v1, undefined"],
    ['$0, $1, $10, $k, $k1, $1a', ['foo', 'bar'], 'foo, bar, undefined, $k, $k1, $1a'],
    ['$a', [[1, 2]], '$a'],
    ['$a', [null], '$a'],
    ['$ a', [{ a: 1 }], '$ a'],
  ])('interpolates %j with %o as %j', (template, items, expected) => {
    assert.equal(formatTitle(template, items, 0), expected);
  });
});

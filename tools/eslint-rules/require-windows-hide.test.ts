/* eslint-disable thermos/require-windows-hide -- the cases are code that the rule must report */
import parser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import { describe } from 'node:test';

import { testEach } from '../test-each/test-each.ts';
import rule from './require-windows-hide.ts';

/** With no global describe or it, as under node:test, RuleTester runs each case inside the calling test. */
function tester(): RuleTester {
  return new RuleTester({ languageOptions: { parser } });
}

describe('require-windows-hide', () => {
  testEach([
    ['a detached spawn with windowsHide: true', 'spawn(cmd, [], { detached: true, windowsHide: true });'],
    ['windowsHide before detached', '({ windowsHide: true, detached: true });'],
    ['quoted keys', "({ 'detached': true, 'windowsHide': true });"],
    ['detached: false', '({ detached: false });'],
    ['detached: false inside type wrappers', '({ detached: (false as const)! satisfies boolean });'],
    ['windowsHide from a variable', '({ detached: true, windowsHide: hide });'],
    ['windowsHide from a member', '({ detached: true, windowsHide: opts.hide });'],
    ['windowsHide from a negation', '({ detached: true, windowsHide: !visible });'],
    ['a computed key named detached', '({ [detached]: true });'],
    ['an earlier detached: true that a later one overrides', '({ detached: true, detached: false });'],
    ['options without detached', "fork(file, { stdio: 'ignore' });"],
    ['a spread before windowsHide', '({ ...base, detached: true, windowsHide: true });'],
    ['a typed options object', 'const options: SpawnOptions = { detached: true, windowsHide: true };'],
    ['an assignment of detached = false', 'options.detached = false;'],
    ['an assignment to a computed member', 'options[detached] = true;'],
    ['an assignment to another member', 'options.windowsHide = true;'],
    ['an assignment to a variable named detached', 'detached = true;'],
    ['a string with windowsHide: true', "'{ detached: true, windowsHide: true }';"],
    ['a string without spaces', "'{ detached:true, windowsHide:true }';"],
    ['a string with extra spaces', "'{ detached  :  true, windowsHide  :  true }';"],
    ['a string with single-quoted keys', "\"{ 'detached': true, 'windowsHide': true }\";"],
    ['a string with double-quoted keys', '\'{ "detached": true, "windowsHide": true }\';'],
    ['a template literal with windowsHide: true', '`{ detached: true, windowsHide: true }`;'],
    ['a string that only names detached', "'detached';"],
    ['a regular expression', '/detached: true/;'],
  ])('accepts %s', (_, code) => {
    tester().run('require-windows-hide', rule, { valid: [code], invalid: [] });
  });

  testEach([
    [
      'a detached spawn without windowsHide',
      "spawn(cmd, [], { detached: true, stdio: 'ignore' });",
      "spawn(cmd, [], { detached: true, stdio: 'ignore', windowsHide: true });",
    ],
    ['a quoted detached key', "({ 'detached': true });", "({ 'detached': true, windowsHide: true });"],
    ['windowsHide: false', '({ detached: true, windowsHide: false });', '({ detached: true, windowsHide: true });'],
    ['windowsHide: 0', '({ detached: true, windowsHide: 0 });', '({ detached: true, windowsHide: true });'],
    ['windowsHide: 1', '({ detached: true, windowsHide: 1 });', '({ detached: true, windowsHide: true });'],
    ['windowsHide: null', '({ detached: true, windowsHide: null });', '({ detached: true, windowsHide: true });'],
    ["windowsHide: ''", "({ detached: true, windowsHide: '' });", '({ detached: true, windowsHide: true });'],
    [
      'windowsHide: undefined',
      '({ detached: true, windowsHide: undefined });',
      '({ detached: true, windowsHide: true });',
    ],
    [
      'windowsHide: false inside a type wrapper',
      '({ detached: true, windowsHide: false as const });',
      '({ detached: true, windowsHide: true });',
    ],
    [
      'a later windowsHide: false',
      '({ detached: true, windowsHide: true, windowsHide: false });',
      '({ detached: true, windowsHide: true, windowsHide: true });',
    ],
    [
      'a later detached: true',
      '({ detached: false, detached: true });',
      '({ detached: false, detached: true, windowsHide: true });',
    ],
    ['a spread before detached', '({ ...base, detached: true });', '({ ...base, detached: true, windowsHide: true });'],
    ['a spread after detached', '({ detached: true, ...base });', '({ detached: true, ...base, windowsHide: true });'],
    ['a spread after windowsHide', '({ detached: true, windowsHide: true, ...overrides });', null],
    [
      'a typed options object',
      'const options = { detached: true } satisfies SpawnOptions;',
      'const options = { detached: true, windowsHide: true } satisfies SpawnOptions;',
    ],
    ['detached: true as const', '({ detached: true as const });', '({ detached: true as const, windowsHide: true });'],
    [
      'detached: true satisfies boolean',
      '({ detached: true satisfies boolean });',
      '({ detached: true satisfies boolean, windowsHide: true });',
    ],
    ['a non-null detached: true', '({ detached: true! });', '({ detached: true!, windowsHide: true });'],
    ['a type-asserted detached: true', '({ detached: <boolean>true });', '({ detached: <boolean>true, windowsHide: true });'],
    ['a shorthand detached', '({ detached });', null],
    ['detached from a member', '({ detached: opts.daemon });', null],
    ['detached from a conditional', '({ detached: daemon ? true : false });', null],
    ['detached from a variable with windowsHide: false', '({ detached: daemon, windowsHide: false });', null],
    ['a string without windowsHide', "\"{ cwd: left, detached: true, stdio: 'ignore' }\";", null],
    ['a string without spaces', "'{ detached:true }';", null],
    ['a string with extra spaces', "'{ detached  :  true }';", null],
    ['a string with a single-quoted key', "\"{ 'detached': true }\";", null],
    ['a string with a double-quoted key', '\'{ "detached": true }\';', null],
    ['a string with windowsHide: false', "'{ detached: true, windowsHide: false }';", null],
    ['a template literal without windowsHide', '`{ detached: true }`;', null],
    ['a template literal with an expression', '`spawn(${cmd}, { detached: true })`;', null],
  ])('reports %s', (_, code, output) => {
    tester().run('require-windows-hide', rule, {
      valid: output === null ? [] : [output],
      invalid: [{ code, output, errors: [{ messageId: 'missing' }] }],
    });
  });

  testEach([
    ['an assignment of detached = true', 'options.detached = true;'],
    ['an assignment to a quoted member', "options['detached'] = daemon;"],
  ])('reports %s with its own message', (_, code) => {
    tester().run('require-windows-hide', rule, {
      valid: [],
      invalid: [{ code, output: null, errors: [{ messageId: 'assignment' }] }],
    });
  });

  testEach([
    ['an object', '({ detached: daemon });', /^Pass windowsHide: true with detached: true/],
    ['an assignment', 'options.detached = daemon;', /^Set windowsHide: true on the same options object as detached/],
  ])('names the fix for %s in its message', (_, code, message) => {
    tester().run('require-windows-hide', rule, { valid: [], invalid: [{ code, errors: [{ message }] }] });
  });
});

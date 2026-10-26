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
    ['a type-asserted detached: false', '({ detached: <boolean>false });'],
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
    ['a detached spawn without windowsHide', "spawn(cmd, [], { detached: true, stdio: 'ignore' });"],
    ['a quoted detached key', "({ 'detached': true });"],
    ['windowsHide: false', '({ detached: true, windowsHide: false });'],
    ['windowsHide: 0', '({ detached: true, windowsHide: 0 });'],
    ['windowsHide: 1', '({ detached: true, windowsHide: 1 });'],
    ['windowsHide: null', '({ detached: true, windowsHide: null });'],
    ["windowsHide: ''", "({ detached: true, windowsHide: '' });"],
    ['windowsHide: undefined', '({ detached: true, windowsHide: undefined });'],
    ['windowsHide: false inside a type wrapper', '({ detached: true, windowsHide: false as const });'],
    ['a later windowsHide: false', '({ detached: true, windowsHide: true, windowsHide: false });'],
    ['a later detached: true', '({ detached: false, detached: true });'],
    ['a spread before detached', '({ ...base, detached: true });'],
    ['a spread after windowsHide', '({ detached: true, windowsHide: true, ...overrides });'],
    ['a shorthand detached', '({ detached });'],
    ['detached from a member', '({ detached: opts.daemon });'],
    ['detached from a conditional', '({ detached: daemon ? true : false });'],
    ['detached from a variable with windowsHide: false', '({ detached: daemon, windowsHide: false });'],
    ['a string without windowsHide', "\"{ cwd: left, detached: true, stdio: 'ignore' }\";"],
    ['a string without spaces', "'{ detached:true }';"],
    ['a string with extra spaces', "'{ detached  :  true }';"],
    ['a string with a single-quoted key', "\"{ 'detached': true }\";"],
    ['a string with a double-quoted key', '\'{ "detached": true }\';'],
    ['a string with windowsHide: false', "'{ detached: true, windowsHide: false }';"],
    ['a template literal without windowsHide', '`{ detached: true }`;'],
    ['a template literal with an expression', '`spawn(${cmd}, { detached: true })`;'],
  ])('reports %s', (_, code) => {
    tester().run('require-windows-hide', rule, { valid: [], invalid: [{ code, errors: [{ messageId: 'missing' }] }] });
  });

  testEach([
    ['an assignment of detached = true', 'options.detached = true;'],
    ['an assignment to a quoted member', "options['detached'] = daemon;"],
  ])('reports %s with its own message', (_, code) => {
    tester().run('require-windows-hide', rule, {
      valid: [],
      invalid: [{ code, errors: [{ messageId: 'assignment' }] }],
    });
  });

  testEach([
    ['an object', '({ detached: daemon });', /^Pass windowsHide: true with detached: true/],
    ['an assignment', 'options.detached = daemon;', /^Set windowsHide: true on the same options object as detached/],
  ])('names the fix for %s in its message', (_, code, message) => {
    tester().run('require-windows-hide', rule, { valid: [], invalid: [{ code, errors: [{ message }] }] });
  });
});

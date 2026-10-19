import type { TestContext } from 'node:test';

import { modified, type Modified } from './modified.ts';
import { register, type Awaitable, type EachOptions, type Flags, type Name, type Register } from './register.ts';

/** Registers the tests of a `testFor` table. Without `fn`, each test is a todo test. */
export interface TestForFunctionReturn<Arg> {
  (name: Name, fn?: (arg: Arg, context: TestContext) => Awaitable<void>, timeout?: number): void;
  (name: Name, options: EachOptions, fn?: (arg: Arg, context: TestContext) => Awaitable<void>): void;
}

export interface TestForFunction {
  <T>(cases: ReadonlyArray<T>): TestForFunctionReturn<T>;
  (strings: TemplateStringsArray, ...values: any[]): TestForFunctionReturn<any>;
}

type ForCallback = (row: any, t: TestContext) => Awaitable<void>;

/**
 * Registers one node:test `it` test per case of the table, as `testEach` does, except that `fn` always gets the case
 * whole and node:test's test context as its second argument.
 */
export const testFor: Modified<TestForFunction> = modified(forCases, {});

function forCases(flags: Flags, cases: readonly unknown[]): Register<ForCallback> {
  return register<ForCallback>(flags, cases, (row, fn) => ({
    items: row == null ? [] : Array.isArray(row) ? row : [row],
    body: fn && ((t) => fn(row, t)),
  }));
}

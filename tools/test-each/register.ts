// Registers the tests of Vitest's test.each and test.for tables on node:test. node:test underneath makes two outcomes
// differ from Vitest's: a todo test that has a body runs it, as node:test runs todo tests and ignores their outcome,
// and a `fails` test that times out does not pass, as node:test's timeout applies outside the body that `fails`
// inverts. title.ts names the tests.
import { it, type TestContext, type TestOptions } from 'node:test';

import { formatName, formatTitle } from './title.ts';

export type Awaitable<T> = T | Promise<T>;

/** A test's name: a string, or a function, which names it by its own name and is never called. */
export type Name = string | Function;

/** node:test's options for each test of the table, and `fails`, which makes a test pass only when its body fails. */
export interface EachOptions extends TestOptions {
  fails?: boolean;
}

export type Flags = Pick<EachOptions, 'skip' | 'only' | 'todo' | 'fails'>;
export type EachCallback = (...args: any[]) => Awaitable<void>;
type Body = (t: TestContext) => Awaitable<void>;

/** What the table's returned function takes, in any of Vitest's call shapes. */
export type Register<F> = (name: Name, optionsOrFn?: F | EachOptions, fnOrTimeout?: F | number) => void;

/** One test of the table: the values its name formats, and its body unless it is a todo test. */
export interface Case {
  items: readonly unknown[];
  body?: Body;
}

const SIGNATURES =
  'testEach and testFor tables take (name, fn), (name, fn, timeout) or (name, options, fn); ' +
  'pass options as the second argument and a single function.';

/** The rows of a template literal table: one object per row, keyed by the column names of its first line. */
export function templateRows(strings: readonly unknown[], values: readonly unknown[]): Record<string, unknown>[] {
  const columns = strings.join('').trim().replaceAll(' ', '').split('\n')[0]!.split('|');

  // Array.from rounds the length down, which drops the values of an incomplete last row.
  return Array.from({ length: values.length / columns.length }, (_, row) =>
    Object.fromEntries(columns.map((column, i) => [column, values[row * columns.length + i]])),
  );
}

/**
 * Reads Vitest's call shapes: `(name, fn)`, `(name, fn, timeout)` and `(name, options, fn)`. Untyped callers can pass
 * other shapes, which throw.
 */
export function parseArguments<F extends EachCallback>(
  optionsOrFn: F | EachOptions | undefined,
  fnOrTimeout: F | number | undefined,
): { options: EachOptions; fn?: F } {
  if (
    optionsOrFn === null ||
    (typeof fnOrTimeout === 'object' && fnOrTimeout !== null) ||
    (typeof optionsOrFn === 'function' && typeof fnOrTimeout === 'function')
  ) {
    throw new TypeError(SIGNATURES);
  }

  return {
    options:
      typeof fnOrTimeout === 'number' ? { timeout: fnOrTimeout } : typeof optionsOrFn === 'object' ? optionsOrFn : {},
    fn: typeof optionsOrFn === 'function' ? optionsOrFn : typeof fnOrTimeout === 'function' ? fnOrTimeout : undefined,
  };
}

/** Registers one test per case, each named after `name` and its case, with the table's options. */
export function register<F extends EachCallback>(
  flags: Flags,
  cases: readonly unknown[],
  caseOf: (row: unknown, fn?: F) => Case,
): Register<F> {
  return (name, optionsOrFn, fnOrTimeout) => {
    const template = formatName(name);
    const { options, fn } = parseArguments(optionsOrFn, fnOrTimeout);
    const defined = Object.entries(options).filter(([, value]) => value !== undefined);
    const { fails, ...testOptions }: EachOptions = { ...flags, ...Object.fromEntries(defined) };

    if (!fn) {
      testOptions.todo ||= true;
    }

    cases.forEach((row, index) => {
      const { items, body } = caseOf(row, fn);

      it(formatTitle(template, items, index), testOptions, fails ? body && failing(body) : body);
    });
  };
}

/** Inverts the outcome of a test's body: the test passes when the body throws or rejects, and fails otherwise. */
function failing(call: Body): Body {
  return async (t) => {
    try {
      await call(t);
    } catch {
      return;
    }

    throw new Error('The test passed, but it is marked to fail.');
  };
}

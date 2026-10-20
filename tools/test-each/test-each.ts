import { modified, type Modified } from './modified.ts';
import {
  register,
  type Awaitable,
  type EachCallback,
  type EachOptions,
  type Flags,
  type Name,
  type Register,
} from './register.ts';

/** The arguments of a `testEach` callback for a readonly tuple row of up to 10 values, as in Vitest and Jest. */
type ExtractEachCallbackArgs<T extends ReadonlyArray<any>> = {
  1: [T[0]];
  2: [T[0], T[1]];
  3: [T[0], T[1], T[2]];
  4: [T[0], T[1], T[2], T[3]];
  5: [T[0], T[1], T[2], T[3], T[4]];
  6: [T[0], T[1], T[2], T[3], T[4], T[5]];
  7: [T[0], T[1], T[2], T[3], T[4], T[5], T[6]];
  8: [T[0], T[1], T[2], T[3], T[4], T[5], T[6], T[7]];
  9: [T[0], T[1], T[2], T[3], T[4], T[5], T[6], T[7], T[8]];
  10: [T[0], T[1], T[2], T[3], T[4], T[5], T[6], T[7], T[8], T[9]];
  fallback: Array<T extends ReadonlyArray<infer U> ? U : any>;
}[T extends Readonly<[any]>
  ? 1
  : T extends Readonly<[any, any]>
    ? 2
    : T extends Readonly<[any, any, any]>
      ? 3
      : T extends Readonly<[any, any, any, any]>
        ? 4
        : T extends Readonly<[any, any, any, any, any]>
          ? 5
          : T extends Readonly<[any, any, any, any, any, any]>
            ? 6
            : T extends Readonly<[any, any, any, any, any, any, any]>
              ? 7
              : T extends Readonly<[any, any, any, any, any, any, any, any]>
                ? 8
                : T extends Readonly<[any, any, any, any, any, any, any, any, any]>
                  ? 9
                  : T extends Readonly<[any, any, any, any, any, any, any, any, any, any]>
                    ? 10
                    : 'fallback'];

/** Registers the tests of a `testEach` table. Without `fn`, each test is a todo test. */
export interface EachFunctionReturn<T extends any[]> {
  (name: Name, fn?: (...args: T) => Awaitable<void>, timeout?: number): void;
  (name: Name, options: EachOptions, fn?: (...args: T) => Awaitable<void>): void;
}

export interface TestEachFunction {
  <T extends any[] | [any]>(cases: ReadonlyArray<T>): EachFunctionReturn<T>;
  <T extends ReadonlyArray<any>>(cases: ReadonlyArray<T>): EachFunctionReturn<ExtractEachCallbackArgs<T>>;
  <T>(cases: ReadonlyArray<T>): EachFunctionReturn<T[]>;
  (...args: [TemplateStringsArray, ...any]): EachFunctionReturn<any[]>;
}

/**
 * Registers one node:test `it` test per case of the table. A case that is an array is spread into `fn`'s arguments
 * when every case is an array; any other case is passed whole. `fn` gets no test context; use `testFor` for that.
 * A template literal table names its columns in its first line and gives `fn` one object per row. The name formats
 * the case as in Vitest's `test.each`: `%s %d %i %f %j %o %O %c`, `%#`, `%$`, `%%` and `$` paths.
 */
export const testEach: Modified<TestEachFunction> = modified(eachCases, {});

function eachCases(flags: Flags, cases: readonly unknown[]): Register<EachCallback> {
  const spread = cases.every(Array.isArray);

  return register<EachCallback>(flags, cases, (row, fn) => {
    const items = Array.isArray(row) ? row : [row];

    return { items, body: fn && (() => (spread ? fn(...items) : fn(row))) };
  });
}

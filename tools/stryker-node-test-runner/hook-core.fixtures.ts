// Fakes of node:test and its test contexts, shared by the tests of hook-core.ts.
import assert from 'node:assert/strict';
import { join } from 'node:path';

import type { NodeTestModule } from './hook-core.ts';

export type Fn = (this: unknown, ...args: unknown[]) => unknown;

export interface Registration {
  /** The node:test function, such as `it` or `it.skip`. */
  kind: string;
  name: string;
  /** The arguments after the name, as the wrapper passed them on. */
  rest: unknown[];
  self: unknown;
}

export const TEST_FILE = join('/repo', 'a.test.ts');

/**
 * A stand-in for node:test that records registrations. Like node:test, it runs suite bodies, except those of skipped
 * suites, while they are registered (with a recognisable `this` and argument) and reports a suite body that throws
 * instead of throwing. Its tests have `expectFailure` unless it stands in for Node.js 22.
 */
export function fakeNodeTest(expectFailure = true) {
  const registrations: Registration[] = [];
  const suiteResults: unknown[] = [];
  const register = (kind: string) =>
    function (this: unknown, name: string, ...rest: unknown[]) {
      registrations.push({ kind, name, rest, self: this });
      const body = rest.find((arg) => typeof arg === 'function') as Fn | undefined;

      if (/^(describe|suite)(\.only|\.todo)?$/.test(kind) && body) {
        try {
          suiteResults.push(body.call('suite this', 'suite argument'));
        } catch (error) {
          suiteResults.push(error);
        }
      }

      return `${kind} ${name}`;
    };
  /** Registers a hook, recorded with its kind as its name and the hook as the first argument after it. */
  const hook = (kind: string) =>
    function (this: unknown, ...rest: unknown[]) {
      registrations.push({ kind, name: kind, rest, self: this });

      return kind;
    };
  const withShorthands = (kind: string, tests = true) =>
    Object.assign(register(kind), {
      skip: register(`${kind}.skip`),
      todo: register(`${kind}.todo`),
      only: register(`${kind}.only`),
      ...(tests && expectFailure && { expectFailure: register(`${kind}.expectFailure`) }),
      mock: `${kind}.mock`,
    });
  // Like node:test, the module is the `test` function, which carries the other functions, and `it` is `test`.
  const test = withShorthands('test');
  const module: NodeTestModule = Object.assign(test, {
    describe: withShorthands('describe', false),
    suite: withShorthands('suite', false),
    it: test,
    test,
    before: hook('before'),
    beforeEach: hook('beforeEach'),
    after: hook('after'),
    afterEach: hook('afterEach'),
    run: 'run',
  });

  return { module, registrations, suiteResults };
}

/**
 * A test context as node:test passes it to a test's body, which notes whether the test skipped itself, and whose
 * `test` adds its subtests to `registrations` as `t.test`.
 */
export function testContext(registrations: Registration[] = []) {
  const context = {
    skipped: false,
    skip: () => {
      context.skipped = true;
    },
    test: function (this: unknown, name: string, ...rest: unknown[]) {
      registrations.push({ kind: 't.test', name, rest, self: this });

      return `t.test ${name}`;
    },
  };

  return context;
}

/** The body the wrapper registered for the test with this name. */
export function rawBodyOf(registrations: Registration[], name: string): Fn {
  const registration = registrations.find((candidate) => candidate.name === name);
  assert.ok(registration, `${name} was not registered`);

  return registration.rest.find((arg) => typeof arg === 'function') as Fn;
}

/** Returns the body the wrapper registered for the test with this name, as a function that returns a promise. */
export function bodyOf(registrations: Registration[], name: string): (this: unknown, ...args: unknown[]) => Promise<unknown> {
  const body = rawBodyOf(registrations, name);

  return async function (this: unknown, ...args: unknown[]) {
    return body.apply(this, args);
  };
}

/** Runs the bodies of the named tests one after another, each with a fresh test context. */
export async function runBodies(registrations: Registration[], names: string[]): Promise<void> {
  for (const name of names) {
    await bodyOf(registrations, name)(testContext());
  }
}

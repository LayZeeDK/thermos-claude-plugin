import assert from 'node:assert/strict';
import { join } from 'node:path';

import type { NodeTestModule } from './hook-core.ts';

export type Fn = (this: unknown, ...args: unknown[]) => unknown;

export interface Registration {
  kind: string;
  name: string;
  rest: unknown[];
  self: unknown;
}

export const TEST_FILE = join('/repo', 'a.test.ts');

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

export function rawBodyOf(registrations: Registration[], name: string): Fn {
  const registration = registrations.find((candidate) => candidate.name === name);
  assert.ok(registration, `${name} was not registered`);

  return registration.rest.find((arg) => typeof arg === 'function') as Fn;
}

export function bodyOf(registrations: Registration[], name: string): (this: unknown, ...args: unknown[]) => Promise<unknown> {
  const body = rawBodyOf(registrations, name);

  return async function (this: unknown, ...args: unknown[]) {
    return body.apply(this, args);
  };
}

export async function runBodies(registrations: Registration[], names: string[]): Promise<void> {
  for (const name of names) {
    await bodyOf(registrations, name)(testContext());
  }
}

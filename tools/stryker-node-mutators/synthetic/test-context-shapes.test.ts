// Tests that exist to be mutated: the test context's assertion shapes of the open-source projects the runner was
// measured on, which the test-code operators match.
import { AssertionError } from 'node:assert';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { describe, it, type TestContext } from 'node:test';

import { onSent, share, total } from './node-apis.ts';

// env-schema/test/make-test.js:6
function checkShare(t: TestContext, part: number, whole: number, expected: number): void {
  t.assert.equal(share(part, whole), expected);
}

// fastify/test/register.test.js:122
function thenableRejects(t: TestContext, promise: Promise<unknown>, error: object) {
  return t.assert.rejects(async () => {
    await promise;
  }, error);
}

describe('assertions of the test context', () => {
  // pino-pretty/lib/utils/create-date.test.js:10
  it('checks in its own body', (t) => {
    t.assert.equal(total(2, 2), 4);
  });

  it('checks through a helper that takes it', (t) => {
    checkShare(t, 1, 2, 0.5);
  });

  // fastify/test/register.test.js:131
  it('checks through a helper that returns its rejects', async (t) => {
    await thenableRejects(t, Promise.resolve().then(() => share(1, 0)), { name: 'AssertionError' });
  });

  // fastify/test/listen.1.test.js:86
  it('checks in a callback', (t) => {
    const emitter = new EventEmitter();
    emitter.on('ready', (value: number) => {
      t.assert.equal(value, total(1, 3));
    });

    emitter.emit('ready', 3);
  });

  // fast-json-stringify/test/integer.test.js:78
  it('checks in a function of its own', (t) => {
    function check({ count, size, product }: { count: number; size: number; product: number }): void {
      t.assert.equal(total(count, size), product);
    }

    [{ count: 2, size: 3, product: 6 }].forEach(check);
  });

  // fastify/test/decorator.test.js:772
  it('checks in a promise callback', async (t) => {
    await Promise.resolve(share(1, 4)).then((value) => t.assert.equal(value, 0.25));
  });

  // pino-pretty/test/boolean-options.test.js:50, pino-pretty/test/error-objects.test.js:265
  it('checks in each branch of a loop', (t) => {
    for (const whole of [1, 2]) {
      if (whole === 1) {
        t.assert.equal(share(1, whole), 1);
      } else {
        t.assert.equal(share(1, whole), 0.5);
      }
    }
  });

  // fast-json-stringify/test/date.test.js:250
  it('checks in a subtest', async (t) => {
    await t.test('with a context of its own', (t: TestContext) => {
      t.assert.deepStrictEqual([total(1, 1)], [1]);
    });
  });

  // pino-pretty/lib/utils/prettify-object.test.js:194, pino-pretty/test/basic.test.js:1085
  it('checks with other methods', (t) => {
    t.assert.doesNotThrow(() => total(1, 1));
    t.assert.match(String(share(1, 8)), /^0\.125$/);
    t.assert.notEqual(share(1, 2), 1);
  });

  // fast-json-stringify/test/anyof.test.js:849
  it('checks the error it catches', (t) => {
    try {
      share(1, 0);
      t.assert.fail('should throw');
    } catch (error) {
      t.assert.equal((error as AssertionError).operator, '==');
    }
  });

  // fastify/test/helper.js:85
  it('checks that a call does not throw', (t: TestContext) => {
    try {
      total(2, 1);
      t.assert.ok(true);
    } catch {
      t.assert.fail('should not throw');
    }
  });

  // pino-pretty/test/basic.test.js:1139
  it('checks in a listener before it calls back', (t, done) => {
    const stream = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    onSent({ raw: stream }, () => {
      t.assert.equal(total(1, 2), 2);
      done();
    });

    stream.end('x');
  });

  // fast-json-stringify/test/array.test.js:9, fastify-cookie/test/cookie.test.js:262
  it('plans the checks of its callbacks', (t) => {
    t.plan(2);
    [1, 2].forEach((count) => t.assert.equal(total(count, 1), count));
  });

  // fastify-cookie/test/signer.test.js:15
  it('names the error that throws expects with a function', (t) => {
    t.assert.throws(
      () => share(1, 0),
      (error) => error instanceof AssertionError,
    );
  });

  // fast-json-stringify/test/allof.test.js:617
  it('names the error that throws expects with an object', (t) => {
    t.assert.throws(
      () => {
        total(0.5, 1);
      },
      { name: 'AssertionError' },
    );
  });

  // fastify/test/schema-feature.test.js:599, fastify-cookie/test/cookie.test.js:956
  it('checks in the validator of rejects', async (t: TestContext) => {
    await t.assert.rejects(
      async () => total(0.5, 1),
      (error) => {
        t.assert.ok(error instanceof AssertionError);

        return true;
      },
    );
  });
});

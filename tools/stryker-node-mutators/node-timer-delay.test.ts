import assert from 'node:assert/strict';
import { describe } from 'node:test';

import { testEach } from '../test-each/test-each.ts';
import { mutantsOf } from './mutants-of.fixtures.ts';
import { nodeTimerDelay } from './node-timer-delay.ts';

const PROMISES = "import { setTimeout as sleep } from 'node:timers/promises';\n";

describe('NodeTimerDelay', () => {
  testEach([
    ['the global setTimeout', 'setTimeout(() => {}, graceMs);', 'graceMs'],
    ['the global setInterval', 'setInterval(tick, 100);', '100'],
    ['setTimeout of node:timers', "import { setTimeout } from 'node:timers';\nsetTimeout(f, ms);", 'ms'],
    ['a renamed setInterval of timers', "import { setInterval as every } from 'timers';\nevery(f, ms);", 'ms'],
    ['a member of node:timers', "import timers from 'node:timers';\ntimers.setTimeout(f, ms);", 'ms'],
    ['a renamed setTimeout of node:timers/promises', `${PROMISES}await sleep(ms, 'value');`, 'ms'],
    [
      'a member of a namespace import of node:timers/promises',
      "import * as timers from 'node:timers/promises';\nawait timers.setTimeout(ms);",
      'ms',
    ],
    [
      'setInterval of a default import of timers/promises',
      "import timers from 'timers/promises';\ntimers.setInterval(ms);",
      'ms',
    ],
    ['scheduler.wait', "import { scheduler } from 'node:timers/promises';\nawait scheduler.wait(ms);", 'ms'],
    ['a delay that needs parentheses', 'setTimeout(f, a ?? 5);', '(a ?? 5)'],
  ])('moves the delay of %s by 1 each way', async (_title, source, delay) => {
    assert.deepEqual(await mutantsOf(nodeTimerDelay, source), [`${delay} + 1`, `${delay} - 1`]);
  });

  testEach([
    ['1, which a move down leaves at 1', 'setTimeout(f, 1);', ['1 + 1']],
    ['0, which either move leaves at 1', 'setTimeout(f, 0);', []],
    ['undefined, which is 1 already', 'setTimeout(f, undefined);', []],
    ['a spread', 'setTimeout(f, ...rest);', []],
  ])('moves a delay of %s only where it changes', async (_title, source, expected) => {
    assert.deepEqual(await mutantsOf(nodeTimerDelay, source), expected);
  });

  testEach([
    ["mock timers' tick", 't.mock.timers.tick(999);'],
    ['the callback of a global setTimeout', 'setTimeout(delay);'],
    ['a function of its own named setTimeout', 'function setTimeout(f: unknown, ms: number) {}\nsetTimeout(f, 5);'],
    ['a method of an object of its own', 'const timers = { setTimeout(f: unknown, ms: number) {} };\ntimers.setTimeout(f, 5);'],
    ['another function of node:timers', "import { setImmediate } from 'node:timers';\nsetImmediate(f, 5);"],
    ['a timer of another module', "import { setTimeout } from 'other';\nsetTimeout(f, 5);"],
    ['a member of another module', "import timers from 'other';\ntimers.setTimeout(f, 5);"],
    ['another member of node:timers', "import timers from 'node:timers';\ntimers.setImmediate(f, 5);"],
    ['another method of the scheduler', "import { scheduler } from 'node:timers/promises';\nscheduler.yield(5);"],
    ['the wait of another scheduler', "import { scheduler } from 'other';\nscheduler.wait(5);"],
    ['another named import of node:timers/promises', "import { setImmediate } from 'node:timers/promises';\nsetImmediate.wait(5);"],
    ['the wait of the callback timers', "import { scheduler } from 'node:timers';\nscheduler.wait(5);"],
    ['AbortSignal.timeout', 'AbortSignal.timeout(5);'],
    ['a computed timer of node:timers', "import timers from 'node:timers';\ntimers['setTimeout'](f, 5);"],
    ['a timer constructed with new', 'new setTimeout(f, 5);'],
    // fastify/test/helper.js:9
    [
      'a timer promisified into a function of its own',
      "import { promisify } from 'node:util';\nconst sleep = promisify(setTimeout);\nawait sleep(200);",
    ],
    // fastify/lib/server.js:319
    ['a setTimeout method of a parameter', 'function f(server: any) {\n  server.setTimeout(5);\n}'],
    // fastify/test/connection-timeout.test.js:37
    ['a setTimeout method of a member', 'fastify.server.setTimeout(5);'],
    // pino-pretty/benchmark.js:24
    ['the global setImmediate', 'setImmediate(f);'],
    // fastify/test/content-type-parser-async-context.test.js:4
    [
      'a renamed setImmediate of node:timers/promises',
      "import { setImmediate as immediate } from 'node:timers/promises';\nawait immediate(5);",
    ],
    // fastify/fastify.js:450
    ['process.nextTick', 'process.nextTick(done, 5);'],
    // fast-json-stringify/index.js:576
    ['a timer in generated source', "new Function('f', 'setTimeout(f, 5)');"],
  ])('leaves %s alone', async (_title, source) => {
    assert.deepEqual(await mutantsOf(nodeTimerDelay, source), []);
  });
});

import assert from 'node:assert/strict';
import { describe } from 'node:test';

import { testEach } from '../test-each/test-each.ts';
import { mutantsOf } from './mutants-of.fixtures.ts';
import { nodeEventName } from './node-event-name.ts';

describe('NodeEventName', () => {
  testEach([
    ["the process's exit", "process.on('exit', f);", ['"beforeExit"']],
    ["the process's beforeExit", "process.once('beforeExit', f);", ['"exit"']],
    ['an imported process', "import process from 'node:process';\nprocess.on('exit', f);", ['"beforeExit"']],
    ['a renamed process', "import * as proc from 'process';\nproc.addListener('exit', f);", ['"beforeExit"']],
    ["a child's exit", "child.on('exit', f);", ['"close"']],
    ["a child's close", "child.once('close', f);", ['"exit"']],
    ["a stream's finish", "stream.addListener('finish', f);", ['"end"', '"close"']],
    ["a stream's end", "stream.prependListener('end', f);", ['"close"']],
    ['a listener put first once', "child.prependOnceListener('close', f);", ['"exit"']],
    ['a parameter named process, as a child', "function f(process: any) {\n  process.on('exit', g);\n}", ['"close"']],
    ['a process of another module, as a child', "import process from 'other';\nprocess.on('exit', f);", ['"close"']],
    ['a named import of node:process, as a child', "import { env } from 'node:process';\nenv.on('exit', f);", ['"close"']],
    ['once of node:events', "import { once } from 'node:events';\nawait once(child, 'exit');", ['"close"']],
    ["on of events, on the process", "import { on } from 'events';\non(process, 'exit');", ['"beforeExit"']],
    ['once of a default import', "import events from 'node:events';\nawait events.once(child, 'close');", ['"exit"']],
    [
      "EventEmitter's once",
      "import { EventEmitter } from 'node:events';\nawait EventEmitter.once(child, 'finish');",
      ['"end"', '"close"'],
    ],
  ])('swaps the event name of %s', async (_title, source, expected) => {
    assert.deepEqual(await mutantsOf(nodeEventName, source), expected);
  });

  testEach([
    ['an event outside the tables', "child.on('data', f);"],
    ["a stream's event on the process", "process.on('close', f);"],
    ['the process inside a member', "globalThis.process.on('beforeExit', f);"],
    ['addEventListener', "target.addEventListener('close', f);"],
    ['emit', "child.emit('exit');"],
    ['off', "child.off('exit', f);"],
    ['a computed listener method', "child['on']('exit', f);"],
    ['a name after the listener', "child.on(f, 'exit');"],
    ['a template literal', 'child.on(`exit`, f);'],
    ['a function on of its own', "on('exit', f);"],
    ["the emitter's place in once of node:events", "import { once } from 'node:events';\nonce('exit', child);"],
    ['once of another module', "import { once } from 'other';\nonce(child, 'exit');"],
    ['another function of node:events', "import { getEventListeners } from 'node:events';\ngetEventListeners(child, 'exit');"],
    ['once of a default import of another module', "import events from 'other';\nevents.once(child, 'exit');"],
    ['another named import of node:events', "import { errorMonitor } from 'node:events';\nerrorMonitor.once(child, 'exit');"],
    ['another member of node:events', "import events from 'node:events';\nevents.listenerCount(child, 'exit');"],
    ['once of a member', "import events from 'node:events';\nevents.EventEmitter.once(child, 'exit');"],
    // fastify/test/http2/closing.test.js:193
    ['an event outside the tables of a member, in once', "import { once } from 'node:events';\nawait once(fastify.server, 'session');"],
    // fastify/test/helper.js:564
    ["the process's warning", "process.on('warning', f);"],
    // pino-pretty/bin.js:88
    ["the process's signal", "process.once('SIGINT', f);"],
    // pino-pretty/test/helper.js:12
    [
      'a once of its own, which listens for the event in its parameter',
      "function once(emitter: any, event: string, fn: unknown) {\n  emitter.on(event, fn);\n}\nonce(child, 'exit', f);",
    ],
  ])('leaves %s alone', async (_title, source) => {
    assert.deepEqual(await mutantsOf(nodeEventName, source), []);
  });
});

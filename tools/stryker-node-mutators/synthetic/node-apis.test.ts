import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { describe, it, mock } from 'node:test';
import timers from 'node:timers';
import timersPromises from 'node:timers/promises';

import { testEach } from '../../test-each/test-each.ts';
import { closed, later, onEnd, onFinish, onIdle, pause, share, total, wait } from './node-apis.ts';

const MS = 10;

type Timers = Record<string, (...args: unknown[]) => unknown>;

/** Runs the event loop until the callbacks and promises due now have run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The arguments that `run` gives `owner[method]`, which a fake that does nothing replaces meanwhile, also behind the
 * named imports of a built-in module.
 */
async function callsOf(owner: object, method: string, run: () => unknown): Promise<unknown[][]> {
  const fake = mock.method(owner as Timers, method, async () => {});
  syncBuiltinESMExports();

  try {
    await run();

    return fake.mock.calls.map((call) => call.arguments);
  } finally {
    fake.mock.restore();
    syncBuiltinESMExports();
  }
}

describe('the timers', () => {
  const callback = () => {};

  testEach([
    ['pause', timersPromises, 'setTimeout', () => pause(MS), [MS]],
    ['wait', timersPromises.scheduler, 'wait', () => wait(MS), [MS]],
    ['later', timers, 'setTimeout', () => later(callback, MS), [callback, MS]],
  ])('%s gives the timer the milliseconds it is given', async (_name, owner, method, run, args) => {
    assert.deepEqual(await callsOf(owner, method, run), [args]);
  });
});

describe('closed', () => {
  it('resolves once the emitter closes, not when it exits', async () => {
    const emitter = new EventEmitter();
    let settled = false;
    void closed(emitter).then(() => {
      settled = true;
    });

    emitter.emit('exit');
    await settle();
    const afterExit = settled;
    emitter.emit('close');
    await settle();

    assert.deepEqual([afterExit, settled], [false, true]);
  });
});

describe('the stream listeners', () => {
  it('onFinish calls back when the stream finishes, before it closes', async () => {
    const events: string[] = [];
    const stream = new Writable({ write: (_chunk, _encoding, callback) => callback() });
    onFinish(stream, () => events.push('done'));
    stream.on('finish', () => events.push('finish'));
    stream.on('close', () => events.push('close'));

    stream.end('x');
    await once(stream, 'close');

    assert.deepEqual(events, ['done', 'finish', 'close']);
  });

  it('onEnd calls back when the stream ends, before it closes', async () => {
    const events: string[] = [];
    const stream = Readable.from(['x']);
    onEnd(stream, () => events.push('done'));
    stream.on('end', () => events.push('end'));
    stream.on('close', () => events.push('close'));

    stream.resume();
    await once(stream, 'close');

    assert.deepEqual(events, ['done', 'end', 'close']);
  });
});

describe('onIdle', () => {
  it("listens for the process's beforeExit", () => {
    const listener = () => {};
    onIdle(listener);

    try {
      assert.deepEqual(
        [process.listeners('beforeExit').includes(listener), process.listeners('exit').includes(listener)],
        [true, false],
      );
    } finally {
      process.removeListener('beforeExit', listener);
    }
  });
});

describe('the assertions', () => {
  it('share divides a part by a positive whole', () => {
    assert.equal(share(1, 4), 0.25);
    assert.throws(() => share(1, 0), assert.AssertionError);
  });

  it('total multiplies a whole count by a size', () => {
    assert.equal(total(3, 2), 6);
    assert.throws(() => total(1.5, 2), assert.AssertionError);
  });
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { testEach } from '../test-each/test-each.ts';
import { endGroup, groupOptions, processEnd } from './process-end.ts';

describe('groupOptions', () => {
  testEach([
    ['linux', { detached: true, windowsHide: true }],
    ['darwin', { detached: true, windowsHide: true }],
    ['win32', { detached: false, windowsHide: true }],
  ] as const)('spawns a test file on %s with %j', (platform, options) => {
    assert.deepEqual(groupOptions(platform), options);
  });
});

describe('endGroup', () => {
  /** endGroup with a kill that records its calls and throws `error` when given one. */
  function setup(platform: NodeJS.Platform, error?: NodeJS.ErrnoException) {
    const calls: unknown[][] = [];
    const end = () =>
      endGroup(123, platform, (pid, signal) => {
        calls.push([pid, signal]);

        if (error) {
          throw error;
        }
      });

    return { calls, end };
  }

  it("kills a POSIX test file's whole process group", () => {
    const { calls, end } = setup('linux');

    end();

    assert.deepEqual(calls, [[-123, 'SIGKILL']]);
  });

  it('leaves Windows, where the processes end with the test file, alone', () => {
    const { calls, end } = setup('win32');

    end();

    assert.deepEqual(calls, []);
  });

  it('takes a group that no longer exists as ended, and throws any other error', () => {
    const gone = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    const denied = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });

    setup('linux', gone).end();
    assert.throws(() => setup('linux', denied).end(), denied);
  });
});

describe('processEnd', () => {
  /**
   * A stand-in for a child process with pid 123, how its end promise stands after pending callbacks ran, and the kills
   * that ended its group on `platform`.
   */
  function ending(graceMs: number, platform: NodeJS.Platform = 'win32') {
    const child = Object.assign(new EventEmitter(), { pid: 123, stderr: new PassThrough() });
    const kills: unknown[][] = [];
    const end = processEnd(child, graceMs, platform, (pid, signal) => {
      kills.push([pid, signal]);
    });
    let state: unknown = 'pending';
    end.then(
      (value) => (state = value),
      (error: unknown) => (state = error),
    );
    const settled = async () => {
      await new Promise(setImmediate);

      return state;
    };

    return { child, settled, kills };
  }

  it("ends what is left of a POSIX process's group once the process ends, whether stderr closes or not", async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const closes = ending(1_000, 'linux');
    closes.child.emit('exit', 0);
    await closes.settled();

    assert.deepEqual(closes.kills, []);

    closes.child.emit('close', 0);
    await closes.settled();
    const staysOpen = ending(1_000, 'linux');
    staysOpen.child.emit('exit', 0);
    t.mock.timers.tick(1_000);
    await staysOpen.settled();

    assert.deepEqual([closes.kills, staysOpen.kills], [[[-123, 'SIGKILL']], [[-123, 'SIGKILL']]]);
  });

  it('ends when the process closes its stdio, with its exit code and stderr, without waiting', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { child, settled } = ending(1_000);
    child.stderr.write('first ');
    child.stderr.write('second');
    await settled();
    child.emit('exit', 3);
    child.emit('close', 3);

    assert.deepEqual(await settled(), { exitCode: 3, stderr: 'first second' });
  });

  it('stops waiting out the grace period once stderr closes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { child, settled } = ending(1_000);
    child.emit('exit', 0);
    child.emit('close', 0);
    await settled();
    t.mock.timers.tick(1_000);

    assert.equal(child.stderr.destroyed, false);
  });

  it('ends `graceMs` after the process exits when stderr stays open, and lets go of stderr', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { child, settled } = ending(1_000);
    child.stderr.write('before exit');
    await settled();
    child.emit('exit', 1);
    t.mock.timers.tick(999);

    assert.equal(await settled(), 'pending');

    t.mock.timers.tick(1);

    assert.deepEqual(await settled(), { exitCode: 1, stderr: 'before exit' });
    assert.equal(child.stderr.destroyed, true);
  });

  it('fails when the process cannot start', async () => {
    const { child, settled } = ending(1_000);
    const failure = new Error('spawn ENOENT');
    child.emit('error', failure);

    assert.equal(await settled(), failure);
  });
});

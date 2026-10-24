import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { isOwn, isRunning, ownDir, removeDir, removeLeftDirs } from './dirs.ts';
import { logger, NO_PROCESS } from './index.fixtures.ts';
import { peakMemoryDir } from './index.ts';

describe('removeDir', () => {
  const DIR = join('/tmp', 'run');

  /** Starts removing DIR with `remove`, waiting 1,000 ms, and collects the warnings. */
  function removal(remove: () => Promise<void>) {
    const warnings: string[] = [];
    const removed: string[] = [];
    let state = 'pending';
    void removeDir(DIR, logger([], false, warnings), {
      waitMs: 1_000,
      remove: (path) => {
        removed.push(path);

        return remove();
      },
    }).then(() => (state = 'done'));
    const settled = async () => {
      await new Promise(setImmediate);

      return state;
    };

    return { warnings, removed, settled };
  }

  it('removes the directory without a warning, and stops waiting', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { warnings, removed, settled } = removal(async () => {});

    assert.equal(await settled(), 'done');

    t.mock.timers.tick(1_000);

    assert.deepEqual([removed, warnings], [[DIR], []]);
  });

  it('leaves a directory it cannot remove, with a warning, and stops waiting', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { warnings, settled } = removal(() => Promise.reject(new Error('EPERM: operation not permitted')));

    assert.equal(await settled(), 'done');

    t.mock.timers.tick(1_000);

    assert.deepEqual(warnings, [`Left ${DIR} for a later runner to remove: EPERM: operation not permitted`]);
  });

  it('stops waiting for a directory still in use after `waitMs`, with a warning', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { warnings, settled } = removal(() => new Promise(() => {}));
    t.mock.timers.tick(999);

    assert.deepEqual([await settled(), warnings], ['pending', []]);

    t.mock.timers.tick(1);

    assert.deepEqual(
      [await settled(), warnings],
      ['done', [`Stopped waiting for ${DIR} to be removed after 1000 ms; a later runner removes what is left.`]],
    );
  });

  it('warns once when the removal fails after it stopped waiting', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let fail = (_error: Error) => {};
    const { warnings, settled } = removal(() => new Promise((_, reject) => (fail = reject)));
    t.mock.timers.tick(1_000);
    fail(new Error('EBUSY: resource busy or locked'));
    await settled();

    assert.deepEqual(warnings, [
      `Stopped waiting for ${DIR} to be removed after 1000 ms; a later runner removes what is left.`,
    ]);
  });
});

describe('isRunning', () => {
  it('tells running processes, also ones it may not signal, from ones that do not run', () => {
    // The system process on Windows and init on POSIX run, and only an administrator may signal them.
    const system = process.platform === 'win32' ? 4 : 1;

    assert.deepEqual([process.pid, system, NO_PROCESS].map(isRunning), [true, true, false]);
  });
});

describe('ownDir', () => {
  it("creates the directory, and keeps one that is this user's", (t) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'own-dir-')), 'peaks');
    t.after(() => rmSync(dirname(dir), { recursive: true, force: true }));

    ownDir(dir, () => true);
    ownDir(dir, () => true);

    assert.ok(lstatSync(dir).isDirectory());
  });

  it("refuses a directory that is another user's, and names it", (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'own-dir-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const asked: string[] = [];

    assert.throws(
      () =>
        ownDir(dir, (path) => {
          asked.push(path);

          return false;
        }),
      { message: `"${dir}" belongs to another user; remove it, or run Stryker as that user.` },
    );
    assert.deepEqual(asked, [dir]);
  });
});

describe('removeLeftDirs', () => {
  it('removes the run, cache and dry-run peak directories whose processes ended, and leaves everything else', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'left-dirs-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const names = [
      'stryker-node-test-111-a',
      'stryker-node-test-cache-111-b',
      basename(peakMemoryDir(111)),
      'stryker-node-test-222-c',
      'stryker-node-test-cache-222-d',
      basename(peakMemoryDir(222)),
      'stryker-node-test-e',
      'other-111-f',
      'other-stryker-node-test-111-g',
    ];

    for (const name of names) {
      mkdirSync(join(dir, name));
    }

    const asked: number[] = [];
    removeLeftDirs(dir, {
      running: (pid) => {
        asked.push(pid);

        return pid === 222;
      },
    });

    assert.deepEqual(readdirSync(dir).sort(), names.slice(3).sort());
    assert.deepEqual(asked.sort(), [111, 111, 111, 222, 222, 222]);
  });

  it("leaves the directories of other users' runners", (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'left-dirs-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const names = ['stryker-node-test-111-mine', 'stryker-node-test-111-theirs', 'stryker-node-test-222-running'];

    for (const name of names) {
      mkdirSync(join(dir, name));
    }

    const asked: string[] = [];
    removeLeftDirs(dir, {
      running: (pid) => pid === 222,
      owned: (path) => {
        asked.push(path);

        return path.endsWith('mine');
      },
    });

    assert.deepEqual(readdirSync(dir).sort(), names.slice(1));
    assert.deepEqual(asked.sort(), [join(dir, names[0] as string), join(dir, names[1] as string)]);
  });

  it('leaves a directory it cannot check or remove yet and goes on with the others', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'left-dirs-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const names = ['stryker-node-test-111-a', 'stryker-node-test-111-b', 'stryker-node-test-111-c'];

    for (const name of names) {
      mkdirSync(join(dir, name));
    }

    const removed: string[] = [];

    removeLeftDirs(dir, {
      running: () => false,
      owned: (path) => {
        if (path.endsWith('a')) {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }

        return true;
      },
      remove: (path) => {
        removed.push(basename(path));
        throw Object.assign(new Error('in use'), { code: 'EBUSY' });
      },
    });

    assert.deepEqual(removed.sort(), names.slice(1));
  });
});

describe('isOwn', () => {
  it("compares the user id of the file itself with this process's", () => {
    const stated: string[] = [];
    const stat = (path: string) => {
      stated.push(path);

      return { uid: 7 };
    };

    assert.deepEqual([isOwn('a', { getuid: () => 7 }, stat), isOwn('b', { getuid: () => 8 }, stat)], [true, false]);
    assert.deepEqual(stated, ['a', 'b']);
  });

  it('counts every file as owned where there are no user ids, as on Windows', () => {
    assert.equal(isOwn('a', {}, () => assert.fail('looked up the owner')), true);
  });

  it('counts a directory this process created as owned', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'own-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    assert.equal(isOwn(dir), true);
  });
});

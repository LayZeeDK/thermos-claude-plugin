import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { testFor } from '../test-each/test-for.ts';
import { checkMemory, watch } from './watchdog.ts';

const DATA = { limitMB: 200, recordPath: '/out/4321.json' };
const MB = 1048576;

/** checkMemory at `rssBytes`, with the writes and kills it made. */
function check(rssBytes: number) {
  const writes: unknown[][] = [];
  const kills: unknown[][] = [];
  checkMemory(
    DATA,
    rssBytes,
    (path, data) => writes.push([path, JSON.parse(data)]),
    (pid, signal) => kills.push([pid, signal]),
  );

  return { writes, kills };
}

describe('checkMemory', () => {
  it("writes the process's record and ends the process once it holds more than the limit", () => {
    assert.deepEqual(check(200.6 * MB), {
      writes: [[DATA.recordPath, { tests: [], memoryLimitReached: { rssMB: 201, limitMB: 200 } }]],
      kills: [[process.pid, 'SIGKILL']],
    });
  });

  testFor([
    ['at the limit', 200 * MB],
    ['just below the limit after rounding', 200.4 * MB],
  ] as const)('leaves the process alone %s', ([, rssBytes]) => {
    assert.deepEqual(check(rssBytes), { writes: [], kills: [] });
  });
});

describe('watch', () => {
  it("looks at the process's memory every 50 ms", (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const looks: number[] = [];
    let rss = 0;
    watch(DATA, () => {
      looks.push(rss);

      return ++rss;
    });

    t.mock.timers.tick(49);
    assert.deepEqual(looks, []);
    t.mock.timers.tick(1);
    t.mock.timers.tick(50);

    assert.deepEqual(looks, [0, 1]);
  });

  it("measures the process's resident memory by default", (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const rss = t.mock.method(process.memoryUsage, 'rss', () => 1);
    watch(DATA);

    t.mock.timers.tick(50);

    assert.equal(rss.mock.callCount(), 1);
  });
});

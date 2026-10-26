import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { it } from 'node:test';

// On Linux a forked child can start with its parent's peak, so the child is started by a small process of its own,
// whose peak is all it can carry over, and the test subtracts a small diff's growth.
const CHILD = `
const assert = require('node:assert');
const lines = Number(process.argv[1]);
const before = process.memoryUsage.rss() / 1024;
try {
  assert.deepStrictEqual({ ids: new Array(lines).fill(null) }, { ids: new Array(lines).fill('string') });
} catch {}
console.log(Math.round((process.resourceUsage().maxRSS - before) / 1024));
`;

const STARTER = `
const { execFileSync } = require('node:child_process');
const [script, ...args] = process.argv.slice(1);
process.stdout.write(execFileSync(process.execPath, ['-e', script, ...args], { encoding: 'utf8', windowsHide: true }));
`;

function growthMB(lines: number): number {
  return Number(
    execFileSync(process.execPath, ['-e', STARTER, CHILD, String(lines)], { encoding: 'utf8', windowsHide: true }),
  );
}

it("still has Node.js's assertion diff grow with the square of the lines it compares", () => {
  const diffMB = growthMB(2000) - growthMB(20);

  // About 140 MB on Node.js 24.18.1; a diff that grows with the lines would take a few MB.
  assert.ok(
    diffMB >= 64,
    `The assertion diff took ${diffMB} MB, so this Node.js release no longer builds it with memory that grows with ` +
      'the square of the lines (nodejs/node#62792, nodejs/node#61347). Releases without the fix still need the ' +
      'memory watchdog, which guards every mutant run, and a dry run under lzNodeTest.maxMemoryMB, against it. Either ' +
      'raise package.json engines to releases with the fix and remove the watchdog with all that serves it, or skip ' +
      'this test on releases with the fix. The watchdog is watchdog.ts, which hook.ts starts; ' +
      "hook-core.ts's install starts it through canWatchMemory, watchMemory and ENV.memoryLimit, keeps it in the " +
      'global slot of its watchdog symbol, and records the dry-run peakMemoryMB it is limited by. The runner\'s side ' +
      'is memory-limits.ts, ownDir and the peaks- directories that removeLeftDirs removes in dirs.ts, and in ' +
      "index.ts the lzNodeTest.maxMemoryMB option, its schema entry and fileOutcome's memoryLimitReached branch. The " +
      "tests' GROWS fixture in index.fixtures.ts goes with them.",
  );
});

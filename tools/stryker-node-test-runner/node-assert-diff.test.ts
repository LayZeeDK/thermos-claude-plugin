import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { it } from 'node:test';

// Fails a deep assertion on `lines` nulls against as many strings in a fresh process, and prints how many MB its peak
// grew over the memory it held at the start. On Linux a forked child can start with its parent's peak, so the child is
// started by a small process of its own, whose peak is all it can carry over, and the test subtracts a small diff's
// growth.
const CHILD = `
const assert = require('node:assert');
const lines = Number(process.argv[1]);
const before = process.memoryUsage.rss() / 1024;
try {
  assert.deepStrictEqual({ ids: new Array(lines).fill(null) }, { ids: new Array(lines).fill('string') });
} catch {}
console.log(Math.round((process.resourceUsage().maxRSS - before) / 1024));
`;

/** Runs the script in its first argument, with the rest as its arguments, and prints what it prints. */
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
      'memory watchdog in watchdog.ts, which guards every mutant run against it. Either raise package.json engines ' +
      'to releases with the fix and remove the watchdog, or skip this test on releases with the fix.',
  );
});

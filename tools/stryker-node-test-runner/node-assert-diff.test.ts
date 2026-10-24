import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { it } from 'node:test';

// Fails a deep assertion on `lines` nulls against as many strings in a fresh process, and prints how many MB its peak
// grew over the memory it held at the start. On Linux a forked child can start with its parent's peak, which can hide
// the growth; the test subtracts a small diff's growth to take that out.
const CHILD = `
const assert = require('node:assert');
const lines = Number(process.argv[1]);
const before = process.memoryUsage.rss() / 1024;
try {
  assert.deepStrictEqual({ ids: new Array(lines).fill(null) }, { ids: new Array(lines).fill('string') });
} catch {}
console.log(Math.round((process.resourceUsage().maxRSS - before) / 1024));
`;

function growthMB(lines: number): number {
  return Number(execFileSync(process.execPath, ['-e', CHILD, String(lines)], { encoding: 'utf8', windowsHide: true }));
}

it("still has Node.js's assertion diff grow with the square of the lines it compares", () => {
  const diffMB = growthMB(2000) - growthMB(20);

  // About 140 MB on Node.js 24.18.1; a diff that grows with the lines would take a few MB.
  assert.ok(
    diffMB >= 64,
    `The assertion diff took ${diffMB} MB, so this Node.js release no longer builds it with memory that grows with ` +
      'the square of the lines (nodejs/node#62792, nodejs/node#61347). Releases without the fix still need the ' +
      "hook's memory watchdog (nodeTest.maxMemoryMB) that guards mutant runs against it. Either raise package.json " +
      'engines to releases with the fix and remove the watchdog, or skip this test on releases with the fix.',
  );
});

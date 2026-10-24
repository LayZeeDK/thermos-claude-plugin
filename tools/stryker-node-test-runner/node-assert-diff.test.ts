import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { it } from 'node:test';

// Fails a deep assertion on 2,000 nulls against 2,000 strings in a fresh process, and prints how many MB the
// assertion's diff took: the peak since the start over the memory held at the start. On Linux a forked child can start
// with its parent's peak, so the start is the memory it holds, not its peak.
const CHILD = `
const assert = require('node:assert');
const before = process.memoryUsage.rss() / 1024;
try {
  assert.deepStrictEqual({ ids: new Array(2000).fill(null) }, { ids: new Array(2000).fill('string') });
} catch {}
console.log(Math.round((process.resourceUsage().maxRSS - before) / 1024));
`;

it("still has Node.js's assertion diff grow with the square of the lines it compares", () => {
  const growthMB = Number(execFileSync(process.execPath, ['-e', CHILD], { encoding: 'utf8', windowsHide: true }));

  // About 140 MB on Node.js 24.18.1; a diff that grows with the lines would take a few MB.
  assert.ok(
    growthMB >= 64,
    `The assertion diff took ${growthMB} MB, so this Node.js release no longer builds it with memory that grows with ` +
      'the square of the lines (nodejs/node#62792, nodejs/node#61347). Releases without the fix still need the ' +
      "hook's memory watchdog (nodeTest.maxMemoryMB) that guards mutant runs against it. Either raise package.json " +
      'engines to releases with the fix and remove the watchdog, or skip this test on releases with the fix.',
  );
});

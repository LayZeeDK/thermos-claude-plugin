import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { it } from 'node:test';

// Fails a deep assertion on 2,000 nulls against 2,000 strings in a fresh process, and prints how many MB the
// assertion's diff took.
const CHILD = `
const assert = require('node:assert');
const before = process.resourceUsage().maxRSS;
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
      'the square of the lines (nodejs/node#62792, nodejs/node#61347). Once every Node.js release that package.json ' +
      "engines allows has the fix, consider removing the hook's memory watchdog (nodeTest.maxMemoryMB) that guards " +
      'mutant runs against it.',
  );
});

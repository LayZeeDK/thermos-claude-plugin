// Tests that exist to be mutated. Each check reaches node:assert in one of the ways that the test-code operators match
// and that no other test file of this repository uses, so npm run mutate makes those mutants and these checks, which
// all run and each name the error they expect, have to kill them.
import legacy from 'node:assert';
import * as namespace from 'assert';
import { deepStrictEqual as same, rejects, strict, strictEqual, throws } from 'node:assert';
import { describe, it } from 'node:test';

import { share, total } from './node-apis.ts';

describe('assertions reached in other ways', () => {
  it('checks through a named and a renamed import', () => {
    strictEqual(share(1, 2), 0.5);
    same([total(2, 3)], [6]);
  });

  it('checks through a namespace import and the strict member of the default import', () => {
    namespace.strictEqual(share(3, 4), 0.75);
    legacy.strict.equal(total(1, 5), 5);
    legacy(total(0, 5) === 0);
  });

  it('checks through the strict export', () => {
    strict.deepEqual([share(1, 1)], [1]);
  });

  it('checks in an arrow function body', () => {
    [1, 2].forEach((count) => strictEqual(total(count, 1), count));
  });

  it('names the errors that throws and an awaited rejects expect', async () => {
    throws(() => share(1, -1), legacy.AssertionError);
    await rejects(async () => total(0.5, 1), legacy.AssertionError);
  });
});

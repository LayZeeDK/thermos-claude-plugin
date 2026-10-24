import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { Instrumenter, InstrumentedMutant, SourceFile } from './install.ts';
import { corpusDiff, mutantDiff } from './mutant-diff.ts';
import type { BabelTypes, NodeMutatorLike, Operator } from './operator.ts';

/** A mutant of `mutatorName` that replaces line `line`, column `column` (both from 0) with `replacement`. */
function mutant(mutatorName: string, line: number, column: number, replacement = ';'): InstrumentedMutant {
  return { mutatorName, replacement, location: { start: { line, column }, end: { line, column: column + 1 } } };
}

describe('mutantDiff', () => {
  it('lists the mutants only one side has, from line and column 1, as often as they occur', () => {
    const before = [
      mutant('CallExpression', 0, 4),
      mutant('StringLiteral', 2, 0, '""'),
      mutant('StringLiteral', 2, 0, '""'),
    ];
    const after = [
      mutant('StringLiteral', 2, 0, '""'),
      mutant('AssertLiveness', 0, 4, 'throw new Error(\n  "x"\n);'),
      mutant('AssertLiveness', 0, 4, 'throw new Error(\n  "x"\n);'),
    ];

    assert.deepEqual(mutantDiff(before, after), {
      added: ['1:5 AssertLiveness throw new Error( "x" );', '1:5 AssertLiveness throw new Error( "x" );'],
      removed: ['1:5 CallExpression ;', '3:1 StringLiteral ""'],
    });
  });
});

describe('corpusDiff', () => {
  /**
   * corpusDiff over `names`, run by a stand-in instrumenter whose list holds Stryker's StringLiteral and in which each
   * mutator makes one mutant per file. The operator Own is for the files whose name has "owned" in it, and no operator
   * is for the others.
   */
  async function setup(names: string[]) {
    const read: string[] = [];
    const instrumented: [SourceFile[], string[]][] = [];
    const instrumenter: Instrumenter = {
      dir: '/stryker/instrumenter',
      version: '10.1.1',
      allMutators: [{ name: 'StringLiteral', *mutate() {} }],
      types: {} as BabelTypes,
      async instrument(files, mutators: readonly NodeMutatorLike[] = []) {
        instrumented.push([[...files], mutators.map(({ name }) => name)]);

        return mutators.map(({ name }) => mutant(name, 0, 0));
      },
    };
    const own: Operator = { name: 'Own', sample: '', *mutate() {} };
    const text = await corpusDiff(
      names,
      (name) => (name.includes('owned') ? [own] : []),
      async () => instrumenter,
      (name) => {
        read.push(name);

        return `content of ${name}`;
      },
    );

    return { text, read, instrumented };
  }

  it("reports each file, relative to the working directory, with and without that file's operators", async () => {
    const owned = resolve('tools', 'owned.ts');
    const { text, read, instrumented } = await setup([owned, 'plain.ts']);

    assert.equal(
      text,
      '### tools/owned.ts\n\n1 mutants without the operators, 2 with them.\n\n    + 1:1 Own ;\n\n' +
        '### plain.ts\n\n1 mutants without the operators, 1 with them.\n\n    (no difference)\n',
    );
    assert.deepEqual(read, [owned, 'plain.ts']);
    assert.deepEqual(instrumented, [
      [[{ name: owned, content: `content of ${owned}` }], ['StringLiteral']],
      [[{ name: owned, content: `content of ${owned}` }], ['StringLiteral', 'Own']],
      [[{ name: 'plain.ts', content: 'content of plain.ts' }], ['StringLiteral']],
      [[{ name: 'plain.ts', content: 'content of plain.ts' }], ['StringLiteral']],
    ]);
  });

  it('lists a mutant that an operator removes', async () => {
    const instrumenter: Instrumenter = {
      dir: '/stryker/instrumenter',
      version: '10.1.1',
      allMutators: [],
      types: {} as BabelTypes,
      async instrument(_files, mutators = []) {
        return [mutators.length > 0 ? mutant('Own', 0, 0) : mutant('CallExpression', 0, 0)];
      },
    };

    assert.equal(
      await corpusDiff(['a.ts'], () => [{ name: 'Own', sample: '', *mutate() {} }], async () => instrumenter, () => ''),
      '### a.ts\n\n1 mutants without the operators, 1 with them.\n\n    + 1:1 Own ;\n    - 1:1 CallExpression ;\n',
    );
  });

  it("runs from the command line over the files it is given, with Stryker's instrumenter", (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-diff-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'sample.ts');
    writeFileSync(file, "f('x');\n");

    const output = execFileSync(process.execPath, [join(import.meta.dirname, 'corpus-diff.ts'), file], {
      encoding: 'utf8',
      windowsHide: true,
    });

    assert.match(output, /sample\.ts\n\n1 mutants without the operators, 1 with them\.\n\n {4}\(no difference\)\n\n$/);
  });
});

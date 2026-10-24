// Prints, for each TypeScript file named on the command line, the mutants that this package's operators add to and
// remove from what Stryker's own mutators make there. A removed mutant is one that a mutator's filter drops once an
// operator's mutant shares its scope, as the CallExpression mutator does.
//
//   node tools/stryker-node-mutators/corpus-diff.ts <file.ts>...
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { resolveFromCore, type InstrumentedMutant } from './install.ts';
import { toNodeMutator } from './operator.ts';
import { productionOperators, testOperators } from './operators.ts';

const instrumenter = await resolveFromCore();
const builtIns = [...instrumenter.allMutators];
const operators = [...productionOperators, ...testOperators].map((operator) =>
  toNodeMutator(operator, instrumenter.types),
);

for (const name of process.argv.slice(2)) {
  const files = [{ name, content: readFileSync(name, 'utf8') }];
  const before = (await instrumenter.instrument(files, builtIns)).map(line);
  const after = (await instrumenter.instrument(files, [...builtIns, ...operators])).map(line);
  const diff = [
    ...without(after, before).map((mutant) => `    + ${mutant}`),
    ...without(before, after).map((mutant) => `    - ${mutant}`),
  ];

  console.log(
    `### ${relative(process.cwd(), name).replaceAll('\\', '/')}\n\n` +
      `${before.length} mutants without the operators, ${after.length} with them.\n\n` +
      `${diff.length > 0 ? diff.join('\n') : '    (no difference)'}\n`,
  );
}

function line({ mutatorName, location, replacement }: InstrumentedMutant): string {
  const { line: row, column } = location.start;

  return `${row + 1}:${column + 1} ${mutatorName} ${replacement.replace(/\s+/g, ' ')}`;
}

/** The lines of `from` that `other` lacks, counting each line as often as it occurs. */
function without(from: readonly string[], other: readonly string[]): string[] {
  const left = [...other];

  return from.filter((entry) => {
    const index = left.indexOf(entry);

    if (index === -1) {
      return true;
    }

    left.splice(index, 1);

    return false;
  });
}

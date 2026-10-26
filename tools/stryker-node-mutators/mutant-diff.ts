import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import { resolveFromCore, type Instrumenter, type InstrumentedMutant } from './install.ts';
import { toNodeMutator, type Operator } from './operator.ts';

export interface MutantDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export function mutantDiff(before: readonly InstrumentedMutant[], after: readonly InstrumentedMutant[]): MutantDiff {
  const beforeLines = before.map(line);
  const afterLines = after.map(line);

  return { added: without(afterLines, beforeLines), removed: without(beforeLines, afterLines) };
}

/**
 * A removed mutant is one that a mutator's filter drops once an operator's mutant shares its scope, as the
 * CallExpression mutator does.
 */
export async function corpusDiff(
  names: readonly string[],
  operatorsFor: (name: string) => readonly Operator[],
  resolve: () => Promise<Instrumenter> = resolveFromCore,
  read: (name: string) => string = (name) => readFileSync(name, 'utf8'),
): Promise<string> {
  const instrumenter = await resolve();
  const sections: string[] = [];

  for (const name of names) {
    const mutators = operatorsFor(name).map((operator) => toNodeMutator(operator, instrumenter.types));
    const files = [{ name, content: read(name) }];
    const before = await instrumenter.instrument(files, instrumenter.allMutators);
    const after = await instrumenter.instrument(files, [...instrumenter.allMutators, ...mutators]);
    const { added, removed } = mutantDiff(before, after);
    const lines = [...added.map((mutant) => `    + ${mutant}`), ...removed.map((mutant) => `    - ${mutant}`)];

    sections.push(
      `### ${relative(process.cwd(), name).split(sep).join('/')}\n\n` +
        `${before.length} mutants without the operators, ${after.length} with them.\n\n` +
        `${lines.length > 0 ? lines.join('\n') : '    (no difference)'}\n`,
    );
  }

  return sections.join('\n');
}

function line({ mutatorName, location, replacement }: InstrumentedMutant): string {
  const { line: row, column } = location.start;

  return `${row + 1}:${column + 1} ${mutatorName} ${replacement.replace(/\s+/g, ' ')}`;
}

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

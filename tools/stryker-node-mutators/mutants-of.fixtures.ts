import { resolveFromCore } from './install.ts';
import { toNodeMutator, type Operator } from './operator.ts';

/**
 * The replacements that `operator` alone makes in the TypeScript module `source`, as Stryker's instrumenter places and
 * prints them, with each run of white space as one space.
 */
export async function mutantsOf(operator: Operator, source: string): Promise<string[]> {
  const instrumenter = await resolveFromCore();
  const mutants = await instrumenter.instrument(
    [{ name: 'sample.ts', content: source }],
    [toNodeMutator(operator, instrumenter.types)],
  );

  return mutants.map(({ replacement }) => replacement.replace(/\s+/g, ' '));
}

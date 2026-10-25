// The one module that reaches into Stryker's internals: no other module of this package names a file of
// @stryker-mutator/instrumenter's dist, which its exports map leaves out.
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Mutant } from '@stryker-mutator/api/core';

import { isOwn, toNodeMutator, type BabelTypes, type NodeMutatorLike, type Operator } from './operator.ts';

/** The instrumenter versions whose internals this module was written against. */
const TESTED_VERSION = /^10\.1\./;
const CORE_BIN = /[\\/]@stryker-mutator[\\/]core[\\/]bin[\\/]stryker\.js$/;
/** Stryker's `// Stryker disable` directives match mutator names with letters only. */
const NAME = /^[A-Za-z]+$/;
const nothing = () => {};
/** The instrumenter's logger, which says nothing, and whose `isDebugEnabled` gives a falsy `undefined`. */
const SILENT = { debug: nothing, info: nothing, warn: nothing, isDebugEnabled: nothing };

export interface SourceFile {
  readonly name: string;
  readonly content: string;
}

export type InstrumentedMutant = Pick<Mutant, 'mutatorName' | 'replacement' | 'location'>;

/** Stryker's instrumenter, as far as this package uses it. */
export interface Instrumenter {
  /** The directory of the @stryker-mutator/instrumenter package. */
  readonly dir: string;
  readonly version: string;
  /** The list that the instrumenter reads its mutators from each time it transforms a file. */
  readonly allMutators: NodeMutatorLike[];
  /** The Babel types of the instrumenter's own @babel/core, to build the nodes it places. */
  readonly types: BabelTypes;
  /** Instruments TypeScript `files` with `mutators`, or with the list in `allMutators` when none are given. */
  instrument(files: readonly SourceFile[], mutators?: readonly NodeMutatorLike[]): Promise<readonly InstrumentedMutant[]>;
}

/** `add` puts the operators next to Stryker's own mutators; `replace` leaves only the operators. */
export type Mode = 'add' | 'replace';

/**
 * Puts `operators` into the mutator list of the instrumenter that Stryker uses, then instruments each operator's
 * sample and throws unless every operator made a mutant: an instrumenter that does not read the list, as a bundled
 * one does not, would otherwise drop the operators without a word. A name that is not letters only, or that another
 * mutator has, throws before the list changes. Installing again adds nothing.
 */
export async function install(
  mode: Mode,
  operators: readonly Operator[],
  resolve: () => Promise<Instrumenter> = resolveFromCore,
  warn: (message: string) => void = console.warn,
): Promise<void> {
  const instrumenter = await resolve();
  const { allMutators } = instrumenter;
  checkNames(operators, allMutators);
  const mutators = operators.map((operator) => toNodeMutator(operator, instrumenter.types));

  if (mode === 'replace') {
    allMutators.splice(0, allMutators.length, ...mutators);
  } else {
    allMutators.push(...mutators.filter((mutator) => !allMutators.some(({ name }) => name === mutator.name)));
  }

  await selfCheck(instrumenter, operators);

  if (!TESTED_VERSION.test(instrumenter.version)) {
    warn(
      `stryker-node-mutators was written for @stryker-mutator/instrumenter 10.1, not ${instrumenter.version}; ` +
        'its install check passed.',
    );
  }
}

function checkNames(operators: readonly Operator[], present: readonly NodeMutatorLike[]): void {
  const names = operators.map(({ name }) => name);
  const invalid = names.filter((name) => !NAME.test(name));

  if (invalid.length > 0) {
    throw new Error(
      `stryker-node-mutators: a mutator name has letters only, as Stryker's directives match no other character: ` +
        invalid.map((name) => JSON.stringify(name)).join(', '),
    );
  }

  const taken = names.filter(
    (name, index) =>
      names.indexOf(name) !== index || present.some((mutator) => mutator.name === name && !isOwn(mutator)),
  );

  if (taken.length > 0) {
    throw new Error(`stryker-node-mutators: another mutator already has the name ${taken.join(', ')}.`);
  }
}

async function selfCheck(instrumenter: Instrumenter, operators: readonly Operator[]): Promise<void> {
  const mutants = await instrumenter.instrument(
    operators.map(({ name, sample }) => ({ name: `${name}.self-check.ts`, content: sample })),
  );
  const made = new Set(mutants.map(({ mutatorName }) => mutatorName));
  const missing = operators.map(({ name }) => name).filter((name) => !made.has(name));

  if (missing.length > 0) {
    throw new Error(
      `stryker-node-mutators: the instrumenter in ${instrumenter.dir} made no mutants of ${missing.join(', ')} from ` +
        'their samples, so it does not read the mutator list this module added to. A bundled instrumenter does that.',
    );
  }
}

/**
 * The package.json of the @stryker-mutator/core that runs this process, from the script that started it when that is
 * core's bin, as when Stryker runs from a global install; otherwise, as when a program uses Stryker's API, the core
 * that this module resolves.
 */
export function corePackageJson(
  argv1: string = process.argv[1],
  realpath: (path: string) => string = realpathSync,
  resolveHere: (specifier: string) => string = createRequire(import.meta.url).resolve,
): string {
  const bin = coreBin(argv1, realpath);

  return bin === undefined ? resolveHere('@stryker-mutator/core/package.json') : join(bin, '..', '..', 'package.json');
}

function coreBin(argv1: string, realpath: (path: string) => string): string | undefined {
  try {
    const bin = realpath(argv1);

    return CORE_BIN.test(bin) ? bin : undefined;
  } catch {
    // `node --eval` and the REPL run no script file.
  }
}

/** Stryker's instrumenter, the copy that the given @stryker-mutator/core imports. */
export async function resolveFromCore(corePackage: string = corePackageJson()): Promise<Instrumenter> {
  const fromCore = createRequire(corePackage);
  const packageJson = fromCore.resolve('@stryker-mutator/instrumenter/package.json');
  const dir = dirname(packageJson);
  const [{ allMutators }, { transformBabel }, { Instrumenter }, { types }] = await Promise.all([
    importFile(join(dir, 'dist', 'src', 'mutators', 'mutate.js')),
    importFile(join(dir, 'dist', 'src', 'transformers', 'babel-transformer.js')),
    importFile(join(dir, 'dist', 'src', 'index.js')),
    importFile(createRequire(packageJson).resolve('@babel/core')),
  ]);

  return {
    dir,
    version: fromCore(packageJson).version,
    allMutators,
    types,
    async instrument(files, mutators) {
      // The instrumenter takes a transform of its own in place of the one that reads `allMutators`.
      const transform =
        mutators &&
        ((ast: unknown, collector: unknown, context: unknown) => transformBabel(ast, collector, context, mutators));
      const { mutants } = await new Instrumenter(SILENT, undefined, undefined, transform).instrument(
        files.map((file) => ({ ...file, mutate: true })),
        {
          plugins: null,
          // Stryker disable next-line ArrayDeclaration: equivalent, as no mutator is named "Stryker was here"
          excludedMutations: [],
          ignorers: [],
        },
      );

      return mutants;
    },
  };
}

function importFile(path: string): Promise<any> {
  return import(pathToFileURL(path).href);
}

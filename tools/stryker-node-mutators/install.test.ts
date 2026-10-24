import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { testEach } from '../test-each/test-each.ts';
import {
  corePackageJson,
  install,
  resolveFromCore,
  type Instrumenter,
  type InstrumentedMutant,
  type SourceFile,
} from './install.ts';
import { isOwn, type BabelTypes, type NodeMutatorLike, type Operator } from './operator.ts';

const LOCATION = { start: { line: 0, column: 0 }, end: { line: 0, column: 1 } };

/** An operator named `name` with a sample of its own name. */
function operator(name: string): Operator {
  return { name, sample: `${name}();`, *mutate() {} };
}

/**
 * A stand-in instrumenter whose list holds Stryker's mutators `builtIns`, which makes one mutant per mutator of this
 * package in its list, except for those named in `silent`, and records the files it instruments and the warnings.
 */
function setup({ builtIns = ['StringLiteral'], silent = [] as string[], version = '10.1.1' } = {}) {
  const allMutators: NodeMutatorLike[] = builtIns.map((name) => ({ name, *mutate() {} }));
  const instrumented: SourceFile[][] = [];
  const warnings: string[] = [];
  const instrumenter: Instrumenter = {
    dir: '/stryker/instrumenter',
    version,
    allMutators,
    types: {} as BabelTypes,
    async instrument(files) {
      instrumented.push([...files]);

      return allMutators
        .filter((mutator) => isOwn(mutator) && !silent.includes(mutator.name))
        .map((mutator): InstrumentedMutant => ({ mutatorName: mutator.name, replacement: '', location: LOCATION }));
    },
  };
  const run = (mode: 'add' | 'replace', operators: Operator[]) =>
    install(mode, operators, async () => instrumenter, (message) => warnings.push(message));
  const names = () => allMutators.map(({ name }) => name);

  return { run, names, instrumented, warnings };
}

describe('install', () => {
  it("adds the operators after Stryker's mutators, and instruments each one's sample", async () => {
    const { run, names, instrumented, warnings } = setup();

    await run('add', [operator('Alpha'), operator('Beta')]);

    assert.deepEqual(names(), ['StringLiteral', 'Alpha', 'Beta']);
    assert.deepEqual(instrumented, [
      [
        { name: 'Alpha.self-check.ts', content: 'Alpha();' },
        { name: 'Beta.self-check.ts', content: 'Beta();' },
      ],
    ]);
    assert.deepEqual(warnings, []);
  });

  it('adds nothing when it installs the same operators again', async () => {
    const { run, names } = setup();

    await run('add', [operator('Alpha')]);
    await run('add', [operator('Alpha'), operator('Beta')]);

    assert.deepEqual(names(), ['StringLiteral', 'Alpha', 'Beta']);
  });

  it("replaces Stryker's mutators, and its own, with the operators", async () => {
    const { run, names } = setup({ builtIns: ['StringLiteral', 'CallExpression'] });

    await run('add', [operator('Alpha')]);
    await run('replace', [operator('Beta'), operator('Gamma')]);
    await run('replace', [operator('Beta'), operator('Gamma')]);

    assert.deepEqual(names(), ['Beta', 'Gamma']);
  });

  it('throws, naming the instrumenter and the operators that made no mutant', async () => {
    const { run } = setup({ silent: ['Alpha', 'Gamma'] });

    await assert.rejects(run('add', [operator('Alpha'), operator('Beta'), operator('Gamma')]), {
      message:
        'stryker-node-mutators: the instrumenter in /stryker/instrumenter made no mutants of Alpha, Gamma from their ' +
        'samples, so it does not read the mutator list this module added to. A bundled instrumenter, or a second ' +
        'copy of it, does that.',
    });
  });

  testEach([
    ["a name of Stryker's", 'add', [operator('StringLiteral')], 'StringLiteral'],
    ["a name of Stryker's, also when it replaces them", 'replace', [operator('StringLiteral')], 'StringLiteral'],
    ['a name twice', 'add', [operator('Alpha'), operator('Beta'), operator('Alpha')], 'Alpha'],
  ] as const)('refuses %s before it changes the list', async (_title, mode, operators, name) => {
    const { run, names, instrumented } = setup();

    await assert.rejects(run(mode, [...operators]), {
      message: `stryker-node-mutators: another mutator already has the name ${name}.`,
    });
    assert.deepEqual([names(), instrumented], [['StringLiteral'], []]);
  });

  testEach(['NodeTimer1', 'Node-Timer', 'Node_Timer', 'Node Timer', ''])(
    'refuses the name %j, as a name has letters only',
    async (name) => {
      const { run, names } = setup();

      await assert.rejects(run('add', [operator('Alpha'), operator(name)]), {
        message:
          "stryker-node-mutators: a mutator name has letters only, as Stryker's directives match no other " +
          `character: ${JSON.stringify(name)}`,
      });
      assert.deepEqual(names(), ['StringLiteral']);
    },
  );

  it('warns about an instrumenter version it was not written for', async () => {
    const { run, warnings } = setup({ version: '10.2.0' });

    await run('add', [operator('Alpha')]);

    assert.deepEqual(warnings, [
      'stryker-node-mutators was written for @stryker-mutator/instrumenter 10.1, not 10.2.0; its install check passed.',
    ]);
  });
});

describe('corePackageJson', () => {
  const CORE = join('/global', 'node_modules', '@stryker-mutator', 'core');
  const HERE = join('/repo', 'node_modules', '@stryker-mutator', 'core', 'package.json');

  /** corePackageJson for a script whose real path is `real`, or which has none when `real` is undefined. */
  function coreFor(real: string | undefined) {
    return corePackageJson(
      '/usr/local/bin/stryker',
      (path) => {
        assert.equal(path, '/usr/local/bin/stryker');

        if (real === undefined) {
          throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
        }

        return real;
      },
      (specifier) => {
        assert.equal(specifier, '@stryker-mutator/core/package.json');

        return HERE;
      },
    );
  }

  it("takes the core whose bin started the process, through the bin's links", () => {
    assert.equal(coreFor(join(CORE, 'bin', 'stryker.js')), join(CORE, 'package.json'));
  });

  testEach([
    ['another script', join('/repo', 'tools', 'corpus-diff.ts')],
    ['a file next to the bin', join(CORE, 'bin', 'stryker.js.map')],
    ["another package's bin", join('/global', 'node_modules', '@stryker-mutator', 'other', 'bin', 'stryker.js')],
    ['no script', undefined],
  ])('takes the core this module resolves when the process runs %s', (_title, real) => {
    assert.equal(coreFor(real), HERE);
  });
});

describe('resolveFromCore', () => {
  it("instruments with Stryker's mutators, or with the mutators given", async () => {
    const instrumenter = await resolveFromCore();
    const files = [{ name: 'sample.ts', content: "f('x');" }];
    const own: NodeMutatorLike = {
      name: 'Own',
      *mutate(path) {
        if (path.isStringLiteral()) {
          yield instrumenter.types.stringLiteral('y');
        }
      },
    };

    const mutants = async (mutators?: NodeMutatorLike[]) =>
      (await instrumenter.instrument(files, mutators)).map(({ mutatorName, replacement }) => [mutatorName, replacement]);

    assert.deepEqual([await mutants(), await mutants([own])], [[['StringLiteral', '""']], [['Own', '"y"']]]);
    assert.ok(instrumenter.allMutators.some(({ name }) => name === 'StringLiteral'));
  });
});

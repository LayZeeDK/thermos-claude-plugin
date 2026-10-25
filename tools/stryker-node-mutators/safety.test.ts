import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NodePath } from '@babel/core';
import type { Location } from '@stryker-mutator/api/core';

import { testEach } from '../test-each/test-each.ts';
import { resolveFromCore } from './install.ts';
import { mutantsOf } from './mutants-of.fixtures.ts';
import { isOwn, toNodeMutator, type Operator } from './operator.ts';
import { productionOperators, testOperators } from './operators.ts';

const OPERATORS = [...productionOperators, ...testOperators];
/** What a replacement may call beyond what the code it replaces calls. */
const ALLOWED: ReadonlySet<string> = new Set(['Error', 'Promise.reject']);
const KEYWORDS: ReadonlySet<string> = new Set(['catch', 'for', 'function', 'if', 'return', 'switch', 'typeof', 'while']);
/** Code that a mutant must never reach further into: a signal to live processes, a removal, a command. */
const TARGETS = [
  'process.kill(pid, 0);',
  "import { rmSync } from 'node:fs';\nrmSync(dir, { recursive: true });",
  "import { spawn } from 'node:child_process';\nspawn(cmd, args, { shell: false });",
];
/** Code with every kind of site the operators mutate, next to the targets. */
const CORPUS = [
  ...OPERATORS.map(({ sample }) => sample),
  ...TARGETS,
  'setTimeout(() => cleanup(), graceMs);',
  "import { setTimeout as sleep } from 'node:timers/promises';\nawait sleep(ms);",
  "child.on('exit', (code) => done(code));\nprocess.once('beforeExit', flush);",
  "import { once } from 'node:events';\nawait once(child, 'close');",
  [
    "import assert from 'node:assert/strict';",
    'assert.equal(compute(), 1);',
    '[1].forEach((n) => assert.ok(check(n)));',
    'await assert.rejects(load());',
    "assert.throws(() => parse(''), /empty/);",
  ].join('\n'),
  "import { it } from 'node:test';\nit('works', (t) => {\n  t.assert.deepEqual(run(), []);\n});",
];

/** The names that `code` calls or constructs, such as `assert.equal` and `Error`. */
function callees(code: string): Set<string> {
  const names = [...code.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)].map(([, name]) => name);

  return new Set(names.filter((name) => !KEYWORDS.has(name)));
}

/** The text of `source` at `location`, whose lines count from 0. */
function textAt(source: string, { start, end }: Location): string {
  const lines = source.split('\n').slice(start.line, end.line + 1);
  lines[lines.length - 1] = lines[lines.length - 1].slice(0, end.column);
  lines[0] = lines[0].slice(start.column);

  return lines.join('\n');
}

/** For each mutant that `operator` makes in `source`, the names its replacement calls that the original does not. */
async function newCallees(operator: Operator, source: string): Promise<string[][]> {
  const instrumenter = await resolveFromCore();
  const mutants = await instrumenter.instrument(
    [{ name: 'sample.ts', content: source }],
    [toNodeMutator(operator, instrumenter.types)],
  );

  return mutants.map(({ location, replacement }) => {
    const before = callees(textAt(source, location));

    return [...callees(replacement)].filter((name) => !before.has(name) && !ALLOWED.has(name));
  });
}

describe('safety', () => {
  testEach(OPERATORS.map((operator) => [operator.name, operator]))(
    '%s calls nothing new in its replacements but Error and Promise.reject',
    async (_name, operator) => {
      const found = await Promise.all(CORPUS.map((source) => newCallees(operator, source)));

      assert.deepEqual(found.flat().flat(), []);
      assert.ok(found.flat().length > 0, `${operator.name} made no mutant in the corpus`);
    },
  );

  testEach([
    [
      'an operator that signals a process',
      'f();',
      (t: Parameters<Operator['mutate']>[1]) =>
        t.expressionStatement(
          t.callExpression(t.memberExpression(t.identifier('process'), t.identifier('kill')), [
            t.memberExpression(t.identifier('process'), t.identifier('pid')),
            t.stringLiteral('SIGKILL'),
          ]),
        ),
      (path: NodePath) => path.isExpressionStatement(),
      [['process.kill']],
    ],
    [
      "the first design of AssertLiveness's arrow body, which fails through node:assert",
      "import assert from 'node:assert/strict';\n[1].forEach((n) => assert.ok(n));",
      (t: Parameters<Operator['mutate']>[1]) =>
        t.callExpression(
          t.memberExpression(
            t.callExpression(t.memberExpression(t.identifier('process'), t.identifier('getBuiltinModule')), [
              t.stringLiteral('node:assert'),
            ]),
            t.identifier('fail'),
          ),
          [t.stringLiteral('Stryker: assertion reached')],
        ),
      (path: NodePath) => path.isCallExpression() && path.parent.type === 'ArrowFunctionExpression',
      [['process.getBuiltinModule', 'fail']],
    ],
  ] as const)('reports %s', async (_title, source, replacement, where, expected) => {
    const unsafe: Operator = {
      name: 'Unsafe',
      sample: '',
      *mutate(path, t) {
        if (where(path)) {
          yield replacement(t);
        }
      },
    };

    assert.deepEqual(await newCallees(unsafe, source), expected);
  });

  testEach(OPERATORS.flatMap((operator) => TARGETS.map((source) => [operator.name, source, operator] as const)))(
    '%s leaves %j alone',
    async (_name, source, operator) => {
      assert.deepEqual(await mutantsOf(operator, source), []);
    },
  );

  it('names each operator with letters only, apart from every other mutator', async () => {
    const instrumenter = await resolveFromCore();
    const names = [
      ...instrumenter.allMutators.filter((mutator) => !isOwn(mutator)).map(({ name }) => name),
      ...OPERATORS.map(({ name }) => name),
    ];

    assert.deepEqual(
      OPERATORS.map(({ name }) => name).filter((name) => !/^[A-Za-z]+$/.test(name)),
      [],
    );
    assert.deepEqual(
      names.filter((name, index) => names.indexOf(name) !== index),
      [],
    );
  });

  testEach(OPERATORS.flatMap((sampled) => OPERATORS.map((operator) => [sampled.name, operator.name, sampled, operator] as const)))(
    "%s's sample gets mutants from %s only when they are the same",
    async (_sampled, _operator, sampled, operator) => {
      assert.equal((await mutantsOf(operator, sampled.sample)).length > 0, sampled === operator);
    },
  );
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NodePath } from '@babel/core';
import type { Location } from '@stryker-mutator/api/core';

import { testEach } from '../test-each/test-each.ts';
import { resolveFromCore } from './install.ts';
import { mutantsOf } from './mutants-of.fixtures.ts';
import { toNodeMutator, type Operator } from './operator.ts';
import { productionOperators, testOperators } from './operators.ts';

const OPERATORS = [...productionOperators, ...testOperators];
const ALLOWED: ReadonlySet<string> = new Set(['Error', 'Promise.reject']);
const KEYWORDS: ReadonlySet<string> = new Set(['catch', 'for', 'function', 'if', 'return', 'switch', 'typeof', 'while']);
const TARGETS = [
  'process.kill(pid, 0);',
  "import { rmSync } from 'node:fs';\nrmSync(dir, { recursive: true });",
  "import { spawn } from 'node:child_process';\nspawn(cmd, args, { shell: false });",
];
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
    'const settled = async () => await assert.rejects(load());',
    "assert.throws(() => parse(''), /empty/);",
  ].join('\n'),
  "import { it } from 'node:test';\nit('works', (t) => {\n  t.assert.deepEqual(run(), []);\n});",
];

function callees(code: string): Set<string> {
  const names = [...code.matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)].map(([, name]) => name);

  return new Set(names.filter((name) => !KEYWORDS.has(name)));
}

function textAt(source: string, { start, end }: Location): string {
  const lines = source.split('\n').slice(start.line, end.line + 1);
  lines[lines.length - 1] = lines[lines.length - 1].slice(0, end.column);
  lines[0] = lines[0].slice(start.column);

  return lines.join('\n');
}

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
      "the first design of AssertCall's arrow body, which fails through node:assert",
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

  testEach(OPERATORS.map((operator) => [operator.name, operator] as const))(
    '%s makes a mutant of its own sample',
    async (_name, operator) => {
      assert.notDeepEqual(await mutantsOf(operator, operator.sample), []);
    },
  );
});

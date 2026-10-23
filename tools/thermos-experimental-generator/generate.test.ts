import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { testEach } from '../test-each/test-each.ts';
import { testFor } from '../test-each/test-for.ts';
import {
  ROOT,
  applyEdits,
  check,
  checkCoverage,
  generate,
  parse,
  renderFrontmatter,
  renderSlice,
  select,
  write,
  type Selection,
  type Upstream,
} from './generate.ts';
import { FILES, OUT_DIRS, SLICED_SOURCES } from './slice-map.ts';

/** An upstream body of `lines` whose first line is line 5 of its file, as after a two-key frontmatter. */
function upstreamOf(...lines: string[]): Upstream {
  return { body: lines, offset: 4 };
}

/** The selection as `[index, drops]` pairs in insertion order. */
function entries(selection: Selection): [number, readonly string[]][] {
  return [...selection];
}

/** Indices taken with no drops. */
function plain(...indices: number[]): [number, string[]][] {
  return indices.map((i) => [i, []]);
}

describe('parse', () => {
  it('returns the body lines after the frontmatter and its blank line, with CRLF normalized', () => {
    const upstream = parse('a.md', '---\r\nname: a\r\ndescription: an a\r\n---\r\n\r\n# A\r\ntext\r\n');

    assert.deepEqual(upstream, { body: ['# A', 'text', ''], offset: 5 });
  });

  it('ends the frontmatter at its first closing line', () => {
    assert.deepEqual(parse('a.md', '---\na: 1\n---\n\nA\n---\n\nB\n').body, ['A', '---', '', 'B', '']);
  });

  testEach(['# A\n', 'x\n---\na: 1\n---\n\nA\n', '---\na: 1\n---\nA\n'])('rejects %j', (text) => {
    assert.throws(() => parse('a.md', text), { message: 'a.md does not start with frontmatter and a blank line' });
  });
});

describe('select', () => {
  const HEADINGS = upstreamOf(
    '# Title', // 0
    'intro', // 1
    '', // 2
    '## A', // 3
    'a text with # inside', // 4
    '#tag', // 5
    '### A1', // 6
    'a1 text', // 7
    '####### seven', // 8
    '## B', // 9
    'b text', // 10
    '# Next', // 11
    'next text', // 12
  );

  testEach([
    ['# Title', plain(0, 1, 3, 4, 5, 6, 7, 8, 9, 10)],
    ['## A', plain(3, 4, 5, 6, 7, 8)],
    ['### A1', plain(6, 7, 8)],
    ['# Next', plain(11, 12)],
  ])('takes the heading %j and its non-blank lines up to the next heading at its level or above', (selector, taken) => {
    assert.deepEqual(entries(select('a.md', HEADINGS, [selector])), taken);
  });

  const LISTS = upstreamOf(
    '- item', // 0
    '  deeper', // 1
    '    deepest', // 2
    '- sibling', // 3
    '  sibling deeper', // 4
    '', // 5
    '  after blank', // 6
    '10. ten', // 7
    '    ten deeper', // 8
    '* star', // 9
    '  - nested', // 10
    '    nested deeper', // 11
    '  nested sibling', // 12
    'plain - not an item', // 13
    '  indented under plain', // 14
  );

  testEach([
    ['- item', plain(0, 1, 2)],
    ['- sibling', plain(3, 4)],
    ['10. ten', plain(7, 8)],
    ['* star', plain(9, 10, 11, 12)],
    ['  - nested', plain(10, 11)],
    ['plain', plain(13)],
  ])('takes the line %j and the lines under it', (selector, taken) => {
    assert.deepEqual(entries(select('a.md', LISTS, [selector])), taken);
  });

  it('takes a heading or list item alone, with its drops, when selected by line', () => {
    const selection = select('a.md', LISTS, [{ line: '- item' }, { line: '* star', drop: ['st', 'r'] }]);

    assert.deepEqual(entries(selection), [
      [0, []],
      [9, ['st', 'r']],
    ]);
    assert.deepEqual(entries(select('a.md', HEADINGS, [{ line: '## A' }])), [[3, []]]);
  });

  it('keeps the order of its selectors', () => {
    assert.deepEqual(entries(select('a.md', LISTS, ['plain', '- item'])), plain(13, 0, 1, 2));
  });

  testEach([
    ['nothing', 'missing', 0],
    ['several', '- ', 2],
  ])('throws when %s matches', (_, selector, count) => {
    assert.throws(() => select('a.md', LISTS, [selector]), {
      message: `a.md: ${count} lines start with ${JSON.stringify(selector)}, not 1`,
    });
    assert.throws(() => select('a.md', LISTS, [{ line: selector }]), { message: /^a\.md: \d+ lines start with/ });
  });

  testEach([
    ['absent', 'x', 0],
    ['repeated', 'e', 3],
  ])('throws when a drop fragment is %s in its line', (_, fragment, count) => {
    assert.throws(() => select('a.md', LISTS, [{ line: '  deeper', drop: [fragment] }]), {
      message: `a.md: ${JSON.stringify(fragment)} occurs ${count} times in line 6, not once`,
    });
  });

  it('throws when two selectors take the same line', () => {
    assert.throws(() => select('a.md', LISTS, ['- item', { line: '    deepest' }]), {
      message: 'a.md: line 7 is taken twice',
    });
  });
});

describe('renderSlice', () => {
  it('writes the lines in upstream order, separated by a blank line where upstream has one, ending in a newline', () => {
    const body = ['', 'a', 'b', '', 'c', '  ', 'd', 'e', 'f', 'g', 'h', ''];
    const selection = new Map([10, 6, 2, 1, 4, 9].map((i) => [i, []]));

    assert.equal(renderSlice(body, selection), 'a\nb\n\nc\n\nd\ng\nh\n');
  });

  it('removes the dropped fragments', () => {
    const selection = new Map([[0, ['quick ', ' lazy']]]);

    assert.equal(renderSlice(['the quick fox and the lazy dog', ''], selection), 'the fox and the dog\n');
  });
});

describe('checkCoverage', () => {
  const UPSTREAM = upstreamOf('a', '', 'b', '  ', 'c drop1 drop2', '');

  /** A slice of `source` that takes each line index with the given drops. */
  function slice(source: string, taken: Record<number, string[]>) {
    return { source, selection: new Map(Object.entries(taken).map(([i, drops]) => [Number(i), drops])) };
  }

  it('accepts slices that together take every non-blank line and keep every fragment', () => {
    assert.doesNotThrow(() =>
      checkCoverage('a.md', UPSTREAM, [
        slice('a.md', { 0: [], 4: ['drop1'] }),
        slice('a.md', { 2: [], 4: ['drop2'] }),
      ]),
    );
    assert.doesNotThrow(() =>
      checkCoverage('a.md', UPSTREAM, [slice('a.md', { 0: [], 2: [], 4: ['drop1', 'drop2'] }), slice('a.md', { 4: [] })]),
    );
  });

  it('names every line no slice of the source takes', () => {
    assert.throws(() => checkCoverage('a.md', UPSTREAM, [slice('a.md', { 2: [] }), slice('b.md', { 0: [], 4: [] })]), {
      message: 'a.md:\nno file takes line 5 "a"\nno file takes line 9 "c drop1 drop2"',
    });
  });

  it('names every fragment that all slices taking its line drop', () => {
    assert.throws(
      () =>
        checkCoverage('a.md', UPSTREAM, [
          slice('a.md', { 0: [], 2: [], 4: ['drop1', 'drop2'] }),
          slice('a.md', { 4: ['drop2', 'drop1'] }),
        ]),
      { message: 'a.md:\nno file keeps "drop1" of line 9 "c drop1 drop2"\nno file keeps "drop2" of line 9 "c drop1 drop2"' },
    );
  });
});

describe('applyEdits', () => {
  const TEXT = 'one\ntwo $\nthree\n';

  testEach([
    [[{ from: 'two', to: 'TWO $&' }], 'one\nTWO $& $\nthree\n'],
    [[{ from: 'e\nt', to: '' }], 'onwo $\nthree\n'],
    [[{ line: 'tw', to: ['2a', '2b'] }], 'one\n2a\n2b\nthree\n'],
    [[{ line: 'two', to: [] }], 'one\nthree\n'],
    [[{ after: 'one', insert: ['1a', '1b'] }], 'one\n1a\n1b\ntwo $\nthree\n'],
    [
      [
        { from: 'three', to: 'four' },
        { line: 'four', to: ['five'] },
        { after: 'five', insert: ['six'] },
      ],
      'one\ntwo $\nfive\nsix\n',
    ],
  ])('applies %j', (edits, expected) => {
    assert.equal(applyEdits('a.md', TEXT, edits), expected);
  });

  testEach([
    [{ from: 'four', to: '' }, 'a.md: "four" occurs 0 times, not once'],
    [{ from: 't', to: '' }, 'a.md: "t" occurs 2 times, not once'],
    [{ line: 'four', to: [] }, 'a.md: 0 lines start with "four", not 1'],
    [{ after: 't', insert: [] }, 'a.md: 2 lines start with "t", not 1'],
  ])('rejects %j', (edit, message) => {
    assert.throws(() => applyEdits('a.md', TEXT, [edit]), { message });
  });
});

describe('renderFrontmatter', () => {
  it('writes each key in order, strings and booleans as JSON and lists as unquoted items, then a blank line', () => {
    assert.equal(
      renderFrontmatter({ name: 'a', description: 'say "hi": now', hidden: false, skills: ['p:x', 'p:y'], color: 'red' }),
      '---\nname: "a"\ndescription: "say \\"hi\\": now"\nhidden: false\nskills:\n  - p:x\n  - p:y\ncolor: "red"\n---\n\n',
    );
  });
});

describe('generate', () => {
  /** Reads repository files, appending a line to `extended`. */
  function readWithExtraLine(extended: string) {
    return (path: string) => readFileSync(join(ROOT, path), 'utf8') + (path === extended ? 'An extra upstream line.\n' : '');
  }

  it('generates one file per slice map entry', () => {
    const files = generate((path) => readFileSync(join(ROOT, path), 'utf8'));

    assert.deepEqual([...files.keys()], FILES.map((file) => file.path));
  });

  testEach(SLICED_SOURCES)('requires every line of %s to be taken', (source) => {
    const lines = readFileSync(join(ROOT, source), 'utf8').replaceAll('\r\n', '\n').split('\n').length;

    assert.throws(() => generate(readWithExtraLine(source)), {
      message: `${source}:\nno file takes line ${lines} "An extra upstream line."`,
    });
  });

  it('matches the committed files, with no extra files beside them', () => {
    assert.ok(isAbsolute(ROOT));
    assert.ok(existsSync(join(ROOT, 'plugins', 'thermos', 'skills')));
    assert.deepEqual(check(ROOT), []);
  });
});

const GENERATOR = join('tools', 'thermos-experimental-generator');
const PLUGIN = join('plugins', 'thermos-experimental');
const FIRST = FILES[0].path;

/**
 * Creates a throwaway repository, removed after the test, holding a copy of the upstream plugin, of this generator
 * with a module-type package.json, and of the plugin's hand-written files. A sibling link points at it through a
 * junction (Windows) or symlink.
 */
function setup(t: TestContext) {
  const parent = mkdtempSync(join(tmpdir(), 'thermos-experimental-generator-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'repo');
  const link = join(parent, 'link');
  cpSync(join(ROOT, 'plugins', 'thermos'), join(root, 'plugins', 'thermos'), { recursive: true });

  for (const file of ['generate.ts', 'slice-map.ts']) {
    cpSync(join(import.meta.dirname, file), join(root, GENERATOR, file));
  }

  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
  mkdirSync(join(root, PLUGIN, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, PLUGIN, '.claude-plugin', 'plugin.json'), '{}\n');
  writeFileSync(join(root, PLUGIN, 'README.md'), '# Hand-written\n');
  symlinkSync(root, link, 'junction');

  return { root, link, script: join(root, GENERATOR, 'generate.ts') };
}

/** Writes `content` to `path` under `root`, creating its directory. */
function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

describe('write and check', () => {
  it('reports every generated file as missing before the first write', (t) => {
    const { root } = setup(t);

    assert.deepEqual(
      check(root),
      FILES.map((file) => `missing: ${file.path}`),
    );
  });

  it('writes the generated files, replaces stale ones, and leaves the hand-written files alone', (t) => {
    const { root } = setup(t);
    put(root, join(PLUGIN, 'skills', 'removed-lens', 'SKILL.md'), 'stale\n');
    put(root, join(PLUGIN, 'agents', 'removed-lens.md'), 'stale\n');

    write(root);

    for (const [path, content] of generate((p) => readFileSync(join(root, p), 'utf8'))) {
      assert.equal(readFileSync(join(root, path), 'utf8'), content);
    }

    assert.ok(!existsSync(join(root, PLUGIN, 'skills', 'removed-lens')));
    assert.ok(!existsSync(join(root, PLUGIN, 'agents', 'removed-lens.md')));
    assert.equal(readFileSync(join(root, PLUGIN, 'README.md'), 'utf8'), '# Hand-written\n');
    assert.deepEqual(check(root), []);
  });

  it('accepts committed files with CRLF line endings and ignores empty directories', (t) => {
    const { root } = setup(t);
    write(root);
    put(root, FIRST, readFileSync(join(root, FIRST), 'utf8').replaceAll('\n', '\r\n'));

    for (const dir of OUT_DIRS) {
      mkdirSync(join(root, dir, 'empty', 'nested'), { recursive: true });
    }

    assert.deepEqual(check(root), []);
  });

  it('names changed, missing and extra files', (t) => {
    const { root } = setup(t);
    write(root);
    put(root, FIRST, 'changed\n');
    rmSync(join(root, FILES[1].path));
    put(root, join(PLUGIN, 'skills', 'old', 'deep', 'SKILL.md'), 'extra\n');
    put(root, join(PLUGIN, 'agents', 'old.md'), 'extra\n');

    assert.deepEqual(check(root), [
      `differs: ${FIRST}`,
      `missing: ${FILES[1].path}`,
      `extra: ${join(PLUGIN, 'skills', 'old', 'deep', 'SKILL.md')}`,
      `extra: ${join(PLUGIN, 'agents', 'old.md')}`,
    ]);
  });
});

describe('command line', () => {
  /** Runs a script with Node.js from the temporary directory, outside the repository. */
  function runNode(scriptPath: string, ...args: string[]) {
    return spawnSync(process.execPath, [scriptPath, ...args], { cwd: tmpdir(), encoding: 'utf8', windowsHide: true });
  }

  testFor([
    { started: 'directly', path: ({ script }: ReturnType<typeof setup>) => script },
    {
      started: 'through a junction or symlink',
      path: ({ root, link, script }: ReturnType<typeof setup>) => join(link, relative(root, script)),
    },
  ])('generates into the repository it sits in, then --check passes, started $started', ({ path }, t) => {
    const repository = setup(t);

    const generated = runNode(path(repository));
    const checked = runNode(path(repository), '--check');

    assert.deepEqual([generated.status, generated.stdout, generated.stderr], [0, '', '']);
    assert.deepEqual([checked.status, checked.stdout, checked.stderr], [0, '', '']);
    assert.deepEqual(check(repository.root), []);
  });

  it('--check names each difference, writes nothing, and exits 1', (t) => {
    const { root, script } = setup(t);
    runNode(script);
    put(root, FIRST, 'changed\n');

    const result = runNode(script, '--check');

    assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', `differs: ${FIRST}\n`]);
    assert.equal(readFileSync(join(root, FIRST), 'utf8'), 'changed\n');
  });

  it('exits non-zero with the error on stderr when the slice map does not apply', (t) => {
    const { root, script } = setup(t);
    put(root, SLICED_SOURCES[0], `${readFileSync(join(root, SLICED_SOURCES[0]), 'utf8')}An extra upstream line.\n`);

    const result = runNode(script);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no file takes line \d+ "An extra upstream line\."/);
    assert.ok(!existsSync(join(root, OUT_DIRS[0])));
  });

  it('does nothing when another script imports it', (t) => {
    const { root, script } = setup(t);
    const importer = join(root, 'importer.ts');
    writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(script).href)});\n`);

    const result = runNode(importer, '--check');

    assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
    assert.ok(!existsSync(join(root, OUT_DIRS[0])));
  });
});

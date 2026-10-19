import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { after, before, describe, it, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

import { testEach } from '../../../tools/test-each/test-each.ts';
import {
  MANIFEST_PATH,
  advanceBaseline,
  basedOnLine,
  git,
  readUpstream,
  withUpstream,
  type Git,
  type Upstream,
} from './advance-baseline.ts';

const COMMIT = '182f2ce414e83224915c190d2f63239c1608d0a5';

const UPSTREAM: Upstream = { version: '1.2.0', commit: COMMIT };

/** Manifest text in the repository's format, with an older baseline. */
const MANIFEST = `{
  "name": "thermos",
  "version": "1.1.0",
  "keywords": [
    "thermos"
  ],
  "metadata": {
    "upstream": {
      "version": "1.0.0",
      "commit": "0452e08a314c03621ec5ac1324f1ad1dd824f1a4"
    }
  }
}
`;

/**
 * Returns a fake `git` that answers the two calls `readUpstream` makes and throws on any other call.
 *
 * @param pluginJson Output of `git show cursor/main:thermos/.cursor-plugin/plugin.json`.
 * @param commit Output of `git rev-parse cursor/main`.
 */
function fakeGit(pluginJson: string, commit: string = COMMIT): Git {
  const answers: Record<string, string> = {
    'rev-parse cursor/main': commit,
    'show cursor/main:thermos/.cursor-plugin/plugin.json': pluginJson,
  };

  return (...args) => {
    const call = args.join(' ');

    if (!(call in answers)) {
      throw new Error(`unexpected git ${call}`);
    }

    return answers[call];
  };
}

/** Reads the `metadata.upstream` of a plugin manifest file. */
function upstreamIn(manifestPath: string): unknown {
  return (JSON.parse(readFileSync(manifestPath, 'utf8')) as { metadata: { upstream: unknown } }).metadata.upstream;
}

describe('repository location', () => {
  it('points MANIFEST_PATH at the committed plugin manifest as an absolute path', () => {
    assert.ok(isAbsolute(MANIFEST_PATH));
    assert.ok(existsSync(MANIFEST_PATH));
  });

  it('runs git in the repository that contains it, from any working directory, and trims its output', (t) => {
    const previous = process.cwd();
    const elsewhere = mkdtempSync(join(tmpdir(), 'advance-baseline-cwd-'));
    t.after(() => {
      process.chdir(previous);
      rmSync(elsewhere, { recursive: true, force: true });
    });
    process.chdir(elsewhere);

    const topLevel = git('rev-parse', '--show-toplevel');

    assert.equal(topLevel, topLevel.trim());
    // The repository root contains this directory: they are equal in a checkout, and the root is an ancestor
    // when the tests run in a copy inside the repository, such as a Stryker sandbox.
    const fromRoot = relative(realpathSync.native(topLevel), realpathSync.native(import.meta.dirname));
    assert.ok(!fromRoot.startsWith('..') && !isAbsolute(fromRoot), `${import.meta.dirname} is outside ${topLevel}`);
  });
});

describe('readUpstream', () => {
  it('reads the commit of cursor/main and the version of its Cursor manifest', () => {
    assert.deepEqual(readUpstream(fakeGit('{"name":"thermos","version":"1.2.0"}')), UPSTREAM);
  });

  testEach([`${COMMIT}\n`, `x${COMMIT}`, COMMIT.slice(0, 7), 'cursor/main'])('rejects %j as the commit', (commit) => {
    assert.throws(() => readUpstream(fakeGit('{"version":"1.2.0"}', commit)), /not a commit SHA/);
  });

  testEach(['{"name":"thermos"}', '{"version":""}', '{"version":1}'])('rejects the upstream manifest %s', (json) => {
    assert.throws(() => readUpstream(fakeGit(json)), /has no version/);
  });
});

describe('withUpstream', () => {
  it('changes only the upstream version and commit lines', () => {
    const before = MANIFEST.split('\n');
    const after = withUpstream(MANIFEST, UPSTREAM).split('\n');
    const changed = after.filter((line, i) => line !== before[i]);

    assert.equal(after.length, before.length);
    assert.deepEqual(changed, ['      "version": "1.2.0",', `      "commit": "${COMMIT}"`]);
  });

  it('is unchanged when the baseline is already current', () => {
    const current = withUpstream(MANIFEST, UPSTREAM);

    assert.equal(withUpstream(current, UPSTREAM), current);
  });

  it('finds the committed plugin.json already in the format it writes', () => {
    // A CRLF checkout differs only in line endings, which git normalizes; the script writes LF.
    const committed = readFileSync(MANIFEST_PATH, 'utf8').replaceAll('\r\n', '\n');
    const current = (JSON.parse(committed) as { metadata: { upstream: Upstream } }).metadata.upstream;

    assert.equal(withUpstream(committed, current), committed);
  });

  testEach(['{"name":"thermos"}', '{"metadata":null}', '{"metadata":[]}'])('rejects the manifest %s', (text) => {
    assert.throws(() => withUpstream(text, UPSTREAM), /no metadata object/);
  });
});

describe('basedOnLine', () => {
  it('names the version, the short commit, and a link to the full commit', () => {
    assert.equal(
      basedOnLine(UPSTREAM),
      `Based on Cursor Thermos 1.2.0 @ [\`182f2ce\`](https://github.com/cursor/plugins/tree/${COMMIT}/thermos).`,
    );
  });
});

describe('advanceBaseline', () => {
  /** Writes `MANIFEST` to a temporary plugin.json that is removed after the test, and returns its path. */
  function tempManifest(t: TestContext): string {
    const dir = mkdtempSync(join(tmpdir(), 'advance-baseline-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const manifestPath = join(dir, 'plugin.json');
    writeFileSync(manifestPath, MANIFEST);

    return manifestPath;
  }

  it('writes the new baseline to the manifest and returns the CHANGELOG line', (t) => {
    const manifestPath = tempManifest(t);

    const line = advanceBaseline(fakeGit('{"version":"1.2.0"}'), manifestPath);

    assert.equal(line, basedOnLine(UPSTREAM));
    assert.deepEqual(upstreamIn(manifestPath), UPSTREAM);
  });

  it('leaves the manifest untouched when upstream is invalid', (t) => {
    const manifestPath = tempManifest(t);

    assert.throws(() => advanceBaseline(fakeGit('{"version":""}'), manifestPath), /has no version/);
    assert.equal(readFileSync(manifestPath, 'utf8'), MANIFEST);
  });
});

describe('command line', () => {
  const SCRIPT = join('.claude', 'skills', 'sync-from-cursor', 'advance-baseline.ts');
  const MANIFEST_IN_REPO = join('plugins', 'thermos', '.claude-plugin', 'plugin.json');

  /**
   * A throwaway repository laid out like this one: an upstream commit at `cursor/main`, a copy of the script, a
   * module-type package.json, and a plugin manifest with an older baseline. A sibling link points at the
   * repository through a junction (Windows) or symlink.
   */
  interface Fixture {
    root: string;
    link: string;
    script: string;
    manifestPath: string;
  }

  let template: string;
  let upstream: Upstream;

  before(() => {
    template = mkdtempSync(join(tmpdir(), 'advance-baseline-template-'));
    const upstreamManifest = join(template, 'thermos', '.cursor-plugin', 'plugin.json');
    const run: Git = (...args) =>
      execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], {
        cwd: template,
        encoding: 'utf8',
      }).trim();

    for (const file of [upstreamManifest, join(template, SCRIPT), join(template, MANIFEST_IN_REPO)]) {
      mkdirSync(dirname(file), { recursive: true });
    }

    run('init', '-q');
    writeFileSync(upstreamManifest, '{"name":"thermos","version":"1.2.0"}\n');
    run('add', 'thermos');
    run('commit', '-q', '-m', 'upstream');
    const commit = run('rev-parse', 'HEAD');
    run('update-ref', 'refs/remotes/cursor/main', commit);
    copyFileSync(join(import.meta.dirname, 'advance-baseline.ts'), join(template, SCRIPT));
    writeFileSync(join(template, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(join(template, MANIFEST_IN_REPO), MANIFEST);
    upstream = { version: '1.2.0', commit };
  });

  after(() => rmSync(template, { recursive: true, force: true }));

  /** Copies the template repository into a fixture that is removed after the test. */
  function fixture(t: TestContext): Fixture {
    const parent = mkdtempSync(join(tmpdir(), 'advance-baseline-repo-'));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const root = join(parent, 'repo');
    const link = join(parent, 'link');
    cpSync(template, root, { recursive: true });
    symlinkSync(root, link, 'junction');

    return { root, link, script: join(root, SCRIPT), manifestPath: join(root, MANIFEST_IN_REPO) };
  }

  /** Runs a script with Node.js from the temporary directory, outside any repository. */
  function runNode(scriptPath: string) {
    return spawnSync(process.execPath, [scriptPath], { cwd: tmpdir(), encoding: 'utf8' });
  }

  it('advances the baseline of the repository it sits in and prints the CHANGELOG line', (t) => {
    const { script, manifestPath } = fixture(t);

    const result = runNode(script);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${basedOnLine(upstream)}\n`);
    assert.equal(result.stderr, '');
    assert.deepEqual(upstreamIn(manifestPath), upstream);
  });

  it('does the same when started through a junction or symlink', (t) => {
    const { root, link, script, manifestPath } = fixture(t);

    const result = runNode(join(link, relative(root, script)));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${basedOnLine(upstream)}\n`);
    assert.deepEqual(upstreamIn(manifestPath), upstream);
  });

  it('does nothing when another script imports it', (t) => {
    const { root, script, manifestPath } = fixture(t);
    const importer = join(root, 'importer.ts');
    writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(script).href)});\n`);

    const result = runNode(importer);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(readFileSync(manifestPath, 'utf8'), MANIFEST);
  });
});

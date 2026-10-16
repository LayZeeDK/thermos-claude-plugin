// Advances the upstream baseline in plugins/thermos/.claude-plugin/plugin.json to cursor/main
// and prints the "Based on Cursor Thermos ..." line for the next CHANGELOG entry.
// Run it from any directory after `git fetch cursor`; it finds the repository from its own location.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Absolute path of the plugin manifest, found from this script's place in `.claude/skills/sync-from-cursor/`. */
export const MANIFEST_PATH = join(import.meta.dirname, '..', '..', '..', 'plugins', 'thermos', '.claude-plugin', 'plugin.json');

/** The upstream Cursor Thermos release that the port is based on. */
export interface Upstream {
  /** Version from upstream's `.cursor-plugin/plugin.json`. */
  version: string;
  /** Full commit SHA in `cursor/plugins`. */
  commit: string;
}

/** Runs `git` with the given arguments and returns its trimmed standard output. */
export type Git = (...args: string[]) => string;

/** The real `git`, run from this script's directory so it acts on this repository from any working directory. */
export const git: Git = (...args) => execFileSync('git', args, { cwd: import.meta.dirname, encoding: 'utf8' }).trim();

/** Reads the commit of `cursor/main` and the version in its Cursor plugin manifest. */
export function readUpstream(run: Git): Upstream {
  const commit = run('rev-parse', 'cursor/main');

  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`git rev-parse cursor/main returned ${JSON.stringify(commit)}, not a commit SHA`);
  }

  const { version } = JSON.parse(run('show', 'cursor/main:thermos/.cursor-plugin/plugin.json')) as { version?: unknown };

  if (typeof version !== 'string' || version === '') {
    throw new Error('upstream plugin.json at cursor/main has no version');
  }

  return { version, commit };
}

/** Returns the manifest text with `metadata.upstream` set to `upstream`, written as 2-space JSON with a trailing newline. */
export function withUpstream(manifestText: string, upstream: Upstream): string {
  const manifest = JSON.parse(manifestText) as { metadata?: unknown };
  const { metadata } = manifest;

  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new Error('plugin.json has no metadata object');
  }

  (metadata as { upstream?: Upstream }).upstream = upstream;

  return JSON.stringify(manifest, null, 2) + '\n';
}

/** Formats the CHANGELOG line that names the upstream release. */
export function basedOnLine(upstream: Upstream): string {
  return `Based on Cursor Thermos ${upstream.version} @ [\`${upstream.commit.slice(0, 7)}\`](https://github.com/cursor/plugins/tree/${upstream.commit}/thermos).`;
}

/** Updates the manifest at `manifestPath` and returns the CHANGELOG line. */
export function advanceBaseline(run: Git, manifestPath: string = MANIFEST_PATH): string {
  const upstream = readUpstream(run);
  writeFileSync(manifestPath, withUpstream(readFileSync(manifestPath, 'utf8'), upstream));

  return basedOnLine(upstream);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  console.log(advanceBaseline(git));
}

// Generates plugins/thermos-experimental/{skills,agents} from the upstream Thermos files that slice-map.ts names.
// `node tools/thermos-experimental-generator/generate.ts` rewrites them; `--check` only reports what differs.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FILES, SLICED_SOURCES, type Edit, type FrontmatterValue, type Selector } from './slice-map.ts';

/** Absolute path of the repository root, found from this script's place in `tools/thermos-experimental-generator/`. */
export const ROOT = join(import.meta.dirname, '..', '..');

/** The directories the generator owns; every file in them comes from the slice map. */
export const OUT_DIRS: readonly string[] = ['plugins/thermos-experimental/skills', 'plugins/thermos-experimental/agents'];

/** An upstream file without its frontmatter: `body[i]` is line `offset + i + 1` of the file. */
export interface Upstream {
  readonly body: readonly string[];
  readonly offset: number;
}

/** The lines one sliced file takes: body line index -> the fragments removed from that line. */
export type Selection = ReadonlyMap<number, readonly string[]>;

const HEADING = /^(#{1,6}) /;
const LIST_ITEM = /^(\s*)(?:[-*]|\d+\.) /;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** Splits a file into its body lines, after normalizing CRLF and removing the frontmatter and the blank line after it. */
export function parse(path: string, text: string): Upstream {
  const normalized = text.replaceAll('\r\n', '\n');
  const frontmatter = /^---\n[\s\S]*?\n---\n\n/.exec(normalized)?.[0];

  if (frontmatter === undefined) {
    throw new Error(`${path} does not start with frontmatter and a blank line`);
  }

  return { body: normalized.slice(frontmatter.length).split('\n'), offset: frontmatter.split('\n').length - 1 };
}

/** Index of the one line that starts with `prefix`. */
function findLine(lines: readonly string[], prefix: string, source: string): number {
  const matches = lines.flatMap((line, i) => (line.startsWith(prefix) ? [i] : []));

  if (matches.length !== 1) {
    throw new Error(`${source}: ${matches.length} lines start with ${JSON.stringify(prefix)}, not 1`);
  }

  return matches[0];
}

/** Indices of line `i` and the non-blank lines under it: a heading's section, or a list item's deeper lines. */
function under(body: readonly string[], i: number): number[] {
  const heading = HEADING.exec(body[i]);
  const item = LIST_ITEM.exec(body[i]);
  const taken = [i];

  for (let j = i + 1; j < body.length; j++) {
    const line = body[j];

    if (heading) {
      const next = HEADING.exec(line);

      if (next && next[1].length <= heading[1].length) {
        break;
      }

      if (!isBlank(line)) {
        taken.push(j);
      }
    } else if (item && !isBlank(line) && line.length - line.trimStart().length > item[1].length) {
      taken.push(j);
    } else {
      break;
    }
  }

  return taken;
}

/** The lines that `take` selects from `upstream`, the upstream file at `source`. */
export function select(source: string, upstream: Upstream, take: readonly Selector[]): Selection {
  const { body, offset } = upstream;
  const selection = new Map<number, readonly string[]>();

  for (const selector of take) {
    const entries: [number, readonly string[]][] =
      typeof selector === 'string'
        ? under(body, findLine(body, selector, source)).map((i) => [i, []])
        : [[findLine(body, selector.line, source), selector.drop ?? []]];

    for (const [i, drops] of entries) {
      for (const fragment of drops) {
        const count = body[i].split(fragment).length - 1;

        if (count !== 1) {
          throw new Error(`${source}: ${JSON.stringify(fragment)} occurs ${count} times in line ${offset + i + 1}, not once`);
        }
      }

      if (selection.has(i)) {
        throw new Error(`${source}: line ${offset + i + 1} is taken twice`);
      }

      selection.set(i, drops);
    }
  }

  return selection;
}

/** Writes the selected lines in upstream order, with a blank line where upstream has one between them. */
export function renderSlice(body: readonly string[], selection: Selection): string {
  const indices = [...selection.keys()].sort((a, b) => a - b);
  const lines = indices.map((i, k) => {
    const text = selection.get(i)!.reduce((line, fragment) => line.replace(fragment, ''), body[i]);
    const gap = k > 0 && body.slice(indices[k - 1] + 1, i).some(isBlank) ? '\n' : '';

    return gap + text;
  });

  return `${lines.join('\n')}\n`;
}

/**
 * Throws unless the slices of `source` together take every non-blank line of it and, for each line that every slice
 * takes with drops, some slice keeps each fragment. `slices` may include slices of other sources; they are ignored.
 */
export function checkCoverage(
  source: string,
  upstream: Upstream,
  slices: readonly { readonly source: string; readonly selection: Selection }[],
): void {
  const selections = slices.filter((slice) => slice.source === source).map((slice) => slice.selection);
  const problems = upstream.body.flatMap((line, i) => {
    if (isBlank(line)) {
      return [];
    }

    const where = `line ${upstream.offset + i + 1} ${JSON.stringify(line)}`;
    const drops = selections.map((selection) => selection.get(i)).filter((d) => d !== undefined);

    if (drops.length === 0) {
      return [`no file takes ${where}`];
    }

    return drops[0]
      .filter((fragment) => drops.every((d) => d.includes(fragment)))
      .map((fragment) => `no file keeps ${JSON.stringify(fragment)} of ${where}`);
  });

  if (problems.length > 0) {
    throw new Error(`${source}:\n${problems.join('\n')}`);
  }
}

/** Applies `edits` in order to `text`, the body of the upstream file at `source`. */
export function applyEdits(source: string, text: string, edits: readonly Edit[]): string {
  return edits.reduce((current, edit) => {
    if ('from' in edit) {
      const parts = current.split(edit.from);

      if (parts.length !== 2) {
        throw new Error(`${source}: ${JSON.stringify(edit.from)} occurs ${parts.length - 1} times, not once`);
      }

      return parts.join(edit.to);
    }

    const lines = current.split('\n');

    if ('after' in edit) {
      lines.splice(findLine(lines, edit.after, source) + 1, 0, ...edit.insert);
    } else {
      lines.splice(findLine(lines, edit.line, source), 1, ...edit.to);
    }

    return lines.join('\n');
  }, text);
}

/** Writes frontmatter in object order: strings and booleans as JSON, string arrays as unquoted YAML lists. */
export function renderFrontmatter(frontmatter: Readonly<Record<string, FrontmatterValue>>): string {
  const lines = Object.entries(frontmatter).flatMap(([key, value]) =>
    typeof value === 'object' ? [`${key}:`, ...value.map((item) => `  - ${item}`)] : [`${key}: ${JSON.stringify(value)}`],
  );

  return ['---', ...lines, '---', '', ''].join('\n');
}

/** Generates every file of the slice map from upstream files read by `read`: output path -> content. */
export function generate(read: (path: string) => string): Map<string, string> {
  const upstream = (path: string) => parse(path, read(path));
  const slices = FILES.flatMap((file) =>
    'take' in file ? [{ path: file.path, source: file.source, selection: select(file.source, upstream(file.source), file.take) }] : [],
  );

  for (const source of SLICED_SOURCES) {
    checkCoverage(source, upstream(source), slices);
  }

  return new Map(
    FILES.map((file) => {
      const { body } = upstream(file.source);
      const content =
        'take' in file
          ? renderSlice(body, slices.find((slice) => slice.path === file.path)!.selection)
          : applyEdits(file.source, body.join('\n'), file.edits);

      return [file.path, renderFrontmatter(file.frontmatter) + content];
    }),
  );
}

function generateIn(root: string): Map<string, string> {
  return generate((path) => readFileSync(join(root, path), 'utf8'));
}

/** Replaces the generated directories under `root` with freshly generated files. */
export function write(root: string): void {
  const files = generateIn(root);

  for (const dir of OUT_DIRS) {
    rmSync(join(root, dir), { recursive: true, force: true });
  }

  for (const [path, content] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** Names each generated file under `root` that differs or is missing, and each extra file in the generated directories. */
export function check(root: string): string[] {
  const files = generateIn(root);
  const expected = new Set([...files.keys()].map((path) => join(root, path)));
  const extra = OUT_DIRS.flatMap((dir) =>
    existsSync(join(root, dir))
      ? readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && !expected.has(join(entry.parentPath, entry.name)))
          .map((entry) => `extra: ${relative(root, join(entry.parentPath, entry.name))}`)
      : [],
  );
  const stale = [...files].flatMap(([path, content]) => {
    if (!existsSync(join(root, path))) {
      return [`missing: ${path}`];
    }

    return readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n') === content ? [] : [`differs: ${path}`];
  });

  return [...stale, ...extra];
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv.includes('--check')) {
    const problems = check(ROOT);

    for (const problem of problems) {
      console.error(problem);
    }

    process.exitCode = problems.length === 0 ? 0 : 1;
  } else {
    write(ROOT);
  }
}

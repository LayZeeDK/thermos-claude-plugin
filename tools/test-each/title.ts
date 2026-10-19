// The titles of testEach and testFor tests, in Vitest's format. A `$` path also takes `[index]` brackets, as in
// `$a[0]`, beyond Vitest's paths of names and `.`.
import { inspect } from 'node:util';

/** The length past which a value in a title is cut short, as Vitest's default `taskTitleValueFormatTruncate`. */
const LIMIT = 40;

/** A printf placeholder, kept by `split` so the parts alternate between text and placeholder. */
const PLACEHOLDER = /(%[sdifjoOc%#$])/;

/** A `$` path into the case: names, `.` and `[index]`. */
const ATTRIBUTE = /\$((?:[$\p{ID_Continue}.]|\[\d+\])+)/gu;

/** The name a test of the table starts from: a string as is, a function by its name, anything else as a string. */
export function formatName(name: unknown): string {
  if (typeof name === 'function') {
    return name.name || '<anonymous>';
  }

  return String(name);
}

/**
 * Names the test of the case at `index`, whose values are `items`, after `template`. Each printf placeholder takes
 * the next value, `%#` and `%$` give the 0-based and 1-based index, `%%` gives `%`, and the text between
 * placeholders reads `$` paths from the case.
 */
export function formatTitle(template: string, items: readonly unknown[], index: number): string {
  let next = 0;

  return template
    .split(PLACEHOLDER)
    .map((part, i) => {
      if (i % 2 === 0) {
        return interpolate(part, items);
      }

      switch (part) {
        case '%%': {
          return '%';
        }
        case '%#': {
          return String(index);
        }
        case '%$': {
          return String(index + 1);
        }
        default: {
          return format(part, items[next++]);
        }
      }
    })
    .join('');
}

function format(placeholder: string, value: unknown): string {
  switch (placeholder) {
    case '%s': {
      return string(value);
    }
    case '%d': {
      return typeof value === 'bigint' ? `${value}n` : typeof value === 'symbol' ? 'NaN' : String(Number(value));
    }
    case '%i': {
      return typeof value === 'bigint' ? `${value}n` : String(Number.parseInt(String(value)));
    }
    case '%f': {
      return `${negative(value) ? '-' : ''}${Number.parseFloat(String(value))}`;
    }
    case '%j': {
      return json(value);
    }
    case '%c': {
      return '';
    }
    default: {
      return render(value);
    }
  }
}

function string(value: unknown): string {
  if (typeof value === 'bigint') {
    return `${value}n`;
  }

  if (Object.is(value, -0)) {
    return '-0';
  }

  if (typeof value === 'object' && value !== null) {
    const { toString } = value as { toString?: unknown };

    return typeof toString === 'function' && toString !== Object.prototype.toString
      ? String(toString.call(value))
      : render(value);
  }

  return String(value);
}

/** Whether `value` is `-0` or a NaN with its sign bit set, which `parseFloat` would print without the sign. */
function negative(value: unknown): boolean {
  return (
    (value === 0 || Number.isNaN(value)) && new Uint32Array(new Float64Array([value as number]).buffer)[1] >>> 31 === 1
  );
}

function json(value: unknown): string {
  try {
    return String(JSON.stringify(value));
  } catch (error) {
    if ((error as Error).message.includes('circular structure')) {
      return '[Circular]';
    }

    throw error;
  }
}

/** Renders `value` on one line, cut short past the limit; a string keeps its closing quote. */
function render(value: unknown): string {
  const text = inspect(value, { breakLength: Infinity, compact: true });
  const cut = truncate(text);

  return typeof value === 'string' && cut !== text ? `${cut}${text.at(-1)}` : cut;
}

/** Cuts `text` short past the limit, before a character that the cut would split in two, as Vitest does. */
function truncate(text: string): string {
  if (text.length <= LIMIT) {
    return text;
  }

  const end = LIMIT - 1;
  const last = text.charCodeAt(end - 1);
  const highSurrogate = last >= 0xd800 && last <= 0xdbff;

  return `${text.slice(0, highSurrogate ? end - 1 : end)}…`;
}

/**
 * Replaces each `$` path in `text`. A path reads from the first item when it is an object, and an index path such as
 * `$1` reads from the items when the first item has no such property. A string value appears without quotes.
 */
function interpolate(text: string, items: readonly unknown[]): string {
  const first = items[0];
  const fromObject = typeof first === 'object' && first !== null && !Array.isArray(first);

  return text.replace(ATTRIBUTE, (match, path: string) => {
    const index = /^\d+$/.test(path);

    if (!fromObject && !index) {
      return match;
    }

    const element = index ? attribute(items, path) : undefined;
    const value = fromObject ? attribute(first, path, element) : element;

    return typeof value === 'string' ? truncate(value) : render(value);
  });
}

function attribute(source: unknown, path: string, fallback?: unknown): unknown {
  let value = source;

  for (const key of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
    value = (Object(value) as Record<string, unknown>)[key];

    if (value === undefined) {
      return fallback;
    }
  }

  return value;
}

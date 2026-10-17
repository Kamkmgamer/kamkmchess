/**
 * A strict JSON reader for one completed answer.
 *
 * `JSON.parse` silently keeps the last of several identical object keys, so a reply
 * carrying `{"move":"e2e4","move":"d5"}` would look unambiguous. This reader parses
 * exactly one complete JSON value, rejects trailing content, and reports conflicting
 * duplicate declarations for the two action keys `move` and `resign`. It never repairs,
 * merges or reorders input, and never inspects prose.
 */

/** The two keys that can carry an actionable declaration. */
const ACTION_KEYS: ReadonlySet<string> = new Set(['move', 'resign']);

export class JsonSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonSyntaxError';
  }
}

export class ConflictingDuplicateKeyError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Conflicting duplicate ${key} keys.`);
    this.name = 'ConflictingDuplicateKeyError';
    this.key = key;
  }
}

interface Cursor {
  readonly text: string;
  index: number;
}

function fail(cursor: Cursor, detail: string): never {
  throw new JsonSyntaxError(`${detail} at offset ${cursor.index}.`);
}

function skipWhitespace(cursor: Cursor): void {
  while (cursor.index < cursor.text.length && /[\s]/.test(cursor.text[cursor.index] as string)) {
    cursor.index += 1;
  }
}

function readString(cursor: Cursor): string {
  const opening = cursor.text[cursor.index];
  if (opening !== '"') fail(cursor, 'Expected a string');
  cursor.index += 1;
  let result = '';
  while (cursor.index < cursor.text.length) {
    const character = cursor.text[cursor.index] as string;
    if (character === '"') {
      cursor.index += 1;
      return result;
    }
    if (character === '\\') {
      cursor.index += 1;
      const escape = cursor.text[cursor.index];
      if (escape === undefined) fail(cursor, 'Unterminated string escape');
      if (escape === 'u') {
        const digits = cursor.text.slice(cursor.index + 1, cursor.index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) fail(cursor, 'Invalid unicode escape');
        result += String.fromCharCode(Number.parseInt(digits, 16));
        cursor.index += 5;
        continue;
      }
      const simple: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      };
      const mapped = simple[escape];
      if (mapped === undefined) fail(cursor, 'Invalid string escape');
      result += mapped;
      cursor.index += 1;
      continue;
    }
    if (character.charCodeAt(0) < 0x20) fail(cursor, 'Unescaped control character in string');
    result += character;
    cursor.index += 1;
  }
  return fail(cursor, 'Unterminated string');
}

function readNumber(cursor: Cursor): number {
  const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
    cursor.text.slice(cursor.index),
  );
  if (match === null || match[0] === '') fail(cursor, 'Expected a number');
  cursor.index += match[0].length;
  return Number(match[0]);
}

function readValue(cursor: Cursor): unknown {
  skipWhitespace(cursor);
  const character = cursor.text[cursor.index];
  if (character === undefined) fail(cursor, 'Expected a value');
  if (character === '"') return readString(cursor);
  if (character === '{') return readObject(cursor);
  if (character === '[') return readArray(cursor);
  if (cursor.text.startsWith('true', cursor.index)) {
    cursor.index += 4;
    return true;
  }
  if (cursor.text.startsWith('false', cursor.index)) {
    cursor.index += 5;
    return false;
  }
  if (cursor.text.startsWith('null', cursor.index)) {
    cursor.index += 4;
    return null;
  }
  if (character === '-' || (character >= '0' && character <= '9')) return readNumber(cursor);
  return fail(cursor, 'Unexpected token');
}

function readArray(cursor: Cursor): unknown[] {
  cursor.index += 1;
  const values: unknown[] = [];
  skipWhitespace(cursor);
  if (cursor.text[cursor.index] === ']') {
    cursor.index += 1;
    return values;
  }
  for (;;) {
    values.push(readValue(cursor));
    skipWhitespace(cursor);
    const separator = cursor.text[cursor.index];
    if (separator === ',') {
      cursor.index += 1;
      continue;
    }
    if (separator === ']') {
      cursor.index += 1;
      return values;
    }
    return fail(cursor, 'Expected , or ] in array');
  }
}

function readObject(cursor: Cursor): Record<string, unknown> {
  cursor.index += 1;
  const value: Record<string, unknown> = {};
  const seen = new Map<string, unknown>();
  skipWhitespace(cursor);
  if (cursor.text[cursor.index] === '}') {
    cursor.index += 1;
    return value;
  }
  for (;;) {
    skipWhitespace(cursor);
    const key = readString(cursor);
    skipWhitespace(cursor);
    if (cursor.text[cursor.index] !== ':') fail(cursor, 'Expected : after object key');
    cursor.index += 1;
    const entry = readValue(cursor);
    if (seen.has(key)) {
      // Only action keys can conflict with an actionable meaning. Identical action
      // duplicates remain one declaration; other duplicate keys keep JSON.parse
      // behaviour and stay non-actionable extra fields.
      if (ACTION_KEYS.has(key)) {
        if (JSON.stringify(seen.get(key)) !== JSON.stringify(entry)) {
          throw new ConflictingDuplicateKeyError(key);
        }
      } else {
        value[key] = entry;
      }
    } else {
      seen.set(key, entry);
      value[key] = entry;
    }
    skipWhitespace(cursor);
    const separator = cursor.text[cursor.index];
    if (separator === ',') {
      cursor.index += 1;
      continue;
    }
    if (separator === '}') {
      cursor.index += 1;
      return value;
    }
    return fail(cursor, 'Expected , or } in object');
  }
}

export interface StrictJsonObject {
  readonly value: Record<string, unknown>;
}

/**
 * Reads exactly one complete JSON object. Arrays, scalars, `null` and any trailing
 * content are rejected; callers then use the documented non-JSON fallback.
 */
export function parseStrictJsonObject(text: string): StrictJsonObject {
  const cursor: Cursor = { text, index: 0 };
  skipWhitespace(cursor);
  if (cursor.text[cursor.index] !== '{') fail(cursor, 'Expected a JSON object');
  const value = readObject(cursor);
  skipWhitespace(cursor);
  if (cursor.index !== cursor.text.length) fail(cursor, 'Unexpected trailing content');
  return { value };
}
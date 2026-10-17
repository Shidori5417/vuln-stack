/** A tiny reader for the Elixir term syntax used by mix.lock (maps, tuples, lists, strings, atoms). */
export interface Atom {
  atom: string;
}
export interface Tuple {
  tuple: Term[];
}
export interface Kw {
  key: string;
  value: Term;
}
export interface ElixirMap {
  map: [string, Term][];
}
export type Term = string | number | Atom | Tuple | ElixirMap | Kw | Term[];

export const isAtom = (t: Term | undefined): t is Atom =>
  typeof t === 'object' && t !== null && !Array.isArray(t) && 'atom' in t;
export const isTuple = (t: Term | undefined): t is Tuple =>
  typeof t === 'object' && t !== null && !Array.isArray(t) && 'tuple' in t;
export const isMap = (t: Term | undefined): t is ElixirMap =>
  typeof t === 'object' && t !== null && !Array.isArray(t) && 'map' in t;
export const isKw = (t: Term | undefined): t is Kw =>
  typeof t === 'object' && t !== null && !Array.isArray(t) && 'key' in t;

const MAX_DEPTH = 64;

export function parseTerms(source: string): Term {
  let i = 0;

  const fail = (message: string): never => {
    throw new Error(`${message} at offset ${i}`);
  };
  const skip = () => {
    for (;;) {
      while (i < source.length && /\s/.test(source[i]!)) i++;
      if (source[i] === '#') while (i < source.length && source[i] !== '\n') i++;
      else return;
    }
  };

  const readString = (): string => {
    i++; // opening quote
    let out = '';
    while (i < source.length && source[i] !== '"') {
      if (source[i] === '\\') {
        i++;
        const c = source[i++] ?? '';
        out += c === 'n' ? '\n' : c === 't' ? '\t' : c;
      } else out += source[i++];
    }
    if (source[i] !== '"') fail('Unterminated string');
    i++;
    return out;
  };

  const item = (depth: number): Term => {
    skip();
    const c = source[i];
    // Keyword key written as `"quoted": value`.
    if (c === '"') {
      const text = readString();
      if (source[i] === ':' && /\s/.test(source[i + 1] ?? '')) {
        i++;
        return { key: text, value: term(depth + 1) };
      }
      skip();
      if (source.startsWith('=>', i)) {
        i += 2;
        return { key: text, value: term(depth + 1) };
      }
      return text;
    }
    const kw = /^([A-Za-z_][\w@?!]*):(?=\s)/.exec(source.slice(i, i + 200));
    if (kw) {
      i += kw[0].length;
      return { key: kw[1]!, value: term(depth + 1) };
    }
    return term(depth + 1);
  };

  const sequence = (close: string, depth: number): Term[] => {
    const out: Term[] = [];
    for (;;) {
      skip();
      if (source[i] === close) {
        i++;
        return out;
      }
      if (i >= source.length) fail(`Expected "${close}"`);
      out.push(item(depth));
      skip();
      if (source[i] === ',') i++;
      else if (source[i] !== close) fail('Expected "," or closing bracket');
    }
  };

  const term = (depth: number): Term => {
    if (depth > MAX_DEPTH) fail('Nesting too deep');
    skip();
    const c = source[i];
    if (c === undefined) return fail('Unexpected end of input');
    if (c === '%' && source[i + 1] === '{') {
      i += 2;
      const map: [string, Term][] = [];
      for (const entry of sequence('}', depth + 1)) {
        if (isKw(entry)) map.push([entry.key, entry.value]);
        else fail('Unexpected map entry');
      }
      return { map };
    }
    if (c === '{') {
      i++;
      return { tuple: sequence('}', depth + 1) };
    }
    if (c === '[') {
      i++;
      return sequence(']', depth + 1);
    }
    if (c === '"') {
      return readString();
    }
    if (c === ':') {
      i++;
      if (source[i] === '"') return { atom: readString() };
      const m = /^[A-Za-z_][\w@?!]*/.exec(source.slice(i, i + 200));
      if (!m) return fail('Bad atom');
      i += m[0].length;
      return { atom: m[0] };
    }
    const num = /^-?\d+(?:\.\d+)?/.exec(source.slice(i, i + 50));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const ident = /^[A-Za-z_][\w@?!.]*/.exec(source.slice(i, i + 200));
    if (ident) {
      i += ident[0].length;
      return { atom: ident[0] };
    }
    return fail(`Unexpected character "${c}"`);
  };

  const result = term(0);
  skip();
  return result;
}

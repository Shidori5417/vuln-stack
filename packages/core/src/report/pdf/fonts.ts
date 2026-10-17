/**
 * Glyph widths (1/1000 em) for the standard Helvetica fonts, ASCII 32–126,
 * from Adobe's AFM files. The base-14 fonts need no embedding, which keeps
 * the PDF writer dependency-free.
 */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

export type FontName = 'regular' | 'bold';

export const FONT_RESOURCES: Record<FontName, { key: string; base: string }> = {
  regular: { key: 'F1', base: 'Helvetica' },
  bold: { key: 'F2', base: 'Helvetica-Bold' },
};

/** Characters outside Latin-1 that Windows-1252 (WinAnsiEncoding) still has. */
const WIN_ANSI_EXTRA: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  ƒ: 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  ˆ: 0x88,
  '‰': 0x89,
  Š: 0x8a,
  '‹': 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  š: 0x9a,
  '›': 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

/** Maps text to WinAnsi code points; anything unrepresentable becomes `?`. */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (WIN_ANSI_EXTRA[ch] !== undefined) out += String.fromCharCode(WIN_ANSI_EXTRA[ch]);
    else if (code === 0x09) out += ' ';
    else if ((code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff)) out += ch;
    else out += '?';
  }
  return out;
}

/** Width of `text` in points. Non-ASCII glyphs use an average width. */
export function measure(text: string, font: FontName, size: number): number {
  const table = font === 'bold' ? HELVETICA_BOLD : HELVETICA;
  let units = 0;
  for (const ch of toWinAnsi(text)) {
    const code = ch.charCodeAt(0);
    units += code >= 32 && code <= 126 ? table[code - 32]! : 556;
  }
  return (units * size) / 1000;
}

/** Greedy word wrap; words longer than the line are broken by character. */
export function wrap(text: string, font: FontName, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate, font, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      let rest = word;
      while (measure(rest, font, size) > width) {
        let cut = 1;
        while (cut < rest.length && measure(rest.slice(0, cut + 1), font, size) <= width) cut++;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

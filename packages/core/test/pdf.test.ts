import { describe, expect, it } from 'vitest';
import { measure, toWinAnsi, wrap } from '../src/report/pdf/fonts.js';
import { PdfWriter } from '../src/report/pdf/writer.js';
import { renderPdfReport } from '../src/report/pdf/report.js';
import { applyIgnores } from '../src/ignore.js';
import { scanManual } from '../src/scan.js';
import { CRITICAL_VECTOR, fakeOsv, ghsa } from './helpers.js';

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

/** Checks the cross-reference table points at each object header. */
function expectValidXref(pdf: string) {
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)![1]);
  expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
  const entries = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
    Number(m[1]),
  );
  entries.forEach((offset, i) =>
    expect(pdf.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`),
  );
  const size = Number(/\/Size (\d+)/.exec(pdf)![1]);
  expect(entries).toHaveLength(size - 1);
  // stream lengths match their content
  for (const m of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = m.index! + m[0].length;
    expect(pdf.slice(start + Number(m[1]), start + Number(m[1]) + 10)).toBe('\nendstream');
  }
}

describe('font helpers', () => {
  it('measures with Helvetica metrics', () => {
    expect(measure('Hello', 'regular', 10)).toBeCloseTo(22.78, 1);
    expect(measure('Hello', 'bold', 10)).toBeGreaterThan(measure('Hello', 'regular', 10));
    expect(measure('ğ', 'regular', 10)).toBeCloseTo(5.56, 1); // fallback width
  });

  it('maps to WinAnsi', () => {
    expect(toWinAnsi('a…b–c€')).toBe('a\x85b\x96c\x80');
    expect(toWinAnsi('é\tş')).toBe('é ?');
  });

  it('wraps words and breaks long tokens', () => {
    expect(wrap('the quick brown fox', 'regular', 10, 50)).toEqual(['the quick', 'brown fox']);
    const long = wrap('@some-scope/very-long-package-name-here', 'regular', 10, 60);
    expect(long.length).toBeGreaterThan(2);
    expect(long.join('')).toBe('@some-scope/very-long-package-name-here');
    expect(wrap('a\nb', 'regular', 10, 100)).toEqual(['a', 'b']);
  });
});

describe('PdfWriter', () => {
  it('writes a structurally valid PDF', () => {
    const doc = new PdfWriter(undefined, undefined, { title: 'T (1)' });
    doc.text(10, 10, 'Hi (there) \\ back');
    doc.rect(0, 0, 10, 10, [255, 0, 0]);
    doc.line(0, 0, 10, 10, [0, 0, 0]);
    doc.addPage();
    const pdf = latin1(doc.toBytes());
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('(Hi \\(there\\) \\\\ back) Tj');
    expect(pdf).toContain('/Count 2');
    expect(pdf).toContain('/Title (T \\(1\\))');
    expectValidXref(pdf);
  });

  it('produces a blank page for an empty document', () => {
    expect(latin1(new PdfWriter().toBytes())).toContain('/Count 1');
  });
});

describe('renderPdfReport', () => {
  async function scan(count: number) {
    const records = Array.from({ length: count }, (_, i) =>
      ghsa(`GHSA-${i}`, 'pkg', i % 3 === 0 ? {} : { fixed: '9.0.0' }, {
        cve: `CVE-2024-${i}`,
        ...(i % 2 ? { vector: CRITICAL_VECTOR } : {}),
        label: 'LOW',
        summary: `Issue number ${i} with a fairly long summary that needs wrapping across several lines in the table cell`,
      }),
    );
    const { fetch } = fakeOsv({ affected: { 'npm:pkg@1.0.0': records.map((r) => r.id) }, records });
    return scanManual('pkg@1.0.0', { fetch });
  }

  it('renders findings across pages with footers and sections', async () => {
    const result = applyIgnores(await scan(40), [
      {
        id: 'CVE-2024-1',
        reason: 'accepted risk',
        source: '.vulnstackignore:1',
        until: '2099-01-01',
      },
    ]);
    result.warnings.push({ code: 'x', message: 'A note about the scan', file: 'package.json' });
    const pdf = latin1(
      renderPdfReport(result, { title: 'acme/app', generatedAt: new Date('2026-10-16T12:00:00Z') }),
    );
    expectValidXref(pdf);
    const pages = Number(/\/Count (\d+)/.exec(pdf)![1]);
    expect(pages).toBeGreaterThan(1);
    expect(pdf).toContain(`(VulnStack  \xb7  page 1 of ${pages}) Tj`);
    expect(pdf).toContain('(Generated 2026-10-16 12:00 UTC');
    expect(pdf).toContain('(acme/app) Tj');
    expect(pdf).toContain('(Ignored) Tj');
    expect(pdf).toContain('accepted risk');
    expect(pdf).toContain('(Notes) Tj');
    expect(pdf).toContain('(No fix yet) Tj');
    expect(pdf).toContain('(CRITICAL) Tj');
    expect(pdf).toContain('ignored) Tj');
  });

  it('says so when nothing was found', async () => {
    const { fetch } = fakeOsv({ affected: {}, records: [] });
    const pdf = latin1(renderPdfReport(await scanManual('a@1.0.0', { fetch })));
    expect(pdf).toContain('(No known vulnerabilities found in 1 dependency.) Tj');
    expect(pdf).not.toContain('(Findings) Tj');
    expectValidXref(pdf);
  });
});

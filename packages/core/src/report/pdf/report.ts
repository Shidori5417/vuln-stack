import {
  SEVERITY_ORDER,
  type Finding,
  type ReportInput,
  type Severity,
} from '../../model/types.js';
import { measure, wrap, type FontName } from './fonts.js';
import { PdfWriter, type Rgb } from './writer.js';

export interface PdfReportOptions {
  /** Shown under the main title, e.g. the project or repository name. */
  title?: string;
  /** Injected for reproducible output in tests. */
  generatedAt?: Date;
}

const SEVERITY_COLORS: Record<Severity, { fg: Rgb; bg: Rgb }> = {
  critical: { fg: [142, 36, 170], bg: [243, 229, 245] },
  high: { fg: [198, 40, 40], bg: [253, 236, 234] },
  medium: { fg: [191, 112, 0], bg: [255, 243, 224] },
  low: { fg: [21, 101, 192], bg: [227, 242, 253] },
  unknown: { fg: [97, 97, 97], bg: [240, 240, 240] },
};

const INK: Rgb = [33, 33, 33];
const MUTED: Rgb = [110, 110, 110];
const RULE: Rgb = [215, 215, 215];
const ZEBRA: Rgb = [248, 248, 248];

const MARGIN = 40;
const FOOTER = 30;
const LINE = 11;
const CELL_PAD = 4;

interface Column {
  title: string;
  width: number;
  cell: (f: Finding) => { lines: { text: string; font?: FontName; color?: Rgb }[] };
}

const fixLabel = (f: Finding) =>
  f.remediation.type === 'no-fix' || !f.remediation.fixedVersion
    ? { text: 'No fix yet', color: SEVERITY_COLORS.high.fg }
    : {
        text: `${f.remediation.fixedVersion}`,
        color:
          f.remediation.type === 'safe-patch' ? ([46, 125, 50] as Rgb) : SEVERITY_COLORS.medium.fg,
      };

const COLUMNS: Column[] = [
  {
    title: 'Severity',
    width: 62,
    cell: (f) => ({
      lines: [
        {
          text: f.vulnerability.severity.toUpperCase(),
          font: 'bold',
          color: SEVERITY_COLORS[f.vulnerability.severity].fg,
        },
        ...(f.vulnerability.cvss
          ? [{ text: `CVSS ${f.vulnerability.cvss.score.toFixed(1)}`, color: MUTED }]
          : []),
      ],
    }),
  },
  {
    title: 'Package',
    width: 120,
    cell: (f) => ({
      lines: [
        { text: f.dependency.name, font: 'bold' },
        { text: f.dependency.version },
        {
          text: [
            f.dependency.isDirect ? 'direct' : 'transitive',
            f.dependency.scope === 'dev' ? 'dev' : '',
            f.dependency.confidence !== 'high' ? 'estimated' : '',
          ]
            .filter(Boolean)
            .join(', '),
          color: MUTED,
        },
      ],
    }),
  },
  {
    title: 'Vulnerability',
    width: 170,
    cell: (f) => ({
      lines: [
        { text: f.vulnerability.id, font: 'bold' },
        ...(f.vulnerability.aliases.length > 1
          ? [
              {
                text: f.vulnerability.aliases.filter((a) => a !== f.vulnerability.id).join(', '),
                color: MUTED,
              },
            ]
          : []),
        { text: truncate(f.vulnerability.summary, 160) },
      ],
    }),
  },
  {
    title: 'Fix',
    width: 70,
    cell: (f) => {
      const label = fixLabel(f);
      const kind =
        f.remediation.type === 'safe-patch'
          ? 'safe patch'
          : f.remediation.type === 'breaking-update'
            ? 'breaking update'
            : '';
      return {
        lines: [
          { text: label.text, font: 'bold', color: label.color },
          ...(kind ? [{ text: kind, color: MUTED }] : []),
        ],
      };
    },
  },
  {
    title: 'Path',
    width: 93,
    cell: (f) => ({
      lines: [
        {
          text: f.dependency.isDirect ? 'direct' : f.chain.join(' > '),
          color: f.dependency.isDirect ? MUTED : INK,
        },
      ],
    }),
  },
];

function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Wraps each logical line of a cell to the column width. */
function layoutCell(col: Column, f: Finding) {
  const width = col.width - CELL_PAD * 2;
  return col
    .cell(f)
    .lines.flatMap((l) =>
      wrap(l.text, l.font ?? 'regular', 8, width).map((text) => ({ ...l, text })),
    );
}

/** Human-readable summary report. Returns PDF bytes. */
export function renderPdfReport(scan: ReportInput, options: PdfReportOptions = {}): Uint8Array {
  const doc = new PdfWriter(undefined, undefined, {
    title: options.title ? `VulnStack report: ${options.title}` : 'VulnStack report',
    creator: `vulnstack ${scan.tool.version}`,
  });
  const contentWidth = doc.width - MARGIN * 2;
  const bottom = doc.height - MARGIN - FOOTER;
  let y = MARGIN;

  doc.addPage();
  doc.text(MARGIN, y, 'VulnStack security report', { font: 'bold', size: 20, color: INK });
  y += 28;
  if (options.title) {
    doc.text(MARGIN, y, options.title, { font: 'bold', size: 12, color: INK });
    y += 17;
  }
  const generated = (options.generatedAt ?? new Date())
    .toISOString()
    .replace('T', ' ')
    .slice(0, 16);
  const s = scan.summary;
  const deps = (n: number) => `${n} dependenc${n === 1 ? 'y' : 'ies'}`;
  doc.text(
    MARGIN,
    y,
    `Generated ${generated} UTC  ·  vulnstack ${scan.tool.version}  ·  ${s.subprojects} project${s.subprojects === 1 ? '' : 's'}, ${deps(s.dependencies)}`,
    { size: 9, color: MUTED },
  );
  y += 24;

  // Severity cards
  const gap = 8;
  const cardW = (contentWidth - gap * (SEVERITY_ORDER.length - 1)) / SEVERITY_ORDER.length;
  SEVERITY_ORDER.forEach((sev, i) => {
    const x = MARGIN + i * (cardW + gap);
    const c = SEVERITY_COLORS[sev];
    doc.rect(x, y, cardW, 52, c.bg);
    doc.rect(x, y, 3, 52, c.fg);
    doc.text(x + 12, y + 9, String(s.bySeverity[sev]), { font: 'bold', size: 20, color: c.fg });
    doc.text(x + 12, y + 34, sev[0]!.toUpperCase() + sev.slice(1), { size: 9, color: INK });
  });
  y += 66;

  const safe = scan.findings.filter((f) => f.remediation.type === 'safe-patch').length;
  const ignored = scan.ignored?.length ?? 0;
  const stats =
    s.findings === 0
      ? `No known vulnerabilities found in ${deps(s.dependencies)}.`
      : `${s.findings} vulnerabilit${s.findings === 1 ? 'y' : 'ies'} in ${s.vulnerableDependencies} of ${deps(s.dependencies)}  ·  ${safe} fixable without a major upgrade` +
        (ignored ? `  ·  ${ignored} ignored` : '');
  doc.text(MARGIN, y, stats, {
    font: 'bold',
    size: 11,
    color: s.findings === 0 ? [46, 125, 50] : INK,
  });
  y += 26;

  const header = () => {
    doc.rect(MARGIN, y, contentWidth, 18, [236, 239, 241]);
    let x = MARGIN;
    for (const col of COLUMNS) {
      doc.text(x + CELL_PAD, y + 5, col.title, { font: 'bold', size: 8, color: INK });
      x += col.width;
    }
    y += 18;
  };
  const newPage = () => {
    doc.addPage();
    y = MARGIN;
  };

  if (scan.findings.length > 0) {
    doc.text(MARGIN, y, 'Findings', { font: 'bold', size: 13, color: INK });
    y += 20;
    header();
    scan.findings.forEach((f, index) => {
      const cells = COLUMNS.map((col) => layoutCell(col, f));
      const height = Math.max(...cells.map((c) => c.length)) * LINE + CELL_PAD * 2;
      if (y + height > bottom) {
        newPage();
        header();
      }
      if (index % 2 === 1) doc.rect(MARGIN, y, contentWidth, height, ZEBRA);
      let x = MARGIN;
      cells.forEach((lines, i) => {
        lines.forEach((l, j) =>
          doc.text(x + CELL_PAD, y + CELL_PAD + j * LINE, l.text, {
            font: l.font ?? 'regular',
            size: 8,
            color: l.color ?? INK,
          }),
        );
        x += COLUMNS[i]!.width;
      });
      y += height;
      doc.line(MARGIN, y, MARGIN + contentWidth, y, RULE);
    });
    y += 16;
  }

  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    if (y + 40 > bottom) newPage();
    doc.text(MARGIN, y, title, { font: 'bold', size: 13, color: INK });
    y += 20;
    for (const item of items) {
      const lines = wrap(item, 'regular', 8.5, contentWidth - 12);
      if (y + lines.length * LINE > bottom) newPage();
      doc.text(MARGIN, y, '•', { size: 8.5, color: MUTED });
      lines.forEach((l, i) => doc.text(MARGIN + 12, y + i * LINE, l, { size: 8.5, color: INK }));
      y += lines.length * LINE + 3;
    }
    y += 12;
  };

  section(
    'Ignored',
    (scan.ignored ?? []).map(
      (i) =>
        `${i.finding.vulnerability.id} in ${i.finding.dependency.name}@${i.finding.dependency.version}: ${i.rule.reason ?? 'no reason given'} (${i.rule.source}${i.rule.until ? `, until ${i.rule.until}` : ''})`,
    ),
  );
  section('Notes', [
    ...new Set(scan.warnings.map((w) => `${w.file ? `${w.file}: ` : ''}${w.message}`)),
  ]);

  // Footers, now that the page count is known.
  const total = doc.pageCount;
  for (let i = 0; i < total; i++) {
    doc.usePage(i);
    const text = `VulnStack  ·  page ${i + 1} of ${total}`;
    doc.text((doc.width - measure(text, 'regular', 8)) / 2, doc.height - MARGIN + 5, text, {
      size: 8,
      color: MUTED,
    });
  }
  return doc.toBytes();
}

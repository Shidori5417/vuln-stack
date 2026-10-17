import { FONT_RESOURCES, toWinAnsi, type FontName } from './fonts.js';

export type Rgb = readonly [number, number, number];

export interface TextStyle {
  font?: FontName;
  size?: number;
  color?: Rgb;
}

export const A4 = { width: 595.28, height: 841.89 };

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const color = ([r, g, b]: Rgb) => `${num(r / 255)} ${num(g / 255)} ${num(b / 255)}`;
const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * A tiny PDF 1.4 writer: pages with text (base-14 Helvetica), filled
 * rectangles and lines. Coordinates use a top-left origin, in points.
 */
export class PdfWriter {
  private readonly pages: string[][] = [];
  private current: string[] | undefined;

  constructor(
    readonly width = A4.width,
    readonly height = A4.height,
    private readonly info: { title?: string; creator?: string } = {},
  ) {}

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): void {
    this.current = [];
    this.pages.push(this.current);
  }

  /** Switches drawing to an existing page (e.g. to add footers once the total is known). */
  usePage(index: number): void {
    this.current = this.pages[index];
  }

  private ops(): string[] {
    if (!this.current) this.addPage();
    return this.current!;
  }

  text(x: number, y: number, text: string, style: TextStyle = {}): void {
    const { font = 'regular', size = 10, color: c = [0, 0, 0] } = style;
    // y is the top of the line; PDF wants the baseline (≈ 0.8 em below the top).
    const baseline = this.height - y - size * 0.8;
    this.ops().push(
      `BT /${FONT_RESOURCES[font].key} ${num(size)} Tf ${color(c)} rg ${num(x)} ${num(baseline)} Td (${escape(toWinAnsi(text))}) Tj ET`,
    );
  }

  rect(x: number, y: number, w: number, h: number, fill: Rgb): void {
    this.ops().push(
      `${color(fill)} rg ${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re f`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, stroke: Rgb, width = 0.5): void {
    this.ops().push(
      `${color(stroke)} RG ${num(width)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`,
    );
  }

  /** Serialises the document. Content is Latin-1, so string length = byte length. */
  toBytes(): Uint8Array {
    if (this.pages.length === 0) this.addPage();
    const objects: string[] = [];
    const add = (body: string) => objects.push(body);

    const fontIds: Record<string, number> = {};
    add('<< /Type /Catalog /Pages 2 0 R >>'); // 1
    add(''); // 2: pages, filled in below
    for (const font of Object.values(FONT_RESOURCES)) {
      add(`<< /Type /Font /Subtype /Type1 /BaseFont /${font.base} /Encoding /WinAnsiEncoding >>`);
      fontIds[font.key] = objects.length;
    }
    const fonts = Object.entries(fontIds)
      .map(([key, id]) => `/${key} ${id} 0 R`)
      .join(' ');
    const kids: number[] = [];
    for (const page of this.pages) {
      const content = page.join('\n');
      add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      const contentId = objects.length;
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] /Resources << /Font << ${fonts} >> >> /Contents ${contentId} 0 R >>`,
      );
      kids.push(objects.length);
    }
    objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const infoEntries = [
      this.info.title ? `/Title (${escape(toWinAnsi(this.info.title))})` : '',
      `/Producer (${escape(this.info.creator ?? 'VulnStack')})`,
    ].filter(Boolean);
    add(`<< ${infoEntries.join(' ')} >>`);
    const infoId = objects.length;

    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}

import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";

// A small flowing layout on top of pdf-lib: headings, wrapped text and tables that break across pages
// (repeating the table header). Standard Helvetica keeps text selectable and searchable with no font files.

export const INK = rgb(0.1, 0.1, 0.1);
export const MUTED = rgb(0.42, 0.42, 0.42);
export const RULE = rgb(0.78, 0.78, 0.78);
const FILL = rgb(0.94, 0.94, 0.94);

const PAGE = { w: 612, h: 792 }; // US Letter
const M = { left: 40, right: 40, top: 40, bottom: 56 };
export const CONTENT_W = PAGE.w - M.left - M.right;

const REPLACE: Record<string, string> = { "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "−": "-", " ": " ", " ": " ", "✓": "ok", "✗": "x", "≈": "~" };

export interface Column {
  label: string;
  width: number;
  align?: "left" | "right";
}

export interface PageFrame {
  /** Drawn at the top of every page. */
  header: (page: PDFPage, l: Layout) => void;
  /** Drawn at the bottom of every page once the page count is known. */
  footer: (page: PDFPage, l: Layout, index: number, count: number) => void;
  headerHeight: number;
}

export class Layout {
  readonly pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  private encodable = new Map<string, boolean>();

  private constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    readonly bold: PDFFont,
    private frame: PageFrame,
  ) {}

  static async create(frame: PageFrame): Promise<Layout> {
    const doc = await PDFDocument.create();
    return new Layout(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold), frame);
  }

  get left() {
    return M.left;
  }
  get right() {
    return PAGE.w - M.right;
  }
  get pageHeight() {
    return PAGE.h;
  }

  /** Characters Helvetica (WinAnsi) can't encode would throw; map the common ones and replace the rest. */
  clean(s: string): string {
    let out = "";
    for (const ch of s.replace(/\r\n?/g, "\n")) {
      const c = REPLACE[ch] ?? ch;
      if (c === "\n") {
        out += c;
        continue;
      }
      let ok = this.encodable.get(c);
      if (ok === undefined) {
        try {
          this.font.encodeText(c);
          ok = true;
        } catch {
          ok = false;
        }
        this.encodable.set(c, ok);
      }
      out += ok ? c : "?";
    }
    return out;
  }

  width(s: string, size: number, bold = false) {
    return (bold ? this.bold : this.font).widthOfTextAtSize(this.clean(s), size);
  }

  /** Word-wrap to a width; long words are broken by character. */
  wrap(s: string, size: number, maxWidth: number, bold = false): string[] {
    const lines: string[] = [];
    for (const para of this.clean(s).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (this.width(next, size, bold) <= maxWidth) {
          line = next;
          continue;
        }
        if (line) lines.push(line);
        line = word;
        while (this.width(line, size, bold) > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && this.width(line.slice(0, cut), size, bold) > maxWidth) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      }
      lines.push(line);
    }
    return lines;
  }

  newPage() {
    this.page = this.doc.addPage([PAGE.w, PAGE.h]);
    this.pages.push(this.page);
    this.y = PAGE.h - M.top;
    this.frame.header(this.page, this);
    this.y -= this.frame.headerHeight;
  }

  /** Start a new page unless `h` points still fit. */
  ensure(h: number) {
    if (!this.page || this.y - h < M.bottom) this.newPage();
  }

  gap(h: number) {
    this.y -= h;
  }

  draw(s: string, x: number, y: number, size: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}) {
    this.page.drawText(this.clean(s), { x, y, size, font: opts.bold ? this.bold : this.font, color: opts.color ?? INK });
  }

  /** Wrapped paragraph at the cursor. */
  text(s: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number; after?: number } = {}) {
    const size = opts.size ?? 9;
    const lead = size * 1.3;
    const x = M.left + (opts.indent ?? 0);
    for (const line of this.wrap(s, size, this.right - x, opts.bold)) {
      this.ensure(lead);
      this.y -= lead;
      this.draw(line, x, this.y + size * 0.28, size, opts);
    }
    this.y -= opts.after ?? 0;
  }

  /** Bulleted list item. */
  bullet(s: string, opts: { size?: number; color?: ReturnType<typeof rgb>; marker?: string } = {}) {
    const size = opts.size ?? 9;
    const lead = size * 1.3;
    const marker = opts.marker ?? "-";
    const indent = 10 + this.width(marker, size);
    const lines = this.wrap(s, size, this.right - M.left - indent);
    lines.forEach((line, i) => {
      this.ensure(lead);
      this.y -= lead;
      if (i === 0) this.draw(marker, M.left + 2, this.y + size * 0.28, size, { color: opts.color });
      this.draw(line, M.left + indent, this.y + size * 0.28, size, { color: opts.color });
    });
  }

  /** Section heading with a rule; keeps at least `keep` points of what follows on the same page. */
  heading(s: string, keep = 48) {
    this.ensure(22 + keep);
    this.y -= 16;
    this.draw(s, M.left, this.y, 10.5, { bold: true });
    this.y -= 5;
    this.page.drawLine({ start: { x: M.left, y: this.y }, end: { x: this.right, y: this.y }, thickness: 0.6, color: RULE });
    this.y -= 2;
  }

  /** Label/value pairs in two columns. */
  pairs(rows: [string, string][], labelWidth = 150) {
    const size = 9;
    const lead = size * 1.35;
    for (const [label, value] of rows) {
      const lines = this.wrap(value, size, CONTENT_W - labelWidth);
      this.ensure(lead * lines.length);
      lines.forEach((line, i) => {
        this.y -= lead;
        if (i === 0) this.draw(label, M.left, this.y + 3, size, { color: MUTED });
        this.draw(line, M.left + labelWidth, this.y + 3, size);
      });
    }
  }

  private measureRow(columns: Column[], cells: string[], size: number, bold: boolean) {
    const pad = 3;
    const wrapped = cells.map((c, i) => this.wrap(c ?? "", size, columns[i].width * CONTENT_W - pad * 2, bold));
    return { wrapped, h: Math.max(1, ...wrapped.map((w) => w.length)) * size * 1.25 + pad * 2 };
  }

  /** Height a table would take, header included. */
  tableHeight(columns: Column[], rows: string[][], opts: { size?: number; boldRows?: Set<number> } = {}) {
    const size = opts.size ?? 8.5;
    const rowsH = rows.reduce((h, cells, i) => h + this.measureRow(columns, cells, size, !!opts.boldRows?.has(i)).h, 0);
    return this.measureRow(columns, columns.map((c) => c.label), size, true).h + rowsH;
  }

  /** Room for content on an empty page. */
  get pageRoom() {
    return PAGE.h - M.top - this.frame.headerHeight - M.bottom;
  }

  /** Table with wrapped cells. Column widths are fractions of the content width; the header repeats after a page break. */
  table(columns: Column[], rows: string[][], opts: { size?: number; boldRows?: Set<number> } = {}) {
    const size = opts.size ?? 8.5;
    const lead = size * 1.25;
    const pad = 3;
    const widths = columns.map((c) => c.width * CONTENT_W);
    const drawRow = (cells: string[], header: boolean, bold: boolean) => this.measureRow(columns, cells, size, header || bold);
    const paint = (r: { wrapped: string[][]; h: number }, header: boolean, bold: boolean) => {
      const top = this.y;
      if (header) this.page.drawRectangle({ x: M.left, y: top - r.h, width: CONTENT_W, height: r.h, color: FILL });
      let x = M.left;
      r.wrapped.forEach((lines, i) => {
        lines.forEach((line, j) => {
          const w = this.width(line, size, header || bold);
          const lx = columns[i].align === "right" ? x + widths[i] - pad - w : x + pad;
          this.draw(line, lx, top - pad - (j + 1) * lead + size * 0.3, size, { bold: header || bold, color: header ? MUTED : INK });
        });
        x += widths[i];
      });
      this.y = top - r.h;
      this.page.drawLine({ start: { x: M.left, y: this.y }, end: { x: this.right, y: this.y }, thickness: 0.4, color: RULE });
    };
    const head = drawRow(columns.map((c) => c.label), true, false);
    const first = rows.length ? drawRow(rows[0], false, !!opts.boldRows?.has(0)) : undefined;
    this.ensure(head.h + (first?.h ?? 0));
    paint(head, true, false);
    rows.forEach((cells, i) => {
      const bold = !!opts.boldRows?.has(i);
      const r = i === 0 && first ? first : drawRow(cells, false, bold);
      if (this.y - r.h < M.bottom) {
        this.newPage();
        paint(head, true, false);
      }
      paint(r, false, bold);
    });
  }

  /** Run the footer on every page and return the file. */
  async finish(meta: { title: string; subject?: string; author?: string; creator?: string }): Promise<Uint8Array> {
    this.pages.forEach((p, i) => {
      this.page = p;
      this.frame.footer(p, this, i, this.pages.length);
    });
    this.doc.setTitle(this.clean(meta.title));
    if (meta.subject) this.doc.setSubject(this.clean(meta.subject));
    if (meta.author) this.doc.setAuthor(this.clean(meta.author));
    if (meta.creator) this.doc.setCreator(this.clean(meta.creator));
    this.doc.setProducer("pdf-lib");
    return this.doc.save();
  }
}

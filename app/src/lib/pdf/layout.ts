import { PDFDocument, PDFFont, PDFImage, PDFPage, rgb, StandardFonts, type RGB } from "pdf-lib";

// A small flowing layout on top of pdf-lib: headings, wrapped text, cards, pills and tables that break
// across pages (repeating the table header). Standard Helvetica keeps text selectable with no font files.

const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

/** The app's light-theme tokens (globals.css). */
export const C = {
  ink: hex("#16202b"),
  muted: hex("#5b6b7d"),
  faint: hex("#8a99ab"),
  line: hex("#b8c4d2"),
  lineSoft: hex("#e3e8ef"),
  group: hex("#f3f6fa"),
  header: hex("#dbe5f1"),
  headerFg: hex("#1f3b61"),
  brand: hex("#1f4e8c"),
  accent: hex("#2f6db5"),
  brandSoft: hex("#c9d8ec"),
  pipe: hex("#b0742f"),
  pipeSoft: hex("#fbf3ea"),
  odu: hex("#3c6e47"),
  good: hex("#2e8540"),
  warn: hex("#c77700"),
  bad: hex("#c62828"),
  white: rgb(1, 1, 1),
  canvas: hex("#f7f9fc"),
  grid: hex("#dfe6ee"),
};
export const INK = C.ink;
export const MUTED = C.muted;
export const RULE = C.line;

const PAGE = { w: 612, h: 792 }; // US Letter
const M = { left: 40, right: 40, top: 0, bottom: 60 };
export const CONTENT_W = PAGE.w - M.left - M.right;

const REPLACE: Record<string, string> = { "\u2192": "->", "\u2190": "<-", "\u2265": ">=", "\u2264": "<=", "\u2212": "-", "\u00a0": " ", "\u202f": " ", "\u2009": " ", "\u2713": "ok", "\u2717": "x", "\u2248": "~" };

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

type TextOpts = { size?: number; bold?: boolean; color?: RGB; indent?: number; after?: number };
type TableOpts = { size?: number; boldRows?: Set<number>; icons?: (PDFImage | undefined)[]; colors?: (RGB | undefined)[][] };

/** Rounded rectangle as SVG path data, origin top-left (pdf-lib flips y for SVG paths). */
export function roundRectPath(w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  return `M${r},0 H${w - r} Q${w},0 ${w},${r} V${h - r} Q${w},${h} ${w - r},${h} H${r} Q0,${h} 0,${h - r} V${r} Q0,0 ${r},0 Z`;
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
  get pageWidth() {
    return PAGE.w;
  }
  get pageHeight() {
    return PAGE.h;
  }
  get bottom() {
    return M.bottom;
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

  /** Cut a single line to fit, ending in "...". */
  fit(s: string, size: number, maxWidth: number, bold = false) {
    let t = this.clean(s);
    if (this.width(t, size, bold) <= maxWidth) return t;
    while (t.length > 1 && this.width(`${t}...`, size, bold) > maxWidth) t = t.slice(0, -1);
    return `${t.trimEnd()}...`;
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

  /** Room for content on an empty page. */
  get pageRoom() {
    return PAGE.h - M.top - this.frame.headerHeight - M.bottom;
  }

  /** Start a new page unless `h` points still fit. */
  ensure(h: number) {
    if (!this.page || this.y - h < M.bottom) this.newPage();
  }

  gap(h: number) {
    this.y -= h;
  }

  draw(s: string, x: number, y: number, size: number, opts: { bold?: boolean; color?: RGB } = {}) {
    this.page.drawText(this.clean(s), { x, y, size, font: opts.bold ? this.bold : this.font, color: opts.color ?? INK });
  }

  /** Text right-aligned to `x`. */
  drawRight(s: string, x: number, y: number, size: number, opts: { bold?: boolean; color?: RGB } = {}) {
    this.draw(s, x - this.width(s, size, opts.bold), y, size, opts);
  }

  drawCentered(s: string, cx: number, y: number, size: number, opts: { bold?: boolean; color?: RGB } = {}) {
    this.draw(s, cx - this.width(s, size, opts.bold) / 2, y, size, opts);
  }

  /** Rounded box; `y` is the top edge. */
  box(x: number, y: number, w: number, h: number, opts: { fill?: RGB; border?: RGB; borderWidth?: number; radius?: number } = {}) {
    this.page.drawSvgPath(roundRectPath(w, h, opts.radius ?? 4), {
      x,
      y,
      color: opts.fill,
      borderColor: opts.border,
      borderWidth: opts.border ? (opts.borderWidth ?? 0.6) : 0,
    });
  }

  /** Small rounded label centered vertically on `cy`. Returns its width. */
  pill(s: string, x: number, cy: number, opts: { size?: number; fill?: RGB; color?: RGB; border?: RGB; bold?: boolean; align?: "left" | "center" | "right" } = {}) {
    const size = opts.size ?? 7;
    const bold = opts.bold ?? true;
    const padX = size * 0.7;
    const h = size * 1.75;
    const w = this.width(s, size, bold) + padX * 2;
    const left = opts.align === "center" ? x - w / 2 : opts.align === "right" ? x - w : x;
    this.box(left, cy + h / 2, w, h, { fill: opts.fill ?? C.white, border: opts.border, radius: h / 2 });
    this.draw(s, left + padX, cy - size * 0.35, size, { bold, color: opts.color ?? INK });
    return w;
  }

  /** Image fitted inside a w × h box (top-left at x, y), centered. */
  image(img: PDFImage | undefined, x: number, y: number, w: number, h: number) {
    if (!img) return;
    const s = Math.min(w / img.width, h / img.height);
    const iw = img.width * s;
    const ih = img.height * s;
    this.page.drawImage(img, { x: x + (w - iw) / 2, y: y - h + (h - ih) / 2, width: iw, height: ih });
  }

  /** Wrapped paragraph at the cursor. */
  text(s: string, opts: TextOpts = {}) {
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

  /** List item with a marker, or with a colored tag (e.g. ERROR) in front. */
  bullet(s: string, opts: { size?: number; color?: RGB; marker?: string; tag?: { text: string; color: RGB } } = {}) {
    const size = opts.size ?? 9;
    const lead = size * 1.45;
    const indent = opts.tag ? 50 : 10 + this.width(opts.marker ?? "-", size);
    const lines = this.wrap(s, size, this.right - M.left - indent);
    lines.forEach((line, i) => {
      this.ensure(lead);
      this.y -= lead;
      if (i === 0) {
        if (opts.tag) this.pill(opts.tag.text, M.left, this.y + size * 0.3, { size: 6, fill: opts.tag.color, color: C.white });
        else this.draw(opts.marker ?? "-", M.left + 2, this.y + size * 0.28, size, { color: opts.color });
      }
      this.draw(line, M.left + indent, this.y + size * 0.28, size, { color: opts.color });
    });
    this.y -= 1.5;
  }

  /** Section heading with an accent mark and a rule; keeps at least `keep` points of what follows on the same page. */
  heading(s: string, keep = 48) {
    this.ensure(28 + keep);
    this.y -= 22;
    this.page.drawRectangle({ x: M.left, y: this.y - 1.5, width: 3, height: 10.5, color: C.accent });
    this.draw(s.toUpperCase(), M.left + 9, this.y, 8.5, { bold: true, color: C.headerFg });
    this.y -= 6;
    this.page.drawLine({ start: { x: M.left, y: this.y }, end: { x: this.right, y: this.y }, thickness: 0.6, color: C.lineSoft });
    this.y -= 2;
  }

  /** Label/value pairs, optionally in side-by-side columns. */
  pairs(rows: [string, string][], labelWidth = 150, columns = 1) {
    const size = 8.5;
    const lead = size * 1.45;
    const colW = (CONTENT_W - (columns - 1) * 20) / columns;
    const per = Math.ceil(rows.length / columns);
    const cols = Array.from({ length: columns }, (_, c) => rows.slice(c * per, (c + 1) * per));
    const heights = cols.map((col) => col.reduce((h, [, v]) => h + this.wrap(v, size, colW - labelWidth).length * lead, 0));
    this.ensure(Math.max(...heights, 0));
    const top = this.y;
    let bottom = top;
    cols.forEach((col, c) => {
      const x = M.left + c * (colW + 20);
      let y = top;
      for (const [label, value] of col) {
        const lines = this.wrap(value, size, colW - labelWidth);
        lines.forEach((line, i) => {
          y -= lead;
          if (i === 0) this.draw(label, x, y + 3, size, { color: MUTED });
          this.draw(line, x + labelWidth, y + 3, size);
        });
      }
      bottom = Math.min(bottom, y);
    });
    this.y = bottom;
  }

  private measureRow(columns: Column[], cells: string[], size: number, bold: boolean, iconW = 0, withIcon = false) {
    const pad = 4;
    const wrapped = cells.map((c, i) => this.wrap(c ?? "", size, columns[i].width * CONTENT_W - pad * 2 - (i === 0 ? iconW : 0), bold));
    const textH = Math.max(1, ...wrapped.map((w) => w.length)) * size * 1.25 + pad * 2;
    return { wrapped, h: Math.max(textH, withIcon ? iconW + 6 : 0) };
  }

  private headRow(columns: Column[]) {
    return this.measureRow(columns, columns.map((c) => c.label.toUpperCase()), 6.5, true);
  }

  /** Height a table would take, header included. */
  tableHeight(columns: Column[], rows: string[][], opts: TableOpts = {}) {
    const size = opts.size ?? 8.5;
    const iconW = opts.icons ? 22 : 0;
    const rowsH = rows.reduce((h, cells, i) => h + this.measureRow(columns, cells, size, !!opts.boldRows?.has(i), iconW, !!opts.icons?.[i]).h, 0);
    return this.headRow(columns).h + rowsH;
  }

  /**
   * Table with wrapped cells. Column widths are fractions of the content width; the header repeats after a page break.
   * `icons` puts a small picture at the start of each row's first cell; `colors` tints single cells.
   */
  table(columns: Column[], rows: string[][], opts: TableOpts = {}) {
    const size = opts.size ?? 8.5;
    const headSize = 6.5;
    const pad = 4;
    const iconW = opts.icons ? 22 : 0;
    const widths = columns.map((c) => c.width * CONTENT_W);
    const paint = (r: { wrapped: string[][]; h: number }, index: number, bold: boolean) => {
      const head = index < 0;
      const top = this.y;
      const sz = head ? headSize : size;
      const lead = sz * 1.25;
      if (head) this.box(M.left, top, CONTENT_W, r.h, { fill: C.header, radius: 3 });
      else if (bold) this.page.drawRectangle({ x: M.left, y: top - r.h, width: CONTENT_W, height: r.h, color: C.group });
      let x = M.left;
      r.wrapped.forEach((lines, i) => {
        const shift = i === 0 && !head ? iconW : 0;
        if (shift) this.image(opts.icons?.[index], x + pad - 1, top - 3, iconW - 2, r.h - 6);
        const textTop = top - (r.h - pad * 2 - lines.length * lead) / 2;
        lines.forEach((line, j) => {
          const b = head || bold;
          const w = this.width(line, sz, b);
          const lx = columns[i].align === "right" ? x + widths[i] - pad - w : x + pad + shift;
          const color = head ? C.headerFg : (opts.colors?.[index]?.[i] ?? INK);
          this.draw(line, lx, textTop - pad - (j + 1) * lead + sz * 0.3, sz, { bold: b, color });
        });
        x += widths[i];
      });
      this.y = top - r.h;
      if (!head) this.page.drawLine({ start: { x: M.left, y: this.y }, end: { x: this.right, y: this.y }, thickness: 0.4, color: C.lineSoft });
    };
    const head = this.headRow(columns);
    const first = rows.length ? this.measureRow(columns, rows[0], size, !!opts.boldRows?.has(0), iconW, !!opts.icons?.[0]) : undefined;
    this.ensure(head.h + (first?.h ?? 0));
    paint(head, -1, false);
    rows.forEach((cells, i) => {
      const bold = !!opts.boldRows?.has(i);
      const r = i === 0 && first ? first : this.measureRow(columns, cells, size, bold, iconW, !!opts.icons?.[i]);
      if (this.y - r.h < M.bottom) {
        this.newPage();
        paint(head, -1, false);
      }
      paint(r, i, bold);
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

import "server-only";
import { LineCapStyle, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import designWeather from "@/data/design-locations.json";
import { dbVersion, iduById, oduById, str } from "../catalog";
import { DEFAULT_CONDITIONS, type BomLine, type Evaluation, type Issue, type ModeCapacity, type PipeRun, type SystemDesign, type SystemKey } from "../design";
import { evaluate, SYSTEM_NAME } from "../engine";
import { inch } from "../engine/lineset";
import { site } from "../site";
import { embedArt, embedLogo, type Logo } from "./assets";
import { C, CONTENT_W, Layout, MUTED, type Column } from "./layout";
import type { PdfRequest } from "./request";

// Submittal-style PDF: one section (starting on its own page) per system, plus a cover page with project
// totals when there is more than one. Every number comes from the same evaluate() the app uses; the unit
// artwork and the system diagram follow the app's canvas.

const DISCLAIMER =
  "Independent planning tool, not affiliated with or endorsed by Mitsubishi Electric. Verify against current manufacturer documentation before quoting, ordering or installing. A passing result is not manufacturer approval.";

const LOCATIONS = new Map((designWeather.locations as { id: string; city: string; state: string }[]).map((l) => [l.id, `${l.city}, ${l.state} (${l.id})`]));
const catalogVersion = (() => {
  const v = dbVersion.find((r) => str(r.strCompany) !== "MESCA") ?? dbVersion[0];
  return str(v?.strDatabaseVersion) ?? "unknown";
})();

const STATUS = { pass: "PASS", fail: "FAIL", incomplete: "INCOMPLETE" } as const;
const STATUS_COLOR = { pass: C.good, fail: C.bad, incomplete: C.warn } as const;
const SEVERITY = { error: { text: "ERROR", color: C.bad }, warning: { text: "WARNING", color: C.warn }, info: { text: "NOTE", color: C.accent } } as const;

const btu = (v?: number) => (v == null || !Number.isFinite(v) ? "-" : Math.round(v).toLocaleString("en-US"));
const kbtu = (v?: number) => (v == null || !Number.isFinite(v) ? "-" : `${Math.round(v / 100) / 10}k`);
const ft = (v?: number) => (v == null ? "-" : `${Math.round(v * 10) / 10}`);
const deg = (v?: number) => (v == null ? "-" : `${Math.round(v * 10) / 10} °F`);
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function oz(v: number): string {
  const total = Math.round(v * 10) / 10;
  if (total < 16) return `${total} oz`;
  const lb = Math.floor(total / 16);
  const rest = Math.round((total - lb * 16) * 10) / 10;
  return `${total} oz (${lb} lb${rest ? ` ${rest} oz` : ""})`;
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

const today = () => new Date().toISOString().slice(0, 10);
const brandName = () => (site.business.enabled ? site.business.name : site.name);

// ---- Artwork (same picks as the app canvas, Designer.tsx) ----

const IDU_ART: Record<string, [art: string, short: string]> = {
  "Wall-Mounted": ["wall-premium", "Wall"],
  "Ceiling-Cassette (Four-Way)": ["cassette-4way", "4-way cassette"],
  "Ceiling Cassette (One-Way)": ["cassette-1way", "1-way cassette"],
  "Ceiling-Concealed (Ducted)": ["ducted", "Ducted"],
  "Ceiling-Suspended": ["ceiling-suspended", "Suspended"],
  "Multi Position": ["air-handler", "Air handler"],
  "Multi-Position Air Handler": ["air-handler", "Air handler"],
  "Cased Coil": ["cased-coil", "Cased coil"],
  "Floor-Standing Type (Exposed)": ["floor-console", "Floor"],
};
function oduArt(model: string, coolingBtu: number, system: SystemKey) {
  if (system === "MXZSM" || coolingBtu >= 42000 || /^MXZ-8/.test(model)) return "outdoor-2fan";
  if (coolingBtu <= 15000) return "outdoor-compact";
  return "outdoor-1fan";
}
const boxArt = (ports: number) => (ports === 3 ? "branch-box-3" : "branch-box-5");
const iduArt = (iduId: number) => IDU_ART[iduById.get(iduId)?.typeName ?? ""]?.[0];

interface Ctx {
  l: Layout;
  art: Map<string, PDFImage>;
}

interface Evaluated {
  design: SystemDesign;
  ev: Evaluation;
  /** Placement key -> "Room (model)". */
  unitLabel: (key?: string) => string;
}

function evaluateAll(systems: SystemDesign[]): Evaluated[] {
  return systems.map((design) => {
    let ev: Evaluation;
    try {
      ev = evaluate({ ...design, branchBoxes: design.branchBoxes ?? [] });
    } catch {
      ev = { status: "fail", issues: [{ severity: "error", code: "EVALUATE", message: "This system could not be evaluated. Check its inputs in the designer." }], bom: [], compatibleIduIds: [], controllers: {}, accessoryOptions: {}, unchecked: [] };
    }
    const byKey = new Map(design.idus.map((p) => [p.key, p]));
    const unitLabel = (key?: string) => {
      if (!key) return "";
      if (key === "odu") return `Outdoor unit (${oduById.get(design.oduId ?? -1)?.model ?? "?"})`;
      const p = byKey.get(key);
      if (!p) return key;
      return `${p.room || "Indoor unit"} (${iduById.get(p.iduId)?.model ?? "?"})`;
    };
    return { design, ev, unitLabel };
  });
}

/** Artwork names a set of systems needs, so each picture is embedded once. */
function artNeeded(systems: Evaluated[]): string[] {
  const names: string[] = [];
  for (const { design, ev } of systems) {
    const odu = oduById.get(design.oduId ?? -1);
    if (odu) names.push(oduArt(odu.model, odu.coolingBtu, design.system));
    for (const p of design.idus) names.push(iduArt(p.iduId) ?? "");
    for (const b of ev.layout?.boxes ?? []) names.push(boxArt(b.ports));
  }
  return names.filter(Boolean);
}

/** Model (or base model) -> artwork, for the bill of materials. */
function bomArt(systems: Evaluated[]) {
  const m = new Map<string, string>();
  for (const { design, ev } of systems) {
    const odu = oduById.get(design.oduId ?? -1);
    if (odu) m.set(odu.model, oduArt(odu.model, odu.coolingBtu, design.system));
    for (const p of design.idus) {
      const u = iduById.get(p.iduId);
      const a = iduArt(p.iduId);
      if (u && a) m.set(u.model, a);
    }
    for (const b of ev.layout?.boxes ?? []) m.set(b.model, boxArt(b.ports));
  }
  return (b: BomLine) => m.get(b.baseModel ?? b.model) ?? m.get(b.model);
}

// ---- Page frame ----

const BAND = 62;

function frame(req: PdfRequest, date: string, logo: () => Logo | undefined) {
  const sub = [req.address, longDate(date)].filter(Boolean).join("  ·  ");
  return {
    headerHeight: BAND + 12,
    header(page: PDFPage, l: Layout) {
      const top = l.pageHeight;
      page.drawRectangle({ x: 0, y: top - BAND, width: l.pageWidth, height: BAND, color: C.brand });
      const lg = logo();
      const h = 36;
      let x = l.left;
      if (lg?.kind === "svg") {
        const s = h / lg.height;
        for (const d of lg.paths) page.drawSvgPath(d, { x, y: top - (BAND - h) / 2, scale: s, color: C.white });
        x += lg.width * s + 14;
      } else if (lg?.kind === "png") {
        const s = h / lg.image.height;
        page.drawImage(lg.image, { x, y: top - (BAND + h) / 2, width: lg.image.width * s, height: h });
        x += lg.image.width * s + 14;
      } else {
        l.draw(brandName(), x, top - 30, 13, { bold: true, color: C.white });
        x += l.width(brandName(), 13, true) + 14;
      }
      const right = l.right;
      const room = right - x - 10;
      l.drawRight("MINI-SPLIT SYSTEM SUBMITTAL", right, top - 20, 6.5, { bold: true, color: C.brandSoft });
      l.drawRight(l.fit(req.job ?? "Mini-split systems", 11.5, room, true), right, top - 35, 11.5, { bold: true, color: C.white });
      l.drawRight(l.fit(sub, 7.5, room), right, top - 47, 7.5, { color: C.brandSoft });
    },
    footer(page: PDFPage, l: Layout, index: number, count: number) {
      const size = 6.5;
      const lines = l.wrap(DISCLAIMER, size, CONTENT_W - 70);
      let y = 42;
      page.drawLine({ start: { x: l.left, y: y + 5 }, end: { x: l.right, y: y + 5 }, thickness: 0.5, color: C.lineSoft });
      for (const line of lines) {
        y -= size * 1.35;
        l.draw(line, l.left, y, size, { color: C.faint });
      }
      y -= size * 1.35;
      l.draw(`${site.name} · ${site.url.replace(/^https?:\/\//, "")} · catalog data ${catalogVersion}`, l.left, y, size, { color: C.faint });
      l.drawRight(`Page ${index + 1} of ${count}`, l.right, 42 - size * 1.35, 7.5, { bold: true, color: C.muted });
    },
  };
}

// ---- Pieces ----

interface Tile {
  label: string;
  value: string;
  sub?: string;
  color?: RGB;
}

function tiles(l: Layout, items: Tile[]) {
  const gap = 8;
  const h = 50;
  const w = (CONTENT_W - gap * (items.length - 1)) / items.length;
  l.ensure(h + 6);
  const top = l.y - 4;
  items.forEach((t, i) => {
    const x = l.left + i * (w + gap);
    l.box(x, top, w, h, { fill: C.group, border: C.lineSoft, radius: 5 });
    l.page.drawRectangle({ x, y: top - h + 6, width: 2.5, height: h - 12, color: t.color ?? C.accent });
    l.draw(l.fit(t.label.toUpperCase(), 6, w - 18, true), x + 10, top - 13, 6, { bold: true, color: C.muted });
    l.draw(l.fit(t.value, 13, w - 18, true), x + 10, top - 30, 13, { bold: true, color: C.ink });
    if (t.sub) l.draw(l.fit(t.sub, 6.5, w - 18), x + 10, top - 42, 6.5, { color: C.muted });
  });
  l.y = top - h;
}

function statusPill(l: Layout, status: Evaluation["status"], x: number, cy: number, size = 8) {
  return l.pill(STATUS[status], x, cy, { size, fill: STATUS_COLOR[status], color: C.white, align: "right" });
}

function pipeLabel(l: Layout, r: PipeRun | undefined, maxW: number): string[] {
  if (!r) return [];
  const size = `${inch(r.liquidIn)}×${inch(r.gasIn)}`;
  const len = r.lengthFt != null ? `${ft(r.lengthFt)} ft` : "";
  const one = len ? `${size} · ${len}` : size;
  return l.width(one, 5.5, true) + 8 <= maxW ? [one] : [size, len].filter(Boolean);
}

/**
 * The system as a tree, like the app canvas: outdoor unit at the top, branch boxes (when there are any),
 * then the indoor units, joined by refrigerant lines labelled with their size and length.
 */
function diagram({ l, art }: Ctx, x: Evaluated) {
  const { design, ev } = x;
  const odu = oduById.get(design.oduId ?? -1);
  if (!odu) return;
  const PAD = 14, GAP = 6, GROUP_GAP = 16, ODU_W = 224, ODU_H = 62, BOX_H = 46, IDU_H = 80, LINK = 50, ROW_GAP = 42, MAX_ROW = 8, LEGEND = 12;
  const inner = CONTENT_W - PAD * 2;
  const x0 = l.left + PAD;
  const runs = ev.piping ?? [];
  const runFor = (key: string) => runs.find((r) => r.target === key);
  const port = (key: string) => ev.assignments?.[key]?.port;
  const byPort = (a: string, b: string) => (port(a) ? 0 : 1) - (port(b) ? 0 : 1) || (port(a) ?? "").localeCompare(port(b) ?? "");
  const keys = design.idus.map((p) => p.key);
  const boxes = ev.layout?.boxes ?? [];
  const groups = boxes.map((b, bi) => {
    const assigned = keys.filter((k) => ev.assignments?.[k]?.box === bi);
    return (assigned.length ? assigned : b.iduKeys.filter((k) => keys.includes(k))).sort(byPort);
  });
  const grouped = new Set(groups.flat());
  const useBoxes = boxes.length > 0 && keys.length <= MAX_ROW && grouped.size === keys.length && groups.flat().length === keys.length;
  const n = keys.length;
  const order = useBoxes ? groups.flat() : [...keys].sort(byPort);
  const rows: string[][] = [];
  for (let i = 0; i < order.length; i += MAX_ROW) rows.push(order.slice(i, i + MAX_ROW));

  // Card width: fill the row, but no wider than the app's cards.
  let cardW: number;
  const EMPTY_BOX_W = 76;
  if (useBoxes) {
    const empties = groups.filter((g) => !g.length).length;
    const fixed = (n - (groups.length - empties)) * GAP + (groups.length - 1) * GROUP_GAP + empties * EMPTY_BOX_W;
    cardW = n ? Math.min(104, (inner - fixed) / n) : 0;
  } else {
    const per = Math.min(n, MAX_ROW);
    cardW = per ? Math.min(104, (inner - (per - 1) * GAP) / per) : 0;
  }

  const H = PAD + ODU_H + (n ? (useBoxes ? LINK + BOX_H + LINK + IDU_H : LINK + rows.length * IDU_H + (rows.length - 1) * ROW_GAP) : 0) + PAD + LEGEND;
  l.ensure(H + 10);
  const top = l.y - 6;
  l.y = top - H;

  // Canvas with the app's dot grid.
  l.box(l.left, top, CONTENT_W, H, { fill: C.canvas, border: C.lineSoft, radius: 6 });
  for (let gx = l.left + 10; gx < l.right - 4; gx += 14)
    for (let gy = top - 10; gy > top - H + 4; gy -= 14) l.page.drawRectangle({ x: gx, y: gy, width: 0.9, height: 0.9, color: C.grid });

  const pills: { lines: string[]; x: number; y: number; strong?: boolean }[] = [];
  const pipe = (x1: number, y1: number, x2: number, y2: number) =>
    l.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1.6, color: C.pipe, lineCap: LineCapStyle.Round });
  type Kid = { cx: number; top: number; label: string[] };
  /** Parent (bottom center) to children (top centers) through a horizontal bus. */
  const connect = (px: number, py: number, kids: Kid[], trunk: string[] = [], extendTo?: number) => {
    if (!kids.length) return py;
    const childTop = kids[0].top;
    if (kids.length === 1 && Math.abs(kids[0].cx - px) < 0.5 && extendTo == null) {
      pipe(px, py, px, childTop);
      pills.push({ lines: trunk.length ? trunk : kids[0].label, x: px, y: (py + childTop) / 2, strong: !!trunk.length });
      return py;
    }
    const busY = trunk.length ? py - 22 : py - 12;
    pipe(px, py, px, busY);
    if (trunk.length) pills.push({ lines: trunk, x: px, y: (py + busY) / 2, strong: true });
    const xs = [px, ...kids.map((k) => k.cx), ...(extendTo != null ? [extendTo] : [])];
    pipe(Math.min(...xs), busY, Math.max(...xs), busY);
    for (const k of kids) {
      pipe(k.cx, busY, k.cx, k.top);
      pills.push({ lines: k.label, x: k.cx, y: (busY + k.top) / 2 + 1 });
    }
    return busY;
  };

  // Outdoor unit card.
  const oduTop = top - PAD;
  const oduX = l.left + (CONTENT_W - ODU_W) / 2;
  const oduCx = oduX + ODU_W / 2;
  const oduBottom = oduTop - ODU_H;
  const drawOdu = () => {
    l.box(oduX, oduTop, ODU_W, ODU_H, { fill: C.white, border: C.odu, borderWidth: 1.2, radius: 6 });
    l.image(art.get(oduArt(odu.model, odu.coolingBtu, design.system)), oduX + 8, oduTop - 6, 64, ODU_H - 12);
    const tx = oduX + 80;
    const tw = ODU_W - 88;
    l.draw("OUTDOOR UNIT", tx, oduTop - 15, 6, { bold: true, color: C.odu });
    l.draw(l.fit(odu.model, 11, tw, true), tx, oduTop - 29, 11, { bold: true });
    l.draw(l.fit(SYSTEM_NAME[design.system], 7, tw), tx, oduTop - 40, 7, { color: C.muted });
    l.draw(l.fit(`${kbtu(odu.coolingBtu)} cool · ${kbtu(odu.heatingBtu)} heat · ${odu.refrigerant}`, 7, tw), tx, oduTop - 50, 7, { color: C.muted });
  };

  const idu = (key: string, ix: number, itop: number) => {
    const p = design.idus.find((q) => q.key === key)!;
    const u = iduById.get(p.iduId);
    const w = cardW;
    l.box(ix, itop, w, IDU_H, { fill: C.white, border: C.line, borderWidth: 0.7, radius: 5 });
    l.image(art.get(iduArt(p.iduId) ?? ""), ix + 5, itop - 6, w - 10, 36);
    const pt = port(key);
    if (pt) l.pill(pt, ix + w - 4, itop - 8, { size: 5.5, fill: C.header, color: C.headerFg, align: "right" });
    const cx = ix + w / 2;
    const fitC = (s: string, size: number, y: number, opts: { bold?: boolean; color?: RGB }) => l.drawCentered(l.fit(s, size, w - 8, opts.bold), cx, y, size, opts);
    fitC(p.room || "Indoor unit", 7.5, itop - 52, { bold: true });
    fitC(u?.model ?? `id ${p.iduId}`, 6.5, itop - 62, { bold: true, color: C.headerFg });
    fitC([u ? `${kbtu(u.coolingBtu)} Btu/h` : "", IDU_ART[u?.typeName ?? ""]?.[1] ?? ""].filter(Boolean).join(" · "), 6, itop - 72, { color: C.muted });
  };

  const draws: (() => void)[] = [];
  if (n && useBoxes) {
    const boxTop = oduBottom - LINK;
    const iduTop = boxTop - BOX_H - LINK;
    const widths = groups.map((g) => (g.length ? g.length * cardW + (g.length - 1) * GAP : EMPTY_BOX_W));
    let gx = x0 + (inner - widths.reduce((a, b) => a + b, 0) - (groups.length - 1) * GROUP_GAP) / 2;
    const boxKids: Kid[] = [];
    groups.forEach((g, bi) => {
      const span = widths[bi];
      const left = gx;
      const b = boxes[bi];
      const bw = Math.min(140, Math.max(span, 60));
      const bx = left + (span - bw) / 2;
      const bcx = bx + bw / 2;
      const jointRun = boxes.length > 1 ? runs.find((r) => !r.target && new RegExp(`box ${bi + 1}$`).test(r.label)) : undefined;
      boxKids.push({ cx: bcx, top: boxTop, label: pipeLabel(l, jointRun, Math.min(bw, span) + GROUP_GAP - 4) });
      const kids: Kid[] = g.map((key, j) => ({ cx: left + j * (cardW + GAP) + cardW / 2, top: iduTop, label: pipeLabel(l, runFor(key), cardW + GAP - 2) }));
      connect(bcx, boxTop - BOX_H, kids);
      g.forEach((key, j) => draws.push(() => idu(key, left + j * (cardW + GAP), iduTop)));
      draws.push(() => {
        l.box(bx, boxTop, bw, BOX_H, { fill: C.white, border: C.pipe, borderWidth: 1.1, radius: 5 });
        const img = art.get(boxArt(b.ports));
        if (bw >= 110) {
          l.image(img, bx + 6, boxTop - 5, 34, BOX_H - 10);
          const tx = bx + 46;
          l.draw(`BRANCH BOX ${bi + 1}`, tx, boxTop - 14, 5.8, { bold: true, color: C.muted });
          l.draw(l.fit(b.model, 8, bw - 52, true), tx, boxTop - 26, 8, { bold: true });
          l.draw(`${b.ports} ports`, tx, boxTop - 37, 6.5, { color: C.muted });
        } else {
          l.image(img, bx, boxTop - 4, bw, 20);
          l.drawCentered(`BOX ${bi + 1} · ${b.ports} PORTS`, bcx, boxTop - 32, 5.5, { bold: true, color: C.muted });
          l.drawCentered(l.fit(b.model, 6.5, bw - 6, true), bcx, boxTop - 41, 6.5, { bold: true });
        }
      });
      gx += span + GROUP_GAP;
    });
    const main = runs.find((r) => !r.target && /^Main/.test(r.label));
    connect(oduCx, oduBottom, boxKids, pipeLabel(l, main, 200));
  } else if (n) {
    const trunkX = l.left + 7;
    let prevBus: number | undefined;
    rows.forEach((row, ri) => {
      const rowTop = oduBottom - LINK - ri * (IDU_H + ROW_GAP);
      const w = row.length * cardW + (row.length - 1) * GAP;
      const rx = x0 + (inner - w) / 2;
      const kids: Kid[] = row.map((key, j) => ({ cx: rx + j * (cardW + GAP) + cardW / 2, top: rowTop, label: pipeLabel(l, runFor(key), cardW + GAP - 2) }));
      if (ri === 0) prevBus = connect(oduCx, oduBottom, kids, [], rows.length > 1 ? trunkX : undefined);
      else {
        const busY = rowTop + ROW_GAP - 14;
        pipe(trunkX, prevBus!, trunkX, busY);
        pipe(trunkX, busY, Math.max(...kids.map((k) => k.cx)), busY);
        for (const k of kids) {
          pipe(k.cx, busY, k.cx, k.top);
          pills.push({ lines: k.label, x: k.cx, y: (busY + k.top) / 2 + 1 });
        }
        prevBus = busY;
      }
      row.forEach((key, j) => draws.push(() => idu(key, rx + j * (cardW + GAP), rowTop)));
    });
  }

  drawOdu();
  for (const d of draws) d();
  for (const p of pills) {
    const h = 10;
    p.lines.forEach((s, i) => {
      const cy = p.y + ((p.lines.length - 1) / 2 - i) * h;
      l.pill(s, p.x, cy, { size: 5.5, fill: p.strong ? C.pipe : C.pipeSoft, color: p.strong ? C.white : C.pipe, border: C.pipe, align: "center" });
    });
  }
  const legend = n ? "Line labels: liquid × gas size · entered length. Port letters as assigned in the designer." : "No indoor units picked yet.";
  l.draw(legend, l.left + PAD, top - H + 8, 6, { color: C.faint });
}

// ---- Cover ----

function cover(ctx: Ctx, req: PdfRequest, date: string, systems: Evaluated[]) {
  const { l, art } = ctx;
  l.newPage();
  l.gap(8);
  l.draw("MINI-SPLIT SYSTEM SUBMITTAL", l.left, l.y - 8, 7, { bold: true, color: C.accent });
  l.gap(12);
  l.text(req.job ?? "Mini-split systems", { size: 22, bold: true, after: 2 });
  if (req.address) l.text(req.address, { size: 11, color: MUTED, after: 1 });
  l.text([req.preparedBy ? `Prepared by ${req.preparedBy}` : "", longDate(date)].filter(Boolean).join("  ·  "), { size: 8.5, color: MUTED, after: 8 });

  const count = (s: Evaluation["status"]) => systems.filter((x) => x.ev.status === s).length;
  const sum = (f: (x: Evaluated) => number | undefined) => systems.reduce((a, x) => a + (f(x) ?? 0), 0);
  const allCap = (m: "cooling" | "heating") => systems.every((x) => x.ev.capacity?.[m]);
  const lineFt = sum((x) => x.ev.bom.filter((b) => b.category === "Line set").reduce((a, b) => a + b.qty, 0));
  tiles(l, [
    {
      label: "Systems",
      value: String(systems.length),
      sub: [count("pass") ? `${count("pass")} pass` : "", count("fail") ? `${count("fail")} fail` : "", count("incomplete") ? `${count("incomplete")} incomplete` : ""].filter(Boolean).join(" · "),
      color: count("fail") ? C.bad : count("incomplete") ? C.warn : C.good,
    },
    { label: "Indoor units", value: String(sum((x) => x.design.idus.length)), sub: "zones, all systems" },
    { label: "Cooling at design", value: btu(sum((x) => x.ev.capacity?.cooling?.systemBtu)), sub: allCap("cooling") ? "Btu/h, all systems" : "Btu/h, systems calculated" },
    { label: "Heating at design", value: btu(sum((x) => x.ev.capacity?.heating?.systemBtu)), sub: allCap("heating") ? "Btu/h, all systems" : "Btu/h, systems calculated" },
    { label: "Line set", value: lineFt ? `${btu(lineFt)} ft` : "-", sub: "takeoff, all sizes" },
  ]);

  l.heading("System summary", 110);
  const gap = 12;
  const w = (CONTENT_W - gap) / 2;
  const h = 104;
  for (let i = 0; i < systems.length; i += 2) {
    l.ensure(h + gap);
    const top = l.y - 6;
    systems.slice(i, i + 2).forEach((x, j) => systemCard(ctx, x, i + j, l.left + j * (w + gap), top, w, h));
    l.y = top - h - gap + 6;
  }

  const lines = new Map<string, BomLine>();
  for (const x of systems)
    for (const b of x.ev.bom) {
      const k = `${b.category}|${b.model}`;
      const prev = lines.get(k);
      lines.set(k, prev ? { ...prev, qty: prev.qty + b.qty, optional: prev.optional && b.optional } : { ...b });
    }
  if (lines.size) {
    const order: BomLine["category"][] = ["Outdoor unit", "Indoor unit", "Branch box", "Controller", "Interface", "Accessory", "Kit", "Line set"];
    const all = [...lines.values()].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.model.localeCompare(b.model));
    const icon = bomArt(systems);
    l.heading("Project bill of materials", 60);
    l.table(
      [
        { label: "Qty", width: 0.12, align: "right" },
        { label: "Model", width: 0.23 },
        { label: "Category", width: 0.14 },
        { label: "Description", width: 0.51 },
      ],
      all.map((b) => [b.unit === "ft" || b.category === "Line set" ? `${b.qty} ft` : String(b.qty), b.model, b.category, `${b.description}${b.optional ? " (optional)" : ""}`]),
      { icons: all.map((b) => art.get(icon(b) ?? "")) },
    );
    l.text("Quantities are summed across the systems in this document. Each system's page lists its own.", { size: 7.5, color: MUTED });
  }
}

function systemCard({ l, art }: Ctx, x: Evaluated, index: number, cx: number, top: number, w: number, h: number) {
  const { design, ev } = x;
  const odu = oduById.get(design.oduId ?? -1);
  l.box(cx, top, w, h, { fill: C.white, border: C.line, borderWidth: 0.7, radius: 6 });
  if (odu) l.image(art.get(oduArt(odu.model, odu.coolingBtu, design.system)), cx + 8, top - 8, 66, 54);
  const tx = cx + 84;
  const tw = w - 92;
  statusPill(l, ev.status, cx + w - 8, top - 14, 6.5);
  l.draw(`SYSTEM ${index + 1}`, tx, top - 16, 6.5, { bold: true, color: C.accent });
  l.draw(l.fit(design.name, 11, tw - 50, true), tx, top - 29, 11, { bold: true });
  l.draw(l.fit(odu?.model ?? "No outdoor unit", 8.5, tw, true), tx, top - 41, 8.5, { bold: true, color: C.headerFg });
  l.draw(l.fit([SYSTEM_NAME[design.system], odu?.refrigerant].filter(Boolean).join(" · "), 7, tw), tx, top - 51, 7, { color: C.muted });
  const cap = ev.capacity;
  l.draw(l.fit(`At design: ${btu(cap?.cooling?.systemBtu)} cool · ${btu(cap?.heating?.systemBtu)} heat Btu/h`, 7, tw), tx, top - 61, 7, { color: C.muted });
  l.page.drawLine({ start: { x: cx + 8, y: top - 70 }, end: { x: cx + w - 8, y: top - 70 }, thickness: 0.5, color: C.lineSoft });
  let ix = cx + 8;
  for (const p of design.idus.slice(0, 8)) {
    l.image(art.get(iduArt(p.iduId) ?? ""), ix, top - 76, 20, 22);
    ix += 22;
  }
  const rooms = design.idus.map((p) => p.room || iduById.get(p.iduId)?.model || "Indoor unit");
  const text = rooms.length ? `${plural(rooms.length, "indoor unit")}: ${rooms.join(", ")}` : "No indoor units yet";
  l.draw(l.fit(text, 7, cx + w - 8 - ix - 4), ix + 4, top - 89, 7, { color: C.ink });
}

// ---- System section ----

function issueLine(x: Evaluated, i: Issue) {
  const who = i.target ? x.unitLabel(i.target) : "";
  return `${who && i.target !== "odu" ? `${who}: ` : ""}${i.message}`;
}

function capacityRows(x: Evaluated, mode: "cooling" | "heating", cap: ModeCapacity): string[][] {
  const odu = oduById.get(x.design.oduId ?? -1);
  const rows = x.design.idus.map((p) => {
    const u = iduById.get(p.iduId);
    const rated = mode === "cooling" ? u?.coolingBtu : u?.heatingBtu;
    return [x.unitLabel(p.key), btu(rated), btu(cap.perIdu[p.key])];
  });
  rows.push(["System total", "", btu(cap.systemBtu)]);
  if (cap.oduBtu != null) rows.push([`Outdoor unit limit (${odu?.model ?? "?"})`, btu(mode === "cooling" ? odu?.coolingBtu : odu?.heatingBtu), btu(cap.oduBtu)]);
  return rows;
}

function factorLine(cap: ModeCapacity) {
  const f = cap.factors;
  return [`temperature ${pct(f.temperature)}`, `piping ${pct(f.piping)}`, f.defrost != null ? `defrost ${pct(f.defrost)}` : "", `connection ${pct(f.connection)}`, `altitude ${pct(f.altitude)}`].filter(Boolean).join(", ");
}

function systemSection(ctx: Ctx, x: Evaluated, index: number, total: number, bomIcon: (b: BomLine) => string | undefined) {
  const { l, art } = ctx;
  const { design, ev } = x;
  const odu = oduById.get(design.oduId ?? -1);
  l.newPage();

  // Title and result
  const top = l.y;
  const errors = ev.issues.filter((i) => i.severity === "error").length;
  const warnings = ev.issues.filter((i) => i.severity === "warning").length;
  const pillW = statusPill(l, ev.status, l.right, top - 9, 8.5);
  if (total > 1) l.draw(`SYSTEM ${index + 1} OF ${total}`, l.left, top - 8, 6.5, { bold: true, color: C.accent });
  l.draw(l.fit(`${total > 1 ? `System ${index + 1}: ` : ""}${design.name}`, 16, CONTENT_W - pillW - 20, true), l.left, top - 25, 16, { bold: true });
  l.draw([SYSTEM_NAME[design.system], odu?.model, odu?.refrigerant].filter(Boolean).join("  ·  "), l.left, top - 37, 8.5, { color: MUTED });
  if (errors || warnings) l.drawRight(`${plural(errors, "error")} · ${plural(warnings, "warning")}`, l.right, top - 26, 7, { color: MUTED });
  l.y = top - 42;

  // Key numbers
  const cap = ev.capacity;
  const s = ev.summary;
  const pctTxt = s?.connectedPct != null ? ` (${Math.round(s.connectedPct)}%)` : "";
  tiles(l, [
    { label: "Connected", value: s ? btu(s.connectedBtu) : "-", sub: s ? `of ${btu(s.oduBtu)} Btu/h${pctTxt}` : "Btu/h indoor" },
    { label: "Cooling at design", value: btu(cap?.cooling?.systemBtu), sub: cap?.cooling?.limitedByOdu ? "Btu/h, outdoor limited" : "Btu/h" },
    { label: "Heating at design", value: btu(cap?.heating?.systemBtu), sub: cap?.heating?.limitedByOdu ? "Btu/h, outdoor limited" : "Btu/h" },
    { label: "Added charge", value: ev.charge ? `${Math.round(ev.charge.additionalOz * 10) / 10} oz` : "-", sub: ev.charge ? (ev.charge.additionalOz >= 16 ? oz(ev.charge.additionalOz).replace(/^.*\(|\)$/g, "") : odu?.refrigerant) : "not calculated" },
    { label: "Outdoor MCA / MOCP", value: ev.specs?.odu.mca || ev.specs?.odu.mocp ? `${ev.specs?.odu.mca ?? "-"} / ${ev.specs?.odu.mocp ?? "-"} A` : "-", sub: ev.specs?.odu.power ?? "" },
  ]);

  // Diagram
  if (odu) {
    l.gap(4);
    diagram(ctx, x);
  }

  // Checks
  l.heading("Checks", 30);
  const shown = ev.issues.filter((i) => i.code !== "LEGACY");
  if (!shown.length) l.text(ev.status === "incomplete" ? "Not checked yet: pick an outdoor unit and its indoor units." : "No errors or warnings from the checks this tool runs.", { size: 9, color: ev.status === "pass" ? C.good : C.ink });
  for (const i of [...shown].sort((a, b) => ["error", "warning", "info"].indexOf(a.severity) - ["error", "warning", "info"].indexOf(b.severity))) l.bullet(issueLine(x, i), { size: 8.5, tag: SEVERITY[i.severity] });
  for (const i of ev.issues.filter((i) => i.code === "LEGACY")) l.bullet(issueLine(x, i), { size: 8.5, color: MUTED, tag: { text: "LEGACY", color: C.faint } });

  // Equipment
  l.heading("Equipment");
  const assignment = (key: string) => {
    const a = ev.assignments?.[key];
    if (!a) return "-";
    return [a.box != null ? `Box ${a.box + 1}` : "", a.port ? `port ${a.port}` : ""].filter(Boolean).join(", ") || "-";
  };
  const equipment: string[][] = [];
  const icons: (PDFImage | undefined)[] = [];
  if (odu) {
    equipment.push(["Outdoor unit", odu.model, `${odu.refrigerant} outdoor unit`, btu(odu.coolingBtu), btu(odu.heatingBtu), "-"]);
    icons.push(art.get(oduArt(odu.model, odu.coolingBtu, design.system)));
  }
  for (const p of design.idus) {
    const u = iduById.get(p.iduId);
    equipment.push([p.room || "Indoor unit", u?.model ?? `id ${p.iduId}`, u?.typeName ?? "-", btu(u?.coolingBtu), btu(u?.heatingBtu), assignment(p.key)]);
    icons.push(art.get(iduArt(p.iduId) ?? ""));
  }
  if (!equipment.length) l.text("No equipment picked yet.", { size: 9 });
  else
    l.table(
      [
        { label: "Location / room", width: 0.23 },
        { label: "Model", width: 0.17 },
        { label: "Type", width: 0.22 },
        { label: "Rated cooling, Btu/h", width: 0.13, align: "right" },
        { label: "Rated heating, Btu/h", width: 0.13, align: "right" },
        { label: "Box / port", width: 0.12 },
      ],
      equipment,
      { icons },
    );

  // Design conditions
  const c = { ...DEFAULT_CONDITIONS, ...design.settings?.conditions };
  const used = ev.capacity?.used;
  l.heading("Design conditions");
  l.pairs(
    [
      ["Location", c.location ? (LOCATIONS.get(c.location) ?? c.location) : "Entered manually / defaults"],
      ["Outdoor cooling", `${deg(c.coolOutdoorDbF)} dry bulb` + (used && used.coolOutdoorDbF !== c.coolOutdoorDbF ? ` (calculated at ${deg(used.coolOutdoorDbF)}, the unit's limit)` : "")],
      ["Outdoor heating", [c.heatOutdoorDbF != null ? `${deg(c.heatOutdoorDbF)} dry bulb` : "", `${deg(c.heatOutdoorWbF)} wet bulb`].filter(Boolean).join(", ") + (used && used.heatOutdoorWbF !== c.heatOutdoorWbF ? ` (calculated at ${deg(used.heatOutdoorWbF)} wet bulb, the unit's limit)` : "")],
      ["Indoor cooling", `${deg(c.coolIndoorWbF)} wet bulb`],
      ["Indoor heating", `${deg(c.heatIndoorDbF)} dry bulb`],
      ["Altitude", `${btu(c.altitudeFt)} ft`],
      ["Part numbers", design.settings?.brand === "TRME" ? "Trane" : design.settings?.brand === "ASME" ? "American Standard" : "Mitsubishi Electric"],
    ],
    105,
    2,
  );

  // Branch boxes and ports
  if (ev.layout?.boxes.length) {
    l.heading("Branch boxes and ports");
    const rows: string[][] = [];
    const boxIcons: (PDFImage | undefined)[] = [];
    ev.layout.boxes.forEach((b, bi) => {
      const keys = design.idus.filter((p) => ev.assignments?.[p.key]?.box === bi).map((p) => p.key);
      const onBox = keys.length ? keys : b.iduKeys;
      if (!onBox.length) {
        rows.push([`Box ${bi + 1}`, b.model, `${b.ports}`, "-", "No units"]);
        boxIcons.push(art.get(boxArt(b.ports)));
      }
      onBox.forEach((k, j) => {
        rows.push([j === 0 ? `Box ${bi + 1}` : "", j === 0 ? b.model : "", j === 0 ? `${b.ports}` : "", ev.assignments?.[k]?.port ?? "-", x.unitLabel(k)]);
        boxIcons.push(j === 0 ? art.get(boxArt(b.ports)) : undefined);
      });
    });
    l.table(
      [
        { label: "Box", width: 0.13 },
        { label: "Model", width: 0.2 },
        { label: "Ports", width: 0.08, align: "right" },
        { label: "Port", width: 0.08 },
        { label: "Indoor unit", width: 0.51 },
      ],
      rows,
      { icons: boxIcons },
    );
    if (ev.layout.joint) l.text(`Branch joint: ${ev.layout.joint}`, { size: 8.5, color: MUTED });
  } else if (ev.assignments && Object.values(ev.assignments).some((a) => a.port)) {
    l.heading("Port assignments");
    l.table(
      [
        { label: "Port", width: 0.12 },
        { label: "Indoor unit", width: 0.88 },
      ],
      design.idus.map((p) => [ev.assignments?.[p.key]?.port ?? "-", x.unitLabel(p.key)]),
    );
  }

  // Piping
  if (ev.piping?.length) {
    l.heading("Piping");
    l.table(
      [
        { label: "Run", width: 0.4 },
        { label: "Liquid", width: 0.1, align: "right" },
        { label: "Gas", width: 0.1, align: "right" },
        { label: "Length, ft", width: 0.13, align: "right" },
        { label: "Bends", width: 0.1, align: "right" },
        { label: "Equivalent, ft", width: 0.17, align: "right" },
      ],
      ev.piping.map((r) => [r.label, inch(r.liquidIn), inch(r.gasIn), ft(r.lengthFt), r.bends == null ? "-" : String(r.bends), ft(r.equivalentFt)]),
    );
  }

  // Line-set takeoff
  const linesets = ev.bom.filter((b) => b.category === "Line set");
  l.heading("Line-set takeoff", 30);
  if (linesets.length)
    l.table(
      [
        { label: "Size (liquid × gas)", width: 0.22 },
        { label: "Length, ft", width: 0.12, align: "right" },
        { label: "Runs", width: 0.66 },
      ],
      linesets.map((b) => [b.model, String(b.qty), b.reason ?? ""]),
    );
  else l.text("No line lengths entered, so there is no takeoff.", { size: 9 });

  // Refrigerant charge
  l.heading("Additional refrigerant charge", 30);
  if (ev.charge) {
    l.pairs([
      ["Additional charge", oz(ev.charge.additionalOz)],
      ...(ev.charge.totalKg != null ? [["System charge", `${Math.round(ev.charge.totalKg * 100) / 100} kg`] as [string, string]] : []),
      ...(ev.charge.maxKg != null ? [["Maximum charge", `${Math.round(ev.charge.maxKg * 100) / 100} kg`] as [string, string]] : []),
    ]);
    if (ev.charge.note) l.text(ev.charge.note, { size: 8.5, color: MUTED });
  } else l.text("Not calculated for this system. See the items not checked below.", { size: 9 });
  if (ev.a2l?.chargeIsFactoryOnly) l.text("R454B checks used the factory charge only because line lengths are missing.", { size: 8.5, color: MUTED });

  // Capacity
  const capColumns: Column[] = [
    { label: "Unit", width: 0.5 },
    { label: "Rated, Btu/h", width: 0.25, align: "right" },
    { label: "At design, Btu/h", width: 0.25, align: "right" },
  ];
  const boldRows = new Set([design.idus.length]);
  const modes = cap ? ([["cooling", cap.cooling], ["heating", cap.heating]] as const).filter((e): e is ["cooling" | "heating", ModeCapacity] => !!e[1]) : [];
  const capTables = modes.map(([mode, m]) => {
    const rows = capacityRows(x, mode, m);
    // The label, the table and its factors line stay on one page.
    return { mode, m, rows, h: l.tableHeight(capColumns, rows, { boldRows }) + 32 };
  });
  l.heading("Corrected capacity at design conditions", Math.min(capTables[0]?.h ?? 48, l.pageRoom - 40));
  if (cap && capTables.length) {
    for (const { mode, m, rows, h } of capTables) {
      if (h <= l.pageRoom) l.ensure(h);
      l.text(`${mode === "cooling" ? "Cooling" : "Heating"}${m.limitedByOdu ? " (indoor units scaled to the outdoor unit's capacity)" : ""}`, { size: 8.5, bold: true, color: mode === "cooling" ? C.accent : C.bad, after: 3 });
      l.table(capColumns, rows, { boldRows });
      l.text(`Factors: ${factorLine(m)}.`, { size: 7.5, color: MUTED, after: 6 });
    }
    for (const n of cap.notes) l.bullet(n, { size: 8, color: MUTED });
  } else l.text("Not calculated for this system.", { size: 9 });

  // Electrical
  if (ev.specs) {
    l.heading("Electrical");
    const sp = ev.specs;
    const rows = [["Outdoor unit", odu?.model ?? "-", sp.odu.power ?? "-", sp.odu.mca ?? "-", sp.odu.mocp ?? "-"]];
    for (const p of design.idus) {
      const u = sp.idus[p.key];
      rows.push([p.room || "Indoor unit", iduById.get(p.iduId)?.model ?? "-", u?.power ?? "-", u?.mca ?? "-", u?.mocp ?? "-"]);
    }
    l.table(
      [
        { label: "Unit", width: 0.24 },
        { label: "Model", width: 0.22 },
        { label: "Power", width: 0.26 },
        { label: "MCA, A", width: 0.14, align: "right" },
        { label: "MOCP, A", width: 0.14, align: "right" },
      ],
      rows,
    );
    const e = sp.efficiency;
    if (e) {
      l.heading("Efficiency", 30);
      l.pairs(
        [
          ["SEER2", e.seer2],
          ["EER2", e.eer2],
          ["HSPF2 (Region IV)", e.hspf2],
          ["HSPF2 (Region V)", e.hspf2Region5],
          ["COP", e.cop],
          ["Basis", e.basis],
        ].filter((r): r is [string, string] => !!r[1]),
      );
    }
  }

  // Bill of materials
  const bom = ev.bom.filter((b) => b.category !== "Line set");
  if (bom.length) {
    l.heading("Bill of materials");
    l.table(
      [
        { label: "Qty", width: 0.07, align: "right" },
        { label: "Model", width: 0.24 },
        { label: "Category", width: 0.14 },
        { label: "Description", width: 0.55 },
      ],
      bom.map((b) => [String(b.qty), b.model, b.category, `${b.description}${b.optional ? " (optional)" : ""}`]),
      { icons: bom.map((b) => art.get(bomIcon(b) ?? "")) },
    );
  }

  // Not checked
  l.heading("Not checked by this tool", 30);
  if (ev.unchecked.length) for (const u of ev.unchecked) l.bullet(u, { size: 8.5, color: MUTED });
  else l.text("Nothing listed for this system type.", { size: 9 });
}

export function pdfFilename(req: PdfRequest): string {
  const base = (req.job ?? (req.systems.length === 1 ? req.systems[0].name : "mini-split-systems")).replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return `${base || "mini-split"}-submittal.pdf`;
}

export async function renderDesignPdf(req: PdfRequest): Promise<Uint8Array> {
  const date = req.date ?? today();
  const systems = evaluateAll(req.systems);
  const brand: { logo?: Logo } = {}; // the frame draws later, once the logo is embedded in this document
  const l = await Layout.create(frame(req, date, () => brand.logo));
  brand.logo = await embedLogo(l.doc);
  const ctx: Ctx = { l, art: await embedArt(l.doc, artNeeded(systems)) };
  const bomIcon = bomArt(systems);
  if (systems.length > 1) cover(ctx, req, date, systems);
  systems.forEach((x, i) => systemSection(ctx, x, i, systems.length, bomIcon));
  return l.finish({
    title: `${req.job ? `${req.job}: ` : ""}mini-split system submittal`,
    subject: systems.map((x) => x.design.name).join(", "),
    author: req.preparedBy ?? brandName(),
    creator: site.name,
  });
}

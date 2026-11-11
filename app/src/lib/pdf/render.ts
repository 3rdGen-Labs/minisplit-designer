import "server-only";
import type { PDFPage } from "pdf-lib";
import designWeather from "@/data/design-locations.json";
import { dbVersion, iduById, oduById, str } from "../catalog";
import { DEFAULT_CONDITIONS, type Evaluation, type Issue, type ModeCapacity, type SystemDesign } from "../design";
import { evaluate, SYSTEM_NAME } from "../engine";
import { inch } from "../engine/lineset";
import { site } from "../site";
import { CONTENT_W, Layout, MUTED, RULE, type Column } from "./layout";
import type { PdfRequest } from "./request";

// Submittal-style PDF: one section (starting on its own page) per system, plus a cover page with a
// summary table when there is more than one. Every number comes from the same evaluate() the app uses.

const DISCLAIMER =
  "Independent planning tool, not affiliated with or endorsed by Mitsubishi Electric. Verify against current manufacturer documentation before quoting, ordering or installing. A passing result is not manufacturer approval.";

const LOCATIONS = new Map((designWeather.locations as { id: string; city: string; state: string }[]).map((l) => [l.id, `${l.city}, ${l.state} (${l.id})`]));
const catalogVersion = (() => {
  const v = dbVersion.find((r) => str(r.strCompany) !== "MESCA") ?? dbVersion[0];
  return str(v?.strDatabaseVersion) ?? "unknown";
})();

const STATUS = { pass: "PASS", fail: "FAIL", incomplete: "INCOMPLETE" } as const;
const SEVERITY = { error: "Error", warning: "Warning", info: "Note" } as const;

const btu = (v?: number) => (v == null || !Number.isFinite(v) ? "-" : Math.round(v).toLocaleString("en-US"));
const ft = (v?: number) => (v == null ? "-" : `${Math.round(v * 10) / 10}`);
const deg = (v?: number) => (v == null ? "-" : `${Math.round(v * 10) / 10} °F`);
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

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

function frame(req: PdfRequest, date: string) {
  const sub = [req.job, req.address, longDate(date)].filter(Boolean).join("  ·  ");
  return {
    headerHeight: 30,
    header(page: PDFPage, l: Layout) {
      const top = l.pageHeight - 40;
      l.draw(brandName(), l.left, top - 10, 11, { bold: true });
      const title = "Mini-split system submittal";
      l.draw(title, l.right - l.width(title, 9), top - 10, 9, { color: MUTED });
      l.draw(sub, l.left, top - 22, 8, { color: MUTED });
      page.drawLine({ start: { x: l.left, y: top - 27 }, end: { x: l.right, y: top - 27 }, thickness: 0.8, color: RULE });
    },
    footer(page: PDFPage, l: Layout, index: number, count: number) {
      const size = 6.8;
      const lines = l.wrap(DISCLAIMER, size, CONTENT_W - 60);
      let y = 40;
      page.drawLine({ start: { x: l.left, y: y + 4 }, end: { x: l.right, y: y + 4 }, thickness: 0.5, color: RULE });
      for (const line of lines) {
        y -= size * 1.3;
        l.draw(line, l.left, y, size, { color: MUTED });
      }
      y -= size * 1.3;
      l.draw(`${site.name} · ${site.url.replace(/^https?:\/\//, "")} · catalog data ${catalogVersion}`, l.left, y, size, { color: MUTED });
      const p = `Page ${index + 1} of ${count}`;
      l.draw(p, l.right - l.width(p, 7.5), 40 - size * 1.3, 7.5, { color: MUTED });
    },
  };
}

function cover(l: Layout, req: PdfRequest, date: string, systems: Evaluated[]) {
  l.newPage();
  l.gap(10);
  l.text(req.job ?? "Mini-split systems", { size: 16, bold: true, after: 4 });
  l.pairs(
    [
      ...(req.address ? [["Address", req.address] as [string, string]] : []),
      ["Date", longDate(date)],
      ...(req.preparedBy ? [["Prepared by", req.preparedBy] as [string, string]] : []),
      ["Systems", String(systems.length)],
    ],
    90,
  );
  l.heading("System summary");
  const cols: Column[] = [
    { label: "#", width: 0.04 },
    { label: "System", width: 0.2 },
    { label: "Outdoor unit", width: 0.17 },
    { label: "Indoor units", width: 0.09, align: "right" },
    { label: "Result", width: 0.12 },
    { label: "Cooling at design, Btu/h", width: 0.13, align: "right" },
    { label: "Heating at design, Btu/h", width: 0.13, align: "right" },
    { label: "Added charge", width: 0.12, align: "right" },
  ];
  l.table(
    cols,
    systems.map(({ design, ev }, i) => [
      String(i + 1),
      design.name,
      oduById.get(design.oduId ?? -1)?.model ?? "-",
      String(design.idus.length),
      STATUS[ev.status],
      btu(ev.capacity?.cooling?.systemBtu),
      btu(ev.capacity?.heating?.systemBtu),
      ev.charge ? `${Math.round(ev.charge.additionalOz * 10) / 10} oz` : "-",
    ]),
  );
  l.gap(8);
  l.text("Each system follows on its own page with equipment, checks, piping, charge, capacity and electrical data. Results are planning estimates from the reference data noted in the footer.", { size: 8.5, color: MUTED });
}

function issueLine(x: Evaluated, i: Issue) {
  const who = i.target ? x.unitLabel(i.target) : "";
  return `${SEVERITY[i.severity]}: ${who && i.target !== "odu" ? `${who}: ` : ""}${i.message}`;
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

function systemSection(l: Layout, x: Evaluated, index: number, total: number) {
  const { design, ev } = x;
  const odu = oduById.get(design.oduId ?? -1);
  l.newPage();
  l.text(`${total > 1 ? `System ${index + 1}: ` : ""}${design.name}`, { size: 14, bold: true, after: 2 });
  l.text([SYSTEM_NAME[design.system], odu?.model, odu?.refrigerant].filter(Boolean).join("  ·  "), { size: 9, color: MUTED, after: 4 });
  const errors = ev.issues.filter((i) => i.severity === "error").length;
  const warnings = ev.issues.filter((i) => i.severity === "warning").length;
  l.text(`Result: ${STATUS[ev.status]}${errors || warnings ? `  (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})` : ""}`, { size: 11, bold: true });

  // Equipment
  l.heading("Equipment");
  const assignment = (key: string) => {
    const a = ev.assignments?.[key];
    if (!a) return "-";
    return [a.box != null ? `Box ${a.box + 1}` : "", a.port ? `port ${a.port}` : ""].filter(Boolean).join(", ") || "-";
  };
  const equipment: string[][] = [];
  if (odu) equipment.push(["Outdoor unit", odu.model, `${odu.refrigerant} outdoor unit`, btu(odu.coolingBtu), btu(odu.heatingBtu), "-"]);
  for (const p of design.idus) {
    const u = iduById.get(p.iduId);
    equipment.push([p.room || "Indoor unit", u?.model ?? `id ${p.iduId}`, u?.typeName ?? "-", btu(u?.coolingBtu), btu(u?.heatingBtu), assignment(p.key)]);
  }
  if (!equipment.length) l.text("No equipment picked yet.", { size: 9 });
  else l.table(
    [
      { label: "Location / room", width: 0.2 },
      { label: "Model", width: 0.18 },
      { label: "Type", width: 0.24 },
      { label: "Rated cooling, Btu/h", width: 0.13, align: "right" },
      { label: "Rated heating, Btu/h", width: 0.13, align: "right" },
      { label: "Box / port", width: 0.12 },
    ],
    equipment,
  );
  if (ev.summary) {
    l.gap(3);
    l.text(`Connected indoor capacity ${btu(ev.summary.connectedBtu)} Btu/h on a ${btu(ev.summary.oduBtu)} Btu/h outdoor unit${ev.summary.connectedPct != null ? ` (${Math.round(ev.summary.connectedPct)}%)` : ""}.`, { size: 8.5, color: MUTED });
  }

  // Design conditions
  const c = { ...DEFAULT_CONDITIONS, ...design.settings?.conditions };
  const used = ev.capacity?.used;
  l.heading("Design conditions");
  l.pairs([
    ["Location", c.location ? (LOCATIONS.get(c.location) ?? c.location) : "Entered manually / defaults"],
    ["Outdoor cooling (dry bulb)", deg(c.coolOutdoorDbF) + (used && used.coolOutdoorDbF !== c.coolOutdoorDbF ? ` (calculated at ${deg(used.coolOutdoorDbF)}, the unit's limit)` : "")],
    ["Outdoor heating", [c.heatOutdoorDbF != null ? `${deg(c.heatOutdoorDbF)} dry bulb` : "", `${deg(c.heatOutdoorWbF)} wet bulb`].filter(Boolean).join(", ") + (used && used.heatOutdoorWbF !== c.heatOutdoorWbF ? ` (calculated at ${deg(used.heatOutdoorWbF)} wet bulb, the unit's limit)` : "")],
    ["Indoor", `${deg(c.coolIndoorWbF)} wet bulb cooling, ${deg(c.heatIndoorDbF)} dry bulb heating`],
    ["Altitude", `${btu(c.altitudeFt)} ft`],
    ["Part numbers", design.settings?.brand === "TRME" ? "Trane" : design.settings?.brand === "ASME" ? "American Standard" : "Mitsubishi Electric"],
  ]);

  // Checks
  l.heading("Checks", 30);
  const shown = ev.issues.filter((i) => i.severity !== "info" || i.code !== "LEGACY");
  if (!shown.length) l.text(ev.status === "incomplete" ? "Not checked yet: pick an outdoor unit and its indoor units." : "No errors or warnings from the checks this tool runs.", { size: 9 });
  for (const i of [...shown].sort((a, b) => ["error", "warning", "info"].indexOf(a.severity) - ["error", "warning", "info"].indexOf(b.severity))) l.bullet(issueLine(x, i));
  for (const i of ev.issues.filter((i) => i.code === "LEGACY")) l.bullet(issueLine(x, i), { color: MUTED });

  // Branch boxes and ports
  if (ev.layout?.boxes.length) {
    l.heading("Branch boxes and ports");
    const rows: string[][] = [];
    ev.layout.boxes.forEach((b, bi) => {
      const keys = design.idus.filter((p) => ev.assignments?.[p.key]?.box === bi).map((p) => p.key);
      const onBox = keys.length ? keys : b.iduKeys;
      if (!onBox.length) rows.push([`Box ${bi + 1}`, b.model, `${b.ports}`, "-", "No units"]);
      onBox.forEach((k, j) => rows.push([j === 0 ? `Box ${bi + 1}` : "", j === 0 ? b.model : "", j === 0 ? `${b.ports}` : "", ev.assignments?.[k]?.port ?? "-", x.unitLabel(k)]));
    });
    l.table(
      [
        { label: "Box", width: 0.1 },
        { label: "Model", width: 0.2 },
        { label: "Ports", width: 0.08, align: "right" },
        { label: "Port", width: 0.08 },
        { label: "Indoor unit", width: 0.54 },
      ],
      rows,
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
  const cap = ev.capacity;
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
    return { mode, m, rows, h: l.tableHeight(capColumns, rows, { boldRows }) + 30 };
  });
  l.heading("Corrected capacity at design conditions", Math.min(capTables[0]?.h ?? 48, l.pageRoom - 40));
  if (cap && capTables.length) {
    for (const { mode, m, rows, h } of capTables) {
      if (h <= l.pageRoom) l.ensure(h);
      l.text(`${mode === "cooling" ? "Cooling" : "Heating"}${m.limitedByOdu ? " (indoor units scaled to the outdoor unit's capacity)" : ""}`, { size: 9, bold: true });
      l.table(capColumns, rows, { boldRows });
      l.text(`Factors: ${factorLine(m)}.`, { size: 8, color: MUTED, after: 4 });
    }
    for (const n of cap.notes) l.bullet(n, { size: 8, color: MUTED });
  } else l.text("Not calculated for this system.", { size: 9 });

  // Electrical
  if (ev.specs) {
    l.heading("Electrical");
    const s = ev.specs;
    const rows = [["Outdoor unit", odu?.model ?? "-", s.odu.power ?? "-", s.odu.mca ?? "-", s.odu.mocp ?? "-"]];
    for (const p of design.idus) {
      const u = s.idus[p.key];
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
    const e = s.efficiency;
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
        { label: "Model", width: 0.22 },
        { label: "Category", width: 0.14 },
        { label: "Description", width: 0.57 },
      ],
      bom.map((b) => [String(b.qty), b.model, b.category, `${b.description}${b.optional ? " (optional)" : ""}`]),
    );
  }

  // Not checked
  l.heading("Not checked by this tool", 30);
  if (ev.unchecked.length) for (const u of ev.unchecked) l.bullet(u);
  else l.text("Nothing listed for this system type.", { size: 9 });
}

export function pdfFilename(req: PdfRequest): string {
  const base = (req.job ?? (req.systems.length === 1 ? req.systems[0].name : "mini-split-systems")).replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return `${base || "mini-split"}-submittal.pdf`;
}

export async function renderDesignPdf(req: PdfRequest): Promise<Uint8Array> {
  const date = req.date ?? today();
  const systems = evaluateAll(req.systems);
  const l = await Layout.create(frame(req, date));
  if (systems.length > 1) cover(l, req, date, systems);
  systems.forEach((x, i) => systemSection(l, x, i, systems.length));
  return l.finish({
    title: `${req.job ? `${req.job}: ` : ""}mini-split system submittal`,
    subject: systems.map((x) => x.design.name).join(", "),
    author: req.preparedBy ?? brandName(),
    creator: site.name,
  });
}

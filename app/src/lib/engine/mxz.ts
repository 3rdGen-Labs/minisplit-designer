// MXZ multi-zone (port-type and branch-box) and Smart Multi residential mode.
// Rules follow research/rules/mxz-and-smart-multi.md; section numbers are cited inline.
import { IDU_TYPE, num, search, str, tables, type IndoorUnit, type OutdoorUnit } from "../catalog";
import { Ctx, fmt, label, type Placed } from "./context";
import { checkHeights } from "./piping";
import { convertForRefrigerant } from "./single";

const isMP = (u: IndoorUnit) => u.typeId === IDU_TYPE.multiPosition;
const isCC = (u: IndoorUnit) => u.typeId === IDU_TYPE.casedCoil;

/* ---------- lookups ---------- */

// Combination table: key "<ODU model>|<sorted sizes>" -> rows (cool + heat). Rows whose model carries a
// stray leading symbol never match in DSB either, so they are left as-is (§1.2).
const combos = new Map<string, Record<string, unknown>[]>();
for (const r of tables.mxz_combinations) {
  if (!r.strModelNumber || !r.strIUCombination) continue;
  const k = `${String(r.strModelNumber).trim()}|${String(r.strIUCombination).trim()}`;
  const list = combos.get(k) ?? [];
  list.push(r);
  combos.set(k, list);
}

const exclusionsByOdu = new Map<string, string[]>();
for (const r of tables.mxz_exclusions) {
  if (!r.odu || !r.idu) continue;
  const list = exclusionsByOdu.get(String(r.odu)) ?? [];
  list.push(String(r.idu));
  exclusionsByOdu.set(String(r.odu), list);
}

/** §2.4: an IDU or branch box is excluded when its model regex-matches any entry for this ODU. */
export function isExcluded(odu: OutdoorUnit, model: string): boolean {
  return (exclusionsByOdu.get(odu.model) ?? []).some((p) => model.startsWith(p) || search(p, model));
}

/** §2.2 palette filter. */
export function multiCompatible(odu: OutdoorUnit, idu: IndoorUnit): boolean {
  if (!idu.systems.includes("MXZ") && !idu.systems.includes("MXZSM")) return false;
  if (odu.system === "MXZSM" && !idu.systems.includes("MXZSM") && !idu.systems.includes("MXZ")) return false;
  if (idu.refrigerant !== odu.refrigerant) return false;
  if (idu.typeId === IDU_TYPE.levKit) return false;
  if (isMP(idu) && !["C", "D", "SM"].includes(odu.generation)) return false;
  return !isExcluded(odu, idu.model);
}

/* ---------- main ---------- */

export function checkMulti(ctx: Ctx) {
  const odu = ctx.odu!;
  const n = ctx.placed.length;

  for (const x of ctx.placed) {
    if (x.u.refrigerant !== odu.refrigerant)
      ctx.error("REFRIGERANT_MISMATCH", `${label(x)} is ${x.u.refrigerant}; ${odu.model} is ${odu.refrigerant}.`, x.p.key);
    else if (x.u.typeId === IDU_TYPE.levKit) ctx.error("1143", `${x.u.model}: LEV kits can't be used on MXZ / Smart Multi.`, x.p.key);
    else if (!x.u.systems.includes("MXZ") && !x.u.systems.includes("MXZSM"))
      ctx.error("1143", `${x.u.model} is not an MXZ-compatible indoor unit.`, x.p.key);
    else if (isExcluded(odu, x.u.model)) ctx.error("1041", `${x.u.model} can't be connected to ${odu.model}.`, x.p.key);
  }

  // §2.5 counts
  if (n < odu.minIdus) ctx.incomplete("1034", `${odu.model} needs at least ${odu.minIdus} indoor units.`);
  const max = maxIdus(ctx);
  if (n > max) ctx.error("1017", `${odu.model} takes at most ${max} indoor units${max < odu.maxIdus ? " with this mix of units" : ""}.`);

  if (!odu.branchBox) portType(ctx);
  else branchBoxType(ctx);

  if (!n) return;
  capacityRatio(ctx);
  ratedWindow(ctx);
  checkHeights(ctx);

}

function maxIdus(ctx: Ctx): number {
  const odu = ctx.odu!;
  let max = odu.maxIdus;
  const reduced = num(odu.raw.numMaxQtyIDU_wPLA_EA7);
  const r454 = odu.refrigerant === "R454B";
  const trigger = ctx.placed.some((x) => isCC(x.u) || (r454 && odu.system === "MXZSM" ? x.u.model.startsWith("PLA") : /^PLA.*EA/.test(x.u.model)));
  if (reduced && trigger) max = Math.min(max, reduced);
  if (odu.model === "MXZ-3C24NAHZ4-U1" && ctx.placed.length === 1 && ctx.placed[0].u.model.startsWith("SVZ-KP24NA")) return Math.max(max, 1);
  return max;
}

/* ---------- port-type ---------- */

function portType(ctx: Ctx) {
  const odu = ctx.odu!;
  const n = ctx.placed.length;
  const ports = odu.ports;
  if (n > ports) ctx.error("1017", `${odu.model} has ${ports} ports.`);
  if (!n) return;

  // §2.3 combination table
  const sorted = [...ctx.placed].sort((a, b) => a.u.size - b.u.size);
  const key = sorted.map((x) => fmt(x.u.size)).join(" + ");
  const model = odu.generation === "B" ? odu.model.slice(0, 10) : odu.model;
  let rows = combos.get(`${model}|${key}`);
  if (!rows && odu.generation === "B") rows = [...combos.entries()].find(([k]) => k.startsWith(model) && k.endsWith(`|${key}`))?.[1];
  if (!rows) {
    ctx.error("1041", `The combination ${key} is not in Mitsubishi's combination table for ${odu.model}.`);
  } else if (rows.length >= 2) {
    const cool = rows.find((r) => num(r.numCoolorHeat) === 0) ?? rows[0];
    const heat = rows.find((r) => num(r.numCoolorHeat) === 1);
    const sizes = sorted.map((x) => x.u.size);
    for (const x of ctx.placed) {
      const col = `numCapacity_Unit${"ABCDEFGH"[sizes.indexOf(x.u.size)]}`;
      if (num(cool[col])) ctx.ratedCooling.set(x.p.key, num(cool[col]));
      if (heat && num(heat[col])) ctx.ratedHeating.set(x.p.key, num(heat[col]));
    }
  }

  // §2.6c / §2.7 mixing rules
  const mp = ctx.placed.filter((x) => isMP(x.u));
  const cc = ctx.placed.filter((x) => isCC(x.u));
  const pead = ctx.placed.filter((x) => x.u.model.startsWith("PEAD"));
  const sizeK = ctx.sizeSum;
  if (odu.refrigerant === "R410A") {
    const mpMax = odu.subGeneration >= 4 ? 2 : 1;
    if (mp.length > mpMax) ctx.error("1148", `${odu.model} can have ${mpMax === 1 ? "only 1" : "up to 2"} multi-position unit${mpMax > 1 ? "s" : ""}.`);
    if (cc.length > 2) ctx.error("1149", `${odu.model} can have at most 2 cased coils.`);
    if (mp.length === 1 && sizeK > odu.nominal) ctx.error("1150", `With a multi-position unit, connected capacity can't exceed 100% (${fmt(sizeK)}k on a ${odu.nominal}k unit).`);
    if (cc.length && sizeK > odu.nominal) ctx.error("1151", `With a cased coil, connected capacity can't exceed 100% (${fmt(sizeK)}k on a ${odu.nominal}k unit).`);
    if (mp.length === 1 && ctx.placed.some((x) => /^(PEAD|PCA|PLA)/.test(x.u.model))) ctx.error("1152", "A multi-position unit can't share this outdoor unit with P-Series indoor units (PEAD / PCA / PLA).");
    if (cc.length && pead.length) ctx.error("1153", "A cased coil can't share this outdoor unit with a PEAD.");
    if (odu.subGeneration >= 4 && mp.length === 2 && n > 2) ctx.error("1159", "With two multi-position units, no other indoor units can be connected.");
  } else if (odu.refrigerant === "R454B" && odu.generation === "D") {
    const mpcc = mp.length + cc.length;
    if (/MXZ-2D20/.test(odu.model)) {
      if (mpcc === 1 && sizeK > odu.nominal) ctx.error("1272", "With a multi-position unit or cased coil, connected capacity can't exceed 100%.");
    } else {
      if (mpcc > 2) ctx.error("1274", "Up to two multi-position / cased-coil units are allowed.");
      if (mpcc === 2 && n > 2) ctx.error("1275", "With two multi-position / cased-coil units, no other indoor units can be connected.");
      if (mpcc && pead.length) ctx.error("1276", "Multi-position / cased-coil units can't be combined with a PEAD.");
    }
  }
  if (pead.length > 2) ctx.error("1154", "At most 2 PEAD units on a port-type MXZ.");
  if (odu.generation === "D" && ctx.placed.filter((x) => x.u.model.startsWith("MFZ")).length > 2) ctx.error("1156", "At most 2 MFZ floor units on a D-generation MXZ.");

  // §4 piping per IDU line, equivalent lengths (actual + bends)
  const raw = odu.raw;
  const lens = ctx.placed.map((x) => ctx.eq(x.p));
  if (lens.some((l) => l == null)) {
    ctx.info("PIPE_BLANK", `Enter each indoor unit's line length to check piping (max ${fmt(num(raw.numFarthestIUfromOU_Equiv))} ft equivalent per unit, ${fmt(num(raw.numTotalPipeLength_MaxLength))} ft total).`);
  } else {
    const total = (lens as number[]).reduce((s, l) => s + l, 0);
    const maxTotal = num(raw.numTotalPipeLength_MaxLength);
    if (maxTotal && total > maxTotal) ctx.error("1023", `Total piping is ${fmt(total)} ft equivalent; the maximum is ${fmt(maxTotal)} ft.`);
    const far = num(raw.numFarthestIUfromOU_Equiv);
    for (const x of ctx.placed) if (far && ctx.eq(x.p)! > far) ctx.error("1024", `${label(x)} line is ${fmt(ctx.eq(x.p)!)} ft equivalent; the maximum per unit is ${fmt(far)} ft.`, x.p.key);
    casedCoilMinimum(ctx, (x) => ctx.eq(x.p));
    portTypeCharge(ctx, total);
  }
  // §4.3 bends: per line and total
  const perLine = num(raw.numBendsIUfromOU_Max);
  const totalBends = num(raw.numTotalBends_Max);
  for (const x of ctx.placed) if (perLine && (x.p.bends ?? 0) > perLine) ctx.error("1134", `${label(x)} has ${x.p.bends} bends; the maximum per line is ${perLine}.`, x.p.key);
  const bendSum = ctx.placed.reduce((s, x) => s + (x.p.bends ?? 0), 0);
  if (totalBends && bendSum > totalBends) ctx.error("1134", `${bendSum} bends in total; the maximum is ${totalBends}.`);

  portAdapters(ctx, odu.model, ctx.placed, "port", odu.ports);
}


function portTypeCharge(ctx: Ctx, total: number) {
  const odu = ctx.odu!;
  if (odu.refrigerant !== "R410A") return;
  const factor = num(odu.raw.numAddtlRefFactor) || 1.08;
  const included = num(odu.raw.numAddtlRefMinLength);
  if (!included || total <= included) return;
  const oz = (factor * (total - included)) / 5;
  ctx.charge = { additionalOz: oz, note: `${fmt(total - included)} ft equivalent beyond the ${fmt(included)} ft pre-charge` };
}

function casedCoilMinimum(ctx: Ctx, run: (x: Placed) => number | undefined) {
  if (!ctx.placed.length || !ctx.placed.every((x) => isCC(x.u))) return;
  const shortest = Math.min(...ctx.placed.map((x) => run(x) ?? Infinity));
  if (shortest < 33) ctx.error("1236", `Cased-coil piping is too short (${fmt(shortest)} ft). Run at least 33 ft to each cased coil.`);
}

/* ---------- branch-box type ---------- */

interface Box {
  model: string;
  ports: number;
  factor: number;
  members: Placed[];
}

function pickBox(odu: OutdoorUnit, ports: number): Record<string, unknown> | undefined {
  return tables.branch_boxes
    .filter((b) => num(b.numMaxBranchCount) === ports && num(b.numRefType) === flagFor(odu.refrigerant))
    .filter((b) => availableBox(b))
    .filter((b) => !isExcluded(odu, String(b.strModelNumber)))
    .sort((a, b) => String(b.strModelNumber).localeCompare(String(a.strModelNumber)))[0];
}
const flagFor = (r: string) => ({ R410A: 2, R454B: 8, R32: 16 })[r] ?? 2;
const availableBox = (b: Record<string, unknown>) => {
  const d = num(b.numMEUSUL) % 10 || num(b.numMEUSNonUL) % 10;
  return d === 1 || d === 3 || d === 2;
};


function autoBoxPorts(n: number): (3 | 5)[] {
  if (n <= 3) return [3];
  if (n <= 5) return [5];
  const out: (3 | 5)[] = [];
  for (let left = n; left > 0; left -= left > 3 ? 5 : 3) out.push(left > 3 ? 5 : 3);
  return out;
}

/**
 * Lay IDUs onto branch boxes. Box sizes come from the design (`boxPorts`) or are chosen automatically
 * (one 3- or 5-port box, or 5-port boxes plus a 3-port). Units with a chosen box go there first;
 * the rest fill the free ports, largest first.
 */
export function layoutBoxes(ctx: Ctx): Box[] {
  const odu = ctx.odu!;
  const sizes = ctx.design.boxPorts?.length ? ctx.design.boxPorts : autoBoxPorts(ctx.placed.length);
  const boxes: Box[] = sizes.map((ports) => {
    const row = pickBox(odu, ports) ?? pickBox(odu, ports === 3 ? 5 : 3);
    return { model: row ? String(row.strModelNumber) : `(no ${ports}-port box available)`, ports: row ? num(row.numMaxBranchCount) : ports, factor: row ? num(row.numConnectionFactor) : 0, members: [] };
  });
  // Capped ports take no unit, so a box holds its ports minus the capped ones.
  const room = (b: Box) => b.ports - cappedOn(ctx, boxes.indexOf(b)).length;
  const unplaced: Placed[] = [];
  for (const x of ctx.placed) {
    const b = x.p.box != null ? boxes[x.p.box] : undefined;
    if (b && b.members.length < room(b)) b.members.push(x);
    else {
      if (x.p.box != null && !b) ctx.warn("BOX_MISSING", `${label(x)} was set to branch box ${x.p.box + 1}, which doesn't exist; placed automatically.`, x.p.key);
      else if (b) ctx.warn("BOX_FULL", `Branch box ${x.p.box! + 1} is full; ${label(x)} was placed automatically.`, x.p.key);
      unplaced.push(x);
    }
  }
  for (const x of unplaced.sort((a, b) => b.u.size - a.u.size)) {
    const b = boxes.find((bx) => bx.members.length < room(bx));
    if (b) b.members.push(x);
    else ctx.error("BOX_PORTS", `Not enough branch box ports for ${label(x)}. Add a box or use larger boxes.`, x.p.key);
  }
  boxes.forEach((b, i) => b.members.forEach((m) => (ctx.assignments[m.p.key] = { box: i })));
  return boxes;
}

function branchBoxType(ctx: Ctx) {
  const odu = ctx.odu!;
  const raw = odu.raw;
  if (!ctx.placed.length) return;
  const boxes = layoutBoxes(ctx);
  ctx.layout = { boxes: boxes.map((b) => ({ model: b.model, ports: b.ports, iduKeys: b.members.map((m) => m.p.key) })) };

  if (boxes.length > 2) ctx.error("1017", `${odu.model} supports at most two branch boxes.`);

  for (const b of boxes) {
    if (b.model.startsWith("(")) ctx.error("BB_NONE", `No ${b.ports}-port branch box in the data works with ${odu.model}.`);
    else ctx.add({ model: b.model, description: `${b.ports}-port branch box`, qty: 1, category: "Branch box", reason: `serves ${b.members.map((m) => m.p.room).join(", ")}` });
  }
  if (boxes.length > 1) {
    ctx.layout.joint = addJoint(ctx);
  }

  // §3.3 connection factor: against the ODU when boxes are powered from it, else per box (600)
  const cfLimit = num(raw.numConnectionFactor);
  if (cfLimit && ["C", "D", "SM"].includes(odu.generation)) {
    const cf = (list: Placed[]) => list.filter((x) => !(isMP(x.u) && x.p.accessories?.SPTB1)).reduce((s, x) => s + x.u.connectionFactor, 0);
    if (ctx.design.boxesPoweredByOdu ?? true) {
      const total = cf(ctx.placed);
      if (total > cfLimit) ctx.error("1234", `Indoor connection factor totals ${total}; ${odu.model} allows ${cfLimit} with branch boxes powered from the outdoor unit.`);
    } else {
      boxes.forEach((b, i) => {
        const total = cf(b.members);
        if (b.factor && total > b.factor) ctx.error("1234", `Branch box ${i + 1} connection factor totals ${total}; the box allows ${b.factor}.`);
      });
    }
  }

  // §3.4 piping, equivalent lengths. With two or more boxes the main line runs to the joint.
  const bendEq = ctx.bendEquivFt;
  const main = ctx.design.mainLineFt == null ? undefined : ctx.design.mainLineFt + (ctx.design.bends ?? 0) * bendEq;
  const jointLegs = boxes.length > 1 ? boxes.map((_, i) => ctx.design.jointToBoxFt?.[i]) : [];
  const lines = ctx.placed.map((x) => ctx.eq(x.p));
  if (main == null || lines.some((l) => l == null) || jointLegs.some((l) => l == null)) {
    ctx.info(
      "PIPE_BLANK",
      boxes.length > 1
        ? "Enter the main line (outdoor unit to joint), each joint-to-box run and each indoor unit's line to check piping."
        : "Enter the main line (outdoor unit to branch box) and each indoor unit's line from its branch box to check piping.",
    );
  } else {
    const legs = jointLegs as number[];
    for (const x of ctx.placed) if (ctx.eq(x.p)! > 82) ctx.error("1042", `${label(x)} is ${fmt(ctx.eq(x.p)!)} ft equivalent from its branch box; the limit is 82 ft.`, x.p.key);
    const sumLines = (lines as number[]).reduce((s, l) => s + l, 0);
    const sumMax = odu.generation === "B" ? 197 : 311;
    if (sumLines > sumMax) ctx.error("1251", `Branch-box-to-indoor lines total ${fmt(sumLines)} ft; the limit is ${fmt(sumMax)} ft.`);
    const legMax = 98;
    legs.forEach((l, i) => l > legMax && ctx.error("1174", `Joint to branch box ${i + 1} is ${fmt(l)} ft; the limit is ${fmt(legMax)} ft.`));
    const toBoxes = main + legs.reduce((s, l) => s + l, 0);
    const mainMax = 180;
    if (toBoxes > mainMax) ctx.error("1043", `Outdoor unit to branch boxes totals ${fmt(toBoxes)} ft; the limit is ${fmt(mainMax)} ft.`);
    const total = toBoxes + sumLines;
    let maxTotal = num(raw.numTotalPipeLength_MaxLength);
    if (odu.system === "MXZSM") maxTotal = smCasedCoilMaxPiping(ctx, maxTotal);
    if (maxTotal && total > maxTotal) ctx.error("1023", `Total piping is ${fmt(total)} ft equivalent; the maximum is ${fmt(maxTotal)} ft.`);
    const far = num(raw.numFarthestIUfromOU_Equiv);
    const boxOf = (x: Placed) => ctx.assignments[x.p.key]?.box ?? 0;
    const run = (x: Placed) => main + (legs[boxOf(x)] ?? 0) + ctx.eq(x.p)!;
    for (const x of ctx.placed) if (far && run(x) > far) ctx.error("1024", `${label(x)} is ${fmt(run(x))} ft equivalent from the outdoor unit; the limit is ${fmt(far)} ft.`, x.p.key);
    casedCoilMinimum(ctx, run);
  }
  // §4.3 bends along each ODU -> IDU path
  const pathMax = num(raw.numBendsIUfromOU_Max);
  for (const x of ctx.placed) {
    const b = (ctx.design.bends ?? 0) + (x.p.bends ?? 0);
    if (pathMax && b > pathMax) ctx.error("1134", `${b} bends between ${odu.model} and ${label(x)}; the maximum is ${pathMax}.`, x.p.key);
  }

  portAdaptersForBoxes(ctx, boxes);
  ctx.unchecked.add("Branch-box elevations (box to box, box to indoor units)");
}

function addJoint(ctx: Ctx): string | undefined {
  const odu = ctx.odu!;
  const rows = tables.acc_outdoor_include.filter((r) => search(String(r.strModelNumber), odu.model) && /^MSDD-50(A|B)R/.test(String(r.strAccessoryNumber)));
  const pick = rows.find((r) => /^MSDD-50AR/.test(String(r.strAccessoryNumber))) ?? rows[0];
  const model = pick ? String(pick.strAccessoryNumber) : undefined;
  if (!model) {
    ctx.warn("JOINT", "Two branch boxes need a branch joint, but none is listed for this outdoor unit. Add one manually.");
    return;
  }
  const alt = rows.filter((r) => String(r.strAccessoryNumber) !== model).map((r) => String(r.strAccessoryNumber));
  ctx.add({ model, description: "Branch joint (two branch boxes)", qty: 1, category: "Kit", reason: alt.length ? `alternative: ${alt.join(", ")}` : "joint for two branch boxes" });
  return model;
}

/** §4.1 Smart Multi with cased coils: total piping limit shrinks. */
function smCasedCoilMaxPiping(ctx: Ctx, base: number): number {
  const coils = ctx.placed.filter((x) => isCC(x.u)).length;
  if (!coils) return base;
  const rated = ctx.ratedSum;
  if (rated <= 27000) return base;
  const sm60 = ctx.odu!.model.includes("60");
  const band = rated <= 54000 ? 0 : 1;
  const table = sm60 ? [[408, 361, 337], [384, 337, 314]] : [[341, 276, 276], [308, 243, 243]];
  return Math.min(base || Infinity, table[band][Math.min(coils, 3) - 1]);
}

/* ---------- capacity ---------- */

/** §2.6a maximum connection ratio, compared against Σ model size. Project setting: 100% or 130% (default). */
function capacityRatio(ctx: Ctx) {
  const odu = ctx.odu!;
  const setting = ctx.design.settings?.connectionRatio ?? 130;
  const anyMatch = (re: RegExp) => ctx.placed.some((x) => re.test(x.u.model));
  const hasCC = ctx.placed.some((x) => isCC(x.u));
  const hasMP = ctx.placed.some((x) => isMP(x.u));
  let factor = 1.3;
  if (odu.refrigerant === "R454B") {
    if (odu.system === "MXZSM") {
      const restricted = tables.r454b_mxzsm_capacity_restrictions.some((r) => ctx.placed.some((x) => search(String(r.strModelNumber ?? ""), x.u.model)));
      factor = restricted ? 1.05 : 1.3;
    } else if (/MXZ-2D20/.test(odu.model) && anyMatch(/^(SVZ|PAA)/)) factor = 1.0;
    else if (/MXZ-(3D24|3D30|4D30|5D36|5D42)/.test(odu.model) && anyMatch(/^PAA/)) factor = 1.0;
  } else if (setting === 100) {
    factor = 1.0;
  } else if (odu.system === "MXZ") {
    if ((hasCC || hasMP) && (!odu.branchBox || odu.model.startsWith("MXZ-8C60"))) factor = 1.0;
  } else if (odu.model.startsWith("MXZ-SM60") && hasCC) factor = 1.0;

  const limit = odu.nominal * factor;
  if (ctx.sizeSum > limit + 1e-9)
    ctx.error("1016", `Connected capacity is ${fmt(ctx.sizeSum)}k (${Math.round((ctx.sizeSum / odu.nominal) * 100)}%); ${odu.model} allows ${Math.round(factor * 100)}% (${fmt(limit)}k) with this mix.`);
}

/** §2.6b absolute rated-capacity window. */
function ratedWindow(ctx: Ctx) {
  const odu = ctx.odu!;
  const rated = ctx.ratedSum;
  if (rated < 12000) {
    ctx.incomplete("1056", `Connected indoor capacity is ${fmt(rated)} Btu/h; the minimum is 12,000 Btu/h.`);
  }
  if (odu.branchBox && ["C", "D", "SM"].includes(odu.generation)) {
    const max = odu.sizeMax * 1000;
    if (max && rated > max) ctx.error("1016", `Connected rated capacity is ${fmt(rated)} Btu/h; ${odu.model} allows ${fmt(max)} Btu/h.`);
  }
}

/* ---------- port adapters (§2.10) ---------- */

const ADAPTERS: Record<string, string> = {
  "0.25>0.375": "PAC-493PI",
  "0.375>0.625": "PAC-SG76RJ-E",
  "0.375>0.5": "MAC-A454JP-E",
  "0.5>0.375": "MAC-A455JP-E",
  "0.5>0.625": "MAC-A456JP-E",
  "0.625>0.75": "PAC-SG75RJ-E",
  "0.625>0.875": "PAC-SG71RJ-E",
  "0.625>1.125": "PAC-SL02RJ-E",
  "0.875>1.125": "PAC-SL03RJ-E",
};
const inch = (v: number) => (v === 0.25 ? '1/4"' : v === 0.375 ? '3/8"' : v === 0.5 ? '1/2"' : v === 0.625 ? '5/8"' : v === 0.75 ? '3/4"' : v === 0.875 ? '7/8"' : v === 1.125 ? '1-1/8"' : `${v}"`);

/**
 * Ports: a unit with a chosen port gets it (if it exists and is free); the rest take a free port with a
 * matching gas size where possible, largest gas line first.
 */
function assignPorts(ctx: Ctx, ports: string[], gasOf: (p: string) => number, placed: Placed[]): [Placed, string][] {
  const free = [...ports];
  const out: [Placed, string][] = [];
  const rest: Placed[] = [];
  for (const x of placed) {
    const want = x.p.port;
    const i = want ? free.indexOf(want) : -1;
    if (i >= 0) out.push([x, free.splice(i, 1)[0]]);
    else {
      if (want) ctx.warn("PORT_TAKEN", `Port ${want} isn't available for ${label(x)}; assigned automatically.`, x.p.key);
      rest.push(x);
    }
  }
  for (const x of rest.sort((a, b) => b.u.gasIn - a.u.gasIn || b.u.size - a.u.size)) {
    if (!free.length) break;
    const i = Math.max(0, free.findIndex((p) => Math.abs(gasOf(p) - x.u.gasIn) < 1e-6));
    out.push([x, free.splice(i, 1)[0]]);
  }
  return out;
}

const cappedOn = (ctx: Ctx, box: number) => ctx.design.cappedPorts?.[String(box)] ?? [];

function portAdapters(ctx: Ctx, model: string, placed: Placed[], where: string, ports = 5, capped: string[] = []) {
  const row = tables.mxz_port_sizes.find((r) => String(r.strModelNumber) === model);
  const letters = [..."ABCDE"].slice(0, ports).filter((p) => (!row || num(row[`GasSize${p}`])) && !capped.includes(p));
  const assigned = assignPorts(ctx, letters, (p) => num(row?.[`GasSize${p}`]), placed);
  for (const [x, port] of assigned) ctx.assignments[x.p.key] = { ...ctx.assignments[x.p.key], port };
  if (!row) return;
  for (const [x, port] of assigned) {
    for (const [kind, size] of [["Liquid", x.u.liquidIn], ["Gas", x.u.gasIn]] as const) {
      const portSize = num(row[`${kind}Size${port}`]);
      if (!portSize || !size || Math.abs(portSize - size) < 1e-6) continue;
      const adapter = ADAPTERS[`${portSize}>${size}`];
      if (!adapter) {
        ctx.error("PORT_ADAPTER", `${label(x)}: no adapter from a ${inch(portSize)} ${kind.toLowerCase()} ${where} to ${inch(size)}.`, x.p.key);
        continue;
      }
      ctx.add({
        model: convertForRefrigerant(adapter, ctx.odu!.refrigerant),
        description: `Port adapter ${inch(portSize)} to ${inch(size)}`,
        qty: 1,
        category: "Accessory",
        reason: `${x.u.model} on ${where} ${port} (${kind.toLowerCase()})`,
      });
    }
  }
}

function portAdaptersForBoxes(ctx: Ctx, boxes: Box[]) {
  boxes.forEach((b, i) => portAdapters(ctx, b.model, b.members, `${b.model} port`, b.ports, cappedOn(ctx, i)));
}

export const _internal = { combos, exclusionsByOdu, str };
export { isCC, isMP };

// Corrected capacity at the design conditions, following research/rules/capacity-derates.md (sections inline).
import "server-only";
import deratesData from "@/data/derates.json";
import { DEFAULT_CONDITIONS, type CapacityResult, type DesignConditions, type ModeCapacity } from "../design";
import { num, str, type OutdoorUnit, type Row } from "../catalog";
import { Ctx, type Placed } from "./context";

type Mode = "cooling" | "heating";
const D = deratesData as unknown as Record<string, Row[]> & { odu_extra: Record<string, Record<string, number | string>> };

const toC = (f: number) => ((f - 32) * 5) / 9;
const toF = (c: number) => c * 1.8 + 32;
const ftToM = (ft: number) => ft / 3.28; // DSB's derate code uses 3.28, not 3.28084 (§ units)
const KW = 3412.14208984375;

/** Rows keyed by ODU model, built once per table. */
const byModel = new Map<string, Map<string, Row[]>>();
function rowsFor(table: string, model: string): Row[] {
  let idx = byModel.get(table);
  if (!idx) {
    idx = new Map();
    for (const r of D[table] ?? []) {
      const k = String(r.strModelNumber ?? "");
      const list = idx.get(k) ?? [];
      list.push(r);
      idx.set(k, list);
    }
    byModel.set(table, idx);
  }
  return idx.get(model) ?? [];
}

const extra = (odu: OutdoorUnit) => D.odu_extra[odu.model] ?? {};
const oldModel = (odu: OutdoorUnit) => str(extra(odu).strOldUnitModelNo);

/** Model rows with the previous-generation fallback (§1.2). */
function modelRows(table: string, odu: OutdoorUnit, model = odu.model, notes?: string[]): Row[] {
  const rows = rowsFor(table, model);
  if (rows.length) return rows;
  const old = oldModel(odu);
  const prev = old ? rowsFor(table, old) : [];
  if (prev.length && notes) notes.push(`Some derates use the previous generation's data (${old}).`);
  return prev;
}

/* ---------- §4.1 temperature correction ---------- */

interface TempRow {
  indoorF: number;
  loF: number;
  hiF?: number;
  coef: number[];
}
type Evaluator = (coef: number[], xC: number) => number;
const quartic: Evaluator = (c, x) => c[0] * x ** 4 + c[1] * x ** 3 + c[2] * x ** 2 + c[3] * x + c[4];
const quadratic: Evaluator = (c, x) => c[0] * x * x + c[1] * x + c[2];
const constant: Evaluator = (c) => c[0];

function tempRows(rows: Row[], indoor: string, lo: string, hi: string | undefined, coefCols: string[]): TempRow[] {
  return rows.map((r) => ({
    indoorF: toF(num(r[indoor])),
    loF: toF(num(r[lo])),
    hiF: hi && r[hi] != null ? toF(num(r[hi])) : undefined,
    coef: coefCols.map((c) => num(r[c])),
  }));
}

/** Two-axis lookup: indoor groups, outdoor bracketing, coefficient interpolation, then evaluate (§4.1 steps 1-5). */
function interpolateTemp(rows: TempRow[], tIn: number, tOut: number, evaluate: Evaluator, pointTable: boolean, extend: boolean): number | undefined {
  if (!rows.length) return undefined;
  const groups = new Map<number, TempRow[]>();
  for (const r of rows) groups.set(r.indoorF, [...(groups.get(r.indoorF) ?? []), r]);
  const keys = [...groups.keys()].sort((a, b) => a - b);
  const exact = keys.find((k) => Math.abs(k - tIn) < 0.01);
  const lowerKey = exact ?? [...keys].reverse().find((k) => k < tIn) ?? keys[0];
  const upperKey = exact ?? keys.find((k) => k >= tIn) ?? keys[keys.length - 1];

  const groupCoef = (key: number): number[] => {
    const g = groups.get(key)!.sort((a, b) => a.loF - b.loF);
    const prev = [...g].reverse().find((r) => r.loF <= tOut) ?? g[0];
    const next = (pointTable ? g.find((r) => r.loF > tOut) : g.find((r) => (r.hiF ?? r.loF) > tOut)) ?? g[g.length - 1];
    if (!extend || prev === next || next.loF === prev.loF) return prev.coef;
    const w = (tOut - prev.loF) / (next.loF - prev.loF);
    return prev.coef.map((c, i) => c + (next.coef[i] - c) * w);
  };
  const a = groupCoef(lowerKey);
  const b = groupCoef(upperKey);
  const w = upperKey === lowerKey ? 0 : (tIn - lowerKey) / (upperKey - lowerKey);
  const coef = a.map((c, i) => c + (b[i] - c) * w);
  return evaluate(coef, toC(tOut));
}

/** The temperature table for this system and mode (§4.1 table choice), as normalized rows plus how to evaluate them. */
function tempTable(odu: OutdoorUnit, mode: Mode, style: "old" | "new", notes: string[]): { rows: TempRow[]; evaluate: Evaluator; point: boolean } | undefined {
  const cool = mode === "cooling";
  if (odu.system === "MandS" || odu.system === "P") {
    const model = odu.model.endsWith("-SLZ") ? odu.model.slice(0, -4) : odu.model;
    const q = modelRows(cool ? "Temperature_Cooling4thDegree" : "Temperature_Heating4thDegree", odu, model, notes);
    if (q.length)
      return {
        rows: tempRows(q, cool ? "numIndoorWB" : "numIndoorDB", cool ? "numOutdoorDBMin" : "numOutdoorWBMin", cool ? "numOutdoorDBMax" : "numOutdoorWBMax", ["numDerateFactorA", "numDerateFactorB", "numDerateFactorC", "numDerateFactorD", "numDerateFactorE"]),
        evaluate: quartic,
        point: false,
      };
    if (odu.system === "P") return undefined;
    const fallback = cool ? (D.Capacity_Cooling_MandS ?? []) : modelRows("Capacity_Heating_MandS", odu, model, notes);
    if (!fallback.length) return undefined;
    return { rows: tempRows(fallback, "numIndoorWB", "numOutdoorDB", undefined, ["numDerateFactor"]), evaluate: constant, point: true };
  }
  if (style === "old") {
    const r = modelRows(cool ? "Temperature_Cooling_MXZ" : "Temperature_Heating_MXZ", odu, odu.model, notes);
    return r.length ? { rows: tempRows(r, "numIndoorWB", "numOutdoorDB", undefined, ["numDerateFactorC"]), evaluate: constant, point: true } : undefined;
  }
  let r = modelRows(cool ? "Temperature_Cooling" : "Temperature_Heating", odu, odu.model, notes);
  if (!cool) r = r.filter((x) => num(x.numMode) === num(extra(odu).numMode));
  return r.length ? { rows: tempRows(r, "numIndoorWB", "numOutdoorDB", "numOutdoorDB_High", ["numDerateFactorA", "numDerateFactorB", "numDerateFactorC"]), evaluate: quadratic, point: false } : undefined;
}

/* ---------- §4.2 piping length ---------- */

const quad = (r: Row, l: number) => num(r.numDerateFactorA) * l * l + num(r.numDerateFactorB) * l + num(r.numDerateFactorC);

function pickInCurve(curve: Row[], l: number): Row {
  const c = [...curve].sort((a, b) => num(a.numEquivLength_Min) - num(b.numEquivLength_Min));
  if (l < num(c[0].numEquivLength_Min)) return c[0];
  if (l > num(c[c.length - 1].numEquivLength_Max)) return c[c.length - 1];
  return c.find((r) => num(r.numEquivLength_Min) <= l && l <= num(r.numEquivLength_Max)) ?? c[c.length - 1];
}

/** Generic piping table: curve mode (by total connected size N) or range mode (P). Undefined when there are no rows. */
function genericPiping(odu: OutdoorUnit, mode: Mode, lengthFt: number, n: number, notes: string[]): number | undefined {
  const rows = modelRows(mode === "cooling" ? "PipingLength_Cooling" : "PipingLength_Heating", odu, odu.model, notes);
  if (!rows.length) return undefined;
  const l = ftToM(lengthFt);
  if (odu.system === "P") {
    const sorted = [...rows].sort((a, b) => num(a.numEquivLength_Max) - num(b.numEquivLength_Max));
    const row = sorted.find((r) => num(r.numEquivLength_Max) >= l) ?? sorted[sorted.length - 1];
    return Math.min(1, quad(row, Math.max(l, num(row.numEquivLength_Min))));
  }
  const curves = new Map<number, Row[]>();
  for (const r of rows) curves.set(num(r.numTotalIUCapacity), [...(curves.get(num(r.numTotalIUCapacity)) ?? []), r]);
  const keys = [...curves.keys()].sort((a, b) => a - b);
  if (curves.has(n)) {
    const row = pickInCurve(curves.get(n)!, l);
    return quad(row, Math.max(l, num(row.numEquivLength_Min))); // exact curve: not capped (§8 Q9)
  }
  const lowerKey = [...keys].reverse().find((k) => k < n);
  const upperKey = keys.find((k) => k > n);
  let v: number;
  if (lowerKey != null && upperKey != null) {
    const lo = pickInCurve(curves.get(lowerKey)!, l);
    const hi = pickInCurve(curves.get(upperKey)!, l);
    const at = Math.max(l, num(hi.numEquivLength_Min));
    v = quad(lo, at) + ((quad(hi, at) - quad(lo, at)) * (n - lowerKey)) / (upperKey - lowerKey);
  } else {
    v = quad(pickInCurve(curves.get((lowerKey ?? upperKey)!)!, l), l);
  }
  return Math.min(1, v);
}

/** Linear interpolation over (x, value) points: first value below, last value above. */
function interpPoints(points: [number, number][], x: number): number {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  if (x <= p[0][0]) return p[0][1];
  if (x >= p[p.length - 1][0]) return p[p.length - 1][1];
  const i = p.findIndex(([k]) => k >= x);
  const [x0, y0] = p[i - 1];
  const [x1, y1] = p[i];
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** Legacy piping tables when the generic one has no rows (§4.2). */
function legacyPiping(ctx: Ctx, mode: Mode, farthestFt: number, totalFt: number): number | undefined {
  const odu = ctx.odu!;
  if (odu.system === "MandS") {
    const key = odu.model.slice(4, 6) === "D3" ? "D3" : "";
    const pts = rowsFor("PipingLength_MandS", key)
      .filter((r) => num(r.numCoolorHeat) === (mode === "cooling" ? 0 : 1))
      .map((r) => [num(r.numEquivLength), num(r.numDerateFactor)] as [number, number]);
    return pts.length ? interpPoints(pts, totalFt) : undefined;
  }
  if (odu.system === "MXZ") {
    const table = mode === "cooling" ? "PipingLength_Cooling_MXZ" : "PipingLength_Heating_MXZ";
    let rows = rowsFor(table, odu.model);
    if (!rows.length) rows = rowsFor(table, odu.model.slice(0, 10));
    if (mode === "cooling" && odu.generation === "C" && /(NA|NAHZ|2-U1)$/.test(odu.model)) {
      const far = farthest(ctx);
      const size = far?.u.size ?? 0;
      const k = size <= 9 ? "MXZ-C2_6-9" : size <= 18 ? "MXZ-C2_12-15-18" : "MXZ-C2_24-";
      if (!far) return 1;
      rows = rowsFor(table, k);
    }
    const pts = rows.map((r) => [num(r.numEquivLength), num(r.numDerateFactor)] as [number, number]);
    return pts.length ? interpPoints(pts, ftToM(farthestFt)) : undefined;
  }
  return undefined;
}

/* ---------- distances ---------- */

/** Equivalent length from the ODU to an IDU (ft), or undefined if lengths are missing. */
function runFt(ctx: Ctx, x: Placed): number | undefined {
  const odu = ctx.odu!;
  if (odu.system === "MandS" || odu.system === "P") {
    const l = ctx.design.totalPipeFt;
    return l == null ? undefined : l + (ctx.design.bends ?? 0) * ctx.bendEquivFt;
  }
  const own = ctx.eq(x.p);
  if (own == null) return undefined;
  if (!odu.branchBox) return own;
  if (ctx.design.mainLineFt == null) return undefined;
  const main = ctx.design.mainLineFt + (ctx.design.bends ?? 0) * ctx.bendEquivFt;
  const boxes = ctx.layout?.boxes ?? [];
  const leg = boxes.length > 1 ? ctx.design.jointToBoxFt?.[ctx.assignments[x.p.key]?.box ?? 0] : 0;
  return leg == null ? undefined : main + leg + own;
}

function farthest(ctx: Ctx): Placed | undefined {
  let best: Placed | undefined;
  let bestFt = -1;
  for (const x of ctx.placed) {
    const f = runFt(ctx, x) ?? -1;
    if (f > bestFt) [best, bestFt] = [x, f];
  }
  return best;
}

/* ---------- §4.3 defrost, §4.4 altitude, §4.5 connected capacity ---------- */

function defrost(odu: OutdoorUnit, wbF: number, notes: string[]): number {
  if (odu.system === "P") return 1;
  if (odu.system === "MXZSM") {
    const pts = modelRows("Defrost", odu, odu.model, notes).map((r) => [num(r.numOutdoorDB), num(r.numDerateFactor)] as [number, number]);
    return pts.length ? Math.min(1, interpPoints(pts, toC(wbF))) : 1;
  }
  const table = odu.system === "MandS" ? D.Defrost_MandS : D.Defrost_MXZ;
  const pts = (table ?? []).map((r) => [toF(num(r.numOutdoorDB)), num(r.numDerateFactor)] as [number, number]).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return 1;
  if (wbF <= pts[0][0]) return pts[0][1];
  if (wbF > pts[pts.length - 1][0]) return 1;
  return interpPoints(pts, wbF);
}

function altitude(ft: number): { idu: number; odu: number } {
  const rows = D.Altitude ?? [];
  if (!rows.length || ft < 0 || ft > 10000) return { idu: 1, odu: 1 };
  return {
    idu: interpPoints(rows.map((r) => [num(r.numAltitude), num(r.numAirSourceSysIDU)]), ft),
    odu: interpPoints(rows.map((r) => [num(r.numAltitude), num(r.numAirSourceSysODU)]), ft),
  };
}

function connectionFactor(odu: OutdoorUnit, mode: Mode, n: number, notes: string[]): number {
  if (odu.system !== "MXZSM" && !(odu.system === "MXZ" && odu.branchBox)) return 1;
  const rows = modelRows(mode === "cooling" ? "OUCapacity_Cooling" : "OUCapacity_Heating", odu, odu.model, notes);
  if (!rows.length) return 1;
  const rated = mode === "cooling" ? odu.coolingBtu : odu.heatingBtu;
  let v: number;
  if (num(rows[0].numDerateCalcType) === 1) {
    const row = rows.find((r) => num(r.numTotalIUCapacity) <= n && n <= num(r.numTotalIUCapacity_High)) ?? rows[rows.length - 1];
    v = quad({ numDerateFactorA: row.numDerateFactorA, numDerateFactorB: row.numDerateFactorB, numDerateFactorC: row.numDerateFactorC }, n);
    const kind = num(row.numCalcDerateFactor);
    if (kind === 0) v = (v * KW) / rated;
    else if (kind === 2) v = v / (rated / 1000);
  } else {
    v = (interpPoints(rows.map((r) => [num(r.numTotalIUCapacity), num(r.numDerateFactorA)]), n) * KW) / rated;
  }
  return Math.max(1, v);
}

/* ---------- §2.2 clamping ---------- */

function clamp(v: number, min: unknown, max: unknown, gMin: number, gMax: number) {
  const lo = num(min);
  const hi = num(max);
  return lo && hi ? Math.min(Math.max(v, lo), hi) : Math.min(Math.max(v, gMin), gMax);
}

/* ---------- §3 combining ---------- */

export function correctedCapacity(ctx: Ctx, input?: DesignConditions): CapacityResult | undefined {
  const odu = ctx.odu;
  if (!odu || !ctx.placed.length) return undefined;
  const c = { ...DEFAULT_CONDITIONS, ...input };
  const raw = odu.raw;
  const used = {
    coolOutdoorDbF: clamp(c.coolOutdoorDbF, raw.numCooling_Outdoor_DBulb_Min, raw.numCooling_Outdoor_DBulb_Max, 14, 125.6),
    heatOutdoorWbF: clamp(c.heatOutdoorWbF, raw.numHeating_Outdoor_WBulb_Min, raw.numHeating_Outdoor_WBulb_Max, -13, 109),
    coolIndoorWbF: clamp(c.coolIndoorWbF, raw.numCooling_Indoor_WBulb_Min, raw.numCooling_Indoor_WBulb_Max, 59, 95),
    heatIndoorDbF: clamp(c.heatIndoorDbF, raw.numHeating_Indoor_DBulb_Min, raw.numHeating_Indoor_DBulb_Max, 59, 80),
    altitudeFt: Math.min(Math.max(c.altitudeFt, 0), 10000),
  };
  const notes: string[] = [];
  if (used.heatOutdoorWbF !== c.heatOutdoorWbF) notes.push(`Heating is calculated at ${used.heatOutdoorWbF} °F WB, the limit of ${odu.model}'s operating range.`);
  if (used.coolOutdoorDbF !== c.coolOutdoorDbF) notes.push(`Cooling is calculated at ${used.coolOutdoorDbF} °F, the limit of ${odu.model}'s operating range.`);
  const style = num(extra(odu).numCalcStylePhase) === 1 ? "new" : "old";
  const alt = altitude(used.altitudeFt);
  const n = ctx.sizeSum;
  const far = farthest(ctx);
  const farFt = far ? runFt(ctx, far) : undefined;
  const totalFt = ctx.piping.reduce((s, r) => s + (r.equivalentFt ?? r.lengthFt ?? 0), 0);
  const portType = (odu.system === "MXZ") && !odu.branchBox;
  if (farFt == null) notes.push("Piping derate assumes no loss until line lengths are entered.");

  const run = (mode: Mode): ModeCapacity | undefined => {
    const cool = mode === "cooling";
    if (!cool && !odu.heatingBtu) return undefined; // cooling-only units (boolCoolingOnly is unreliable in the data)
    const outT = cool ? used.coolOutdoorDbF : used.heatOutdoorWbF;
    const inT = (cool ? used.coolIndoorWbF : used.heatIndoorDbF);
    const ratedOut = cool ? 95 : 43;
    const ratedIn = cool ? 67 : 70;
    const table = tempTable(odu, mode, style, notes);
    if (!table) notes.push(`No ${mode} performance data for ${odu.model}; ${mode} isn't derated for temperature.`);
    const temp = (tIn: number, tOut: number, extend: boolean) => (table ? (interpolateTemp(table.rows, tIn, tOut, table.evaluate, table.point, extend) ?? 1) : 1);

    // piping: generic table first, then the legacy table (which reaches IDUs only through the ODU ceiling)
    let legacy = false;
    const pipingAt = (ft: number | undefined): number => {
      if (ft == null) return 1;
      const g = genericPiping(odu, mode, ft, n, notes);
      if (g != null) return g;
      legacy = true;
      return legacyPiping(ctx, mode, ft, totalFt) ?? 1;
    };
    const pipeSys = pipingAt(farFt);
    const frost = cool ? 1 : defrost(odu, used.heatOutdoorWbF, notes);
    const rated = (x: Placed) => (cool ? ctx.ratedCooling.get(x.p.key) : ctx.ratedHeating.get(x.p.key)) ?? 0;
    const perIdu: Record<string, number> = {};
    let oduCap: number;
    let tempSys: number;
    const conn = connectionFactor(odu, mode, n, notes);

    if (style === "old") {
      const temps = ctx.placed.map((x) => temp(inT, outT, true));
      const weights = ctx.placed.map(rated);
      const wsum = weights.reduce((s, w) => s + w, 0);
      tempSys = wsum ? temps.reduce((s, t, i) => s + t * weights[i], 0) / wsum : temps[0];
      ctx.placed.forEach((x, i) => {
        const pipe = legacy ? 1 : pipingAt(runFt(ctx, x));
        perIdu[x.p.key] = rated(x) * temps[i] * pipe * frost * alt.idu;
      });
      const altOdu = (odu.system === "MandS" || odu.system === "P") && ctx.placed.length === 1 ? alt.idu : alt.odu;
      oduCap = (cool ? odu.coolingBtu : odu.heatingBtu) * tempSys * pipeSys * frost * conn * altOdu;
    } else {
      tempSys = temp(ratedIn, outT, false);
      const overConnected = n * 1000 > odu.nominal * 1000;
      oduCap = (cool ? odu.coolingBtu : odu.heatingBtu) * (overConnected ? conn : 1) * tempSys * pipeSys * frost * alt.odu;
      for (const x of ctx.placed) perIdu[x.p.key] = rated(x) * temp(inT, ratedOut, false) * alt.idu;
    }

    // §3.3 scale IDUs down to the ODU (not port-type MXZ)
    const sum = Object.values(perIdu).reduce((s, v) => s + v, 0);
    const limitedByOdu = !portType && oduCap > 0 && sum / oduCap > 1 + 1e-9;
    if (limitedByOdu) for (const k of Object.keys(perIdu)) perIdu[k] = (perIdu[k] * oduCap) / sum;
    const systemBtu = Object.values(perIdu).reduce((s, v) => s + v, 0);
    return {
      systemBtu,
      oduBtu: portType ? undefined : oduCap,
      perIdu,
      limitedByOdu,
      factors: { temperature: tempSys, piping: pipeSys, defrost: cool ? undefined : frost, connection: conn, altitude: style === "old" ? alt.idu : alt.odu },
    };
  };

  return { cooling: run("cooling"), heating: run("heating"), used, style, notes: [...new Set(notes)] };
}

// R454B (A2L) refrigerant-safety checks, following research/rules/r454b-a2l.md (section numbers inline).
// All minimums are computed in m² with DSB's constants, then compared in ft² with DSB's rounding.
import type { A2lResult, A2lUnit } from "../design";
import { num, search, str, tables, type Row } from "../catalog";
import { Ctx, fmt, label, type Placed } from "./context";

const FT2_PER_M2 = 10.764;
const FT_PER_M = 3.28084;
const SM_HARD_MIN_M2 = 9;

const trunc1 = (v: number) => Math.floor(v * 10) / 10;
const trunc2 = (v: number) => Math.floor(v * 100) / 100;
const round2 = (v: number) => Math.round(v * 100) / 100;

const COIL_TYPES = new Set([20, 22, 9]); // multi-position, cased coil, vertical
const DUCTED_TYPES = new Set([5, 13]);

/** §5.2a ODU series key for the validation table, first match wins. */
const SERIES: [RegExp, string][] = [
  [/PUZ/, "PUZ"],
  [/PUY/, "PUY"],
  [/SUZ/, "SUZ"],
  [/MXZ-\dD/, "MXZ-D"],
  [/MXZ-SM\d+NL/, "MXZ-SM"],
];

// De-duplicated validation rows by series (§5.2e notes MXZ-D PVA rows are stored twice).
const rowsBySeries = new Map<string, Row[]>();
{
  const seen = new Set<string>();
  for (const r of tables.r454b_idu_validation) {
    const k = `${r.strODUSeries}|${r.strIDUModelNumber}|${r.strCase}|${r.numRefCharge}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const list = rowsBySeries.get(String(r.strODUSeries)) ?? [];
    list.push(r);
    rowsBySeries.set(String(r.strODUSeries), list);
  }
}

/** §3 installation case for coil units. */
function installationCase(p: Placed["p"]): A2lUnit["case"] | undefined {
  if (p.inConditionedSpace) return "D";
  if (p.installHeightFt == null) return undefined;
  const m = p.installHeightFt / FT_PER_M;
  return m >= 2.2 ? "A" : m >= 1.0 ? "B" : "C";
}

/** §5.2b TAmin / Amin (m²) for a coil unit, interpolated on charge; zeros when the table has no rows. */
function coilMinimums(oduModel: string, iduModel: string, kase: string, m: number): { tamin: number; amin: number } {
  const series = SERIES.find(([re]) => re.test(oduModel))?.[1];
  if (!series) return { tamin: 0, amin: 0 };
  const rows = (rowsBySeries.get(series) ?? [])
    .filter((r) => String(r.strCase) === kase && search(str(r.strIDUModelNumber), iduModel))
    .sort((a, b) => num(a.numRefCharge) - num(b.numRefCharge));
  if (!rows.length) return { tamin: 0, amin: 0 };
  const exact = rows.find((r) => num(r.numRefCharge) === m);
  const lo = [...rows].reverse().find((r) => num(r.numRefCharge) < m);
  const hi = rows.find((r) => num(r.numRefCharge) >= m);
  let tamin: number, amin: number;
  if (exact) [tamin, amin] = [num(exact.numTAmin), num(exact.numAmin)];
  else if (lo && hi) {
    const t = (m - num(lo.numRefCharge)) / (num(hi.numRefCharge) - num(lo.numRefCharge));
    tamin = num(lo.numTAmin) + t * (num(hi.numTAmin) - num(lo.numTAmin));
    amin = num(lo.numAmin) + t * (num(hi.numAmin) - num(lo.numAmin));
  } else {
    const r = (hi ?? lo)!;
    [tamin, amin] = [num(r.numTAmin), num(r.numAmin)];
  }
  return { tamin: round2(tamin), amin: round2(amin) };
}

export function checkA2l(ctx: Ctx) {
  const odu = ctx.odu!;
  if (odu.refrigerant !== "R454B" || !ctx.placed.length) return;
  const sm = odu.system === "MXZSM";
  const factoryOnly = ctx.charge?.totalKg == null;
  const m = ctx.charge?.totalKg ?? num(odu.raw.numRefrigerantWeight);
  const result: A2lResult = { chargeKg: m, chargeIsFactoryOnly: factoryOnly, units: {} };
  const missing = new Set<string>();

  for (const x of ctx.placed) {
    const p = x.p;
    const u = x.u;
    const coil = COIL_TYPES.has(u.typeId);
    const ducted = DUCTED_TYPES.has(u.typeId);
    const unit: A2lUnit = { coil, ducted };

    // §6.1 mounting height
    const minH = round2(num(u.raw.numMinUnitHeight));
    if (minH) {
      unit.minMountingFt = minH;
      if (p.installHeightFt == null) missing.add("mounting height");
      else if (p.installHeightFt < minH) ctx.error("1259", `${label(x)} is mounted at ${fmt(p.installHeightFt)} ft; R454B needs at least ${fmt(minH)} ft.`, p.key);
    }

    // §6.2 ducted grille heights
    if (ducted) {
      const minSupply = num(u.raw.numLowestHeightSupplyDuct);
      const minReturn = num(u.raw.numLowestHeightReturnDuct);
      unit.minGrilleFt = Math.max(minSupply, minReturn) || undefined;
      if (p.supplyGrilleFt == null || p.returnGrilleFt == null) missing.add("ducted grille heights");
      if (minSupply && p.supplyGrilleFt != null && p.supplyGrilleFt < minSupply)
        ctx.error("1260", `${label(x)}: lowest supply grille at ${fmt(p.supplyGrilleFt)} ft; R454B needs at least ${fmt(minSupply)} ft.`, p.key);
      if (minReturn && p.returnGrilleFt != null && p.returnGrilleFt < minReturn)
        ctx.error("1261", `${label(x)}: lowest return grille at ${fmt(p.returnGrilleFt)} ft; R454B needs at least ${fmt(minReturn)} ft. Use a high-wall or ceiling return.`, p.key);
    }

    if (coil) {
      // §5.2 two-area check by installation case
      const kase = installationCase(p);
      unit.case = kase;
      if (!kase) missing.add("mounting height or 'inside conditioned space' for coil units");
      else {
        const mins = coilMinimums(odu.model, u.model, kase, m);
        const amin = mins.amin;
        const tamin = sm ? Math.max(mins.tamin, SM_HARD_MIN_M2) : mins.tamin;
        unit.minAreaSqFt = trunc1(tamin * FT2_PER_M2);
        unit.minInstalledRoomSqFt = trunc1(amin * FT2_PER_M2);
        if (p.floorAreaSqFt == null) missing.add("floor area served");
        else if (round2(p.floorAreaSqFt / FT2_PER_M2) < tamin)
          ctx.error("1262", `${label(x)}: the conditioned area it serves (${fmt(p.floorAreaSqFt)} sq ft) is below the ${fmt(unit.minAreaSqFt)} sq ft minimum for ${m.toFixed(2)} kg in case ${kase}.`, p.key);
        if (amin) {
          if (p.installedRoomSqFt == null) missing.add("installed-room area for coil units");
          else if (p.installedRoomSqFt < unit.minInstalledRoomSqFt)
            ctx.error("1263", `${label(x)}: the room it's installed in (${fmt(p.installedRoomSqFt)} sq ft) is below the ${fmt(unit.minInstalledRoomSqFt)} sq ft minimum for case ${kase}. Mount it higher, enlarge the space, or install it inside the conditioned space.`, p.key);
        }
      }
    } else {
      // §5.1 / §5.3 / §5.4 room units (ducted units included)
      let minM2: number;
      if (!sm) minM2 = m / 0.27;
      else minM2 = Math.max(SM_HARD_MIN_M2, /MXZ-SM(36|48)NL$/.test(odu.model) ? (m + 2.7138) / 1.3316 : (m + 3.6333) / 1.8);
      const minFt2 = sm ? trunc2(minM2 * FT2_PER_M2) : trunc1(minM2 * FT2_PER_M2);
      unit.minAreaSqFt = minFt2;
      if (p.floorAreaSqFt == null) missing.add("floor area served");
      else if (p.floorAreaSqFt < minFt2) {
        ctx.error("1258", `${label(x)}: room is ${fmt(p.floorAreaSqFt)} sq ft; R454B needs at least ${fmt(minFt2)} sq ft for ${m.toFixed(2)} kg of refrigerant.`, p.key);
      }
    }
    result.units[p.key] = unit;
  }

  // §5.5 / §6.1 branch boxes in habitable rooms (Smart Multi)
  const boxes = ctx.layout?.boxes ?? [];
  if (sm && boxes.length) {
    const minBox = Math.round((3.7 * m + 0.1) * FT2_PER_M2 * 10) / 10;
    result.boxMinAreaSqFt = minBox;
    boxes.forEach((b, i) => {
      const room = ctx.design.boxRooms?.[i];
      if (!room?.habitable) return;
      const minH = num(tables.branch_boxes.find((r) => String(r.strModelNumber) === b.model)?.numMinUnitHeight_R454B) || 6.0;
      if (room.mountingHeightFt != null && room.mountingHeightFt < minH) ctx.error("1259", `Branch box ${i + 1} is mounted at ${fmt(room.mountingHeightFt)} ft; in a living space R454B needs at least ${fmt(minH)} ft.`);
      if (room.floorAreaSqFt == null) missing.add("floor area of branch boxes in living spaces");
      else if (room.floorAreaSqFt < minBox) ctx.error("1267", `Branch box ${i + 1} is in a ${fmt(room.floorAreaSqFt)} sq ft room; with ${m.toFixed(2)} kg it needs ${fmt(minBox)} sq ft, or move it to a utility area.`);
    });
  }

  // P-Series R454B short-line noise note (dialog warning in DSB)
  if (odu.system === "P" && ctx.design.totalPipeFt != null && ctx.design.totalPipeFt < 25)
    ctx.warn("P_R454B_SHORT_LINE", "R454B P-Series with less than 25 ft of piping may be noisy in very quiet rooms.");

  if (missing.size) ctx.info("R454B_INPUTS", `R454B checks need: ${[...missing].join(", ")}.`);
  if (factoryOnly) ctx.info("R454B_CHARGE", "R454B minimums use the factory charge until line lengths are entered.");
  ctx.a2l = result;
}

// M & S-Series single zone and P-Series rules, following research/rules/m-and-p-series.md (sections inline).
import { num, search, str, tables, type IndoorUnit, type OutdoorUnit } from "../catalog";
import { Ctx, fmt, label } from "./context";

const mRows = tables.compat_m_series.filter((r) => r.idu);
const pRows = tables.compat_p_series.filter((r) => r.idu);

const regexPair = (rows: typeof mRows, odu: OutdoorUnit, idu: IndoorUnit) =>
  rows.some((r) => search(String(r.odu), odu.model) && search(String(r.idu), idu.model));

/** Rated cooling within 10% of the ODU's. M & S rejects exactly 10%, P accepts it (§2.1, §2.2). */
const ratedClose = (odu: OutdoorUnit, idu: IndoorUnit, inclusive: boolean) => {
  if (!odu.coolingBtu) return false;
  const d = Math.abs(odu.coolingBtu - idu.coolingBtu) / odu.coolingBtu;
  return inclusive ? d <= 0.1 : d < 0.1;
};

/** The ODU's listed default IDU: always offered, regardless of region flags (§2.1b). */
export const isDefaultIdu = (odu: OutdoorUnit, idu: IndoorUnit) =>
  odu.system === "MandS" && !!odu.defaultIdu && odu.defaultIdu === idu.model && idu.refrigerant === odu.refrigerant;

/** §2.1a M & S pairing: regex row, rated capacity within 10% (or the SUZ-24 + PAA-A18 case), and CorrespOU as a filter. */
export function mPairs(odu: OutdoorUnit, idu: IndoorUnit): boolean {
  if (!idu.systems.includes("MandS")) return false;
  if (!regexPair(mRows, odu, idu)) return false;
  const special = /SUZ-.*24/.test(odu.model) && /PAA-(A|B)?A18/.test(idu.model);
  if (!special && !ratedClose(odu, idu, false)) return false;
  return !idu.correspondingOdu || search(idu.correspondingOdu, odu.model);
}

/** §2.2 special pairs that skip the capacity rules. */
const pSpecial = (odu: OutdoorUnit, idu: IndoorUnit) => idu.model.includes("S-MEXT") || (/PU(Y|Z)-.*24/.test(odu.model) && /PAA-(A|B)?A18/.test(idu.model));

/** §2.2a P pairing: regex row and rated capacity within 10%, or a special pair. */
export function pPairs(odu: OutdoorUnit, idu: IndoorUnit): boolean {
  if (!idu.systems.includes("P")) return false;
  if (!regexPair(pRows, odu, idu)) return false;
  return pSpecial(odu, idu) || ratedClose(odu, idu, true);
}

export function singleCompatible(odu: OutdoorUnit, idu: IndoorUnit): boolean {
  return odu.system === "MandS" ? isDefaultIdu(odu, idu) || mPairs(odu, idu) : pPairs(odu, idu);
}

export function checkSingle(ctx: Ctx) {
  const odu = ctx.odu!;
  const isP = odu.system === "P";
  const raw = odu.raw;

  // §4.3 counts. P twinning: every US P ODU allows one IDU and no US distribution pipe exists (§2.3).
  if (ctx.placed.length < odu.minIdus) ctx.incomplete("1034", `${odu.model} needs an indoor unit.`);
  if (ctx.placed.length > odu.maxIdus)
    ctx.error(
      "1017",
      isP ? `${odu.model} takes one indoor unit. DSB doesn't allow P-Series twinning in the US (no distribution pipe is available).` : `${odu.model} takes one indoor unit.`,
    );

  // §2 pairing
  for (const x of ctx.placed) {
    if (x.u.refrigerant !== odu.refrigerant) {
      ctx.error("REFRIGERANT_MISMATCH", `${label(x)} is ${x.u.refrigerant}; ${odu.model} is ${odu.refrigerant}.`, x.p.key);
      continue;
    }
    if (isP) {
      if (!pPairs(odu, x.u)) ctx.error("1044", `${x.u.model} can't connect to ${odu.model}.`, x.p.key);
    } else if (!isDefaultIdu(odu, x.u)) {
      if (x.u.correspondingOdu && !odu.model.startsWith(x.u.correspondingOdu)) ctx.error("1044", `${x.u.model} is matched to ${x.u.correspondingOdu}, not ${odu.model}.`, x.p.key);
      else if (!mPairs(odu, x.u)) ctx.error("1225", `${x.u.model} and ${odu.model} aren't a valid combination.`, x.p.key);
    }
  }

  // §4 capacity (Σ model size, kBtu)
  if (ctx.placed.length && odu.sizeMax) {
    const sum = ctx.sizeSum;
    if (!isP && sum > odu.sizeMax * 1.1) ctx.error("1016", `Indoor capacity is ${fmt(sum)}k; ${odu.model} allows up to ${fmt(odu.sizeMax * 1.1)}k.`);
    const exempt = ctx.placed.length === 1 && pSpecial(odu, ctx.placed[0].u);
    if (isP && !exempt && sum !== odu.sizeMax) (sum < odu.sizeMax ? ctx.incomplete : ctx.error).call(ctx, "1045", `P-Series needs exactly ${fmt(odu.sizeMax)}k of indoor capacity on ${odu.model}; this has ${fmt(sum)}k.`);
  }

  // §3.1 line-set length (equivalent), §3.3 bends
  const len = ctx.design.totalPipeFt;
  const eq = len == null ? undefined : len + (ctx.design.bends ?? 0) * ctx.bendEquivFt;
  let max = num(raw.numTotalPipeLength_MaxLength);
  const extended = num(raw.numTotalPipeLength_MaxLength_Extended);
  if (isP && extended && ctx.placed.some((x) => num(x.u.raw.boolAllowExtendingTotalPipingLength_Max) === 1)) max = extended;
  if (eq == null) ctx.info("PIPE_BLANK", `Enter the line-set length to check it (up to ${fmt(max)} ft equivalent).`, "odu");
  else if (max && eq > max) ctx.error("1023", `Line set is ${fmt(eq)} ft equivalent; the maximum for ${odu.model} is ${fmt(max)} ft.`, "odu");
  const bendsMax = num(raw.numTotalBends_Max);
  if (ctx.design.bends != null && bendsMax && ctx.design.bends > bendsMax)
    ctx.error(isP ? "1184" : "1134", `${ctx.design.bends} bends on the line set; the maximum is ${bendsMax}.`, "odu");
  // P cased coil: 100 ft equivalent max (DSB rejects it at entry)
  if (isP && eq != null && eq > 100)
    for (const x of ctx.placed) if (x.u.typeId === 22) ctx.error("P_CASED_COIL_LENGTH", `${label(x)}: a cased coil on P-Series is limited to 100 ft equivalent.`, x.p.key);

  heights(ctx, eq);

  if (isP) pSeriesPortAdapters(ctx);
  else mSeriesAdapters(ctx);
  singleCharge(ctx);
}

/** §3.4 ODU <-> IDU height. M & S uses the `_Above` limit in both directions; P is directional. Plus height vs length (M & S). */
function heights(ctx: Ctx, eq: number | undefined) {
  const odu = ctx.odu!;
  const raw = odu.raw;
  const above = Math.max(num(raw.numMaxHeightBetweenOUandIU_Above), num(raw.numMaxHeightBetweenOUandIU_Above_Override));
  const below = Math.max(num(raw.numMaxHeightBetweenOUandIU_Below), num(raw.numMaxHeightBetweenOUandIU_Below_Override));
  let missing = false;
  for (const x of ctx.placed) {
    const h = x.p.heightFt;
    if (h == null) {
      missing = true;
      continue;
    }
    // h > 0: IDU above the ODU (ODU below) -> `_Below`; h < 0: ODU above -> `_Above`.
    const limit = odu.system === "MandS" ? above : h > 0 ? below : above;
    if (limit && Math.abs(h) > limit)
      ctx.error("1019", `${label(x)} is ${fmt(Math.abs(h))} ft ${h > 0 ? "above" : "below"} the outdoor unit; the limit is ${fmt(limit)} ft.`, x.p.key);
    if (odu.system === "MandS" && h !== 0 && eq != null && eq < Math.abs(h))
      ctx.error("1201", `The line set (${fmt(eq)} ft) is shorter than the ${fmt(Math.abs(h))} ft height difference to ${label(x)}.`, x.p.key);
  }
  if (missing) ctx.info("HEIGHT_BLANK", "Enter each indoor unit's height relative to the outdoor unit to check elevation limits (0 if level).");
}

/** §6 P special pairs get a size adapter pair on the IDU. */
function pSeriesPortAdapters(ctx: Ctx) {
  const odu = ctx.odu!;
  for (const x of ctx.placed) {
    if (!pSpecial(odu, x.u)) continue;
    for (const model of ["MAC-A456JP-E", "PAC-493PI"])
      ctx.add({ model: convertForRefrigerant(model, odu.refrigerant), description: "Pipe size adapter", qty: 1, category: "Accessory", reason: `required for ${x.u.model} on ${odu.model}` });
  }
}

/** §6 M & S pairs that need an adapter (exact model matches). */
function mSeriesAdapters(ctx: Ctx) {
  const odu = ctx.odu!;
  for (const x of ctx.placed) {
    let model: string | undefined;
    if (["SUZ-KA12NA2.MX", "SUZ-KA12NAHZ.TH"].includes(odu.model) && /^PEAD-A12AA[789]$/.test(x.u.model)) model = "MAC-A455JP-E";
    if (["SUZ-AA12NLHZ", "SUZ-AA12NL"].includes(odu.model) && x.u.model.startsWith("PEAD-AA12N")) model = "PAC-SK88RJ-E";
    if (model) ctx.add({ model, description: "Pipe size adapter", qty: 1, category: "Accessory", reason: `required for ${x.u.model} on ${odu.model}` });
  }
}

export function convertForRefrigerant(model: string, refrigerant: string): string {
  if (refrigerant === "R410A") return model;
  const col = refrigerant === "R454B" ? "R410A_TO_R454B" : "R410A_TO_R32";
  const row = tables.refrigerant_conversion.find((r) => String(r.strModelNumber) === model);
  return (row && str(row[col])) || model;
}

const P_CASED_COIL_CHARGED = new Set(["PUZ-A24NHA7", "PUZ-A30NHA7", "PUY-A24NHA7", "PUY-A30NHA7", "PUZ-HA24NHA1"]);

/**
 * §5 field charge beyond the pre-charged length, on actual length.
 * M & S: factor oz per ft, capped at (max - factory) when a max exists.
 * P: factor oz per 10 ft; none with a cased coil (except five ODUs); capped only on R454B.
 */
function singleCharge(ctx: Ctx) {
  const odu = ctx.odu!;
  const raw = odu.raw;
  const len = ctx.design.totalPipeFt;
  if (len == null || !ctx.placed.length) return;
  const factory = num(raw.numRefrigerantWeight);
  const max = num(raw.numMaxRefCharge);
  const factor = num(raw.numAddtlRefFactor);
  const included = num(raw.numAddtlRefMinLength);
  const isP = odu.system === "P";
  const casedCoil = isP && ctx.placed.some((x) => x.u.typeId === 22) && !P_CASED_COIL_CHARGED.has(odu.model);
  let oz = !factor || len <= included || casedCoil ? 0 : isP ? ((len - included) / 10) * factor : (len - included) * factor;
  const capOz = max > factory && (!isP || odu.refrigerant === "R454B") ? (max - factory) * 35.274 : Infinity;
  const capped = oz > capOz;
  oz = Math.min(oz, capOz);
  const note = !oz
    ? casedCoil
      ? "no field charge with a cased coil on this outdoor unit"
      : `within the ${fmt(included)} ft pre-charged length`
    : `${fmt(len - included)} ft beyond ${fmt(included)} ft at ${isP ? `${factor} oz per 10 ft` : `${factor.toFixed(3)} oz/ft`}${capped ? ", capped at the unit maximum" : ""}`;
  if (capped) ctx.warn("CHARGE_CAPPED", `The calculated field charge is more than ${odu.model}'s maximum allows; it's shown capped, as DSB does. Check the line length.`, "odu");
  ctx.charge = { additionalOz: oz, totalKg: factory + oz / 35.274, maxKg: max || undefined, note };
}

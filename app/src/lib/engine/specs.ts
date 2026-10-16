// Electrical, efficiency ratings, document links and cobranded part numbers.
import type { BomLine, Brand, SystemSpecs, UnitSpecs } from "../design";
import { IDU_TYPE, str, tables, type Row } from "../catalog";
import type { Ctx } from "./context";

function unitSpecs(raw: Row, boxesPoweredByOdu = true): UnitSpecs {
  // Branch-box ODUs list two values ("42;36"): powered from the ODU first, separately second.
  const pick = (v: unknown) => {
    const s = str(v);
    if (!s) return undefined;
    const parts = s.split(";");
    return parts.length > 1 ? parts[boxesPoweredByOdu ? 0 : 1] : s;
  };
  const voltage = str(raw.strVoltage) ?? str(raw.strPowerSource);
  const phase = str(raw.strPhase);
  return {
    mca: pick(raw.strMCA),
    mocp: pick(raw.strMOCP),
    power: [voltage, phase].filter(Boolean).join(" ") || undefined,
    submittal: str(raw.strURLSubmittal),
    catalogue: str(raw.strURLCatalogue),
  };
}

const ratings = tables.efficiency_ratings;

/** Pick "23(Non-Ducted), 20.5(Mix), 18(Ducted)" -> the value for the system's mix. */
function forMix(v: unknown, mix: "Non-Ducted" | "Mix" | "Ducted"): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (!s.includes("(")) return s;
  return s.match(new RegExp(`([\\d.]+)\\(${mix}\\)`))?.[1];
}

const DUCTED = new Set<number>([IDU_TYPE.ducted, IDU_TYPE.multiPosition, IDU_TYPE.casedCoil, 9]);

function efficiency(ctx: Ctx): SystemSpecs["efficiency"] {
  const odu = ctx.odu!;
  let row: Row | undefined;
  let basis = "";
  if (ctx.placed.length === 1 && (odu.system === "MandS" || odu.system === "P")) {
    const pair = `${odu.model}-${ctx.placed[0].u.model}`;
    row = ratings.find((r) => str(r.strModelNumber) === pair);
    basis = row ? `rated pair ${pair}` : "";
  }
  if (!row) {
    row = ratings.find((r) => str(r.strModelNumber) === odu.model);
    basis = row ? `${odu.model} system rating` : "";
  }
  if (!row) return undefined;
  const ducted = ctx.placed.filter((x) => DUCTED.has(x.u.typeId)).length;
  const mix = ducted === 0 ? "Non-Ducted" : ducted === ctx.placed.length ? "Ducted" : "Mix";
  const isMix = String(row.strSEER2 ?? "").includes("(");
  return {
    seer2: forMix(row.strSEER2, mix),
    eer2: forMix(row.strEER2, mix),
    hspf2: forMix(row.strHSPF_IV, mix),
    hspf2Region5: forMix(row.strHSPF_V, mix),
    cop: forMix(row.strCOP, mix),
    basis: isMix ? `${basis}, ${mix.toLowerCase()} indoor units` : basis,
  };
}

export function systemSpecs(ctx: Ctx): SystemSpecs {
  const powered = ctx.design.boxesPoweredByOdu ?? true;
  return {
    odu: unitSpecs(ctx.odu!.raw, powered),
    idus: Object.fromEntries(ctx.placed.map((x) => [x.p.key, unitSpecs(x.u.raw)])),
    efficiency: efficiency(ctx),
  };
}

/* ---------- cobranded part numbers (controls-and-bom.md §4.4) ---------- */

const COLUMN: Record<Exclude<Brand, "ME">, string> = { TRME: "strModelNumber_TRME", ASME: "strModelNumber_ASME" };
const cobrandTables: Partial<Record<BomLine["category"], Row[]>> = {
  "Outdoor unit": tables.cobrand_odu,
  "Indoor unit": tables.cobrand_idu,
  "Branch box": tables.cobrand_branchbox,
  Controller: tables.cobrand_lrc,
};

/** Swap in Trane / American Standard numbers where a mapping exists; an empty column keeps the base model. */
export function applyBrand(lines: BomLine[], brand: Brand | undefined): BomLine[] {
  if (!brand || brand === "ME") return lines;
  const col = COLUMN[brand];
  return lines.map((l) => {
    const rows = cobrandTables[l.category];
    const hit = rows?.find((r) => str(r.strBaseModel) === l.model);
    const branded = hit ? str(hit[col]) : undefined;
    return branded && branded !== l.model ? { ...l, model: branded, baseModel: l.model } : l;
  });
}

// Refrigerant charge for branch-box MXZ and Smart Multi residential (mxz-and-smart-multi.md §6).
import { num, str } from "../catalog";
import { Ctx, fmt } from "./context";
import { isCC } from "./mxz";

const OZ_TO_KG = 0.0283495;
const SQFT_TO_M2 = 0.092903;

/** oz per ft of liquid line by liquid OD, per the ODU's additional-charge table code. */
const LIQUID_FACTORS: Record<string, Record<number, number>> = {
  E: { 0.5: 0.99, 0.375: 0.55, 0.25: 0.21 },
  F: { 0.375: 0.75, 0.25: 0.29 },
  G: { 0.375: 0.58, 0.25: 0.22 },
};

function lineCharge(ctx: Ctx, table: Record<number, number>): number {
  return ctx.piping.reduce((s, r) => s + (r.liquidIn ? (table[r.liquidIn] ?? 1.0) : 0) * (r.lengthFt ?? 0), 0);
}

const band = (v: number, steps: [number, number][], last: number) => steps.find(([max]) => v <= max)?.[1] ?? last;

export function multiCharge(ctx: Ctx) {
  const odu = ctx.odu!;
  if (!odu.branchBox) return portTypeMax(ctx); // port-type additional charge is computed with the piping checks
  if (ctx.piping.some((r) => r.lengthFt == null)) return;

  const code = str(odu.raw.strAddtionalRefChargeTableCode);
  const table = code ? LIQUID_FACTORS[code] : undefined;
  if (odu.generation === "B" || !table) {
    ctx.unchecked.add("Additional refrigerant charge for this outdoor unit");
    return;
  }
  const rated = ctx.ratedSum;
  let adder: number;
  if (odu.system === "MXZSM" && odu.refrigerant === "R454B") {
    adder = band(rated, [[27000, 142], [54000, 177]], 184);
  } else {
    adder = band(odu.nominal * 1000, [[27000, 53], [54000, 88]], 106);
  }
  const additionalOz = lineCharge(ctx, table) + adder;
  const totalKg = num(odu.raw.numRefrigerantWeight) + additionalOz * OZ_TO_KG;
  ctx.charge = { additionalOz, totalKg, note: `table ${code} line charge + ${adder} oz capacity adder` };
  checkMax(ctx, totalKg);
}

/** Port-type: R410A field charge comes from the piping checks; R454B D-generation takes no field charge. */
function portTypeMax(ctx: Ctx) {
  const odu = ctx.odu!;
  const factory = num(odu.raw.numRefrigerantWeight);
  if (odu.refrigerant === "R454B") {
    const max = num(odu.raw.numMaxRefCharge);
    ctx.charge = { additionalOz: 0, totalKg: factory, maxKg: max || undefined, note: "no field charge on R454B port-type units" };
    if (max && factory > max) ctx.error("1257", `Total R454B charge is ${fmt(factory)} kg; the maximum is ${fmt(max)} kg.`);
    return;
  }
  if (ctx.piping.some((r) => r.lengthFt == null)) return;
  ctx.charge ??= { additionalOz: 0, note: "within the pre-charged length" };
  const totalKg = factory + ctx.charge.additionalOz * OZ_TO_KG;
  ctx.charge.totalKg = totalKg;
  checkMax(ctx, totalKg);
}

function checkMax(ctx: Ctx, totalKg: number) {
  const odu = ctx.odu!;
  const coils = ctx.placed.filter((x) => isCC(x.u)).length;
  if (odu.refrigerant === "R410A") {
    let max = num(odu.raw.numMaxRefCharge);
    if (!max) return;
    if (odu.system === "MXZSM" && coils) max -= coils === 1 ? 1.5 : coils === 2 || !odu.model.includes("60") ? 2.5 : 3.0;
    ctx.charge!.maxKg = max;
    if (totalKg > max) ctx.error("1135", `Total refrigerant charge is ${fmt(totalKg)} kg; the maximum is ${fmt(max)} kg.`);
    return;
  }
  if (odu.refrigerant === "R454B" && odu.system === "MXZSM") {
    const hard = 14.4;
    let max = hard;
    const areas = ctx.placed.map((x) => x.p.floorAreaSqFt).filter((a): a is number => a != null && a > 0);
    if (areas.length) {
      const a = Math.min(...areas) * SQFT_TO_M2;
      const exact = odu.model === "MXZ-SM36NL" || odu.model === "MXZ-SM48NL";
      max = Math.min(hard, exact ? 1.3316 * a - 2.7138 : 1.8 * a - 3.6333);
    } else ctx.info("R454B_AREA", "Enter each room's floor area to check the R454B charge limit for the smallest room.");
    ctx.charge!.maxKg = max;
    if (totalKg > hard) ctx.error("1257", `Total R454B charge is ${fmt(totalKg)} kg; the hard limit is ${hard} kg.`);
    else if (totalKg > max) ctx.error("1257", `Total R454B charge is ${fmt(totalKg)} kg, more than the ${fmt(max)} kg allowed for the smallest room.`);
  }
}

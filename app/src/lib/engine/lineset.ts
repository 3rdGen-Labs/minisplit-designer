// Pipe size per run and the line-set takeoff (mxz-and-smart-multi.md §2.11; single zone from the unit data).
import type { PipeRun } from "../design";
import { num } from "../catalog";
import { Ctx, label, type Placed } from "./context";

export const inch = (v: number) =>
  ({ 0.25: '1/4"', 0.375: '3/8"', 0.5: '1/2"', 0.625: '5/8"', 0.75: '3/4"', 0.875: '7/8"', 1.125: '1-1/8"' })[v] ?? `${v}"`;

export function pipeRuns(ctx: Ctx) {
  const odu = ctx.odu!;
  const raw = odu.raw;
  const main = { liquid: num(raw.numPipeSizeA_High), gas: num(raw.numPipeSizeA_Low) };
  const runs: PipeRun[] = [];
  const iduRun = (x: Placed, from: string, gasBump = 0): PipeRun => ({
    label: `${from} → ${label(x)}`,
    target: x.p.key,
    liquidIn: x.u.liquidIn,
    gasIn: x.u.gasIn + gasBump,
    lengthFt: x.p.pipeLengthFt,
    bends: x.p.bends,
    equivalentFt: ctx.eq(x.p),
  });

  if (odu.system === "MandS" || odu.system === "P") {
    // M & S takes the ODU's sizes; P takes the IDU's own sizes (m-and-p-series.md §6).
    const x = ctx.placed[0];
    if (x) {
      const own = odu.system === "P";
      runs.push({
        label: `Line set ${odu.model} → ${label(x)}`,
        target: x.p.key,
        liquidIn: own ? x.u.liquidIn : main.liquid || x.u.liquidIn,
        gasIn: own ? x.u.gasIn : main.gas || x.u.gasIn,
        lengthFt: ctx.design.totalPipeFt,
        bends: ctx.design.bends,
        equivalentFt: ctx.design.totalPipeFt == null ? undefined : ctx.design.totalPipeFt + (ctx.design.bends ?? 0) * ctx.bendEquivFt,
      });
    }
  } else if (!odu.branchBox) {
    // Port-type MXZ: each unit on its own line at the unit's sizes; 4C36 (sub-gen >= 4) with two or more
    // PAA-A18 cased coils runs their gas line 1/8" larger.
    const paa18 = ctx.placed.filter((x) => x.u.model.startsWith("PAA-A18"));
    const bump = /^MXZ-4C36NA/.test(odu.model) && odu.subGeneration >= 4 && paa18.length >= 2;
    for (const x of ctx.placed) runs.push(iduRun(x, `Port ${ctx.assignments[x.p.key]?.port ?? "?"}`, bump && x.u.model.startsWith("PAA-A18") ? 0.125 : 0));
  } else {
    const boxes = ctx.layout?.boxes ?? [];
    runs.push({
      label: boxes.length > 1 ? "Main line to joint" : "Main line to branch box",
      liquidIn: main.liquid,
      gasIn: main.gas,
      lengthFt: ctx.design.mainLineFt,
      bends: ctx.design.bends,
    });
    if (boxes.length > 1) {
      boxes.forEach((b, i) => {
        const downstream = ctx.placed.filter((x) => b.iduKeys.includes(x.p.key)).reduce((s, x) => s + x.u.size, 0);
        let gas = main.gas;
        if ((/^MXZ-8C60NA/.test(odu.model) || /^MXZ-SM60/.test(odu.model)) && downstream < 54) gas = main.gas - 0.125;
        runs.push({ label: `Joint → branch box ${i + 1}`, liquidIn: main.liquid, gasIn: gas, lengthFt: ctx.design.jointToBoxFt?.[i] });
      });
    }
    for (const x of ctx.placed) runs.push(iduRun(x, `Branch box ${(ctx.assignments[x.p.key]?.box ?? 0) + 1}`));
  }
  ctx.piping.push(...runs);
}

/** One BOM line per liquid × gas size pair, in feet of actual length. */
export function lineSetBom(ctx: Ctx) {
  const pairs = new Map<string, { liquid: number; gas: number; ft: number; runs: string[] }>();
  let missing = 0;
  for (const r of ctx.piping) {
    if (r.lengthFt == null) {
      missing++;
      continue;
    }
    const k = `${r.liquidIn}|${r.gasIn}`;
    const cur = pairs.get(k) ?? { liquid: r.liquidIn, gas: r.gasIn, ft: 0, runs: [] };
    cur.ft += r.lengthFt;
    cur.runs.push(`${r.label} ${r.lengthFt} ft`);
    pairs.set(k, cur);
  }
  for (const p of pairs.values())
    ctx.add({
      model: `${inch(p.liquid)} × ${inch(p.gas)}`,
      description: `Line set ${inch(p.liquid)} liquid × ${inch(p.gas)} gas, insulated`,
      qty: Math.ceil(p.ft),
      unit: "ft",
      category: "Line set",
      reason: p.runs.join("; "),
    });
  if (missing && ctx.piping.length) ctx.info("LINESET_PARTIAL", `${missing} pipe run${missing > 1 ? "s have" : " has"} no length yet, so the line-set takeoff is incomplete.`);
}

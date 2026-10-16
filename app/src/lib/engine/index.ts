import "server-only";
import type { AccessoryOption, BomLine, ControllerOption, Evaluation, Palette, SystemDesign } from "../design";
import { dbVersion, indoorUnits, num, outdoorUnits, str, type IndoorUnit, type OutdoorUnit } from "../catalog";
import { checkA2l } from "./a2l";
import { correctedCapacity } from "./derate";
import { checkAccessories } from "./accessories";
import { multiCharge } from "./charge";
import { Ctx } from "./context";
import { centralControllerOptions, checkControls } from "./controls";
import { lineSetBom, pipeRuns } from "./lineset";
import { checkMulti, multiCompatible } from "./mxz";
import { checkSingle, isDefaultIdu, singleCompatible } from "./single";
import { applyBrand, systemSpecs } from "./specs";

const SYSTEM_NAME = { MandS: "M & S-Series", P: "P-Series", MXZ: "MXZ multi-zone", MXZSM: "Smart Multi" } as const;

export function isCompatible(odu: OutdoorUnit, idu: IndoorUnit): boolean {
  return odu.system === "MandS" || odu.system === "P" ? singleCompatible(odu, idu) : multiCompatible(odu, idu);
}

export function evaluate(design: SystemDesign): Evaluation {
  const ctx = new Ctx(design);
  const controllers: Record<string, ControllerOption[]> = {};
  const accessoryOptions: Record<string, AccessoryOption[]> = {};
  const odu = ctx.odu;

  if (!odu) {
    const unknown = design.oduId != null;
    return {
      status: unknown ? "fail" : "incomplete",
      issues: unknown ? [{ severity: "error", code: "ODU_UNSUPPORTED", message: "This outdoor unit is unavailable or outside the supported scope. Choose another outdoor unit.", target: "odu" }] : [],
      bom: [], compatibleIduIds: [], controllers, accessoryOptions, unchecked: [],
    };
  }
  if (odu.system !== design.system) ctx.error("SYSTEM_TYPE", `${odu.model} is not a ${SYSTEM_NAME[design.system]} outdoor unit.`, "odu");
  if (odu.status === "legacy") ctx.info("LEGACY", `${odu.model} is a legacy model.`, "odu");

  ctx.add({ model: odu.model, description: `${odu.refrigerant} ${SYSTEM_NAME[odu.system]} outdoor unit`, qty: 1, category: "Outdoor unit" });
  for (const x of ctx.placed) {
    ctx.add({ model: x.u.model, description: `${x.u.typeName.replace(/ type$/i, "")} indoor unit`, qty: 1, category: "Indoor unit", reason: x.p.room });
    if (x.u.status === "legacy") ctx.info("LEGACY", `${x.u.model} is a legacy model.`, x.p.key);
  }

  if (odu.system === "MandS" || odu.system === "P") checkSingle(ctx);
  else checkMulti(ctx);
  checkControls(ctx, controllers);
  checkAccessories(ctx, accessoryOptions);
  if (ctx.placed.length) {
    pipeRuns(ctx);
    if (odu.system === "MXZ" || odu.system === "MXZSM") multiCharge(ctx);
    lineSetBom(ctx);
    checkA2l(ctx);
  }
  const capacity = correctedCapacity(ctx, design.settings?.conditions);

  // Region filtering applies to alternatives only: an M & S ODU's default IDU is always offered,
  // even when its row is flagged legacy (m-and-p-series.md §2.1b).
  const allowLegacy = !!design.showLegacy;
  const compatibleIduIds = indoorUnits
    .filter((u) => u.status === "current" || (allowLegacy && u.status === "legacy") || (u.status === "legacy" && isDefaultIdu(odu, u)))
    .filter((u) => isCompatible(odu, u))
    .map((u) => u.id);

  const errors = ctx.issues.some((i) => i.severity === "error");
  const status = errors ? "fail" : ctx.placed.length < odu.minIdus ? "incomplete" : "pass";
  const order = { error: 0, warning: 1, info: 2 } as const;

  return {
    oduId: odu.id,
    status,
    issues: ctx.issues.sort((a, b) => order[a.severity] - order[b.severity]),
    bom: applyBrand(mergeBom(ctx.bom), design.settings?.brand),
    compatibleIduIds,
    controllers,
    accessoryOptions,
    layout: ctx.layout,
    assignments: ctx.assignments,
    piping: ctx.piping,
    charge: ctx.charge,
    a2l: ctx.a2l,
    capacity,
    specs: systemSpecs(ctx),
    centralControllers: centralControllerOptions(!!design.showLegacy),
    unchecked: [...ctx.unchecked],
    summary: {
      connectedBtu: ctx.placed.reduce((s, x) => s + x.u.size * 1000, 0),
      oduBtu: odu.nominal * 1000,
      connectedPct: odu.nominal ? (ctx.sizeSum / odu.nominal) * 100 : undefined,
    },
  };
}

const CATEGORY_ORDER: BomLine["category"][] = ["Outdoor unit", "Indoor unit", "Branch box", "Kit", "Controller", "Interface", "Accessory", "Line set"];

function mergeBom(lines: BomLine[]): BomLine[] {
  const merged = new Map<string, BomLine>();
  for (const l of lines) {
    const k = `${l.category}|${l.model}|${l.optional ? 1 : 0}`;
    const cur = merged.get(k);
    if (cur) {
      cur.qty += l.qty;
      if (l.reason && !cur.reason?.includes(l.reason)) cur.reason = cur.reason ? `${cur.reason}; ${l.reason}` : l.reason;
    } else merged.set(k, { ...l });
  }
  return [...merged.values()].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.model.localeCompare(b.model));
}

export function buildPalette(): Palette {
  const v = dbVersion.find((r) => str(r.strCompany) !== "MESCA") ?? dbVersion[0];
  return {
    dbVersion: `DB ${str(v?.strDatabaseVersion) ?? "?"}`,
    odus: outdoorUnits
      .filter((u) => u.status !== "unavailable")
      .map((u) => ({ id: u.id, legacy: u.status === "legacy", model: u.model, name: u.name, system: u.system, refrigerant: u.refrigerant, coolingBtu: u.coolingBtu, heatingBtu: u.heatingBtu, maxIdus: u.maxIdus, maxIdusReduced: num(u.raw.numMaxQtyIDU_wPLA_EA7) || undefined, minIdus: u.minIdus, branchBox: u.branchBox, defaultIdu: u.defaultIdu })),
    idus: indoorUnits
      .filter((u) => u.status !== "unavailable")
      .map((u) => ({ id: u.id, legacy: u.status === "legacy", model: u.model, name: u.name, systems: u.systems, refrigerant: u.refrigerant, typeName: u.typeName, coolingBtu: u.coolingBtu, heatingBtu: u.heatingBtu, size: u.size })),
  };
}

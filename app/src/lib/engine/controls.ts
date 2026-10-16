// Controller choices per indoor unit, following research/rules/controls-and-bom.md §2.
// Simplification: every indoor unit is its own control group (true for MXZ port-type and
// branch-box units, and the common case elsewhere). Group control is not modelled yet.
import type { ControllerOption } from "../design";
import { accessoryDescription, availability, IDU_TYPE, num, search, str, tables, type IndoorUnit, type OutdoorUnit, type Row } from "../catalog";
import { Ctx, label } from "./context";

const TYPE = { ma: 1, me: 2, simpleMa: 3, simpleMe: 4, wireless: 5, lossnay: 6, thermostatKit: 7, thermostatInterface: 8, wifi: 9 } as const;
const CONTROLLER_TYPES: number[] = [TYPE.ma, TYPE.me, TYPE.simpleMa, TYPE.simpleMe, TYPE.wireless, TYPE.thermostatKit, TYPE.thermostatInterface];

const TYPE_NAME: Record<number, string> = {
  1: "Wired remote controller (MA)",
  2: "Wired remote controller (M-NET)",
  3: "Simple wired remote controller (MA)",
  4: "Simple wired remote controller (M-NET)",
  5: "Wireless remote controller",
  7: "Wireless thermostat kit",
  8: "Thermostat interface",
  9: "Wi-Fi / app adapter",
};

interface Lrc {
  id: number;
  model: string;
  type: number;
  wired: boolean;
  cn105: boolean;
  maCompatible: boolean;
  meCompatible: boolean;
  preInstalled: boolean;
  status: ReturnType<typeof availability>;
}

const lrcs: Lrc[] = tables.lrc_list.map((r) => ({
  id: num(r.Id),
  model: String(r.strModelNumber),
  type: num(r.fkLRCType_Id),
  wired: num(r.boolWired) === 1 || [1, 2, 3, 4, 8].includes(num(r.fkLRCType_Id)),
  cn105: num(r.boolCN105) === 1,
  maCompatible: num(r.boolMACompatible) === 1,
  meCompatible: num(r.boolMECompatible) === 1,
  preInstalled: num(r.boolPreInstalled) === 1,
  status: availability(r.numMEUSUL),
}));
const lrcByModel = new Map(lrcs.map((l) => [l.model, l]));

const compatRows = tables.idu_lrc_compat as Row[];
const isTraditionalM = (u: IndoorUnit) => /^(MSZ|MSY|MLZ|MFZ)/.test(u.model);
const isMA = (l: Lrc) => l.type === TYPE.ma || l.type === TYPE.simpleMa;

/** §2.3 C1/C2: rows whose IDU regex matches, keyed by base LRC model. */
function compatFor(u: IndoorUnit): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of compatRows) {
    if (!search(str(r.strIDUModelNumber), u.model)) continue;
    const lrc = String(r.strLRCModelNumber ?? "");
    const extra = str(r.strAdditionalEquipments);
    const list = out.get(lrc) ?? [];
    if (extra && !extra.includes("*") && !list.includes(extra)) list.push(extra);
    out.set(lrc, list);
  }
  return out;
}

/** §2.6: a handheld wireless remote is packaged with wall, floor and 1-way cassette units (not on City-Multi-mode systems). */
const STOCK_REMOTE_TYPES = new Set<number>([IDU_TYPE.wall, IDU_TYPE.floorExposed, IDU_TYPE.floorConcealed, IDU_TYPE.oneWayCassette]);
function hasStockRemote(ctx: Ctx, u: IndoorUnit) {
  return STOCK_REMOTE_TYPES.has(u.typeId) && ["MandS", "MXZ", "MXZSM"].includes(ctx.odu?.system ?? "");
}

/** Comfort-app adapter that ships inside some R454B units (§2.6). */
export function hasFactoryWifi(odu: OutdoorUnit | undefined, u: IndoorUnit) {
  return odu?.refrigerant === "R454B" && /^(MSZ-(EX|FX|GX|HX|JX)|MLZ-KX|MFZ-KX)/.test(u.model);
}

export function controllerOptions(u: IndoorUnit, allowLegacy: boolean): ControllerOption[] {
  const compat = compatFor(u);
  const out: ControllerOption[] = [];
  for (const l of lrcs) {
    if (l.preInstalled || !(l.status === "current" || (allowLegacy && l.status === "legacy"))) continue;
    const isWifi = l.type === TYPE.wifi;
    if (!isWifi && !CONTROLLER_TYPES.includes(l.type)) continue;
    const extra = compat.get(l.model);
    if (!extra) continue;
    const requires = [...extra];
    if (isTraditionalM(u) && isMA(l) && !requires.includes("MAC-334IF-E")) requires.push("MAC-334IF-E");
    out.push({ model: l.model, name: TYPE_NAME[l.type] ?? "Controller", wired: l.wired, kind: isWifi ? "wifi" : "controller", requires });
  }
  return out.sort((a, b) => Number(a.kind === "wifi") - Number(b.kind === "wifi") || a.name.localeCompare(b.name) || a.model.localeCompare(b.model));
}

/** §2.4 two devices on one unit. */
function pairOk(a: Lrc, b: Lrc): boolean {
  if (!a.cn105) return true;
  if (!b.cn105) return true;
  if (a.maCompatible && isMA(b)) return true;
  if (a.meCompatible && b.type === TYPE.me) return true;
  const types = new Set([a.type, b.type]);
  if (types.has(TYPE.wireless) && (types.has(TYPE.thermostatInterface) || types.has(TYPE.wifi) || types.has(TYPE.thermostatKit))) return true;
  if ((a.model === "PAC-USWHS002-WF-2" && /MHK1|MHK2|PAC-SDW/.test(b.model)) || (b.model === "PAC-USWHS002-WF-2" && /MHK1|MHK2|PAC-SDW/.test(a.model))) return true;
  return false;
}

/** Central controllers offered for a system (§4.1 system controllers). */
export function centralControllerOptions(allowLegacy: boolean) {
  return tables.src_list
    .filter((r) => [1, 2, 5].includes(num(r.fkSRCType_Id)))
    .filter((r) => {
      const a = availability(r.numMEUSUL);
      return a === "current" || (allowLegacy && a === "legacy");
    })
    .map((r) => ({ model: String(r.strModelNumber), name: str(r.strMarketingName) ?? "Central controller" }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

const KENZA = "RMD-50A";

export function checkControls(ctx: Ctx, options: Record<string, ControllerOption[]>) {
  const allowLegacy = !!ctx.design.showLegacy;
  const odu = ctx.odu!;
  const central = ctx.design.centralController;
  const kenza = central === KENZA;
  const mnet = !!ctx.design.mnet || (!!central && !kenza);
  const add334 = new Set<string>(); // IDU keys that need MAC-334IF-E, added once each

  for (const x of ctx.placed) {
    const opts = controllerOptions(x.u, allowLegacy);
    options[x.p.key] = opts;
    const controller = x.p.controller;
    const picked = [x.p.controller, x.p.wifiAdapter].filter((m): m is string => !!m);

    if (!controller && !central && !hasStockRemote(ctx, x.u))
      ctx.warn("NO_CONTROLLER", `${label(x)} doesn't come with a remote. Pick a controller.`, x.p.key);

    for (const model of picked) {
      const opt = opts.find((o) => o.model === model);
      if (!opt) {
        ctx.error("LRC_INCOMPATIBLE", `${model} is not compatible with ${x.u.model}.`, x.p.key);
        continue;
      }
      ctx.add({ model, description: opt.name, qty: 1, category: "Controller", reason: label(x) });
      for (const extra of opt.requires) {
        if (extra === "MAC-334IF-E") add334.add(x.p.key);
        else ctx.add({ model: extra, description: accessoryDescription(extra) || "Controller interface", qty: 1, category: "Interface", reason: `${model} on ${x.u.model}` });
      }
    }

    const [a, b] = picked.map((m) => lrcByModel.get(m));
    if (a && b) {
      if (a.cn105 && b.cn105 && !(pairOk(a, b) && pairOk(b, a))) ctx.error("CN105", `${a.model} and ${b.model} both need the unit's CN105 port; pick one.`, x.p.key);
      else if (!(pairOk(a, b) && pairOk(b, a))) ctx.error("LRC_PAIR", `${a.model} and ${b.model} can't be used together on one unit.`, x.p.key);
      const isME = (l: Lrc) => l.type === TYPE.me || l.type === TYPE.simpleMe;
      if ((isMA(a) && isME(b)) || (isME(a) && isMA(b))) ctx.error("LRC_MA_ME", "MA and M-NET controllers can't be mixed on one unit.", x.p.key);
    }

    const ctl = controller ? lrcByModel.get(controller) : undefined;
    const wifi = x.p.wifiAdapter ? lrcByModel.get(x.p.wifiAdapter) : undefined;

    // §2.3 stock-only rule: these M-series wall units on an MU outdoor unit with M-NET take the wireless remote only.
    if (mnet && /MS(Y|Z)-(GL|HM|WR|JP|D)/.test(x.u.model) && /MU(Y|Z)/.test(odu.model) && ctl && ctl.type !== TYPE.wireless)
      ctx.error("1218", `${x.u.model} on ${odu.model} with M-NET only supports its wireless remote.`, x.p.key);

    // §2.9 MAC-334IF-E per indoor unit
    const nonBoxSystem = !odu.branchBox;
    if (isTraditionalM(x.u) && ctl && isMA(ctl)) add334.add(x.p.key);
    if (odu.system === "MandS" && mnet) add334.add(x.p.key);
    // With Kenza no M-NET converter goes on a P outdoor unit, so each indoor unit takes the interface instead.
    if (kenza && nonBoxSystem && (odu.system === "MXZ" || odu.system === "P")) add334.add(x.p.key);

    // §2.9 12 VDC power supply
    const ps5r =
      (isTraditionalM(x.u) && ctl && isMA(ctl) && wifi && !wifi.preInstalled) ||
      (/^MSZ-FH/.test(x.u.model) && /^MUZ-FH/.test(odu.model) && mnet && ctl && isMA(ctl)) ||
      (odu.system === "MandS" && mnet && ctl?.type === TYPE.thermostatKit);
    if (ps5r) ctx.add({ model: "PS5R-VA12", description: accessoryDescription("PS5R-VA12") || "12 VDC power supply", qty: 1, category: "Interface", reason: label(x) });

    if (hasFactoryWifi(ctx.odu, x.u) && x.p.wifiAdapter)
      ctx.info("WIFI_BUILT_IN", `${x.u.model} ships with an app adapter built in; ${x.p.wifiAdapter} may not be needed.`, x.p.key);
  }

  for (const key of add334) {
    const x = ctx.placed.find((p) => p.p.key === key)!;
    ctx.add({ model: "MAC-334IF-E", description: accessoryDescription("MAC-334IF-E") || "M-NET / controller interface", qty: 1, category: "Interface", reason: label(x) });
  }

  // System-level M-NET parts (§2.9) and the central controller.
  if (mnet && !kenza && ctx.placed.length) {
    if (odu.system === "P") {
      const model = p95(odu.model) ?? "PAC-SJ95MA-E";
      ctx.add({ model, description: accessoryDescription(model) || "M-NET converter", qty: 1, category: "Interface", reason: `M-NET on ${odu.model}` });
    }
    if (odu.system === "MXZ" && !odu.branchBox && ["C", "D"].includes(odu.generation))
      ctx.add({ model: "PAC-IF01MNT-E", description: accessoryDescription("PAC-IF01MNT-E") || "M-NET adapter", qty: 1, category: "Interface", reason: `M-NET on ${odu.model}` });
  }
  if (central) ctx.add({ model: central, description: kenza ? "Cloud gateway" : "Central controller", qty: 1, category: "Controller", reason: "system controller" });
  ctx.unchecked.add("Grouping units from different outdoor units on one controller, and M-NET addresses");
}

/** P-Series ODUs listed with PAC-SJ96MA-E take that converter; others take PAC-SJ95MA-E. */
function p95(oduModel: string): string | undefined {
  const row = tables.acc_outdoor_include.find((r) => String(r.strAccessoryNumber) === "PAC-SJ96MA-E" && search(str(r.strModelNumber), oduModel));
  return row ? "PAC-SJ96MA-E" : undefined;
}

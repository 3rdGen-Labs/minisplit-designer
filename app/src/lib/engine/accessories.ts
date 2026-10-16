// Required and optional accessories, following research/rules/controls-and-bom.md §3.
import type { AccessoryOption } from "../design";
import { accessoryDescription, availability, num, search, str, tables, type Row } from "../catalog";
import { Ctx, label } from "./context";

const usable = (r: Row) => num(r.numDisplaySetting) !== 2 && availability(r.numMEUSUL ?? 1) !== "unavailable";
const isKit = (m: string) => m.includes("_KIT");

/** Kit lines are replaced by their components for this exact ODU model; duplicate rows add up. */
function kitComponents(kit: string, oduModel: string) {
  const out = new Map<string, number>();
  for (const r of tables.acc_kit_components)
    if (String(r.strKitName) === kit && String(r.strModelNumber) === oduModel)
      out.set(String(r.strAccessoryNumber), (out.get(String(r.strAccessoryNumber)) ?? 0) + num(r.numQty, 1));
  return out;
}

function optionsFor(model: string, include: Row[], exclude: Row[], oduModel?: string): string[] {
  const excluded = new Set(exclude.filter((r) => search(str(r.strModelNumber), model)).map((r) => String(r.strAccessoryNumber)));
  const out = new Set<string>();
  for (const r of include) {
    if (!usable(r) || !search(str(r.strModelNumber), model)) continue;
    const acc = String(r.strAccessoryNumber);
    if (excluded.has(acc)) continue;
    if (isKit(acc) && (!oduModel || !kitComponents(acc, oduModel).size)) continue;
    out.add(acc);
  }
  return [...out];
}

export function checkAccessories(ctx: Ctx, options: Record<string, AccessoryOption[]>) {
  const odu = ctx.odu!;
  const required = new Map<string, Map<string, { qty: number; reason: string }>>(); // target -> accessory -> qty
  const need = (target: string, acc: string, qty: number, reason: string) => {
    const m = required.get(target) ?? new Map();
    if (!m.has(acc)) m.set(acc, { qty, reason });
    required.set(target, m);
  };

  // Indoor units: defaults, include rows with a minimum, either-or grilles.
  for (const x of ctx.placed) {
    for (const r of tables.acc_default) if (search(str(r.strModelNumber), x.u.model)) need(x.p.key, String(r.strAccessoryNumber), num(r.numCount, 1), "always required");
    for (const r of tables.acc_indoor_include)
      if (usable(r) && num(r.numMin) > 0 && search(str(r.strModelNumber), x.u.model)) need(x.p.key, String(r.strAccessoryNumber), num(r.numMin), "required minimum");
    for (const r of tables.acc_default_either_or) {
      if (!search(str(r.strModelNumber), x.u.model)) continue;
      const [a, b] = [String(r.strAccessoryNumber1), String(r.strAccessoryNumber2)];
      const picked = x.p.accessories ?? {};
      if (!picked[a] && !picked[b]) need(x.p.key, a, num(r.numMin, 1), `required (or ${b})`);
    }
  }

  // Outdoor unit: include rows with a minimum; some only when a matching indoor unit is connected.
  for (const r of tables.acc_outdoor_include) {
    if (!usable(r) || num(r.numMin) <= 0 || !search(str(r.strModelNumber), odu.model)) continue;
    const iduCond = str(r.strIndoorUnitModel);
    if (iduCond) {
      const hit = ctx.placed.find((x) => search(iduCond, x.u.model));
      if (hit) need("odu", String(r.strAccessoryNumber), num(r.numMin), `required with ${hit.u.model}`);
    }
  }

  // Optional lists.
  const projectOdu = tables.acc_project_include.filter((r) => String(r.strAssociatedUnit ?? "odu") === "odu");
  const oduOpts = new Set([...optionsFor(odu.model, tables.acc_outdoor_include, tables.acc_outdoor_exclude, odu.model), ...optionsFor(odu.model, projectOdu, [], odu.model)]);
  options.odu = toOptions([...oduOpts], required.get("odu"));
  for (const x of ctx.placed) options[x.p.key] = toOptions(optionsFor(x.u.model, tables.acc_indoor_include, tables.acc_indoor_exclude), required.get(x.p.key));

  // BOM lines: required first, then the user's picks on top of the required quantity.
  const emit = (target: string, acc: string, qty: number, reason: string, optional: boolean) => {
    if (qty <= 0) return;
    if (isKit(acc)) {
      const parts = kitComponents(acc, odu.model);
      for (const [part, n] of parts)
        ctx.add({ model: part, description: accessoryDescription(part) || part, qty: n * qty, category: "Kit", reason: `${acc.replace(/_/g, " ").toLowerCase()} for ${odu.model}`, optional });
      return;
    }
    ctx.add({ model: acc, description: accessoryDescription(acc) || "Accessory", qty, category: "Accessory", reason, optional });
  };
  const targetLabel = (key: string) => (key === "odu" ? odu.model : label(ctx.placed.find((x) => x.p.key === key)!));
  for (const [target, accs] of required) for (const [acc, { qty, reason }] of accs) emit(target, acc, qty, `${targetLabel(target)}: ${reason}`, false);

  const picks: [string, Record<string, number> | undefined][] = [["odu", ctx.design.oduAccessories], ...ctx.placed.map((x) => [x.p.key, x.p.accessories] as [string, Record<string, number> | undefined])];
  for (const [target, chosen] of picks) {
    for (const [acc, qty] of Object.entries(chosen ?? {})) {
      const offered = options[target]?.some((o) => o.model === acc);
      if (!offered) {
        if (qty > 0) ctx.warn("ACC_NOT_OFFERED", `${acc} is not listed as an accessory for ${targetLabel(target)}.`, target);
        continue;
      }
      const already = required.get(target)?.get(acc)?.qty ?? 0;
      emit(target, acc, qty - already, `${targetLabel(target)}: selected`, false);
    }
  }
}

function toOptions(models: string[], required?: Map<string, { qty: number }>): AccessoryOption[] {
  const all = new Set([...models, ...(required?.keys() ?? [])]);
  return [...all]
    .map((m) => ({ model: m, description: accessoryDescription(m) || (isKit(m) ? m.replace(/_/g, " ").toLowerCase() : ""), required: required?.get(m)?.qty ?? 0 }))
    .sort((a, b) => b.required - a.required || a.description.localeCompare(b.description) || a.model.localeCompare(b.model));
}

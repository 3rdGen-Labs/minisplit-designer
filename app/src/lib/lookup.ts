import "server-only";
import { indoorUnits, iduById, outdoorUnits, oduById, type Availability, type IndoorUnit, type OutdoorUnit, type SystemKey } from "./catalog";
import { isCompatible } from "./engine";

// Model-number lookup shared by the MCP tools and the DSB importer. The catalog repeats many model
// numbers, one record per system (SVZ-AP30NL is both a single-zone record and an MXZ record) and
// sometimes a legacy copy, so "the first record with this model" can pick one the outdoor unit
// can't use. Numeric ids are exact and returned as is.

const STATUS_RANK: Record<Availability, number> = { current: 0, legacy: 1, unavailable: 2 };
const norm = (model: string) => model.trim().toUpperCase();

function group<T extends { model: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(norm(r.model), [...(m.get(norm(r.model)) ?? []), r]);
  return m;
}
const oduByModel = group(outdoorUnits);
const iduByModel = group(indoorUnits);

/** Lowest rank wins; ties keep catalog order. */
function best<T>(rows: T[], rank: (row: T) => number): T | undefined {
  let pick: T | undefined;
  let pickRank = Infinity;
  for (const row of rows) {
    const r = rank(row);
    if (r < pickRank) [pick, pickRank] = [row, r];
  }
  return pick;
}

/** Outdoor unit by id or model number. A repeated model resolves to the record for `system` if given, then current before legacy. */
export function findOutdoorUnit(ref: number | string, system?: SystemKey): OutdoorUnit | undefined {
  if (typeof ref === "number") return oduById.get(ref);
  return best(oduByModel.get(norm(ref)) ?? [], (u) => (system && u.system !== system ? 10 : 0) + STATUS_RANK[u.status]);
}

/**
 * Indoor unit by id or model number. A repeated model resolves to the record that connects to `odu`
 * (the one list_indoor_units shows for that outdoor unit), then to one for the system, then current before legacy.
 */
export function findIndoorUnit(ref: number | string, within: { odu?: OutdoorUnit; system?: SystemKey } = {}): IndoorUnit | undefined {
  if (typeof ref === "number") return iduById.get(ref);
  const { odu } = within;
  const system = within.system ?? odu?.system;
  return best(
    iduByModel.get(norm(ref)) ?? [],
    (u) => (odu && !isCompatible(odu, u) ? 100 : 0) + (system && !u.systems.includes(system) ? 10 : 0) + STATUS_RANK[u.status],
  );
}

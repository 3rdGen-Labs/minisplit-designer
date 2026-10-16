import "server-only";
import catalogData from "@/data/catalog.json";
import controlsData from "@/data/controls.json";
import multiData from "@/data/multi.json";
import versionData from "@/data/version.json";
import type { SystemKey } from "./design";
import { isExcludedSmartMulti } from "./equipment-scope.mjs";

export type { SystemKey };
export type Refrigerant = "R410A" | "R454B" | "R32";
export const REFRIGERANT_BY_FLAG: Record<number, Refrigerant> = { 2: "R410A", 8: "R454B", 16: "R32" };

export type Row = Record<string, string | number | string[] | undefined>;

export interface OutdoorUnit {
  id: number;
  model: string;
  system: SystemKey;
  refrigerant: Refrigerant;
  name: string;
  coolingBtu: number;
  heatingBtu: number;
  minIdus: number;
  maxIdus: number;
  /** Connected indoor model-size window in kBtu (normalized; the table mixes Btu and kBtu). */
  sizeMin: number;
  sizeMax: number;
  /** Nominal size in kBtu, parsed from the model number (MXZ-3C24 -> 24, SM36 -> 36). */
  nominal: number;
  ports: number;
  branchBox: boolean;
  /** Smart Multi rows exist twice; we only use the residential (branch-box) row. */
  cityMultiMode: boolean;
  /** MXZ generation letter (B/C/D) or "SM". */
  generation: string;
  /** Digit right before -U<n> (MXZ-3C24NA4-U1 -> 4), 1 if none. */
  subGeneration: number;
  /** Single zone: the indoor unit this ODU is normally sold with. */
  defaultIdu?: string;
  status: Availability;
  raw: Row;
}

export interface IndoorUnit {
  id: number;
  model: string;
  systems: SystemKey[];
  refrigerant: Refrigerant;
  name: string;
  typeId: number;
  typeName: string;
  coolingBtu: number;
  heatingBtu: number;
  /** Model size in kBtu. */
  size: number;
  correspondingOdu?: string;
  liquidIn: number;
  gasIn: number;
  connectionFactor: number;
  status: Availability;
  raw: Row;
}

export const num = (v: unknown, d = 0) => (typeof v === "number" ? v : v == null || v === "" ? d : Number(v) || d);
export const str = (v: unknown) => (v == null || v === "" ? undefined : String(v).trim());

/**
 * Region/brand flags (numMEUSUL etc.) are decimal digits ABC: A = American Standard,
 * B = Trane, C = Mitsubishi. Digit 1 = current, 2 = legacy, 3 = both, 0/4/5 = not offered / test / staging.
 * We estimate Mitsubishi-branded US equipment, so only the ones digit matters.
 */
export type Availability = "current" | "legacy" | "unavailable";
export function availability(flag: unknown): Availability {
  const d = num(flag) % 10;
  if (d === 1 || d === 3) return "current";
  if (d === 2) return "legacy";
  return "unavailable";
}

/** Strip carving artifacts (a stray leading `$` / `&` on some model numbers). */
const cleanModel = (m: unknown) => String(m ?? "").trim();

const kbtu = (v: number) => (v >= 1000 ? v / 1000 : v);

const types = new Map((catalogData.indoor_unit_types as Row[]).map((t) => [num(t.ID), String(t.strName).replace(/\s+-\s*/g, "-").trim()]));

function nominalFromModel(model: string, system: SystemKey, coolingBtu: number): number {
  const m = model.match(/^MXZ-(?:\d[A-Z]|SM)(\d+)/) ?? model.match(/^[A-Z]+-[A-Z]*?(\d{2,3})/);
  if (m) return Number(m[1]);
  return Math.round(coolingBtu / 1000);
}

export const outdoorUnits: OutdoorUnit[] = (catalogData.outdoor_units as Row[])
  .map((r) => {
    const model = cleanModel(r.strModelNumber);
    const system = r._system as SystemKey;
    const gen = system === "MXZSM" ? "SM" : (model.match(/^MXZ-\d([A-Z])/)?.[1] ?? "");
    return {
      id: num(r.Id),
      model,
      system,
      refrigerant: REFRIGERANT_BY_FLAG[num(r.numRefType)] ?? "R410A",
      name: str(r.strMarketingName) ?? "",
      coolingBtu: num(r.numCoolingCapacity),
      heatingBtu: num(r.numHeatingCapacity),
      minIdus: num(r.numMinAllowableQtyIndoorUnit, 1),
      maxIdus: num(r.numMaxAllowableQtyIndoorUnit, 1),
      sizeMin: kbtu(num(r.numIndoorUnitTotalCapacity_Min)),
      sizeMax: kbtu(num(r.numIndoorUnitTotalCapacity_Max)),
      nominal: nominalFromModel(model, system, num(r.numCoolingCapacity)),
      ports: num(r.numRefLineInputCount, 1),
      branchBox: num(r.boolMXZBranchBoxUnit) === 1,
      cityMultiMode: num(r.boolIsCMType) === 1,
      generation: gen,
      subGeneration: Number(model.match(/(\d)-U\d+$/)?.[1] ?? 1),
      defaultIdu: str(r.strDefaultIndoorUnitModelNo),
      status: model.startsWith("$") ? "unavailable" : availability(r.numMEUSUL),
      raw: r,
    } satisfies OutdoorUnit;
  })
  // Smart Multi City-Multi mode needs CITY MULTI indoor units, which are out of scope.
  .filter((u) => !(u.system === "MXZSM" && u.cityMultiMode) && !isExcludedSmartMulti(u.model, str(u.raw.strPhase)));

export const indoorUnits: IndoorUnit[] = (catalogData.indoor_units as Row[]).map((r) => {
  const model = cleanModel(r.strModelNumber);
  return {
    id: num(r.ID),
    model,
    systems: (r._systems as SystemKey[]) ?? [],
    refrigerant: REFRIGERANT_BY_FLAG[num(r.numRefType)] ?? "R410A",
    name: str(r.strMarketingName) ?? "",
    typeId: num(r.fkIUType_Id),
    typeName: types.get(num(r.fkIUType_Id)) ?? "Other",
    coolingBtu: num(r.numCoolingCapacity_Total),
    heatingBtu: num(r.numHeatingCapacity),
    size: num(r.numModelSize_UL) || Number(model.match(/^[A-Z]+-[A-Z]*?(\d+)/)?.[1] ?? 0),
    correspondingOdu: str(r.strCorrespOU_MSSeries),
    liquidIn: num(r.numPipeSize_Liquid),
    gasIn: num(r.numPipeSize_Gas),
    connectionFactor: num(r.numConnectionFactor),
    status: availability(r.numMEUSUL),
    raw: r,
  } satisfies IndoorUnit;
});

export const oduById = new Map(outdoorUnits.map((u) => [u.id, u]));
export const iduById = new Map(indoorUnits.map((u) => [u.id, u]));

export const tables = { ...catalogData, ...controlsData, ...multiData } as unknown as Record<string, Row[]>;
export const dbVersion = versionData as Row[];

/**
 * DSB's rule tables key models by .NET regex and test them with an unanchored search
 * (Regex.IsMatch), so `MSZ-(FH|FS)\d+NA` also matches `MSZ-FH09NA2`. Patterns such as `$.`
 * or `$a` can never match and act as "disabled row" markers.
 */
const regexCache = new Map<string, RegExp | null>();
export function search(pattern: string | undefined, model: string): boolean {
  if (!pattern) return false;
  let re = regexCache.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern);
    } catch {
      re = null;
    }
    regexCache.set(pattern, re);
  }
  return re ? re.test(model) : false;
}

const descriptions = new Map((controlsData.acc_descriptions as Row[]).map((r) => [cleanModel(r.strModelNumber), str(r.strDescriptionShort) ?? ""]));
export function accessoryDescription(model: string): string {
  return descriptions.get(model) ?? "";
}

/** IDU type ids used by the MXZ rules. */
export const IDU_TYPE = { ducted: 5, wall: 10, floorExposed: 8, floorConcealed: 7, oneWayCassette: 3, rac: 16, multiPosition: 20, levKit: 21, casedCoil: 22 } as const;

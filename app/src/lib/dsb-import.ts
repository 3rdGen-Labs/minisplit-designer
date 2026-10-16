// Import a Diamond System Builder project (an Access .mdb database) into Mini-Split Designer designs.
// Table layout is documented in research/dsb-project-format.md (built from the empty project
// template; several links are inferred and still need checking against a real project file).
import "server-only";
import MDBReader from "mdb-reader";
import { isExcludedSmartMulti } from "./equipment-scope.mjs";
import { indoorUnits, outdoorUnits, tables, type IndoorUnit, type OutdoorUnit } from "./catalog";
import type { BranchBoxPlacement, IduPlacement, SystemDesign, SystemKey } from "./design";

// ---------------------------------------------------------------------------------------------
// Plain structure read from the file
// ---------------------------------------------------------------------------------------------

export interface DsbIdu {
  id: number;
  model: string;
  room?: string;
  tag?: string;
  groupName?: string;
  /** Pipe run from the parent node (ODU, joint or branch box), as stored (assumed feet). */
  pipeLength?: number;
  /** Absolute elevation of the unit above grade, as stored (assumed feet). */
  elevation?: number;
  bends?: number;
  port?: string;
  /** Nearest branch box above this unit in the piping tree. */
  branchBoxId?: number;
  /** Local remote controllers assigned to this unit's control group. */
  controllers: string[];
  /** Other indoor units sharing the control group (group control). */
  groupSize: number;
}

export interface DsbBranchBox {
  id: number;
  model: string;
  pipeLength?: number;
  /** Port count stored on the row (numMaxBranchCount), if any. */
  ports?: number;
  /** True when the box hangs directly off the ODU (not off a joint or another box). */
  direct: boolean;
  /** Parent node is a joint. */
  underJoint: boolean;
}

export interface DsbJoint {
  id: number;
  model?: string;
  pipeLength?: number;
  direct: boolean;
}

export interface DsbSystem {
  id: number;
  name?: string;
  /** DSB system type id: 7 M & S, 8 P, 9 MXZ, 27 Smart Multi; anything else is out of scope. */
  systemType: number;
  /** tblSystem.boolAssignMNet. */
  mnet?: boolean;
  /** Centralized controllers referenced by this system's control groups (tblIndoorUnitGroup.fkSystemRemoteController1-4_Id). */
  centralControllers: string[];
  odu?: { id: number; model: string; elevation?: number; pipingLengths: number[] };
  /** Additional outdoor units on the same system (not expected for residential systems). */
  extraOdus: string[];
  idus: DsbIdu[];
  branchBoxes: DsbBranchBox[];
  joints: DsbJoint[];
  /** Other piping nodes we do not model (headers, BC controllers, ...): type name -> count. */
  otherNodes: Record<string, number>;
}

export interface DsbEquipment {
  model: string;
  kind: string;
  qty: number;
}

export interface DsbProject {
  name?: string;
  customer?: string;
  /** tblProject.numMeasure_PipeLengthUnit (display preference; enum values unconfirmed). */
  pipeLengthUnitSetting?: number;
  systems: DsbSystem[];
  /** Centralized controllers, interfaces, Lossnay, PI/AI/DIDO etc. Not imported into designs. */
  projectEquipment: DsbEquipment[];
  /** Optional accessories. The template schema has no accessory table, so this is always empty for now. */
  accessories: (DsbEquipment & { systemId?: number })[];
}

export class DsbImportError extends Error {}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

type Cell = string | number | boolean | Date | Buffer | bigint | null | undefined | unknown;
export type DsbRow = Record<string, Cell>;
export type DsbTables = Record<string, DsbRow[]>;

const TABLES = [
  "tblProject",
  "tblSystem",
  "tblOutdoorUnit",
  "tblBranchUnit",
  "tblBranchUnitType",
  "z_tblIndoorUnit",
  "tblIndoorUnitGroup",
  "tblLocalRemoteController",
  "tblSystemRemoteController",
  "tblControlsInterface",
  "tblPIAIDIDO",
  "tblLossnay",
  "tblInterfacePanel",
] as const;

/** Branch unit types (tblBranchUnitType, confirmed from the template's rows). */
export const NODE_TYPE = {
  bcController: 1,
  header: 2,
  joint: 3,
  indoorUnit: 4,
  outdoorUnit: 5,
  endcap: 6,
  distributionPipe: 7,
  branchBox: 8,
  waterConnectionBox: 9,
} as const;
const NODE_NAME: Record<number, string> = {
  1: "BC controller",
  2: "header",
  3: "joint",
  4: "indoor unit",
  5: "outdoor unit",
  6: "endcap",
  7: "distribution pipe",
  8: "branch box",
  9: "water connection box",
};

function checkSignature(buf: Buffer) {
  if (buf.length < 4096) throw new DsbImportError("The file is too small to be a DSB project.");
  if (buf[0] === 0x50 && buf[1] === 0x4b)
    throw new DsbImportError("This looks like a ZIP archive. Extract it and upload the DSB project file inside.");
  const sig = buf.subarray(4, 20).toString("latin1");
  if (!sig.startsWith("Standard Jet DB") && !sig.startsWith("Standard ACE DB"))
    throw new DsbImportError("This is not a DSB project file (expected a Microsoft Access database, as saved by DSB's Export a Copy).");
}

/** Read the project tables into plain rows. Missing tables come back empty. */
export function readDsbTables(buf: Buffer): DsbTables {
  checkSignature(buf);
  let reader: MDBReader;
  let names: Set<string>;
  try {
    reader = new MDBReader(buf);
    names = new Set(reader.getTableNames());
  } catch (e) {
    throw new DsbImportError(`Could not read the project database (${e instanceof Error ? e.message : "unknown error"}). The file may be damaged or password protected.`);
  }
  if (!names.has("tblSystem") || !names.has("tblOutdoorUnit"))
    throw new DsbImportError("This Access database is not a DSB project (no tblSystem / tblOutdoorUnit tables).");
  const out: DsbTables = {};
  for (const t of TABLES) {
    if (!names.has(t)) {
      out[t] = [];
      continue;
    }
    try {
      out[t] = reader.getTable(t).getData() as DsbRow[];
    } catch (e) {
      throw new DsbImportError(`Could not read table ${t} (${e instanceof Error ? e.message : "unknown error"}).`);
    }
  }
  return out;
}

export function parseDsbProject(buf: Buffer): DsbProject {
  return buildDsbProject(readDsbTables(buf));
}

const n = (v: Cell): number | undefined => {
  if (v == null || v === "" || typeof v === "boolean") return undefined;
  const x = typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : Number(v);
  return Number.isFinite(x) ? x : undefined;
};
const s = (v: Cell): string | undefined => {
  if (v == null || typeof v === "object") return undefined;
  const t = String(v).trim();
  return t ? t : undefined;
};
/** Lengths: 0 / negative mean "not entered". */
const len = (v: Cell) => {
  const x = n(v);
  return x != null && x > 0 ? x : undefined;
};
const id = (r: DsbRow) => n(r.Id ?? r.ID) ?? -1;

/** Build the plain project structure from table rows (split out so it can be tested without an .mdb writer). */
export function buildDsbProject(t: Partial<DsbTables>): DsbProject {
  const rows = (k: (typeof TABLES)[number]) => t[k] ?? [];
  const project = rows("tblProject")[0];

  // Piping tree: each tblBranchUnit row points at its parent node (fkBranchUnit_Id) and/or the ODU (fkOutdoorUnit_Id).
  const nodes = new Map(rows("tblBranchUnit").map((r) => [id(r), r]));
  const parentOf = (r: DsbRow) => n(r.fkBranchUnit_Id);
  const rootOdu = (r: DsbRow): number | undefined => {
    const seen = new Set<number>();
    let cur: DsbRow | undefined = r;
    while (cur && !seen.has(id(cur))) {
      seen.add(id(cur));
      const odu = n(cur.fkOutdoorUnit_Id);
      if (odu) return odu;
      const p = parentOf(cur);
      cur = p ? nodes.get(p) : undefined;
    }
    return undefined;
  };
  const ancestorOfType = (r: DsbRow, type: number): number | undefined => {
    const seen = new Set<number>([id(r)]);
    let p = parentOf(r);
    while (p && !seen.has(p)) {
      seen.add(p);
      const node = nodes.get(p);
      if (!node) return undefined;
      if (n(node.numType) === type) return p;
      p = parentOf(node);
    }
    return undefined;
  };
  /** Directly under the ODU: no parent, or the parent is an ODU-type node. */
  const isDirect = (r: DsbRow) => {
    const p = parentOf(r);
    if (!p) return true;
    return n(nodes.get(p)?.numType) === NODE_TYPE.outdoorUnit;
  };

  // Control groups -> local remote controllers, and group sizes.
  const lrcByGroup = new Map<number, string[]>();
  for (const r of rows("tblLocalRemoteController")) {
    const g = n(r.fkIndoorUnitGroup_Id);
    const m = s(r.strModelNumber);
    if (!g || !m) continue;
    lrcByGroup.set(g, [...(lrcByGroup.get(g) ?? []), m]);
  }
  const srcById = new Map(rows("tblSystemRemoteController").map((r) => [id(r), s(r.strModelNumber)]));
  const srcByGroup = new Map<number, string[]>();
  for (const g of rows("tblIndoorUnitGroup")) {
    const models = [1, 2, 3, 4].map((i) => srcById.get(n(g[`fkSystemRemoteController${i}_Id`]) ?? -1)).filter((m): m is string => !!m);
    if (models.length) srcByGroup.set(id(g), models);
  }
  const groupCount = new Map<number, number>();
  for (const r of nodes.values()) {
    const g = n(r.fkIndoorUnitGroup_Id);
    if (g && n(r.numType) === NODE_TYPE.indoorUnit) groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
  }

  const nodesByOdu = new Map<number, DsbRow[]>();
  for (const r of nodes.values()) {
    const odu = rootOdu(r);
    if (odu == null) continue;
    nodesByOdu.set(odu, [...(nodesByOdu.get(odu) ?? []), r]);
  }
  // Legacy indoor unit table (z_ prefix suggests it is retired); only used when the tree has no IDU rows.
  const legacyIdusByOdu = new Map<number, DsbRow[]>();
  for (const r of rows("z_tblIndoorUnit")) {
    const parent = n(r.fkBranchUnit_Id);
    const node = parent ? nodes.get(parent) : undefined;
    const odu = node ? rootOdu(node) : undefined;
    if (odu == null) continue;
    legacyIdusByOdu.set(odu, [...(legacyIdusByOdu.get(odu) ?? []), r]);
  }

  const odusBySystem = new Map<number, DsbRow[]>();
  for (const r of rows("tblOutdoorUnit")) {
    const sys = n(r.fkSystem_Id);
    if (sys == null) continue;
    odusBySystem.set(sys, [...(odusBySystem.get(sys) ?? []), r]);
  }

  const systems: DsbSystem[] = [];
  for (const sr of rows("tblSystem")) {
    const sysId = id(sr);
    const oduRows = (odusBySystem.get(sysId) ?? []).filter((r) => s(r.strModelNumber));
    const oduRow = oduRows[0];
    const sys: DsbSystem = {
      id: sysId,
      name: s(sr.strSystemName),
      systemType: n(sr.numSystemType) ?? 0,
      mnet: typeof sr.boolAssignMNet === "boolean" ? sr.boolAssignMNet : undefined,
      centralControllers: [],
      extraOdus: oduRows.slice(1).map((r) => s(r.strModelNumber)!),
      idus: [],
      branchBoxes: [],
      joints: [],
      otherNodes: {},
    };
    systems.push(sys);
    if (!oduRow) continue;
    const oduId = id(oduRow);
    sys.odu = {
      id: oduId,
      model: s(oduRow.strModelNumber)!,
      elevation: n(oduRow.numElevation_1),
      pipingLengths: ["A", "B", "C", "D", "E"].map((k) => len(oduRow[`numPipingLength_${k}`]) ?? 0),
    };
    for (const odu of oduRows) {
      for (const r of nodesByOdu.get(id(odu)) ?? []) {
        const type = n(r.numType) ?? 0;
        const model = s(r.strModelNumber);
        if (type === NODE_TYPE.indoorUnit) {
          if (!model) continue;
          const g = n(r.fkIndoorUnitGroup_Id);
          for (const m of (g && srcByGroup.get(g)) || []) if (!sys.centralControllers.includes(m)) sys.centralControllers.push(m);
          sys.idus.push({
            id: id(r),
            model,
            room: s(r.strRoom),
            tag: s(r.strReferenceTag),
            groupName: s(r.strGroupDescr),
            pipeLength: len(r.numPipingLength),
            elevation: n(r.numElevation),
            bends: n(r.numNumberofBends),
            port: s(r.strActualPort),
            branchBoxId: ancestorOfType(r, NODE_TYPE.branchBox),
            controllers: g ? (lrcByGroup.get(g) ?? []) : [],
            groupSize: g ? (groupCount.get(g) ?? 1) : 1,
          });
        } else if (type === NODE_TYPE.branchBox) {
          const p = parentOf(r);
          if (model)
            sys.branchBoxes.push({
              id: id(r),
              model,
              pipeLength: len(r.numPipingLength),
              ports: len(r.numMaxBranchCount),
              direct: isDirect(r),
              underJoint: p != null && n(nodes.get(p)?.numType) === NODE_TYPE.joint,
            });
        } else if (type === NODE_TYPE.joint) {
          sys.joints.push({ id: id(r), model, pipeLength: len(r.numPipingLength), direct: isDirect(r) });
        } else if (type !== NODE_TYPE.outdoorUnit) {
          const name = NODE_NAME[type] ?? `node type ${type}`;
          sys.otherNodes[name] = (sys.otherNodes[name] ?? 0) + 1;
        }
      }
      if (!sys.idus.length)
        for (const r of legacyIdusByOdu.get(id(odu)) ?? []) {
          const model = s(r.strModelNumber);
          if (!model) continue;
          sys.idus.push({
            id: id(r),
            model,
            tag: s(r.strReference),
            groupName: s(r.strGroupDescr),
            pipeLength: len(r.numPipingLength),
            elevation: n(r.numElevation),
            bends: n(r.numNumberofBends),
            controllers: [],
            groupSize: 1,
          });
        }
    }
  }

  // Project-level equipment we do not import (centralized controls, interfaces, ventilation).
  const equipment = new Map<string, DsbEquipment>();
  const addEq = (kind: string, rs: DsbRow[]) => {
    for (const r of rs) {
      const m = s(r.strModelNumber);
      if (!m) continue;
      const k = `${kind}|${m}`;
      const e = equipment.get(k) ?? { model: m, kind, qty: 0 };
      e.qty++;
      equipment.set(k, e);
    }
  };
  addEq("System controller", rows("tblSystemRemoteController"));
  addEq("Controls interface", rows("tblControlsInterface"));
  addEq("PI / AI / DIDO controller", rows("tblPIAIDIDO"));
  addEq("Lossnay ERV", rows("tblLossnay"));
  addEq("Interface panel", rows("tblInterfacePanel"));

  return {
    name: s(project?.strProjectName),
    customer: s(project?.strCustomerName),
    pipeLengthUnitSetting: n(project?.numMeasure_PipeLengthUnit),
    systems,
    projectEquipment: [...equipment.values()],
    accessories: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Mapping to app designs
// ---------------------------------------------------------------------------------------------

export const SYSTEM_TYPE: Record<number, SystemKey> = { 7: "MandS", 8: "P", 9: "MXZ", 27: "MXZSM" };
const SYSTEM_LABEL: Record<SystemKey, string> = { MandS: "M & S-Series", P: "P-Series", MXZ: "MXZ multi-zone", MXZSM: "Smart Multi" };
const OUT_OF_SCOPE: Record<number, string> = { 6: "S-Series PUMY (VRF)", 10: "PH", 11: "PF" };

const norm = (m: string) => m.trim().toUpperCase();

const oduByModel = new Map<string, OutdoorUnit[]>();
for (const u of outdoorUnits) oduByModel.set(norm(u.model), [...(oduByModel.get(norm(u.model)) ?? []), u]);
const iduByModel = new Map<string, IndoorUnit[]>();
for (const u of indoorUnits) iduByModel.set(norm(u.model), [...(iduByModel.get(norm(u.model)) ?? []), u]);
const rank = (st: string) => (st === "current" ? 0 : st === "legacy" ? 1 : 2);

export function matchOdu(model: string, system: SystemKey): OutdoorUnit | undefined {
  const c = oduByModel.get(norm(model)) ?? [];
  return [...c].sort((a, b) => Number(a.system !== system) - Number(b.system !== system) || rank(a.status) - rank(b.status))[0];
}

export function matchIdu(model: string, system: SystemKey): IndoorUnit | undefined {
  const c = iduByModel.get(norm(model)) ?? [];
  return [...c].sort((a, b) => Number(!a.systems.includes(system)) - Number(!b.systems.includes(system)) || rank(a.status) - rank(b.status))[0];
}

const WIFI_LRC_TYPE = 9;
const wifiModels = new Set((tables.lrc_list ?? []).filter((r) => Number(r.fkLRCType_Id) === WIFI_LRC_TYPE).map((r) => norm(String(r.strModelNumber))));

const boxPortsByModel = new Map((tables.branch_boxes ?? []).map((r) => [norm(String(r.strModelNumber)), r.numMaxBranchCount]));

const round1 = (x: number) => Math.round(x * 10) / 10;

export function toDesigns(p: DsbProject): { systems: SystemDesign[]; warnings: string[] } {
  const warnings: string[] = [];
  const systems: SystemDesign[] = [];

  p.systems.forEach((ds, i) => {
    const label = ds.name ? `"${ds.name}"` : `System ${i + 1}`;
    const key = SYSTEM_TYPE[ds.systemType];
    if (!key) {
      const what = OUT_OF_SCOPE[ds.systemType] ?? (ds.odu ? `${ds.odu.model}, system type ${ds.systemType}` : `system type ${ds.systemType}`);
      warnings.push(`${label}: skipped. this app only handles M & S, P, MXZ and Smart Multi systems (this one is ${what}).`);
      return;
    }
    if (!ds.odu) {
      warnings.push(`${label}: skipped, it has no outdoor unit.`);
      return;
    }
    if (isExcludedSmartMulti(ds.odu.model)) {
      warnings.push(`${label}: skipped, three-phase Smart Multi is outside the residential V1 scope (${ds.odu.model}).`);
      return;
    }
    const odu = matchOdu(ds.odu.model, key);
    if (!odu) {
      warnings.push(`${label}: skipped, outdoor unit ${ds.odu.model} is not in the catalog.`);
      return;
    }
    let system = key;
    if (odu.system !== key) {
      warnings.push(`${label}: DSB lists ${odu.model} as ${SYSTEM_LABEL[key]}; the catalog lists it as ${SYSTEM_LABEL[odu.system]}, so it was imported as ${SYSTEM_LABEL[odu.system]}.`);
      system = odu.system;
    }
    if (ds.extraOdus.length) warnings.push(`${label}: extra outdoor units ignored (${ds.extraOdus.join(", ")}).`);
    for (const [name, count] of Object.entries(ds.otherNodes)) warnings.push(`${label}: ${count} ${name}${count > 1 ? "s" : ""} not imported.`);

    const design: SystemDesign = { id: `dsb-${ds.id}`, name: ds.name ?? `${odu.model}`, system, oduId: odu.id, idus: [], branchBoxes: [] };

    if (ds.mnet) design.mnet = true;
    if (ds.centralControllers.length) {
      design.centralController = ds.centralControllers[0];
      design.mnet = true;
      if (ds.centralControllers.length > 1) warnings.push(`${label}: extra central controllers not imported: ${ds.centralControllers.slice(1).join(", ")}.`);
    }

    // Branch boxes (Smart Multi / branch-box MXZ), in file order; IDUs point at them by index.
    const boxIndex = new Map<number, number>();
    if (ds.branchBoxes.length && !odu.branchBox)
      warnings.push(`${label}: ${odu.model} does not use branch boxes; ${ds.branchBoxes.length} branch box(es) ignored.`);
    else if (ds.branchBoxes.length) {
      const ports: number[] = [];
      for (const b of ds.branchBoxes) {
        boxIndex.set(b.id, design.branchBoxes.length);
        const bb: BranchBoxPlacement = { key: `dsb-bb-${b.id}`, model: b.model };
        if (b.pipeLength != null) bb.pipeLengthFt = round1(b.pipeLength);
        design.branchBoxes.push(bb);
        ports.push(b.ports ?? Number(boxPortsByModel.get(norm(b.model)) ?? 0));
      }
      design.boxCount = ds.branchBoxes.length;
      if (ports.every((x) => x === 3 || x === 5)) design.boxPorts = ports as (3 | 5)[];
      const joint = ds.joints.find((j) => j.direct && j.pipeLength != null);
      const viaJoint = ds.branchBoxes.filter((b) => b.underJoint);
      if (joint) {
        design.mainLineFt = round1(joint.pipeLength!);
        if (viaJoint.length && viaJoint.every((b) => b.pipeLength != null)) design.jointToBoxFt = viaJoint.map((b) => round1(b.pipeLength!));
      } else {
        const box = ds.branchBoxes.find((b) => b.direct && b.pipeLength != null);
        if (box) design.mainLineFt = round1(box.pipeLength!);
      }
    }

    const sharedGroupsWarned = new Set<string>();
    const controlledGroups = new Set<string>();
    for (const du of ds.idus) {
      const u = matchIdu(du.model, system);
      if (!u) {
        warnings.push(`${label}: indoor unit ${du.model}${du.room ? ` (${du.room})` : ""} skipped, it is not in the catalog.`);
        continue;
      }
      if (!u.systems.includes(system))
        warnings.push(`${label}: ${u.model} is not listed for ${SYSTEM_LABEL[system]} in the catalog; check compatibility.`);
      const placement: IduPlacement = {
        key: `dsb-${du.id}`,
        iduId: u.id,
        room: du.room ?? du.groupName ?? du.tag ?? u.model,
      };
      if (du.pipeLength != null) placement.pipeLengthFt = round1(du.pipeLength);
      if (du.elevation != null) placement.heightFt = round1(du.elevation - (ds.odu.elevation ?? 0));
      if (du.bends != null && du.bends > 0) placement.bends = Math.round(du.bends);
      if (du.port && /^[A-E]$/i.test(du.port)) placement.port = du.port.toUpperCase();
      if (du.branchBoxId != null && boxIndex.has(du.branchBoxId)) placement.box = boxIndex.get(du.branchBoxId);

      // Controllers: a group remote controlling several units is attached to the first unit only (group control is not modelled).
      const groupKey = du.controllers.join("|");
      const shared = du.groupSize > 1 && du.controllers.length > 0;
      if (shared && controlledGroups.has(`${groupKey}#${du.groupSize}`)) {
        if (!sharedGroupsWarned.has(groupKey)) {
          warnings.push(`${label}: controller ${du.controllers.join(" + ")} is shared by a group of ${du.groupSize} indoor units; it was added to the first unit only (group control is not modelled).`);
          sharedGroupsWarned.add(groupKey);
        }
      } else {
        if (shared) controlledGroups.add(`${groupKey}#${du.groupSize}`);
        const extra: string[] = [];
        for (const m of du.controllers) {
          if (wifiModels.has(norm(m))) {
            if (!placement.wifiAdapter) placement.wifiAdapter = m;
            else extra.push(m);
          } else if (!placement.controller) placement.controller = m;
          else extra.push(m);
        }
        if (extra.length) warnings.push(`${label}: extra controllers on ${u.model} (${placement.room}) not imported: ${extra.join(", ")}.`);
      }
      design.idus.push(placement);
    }

    if (system === "MandS" || system === "P") {
      const joint = ds.joints.find((j) => j.direct && j.pipeLength != null);
      const first = ds.idus.find((x) => x.pipeLength != null);
      const line = joint?.pipeLength ?? first?.pipeLength ?? (ds.odu.pipingLengths[0] || undefined);
      if (line != null) design.totalPipeFt = round1(line);
      const bends = ds.idus.find((x) => x.bends != null)?.bends;
      if (bends != null && bends > 0) design.bends = Math.round(bends);
    }

    const accessories = p.accessories.filter((a) => a.systemId === ds.id);
    if (accessories.length) design.oduAccessories = Object.fromEntries(accessories.map((a) => [a.model, a.qty]));

    if (!design.idus.length) warnings.push(`${label}: no indoor units were imported.`);
    systems.push(design);
  });

  if (p.projectEquipment.length)
    warnings.push(`Project-level equipment not imported (centralized controls and ventilation are out of scope): ${p.projectEquipment.map((e) => `${e.qty} x ${e.model}`).join(", ")}.`);
  if (!p.systems.length) warnings.push("The project has no systems.");
  return { systems, warnings };
}

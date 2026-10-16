// Types shared by the client UI and the server-side rules engine.

export type SystemKey = "MandS" | "P" | "MXZ" | "MXZSM";

/** Brand printed on the BOM: Mitsubishi, Trane or American Standard part numbers. */
export type Brand = "ME" | "TRME" | "ASME";

/** Project-wide settings, sent along with every system for evaluation. */
export interface ProjectSettings {
  brand: Brand;
  /** DSB's "max connection" project setting for R410A multi-zone: 100% or 130%. R454B ignores it. */
  connectionRatio: 100 | 130;
  /** Design conditions for corrected capacity; DSB's US defaults when missing. */
  conditions?: DesignConditions;
}

export interface DesignConditions {
  /** Outdoor cooling design dry bulb, °F (default 95). */
  coolOutdoorDbF: number;
  /** Outdoor heating design WET bulb, °F (default 43). Roughly 1 °F below dry bulb in cold weather. */
  heatOutdoorWbF: number;
  /** Indoor cooling wet bulb, °F (default 67). */
  coolIndoorWbF: number;
  /** Indoor heating dry bulb, °F (default 70). */
  heatIndoorDbF: number;
  /** Site altitude, ft (default 0). */
  altitudeFt: number;
}

export const DEFAULT_CONDITIONS: DesignConditions = { coolOutdoorDbF: 95, heatOutdoorWbF: 43, coolIndoorWbF: 67, heatIndoorDbF: 70, altitudeFt: 0 };

export interface PaletteOdu {
  id: number;
  legacy: boolean;
  model: string;
  name: string;
  system: SystemKey;
  refrigerant: string;
  coolingBtu: number;
  heatingBtu: number;
  maxIdus: number;
  /** Lower indoor-unit limit when a PLA cassette or cased coil is in the mix (MXZ / Smart Multi). */
  maxIdusReduced?: number;
  minIdus: number;
  /** Branch-box MXZ / Smart Multi (IDUs hang off branch boxes, not ODU ports). */
  branchBox: boolean;
  /** Single zone: the indoor unit this ODU is normally paired with. */
  defaultIdu?: string;
}

export interface PaletteIdu {
  id: number;
  legacy: boolean;
  model: string;
  name: string;
  systems: SystemKey[];
  refrigerant: string;
  typeName: string;
  coolingBtu: number;
  heatingBtu: number;
  size: number;
}

export interface Palette {
  odus: PaletteOdu[];
  idus: PaletteIdu[];
  dbVersion: string;
}

export interface IduPlacement {
  key: string;
  iduId: number;
  room: string;
  /** Pipe run from the ODU (or branch box) to this IDU, feet (actual length; bends add equivalent length). */
  pipeLengthFt?: number;
  /** Field bends on this unit's line. */
  bends?: number;
  /** Height of the IDU relative to the ODU, feet: positive = IDU above ODU. */
  heightFt?: number;
  /** R454B: floor area this unit serves, sq ft (coil units: the whole conditioned area it serves). */
  floorAreaSqFt?: number;
  /** R454B: mounting height of the unit above the finished floor, ft. */
  installHeightFt?: number;
  /** R454B coil units (multi-position, cased coil): installed inside the conditioned space? */
  inConditionedSpace?: boolean;
  /** R454B coil units: floor area of the room the unit is physically installed in (closet, attic), sq ft. */
  installedRoomSqFt?: number;
  /** R454B ducted units: height of the lowest supply grille above the floor, ft. */
  supplyGrilleFt?: number;
  /** R454B ducted units: height of the lowest return grille above the floor, ft. */
  returnGrilleFt?: number;
  controller?: string;
  /** Wi-Fi / app adapter (kumo cloud etc.), a second controller on the same unit. */
  wifiAdapter?: string;
  /** Optional accessories the user picked: model -> qty. */
  accessories?: Record<string, number>;
  /** Branch-box systems: which branch box (index into the layout) and port; empty = automatic. */
  box?: number;
  /** MXZ port-type / branch box port letter (A-E); empty = automatic. */
  port?: string;
}

export interface BranchBoxPlacement {
  key: string;
  model: string;
  pipeLengthFt?: number;
}

export interface SystemDesign {
  id: string;
  name: string;
  system: SystemKey;
  oduId?: number;
  idus: IduPlacement[];
  branchBoxes: BranchBoxPlacement[];
  /** Single-zone / P-Series: line-set length ODU to IDU, feet. */
  totalPipeFt?: number;
  /** Branch-box systems: ODU to first branch box (or to the joint when there are two), feet. */
  mainLineFt?: number;
  /** Branch-box systems with a joint: joint to each branch box, feet. */
  jointToBoxFt?: number[];
  /** Branch-box systems: number of branch boxes; empty = automatic. */
  boxCount?: number;
  /** Branch-box systems: unused ports capped off, by box index ("0", "1"…) → port letters. Units are never put on a capped port. */
  cappedPorts?: Record<string, string[]>;
  /** Branch-box systems: ports per box (3 or 5) in order; empty = automatic. */
  boxPorts?: (3 | 5)[];
  /** Branch boxes powered from the outdoor unit (DSB default) or separately. */
  boxesPoweredByOdu?: boolean;
  /** R454B: where each branch box is installed (index = box). Habitable rooms get height and area checks. */
  boxRooms?: { habitable?: boolean; mountingHeightFt?: number; floorAreaSqFt?: number }[];
  /** M-NET on (needed for central controllers; DSB's "AssignMNet"). */
  mnet?: boolean;
  /** Central controller (e.g. AE-200A) for this system; turns M-NET on. */
  centralController?: string;
  /** Project settings copied in by the client when evaluating. */
  settings?: ProjectSettings;
  /** Number of field bends on the line set (single-zone / P-Series). */
  bends?: number;
  /** Optional outdoor-unit accessories the user picked: model -> qty. */
  oduAccessories?: Record<string, number>;
  /** Include discontinued (legacy) models in the palette. */
  showLegacy?: boolean;
  /** Narrow the outdoor-unit choices to one refrigerant before an ODU is placed. */
  refrigerantFilter?: "R454B" | "R410A";
}

export type Severity = "error" | "warning" | "info";

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  /** IDU placement key or "odu" / branch box key this issue is about. */
  target?: string;
  /** An error that adding more units can clear (too few units, under minimum capacity). */
  incomplete?: boolean;
}

export interface BomLine {
  model: string;
  /** "ft" for line sets; each otherwise. */
  unit?: "ea" | "ft";
  /** Base Mitsubishi model when a cobranded number is shown in `model`. */
  baseModel?: string;
  description: string;
  qty: number;
  category: "Outdoor unit" | "Indoor unit" | "Branch box" | "Controller" | "Interface" | "Accessory" | "Kit" | "Line set";
  /** Why this line is here (e.g. "required by MSZ-GS12NA-U1"). */
  reason?: string;
  optional?: boolean;
}

export interface ControllerOption {
  model: string;
  name: string;
  wired: boolean;
  kind: "controller" | "wifi";
  /** Extra parts needed to use this controller with this IDU. */
  requires: string[];
}

export interface Evaluation {
  /** The ODU this evaluation was computed for (lets the UI ignore stale results). */
  oduId?: number;
  status: "pass" | "fail" | "incomplete";
  issues: Issue[];
  bom: BomLine[];
  /** IDU ids that can be dropped onto the current ODU (for palette highlighting). */
  compatibleIduIds: number[];
  /** Controller choices per IDU placement key. */
  controllers: Record<string, ControllerOption[]>;
  /** Central controllers offered for the system. */
  centralControllers?: { model: string; name: string }[];
  /** Optional accessories offered per placement key ("odu" for the outdoor unit). */
  accessoryOptions: Record<string, AccessoryOption[]>;
  /** Branch boxes the engine laid out (branch-box MXZ / Smart Multi). */
  layout?: { boxes: { model: string; ports: number; iduKeys: string[] }[]; joint?: string };
  /** Rules this system type does not check yet. */
  unchecked: string[];
  /** Port / branch box each unit ended up on (user choice or automatic). */
  assignments?: Record<string, { box?: number; port?: string }>;
  /** Electrical, efficiency and documents for the units in this system. */
  specs?: SystemSpecs;
  /** Pipe sizes per run (inches) for the line-set takeoff. */
  piping?: PipeRun[];
  /** Corrected capacity at the design conditions (capacity-derates.md). */
  capacity?: CapacityResult;
  /** R454B (A2L) results: charge used and each unit's minimums. */
  a2l?: A2lResult;
  /** Refrigerant charge (multi-zone / single zone where known). */
  charge?: { additionalOz: number; totalKg?: number; maxKg?: number; note?: string };
  summary?: {
    connectedBtu: number;
    oduBtu: number;
    connectedPct?: number;
  };
}

export interface AccessoryOption {
  model: string;
  description: string;
  /** Required quantity already added automatically (0 = optional). */
  required: number;
}

export interface UnitSpecs {
  mca?: string;
  mocp?: string;
  power?: string;
  submittal?: string;
  catalogue?: string;
}

export interface SystemSpecs {
  odu: UnitSpecs;
  idus: Record<string, UnitSpecs>;
  efficiency?: { seer2?: string; eer2?: string; hspf2?: string; hspf2Region5?: string; cop?: string; basis: string };
}

export interface PipeRun {
  /** e.g. "Outdoor unit → Living room" or "Main line". */
  label: string;
  target?: string;
  liquidIn: number;
  gasIn: number;
  lengthFt?: number;
  bends?: number;
  equivalentFt?: number;
}

export interface A2lUnit {
  /** Installation case for coil units (A-D). */
  case?: "A" | "B" | "C" | "D";
  /** Minimum floor area served, sq ft. */
  minAreaSqFt?: number;
  /** Coil units: minimum area of the room the unit is installed in, sq ft. */
  minInstalledRoomSqFt?: number;
  minMountingFt?: number;
  minGrilleFt?: number;
  coil?: boolean;
  ducted?: boolean;
}

export interface A2lResult {
  /** System charge the checks used, kg. */
  chargeKg: number;
  /** True when line lengths were missing and the charge is the factory charge only. */
  chargeIsFactoryOnly: boolean;
  units: Record<string, A2lUnit>;
  boxMinAreaSqFt?: number;
}

export interface ModeCapacity {
  /** System total after scaling (Btu/h). */
  systemBtu: number;
  /** Corrected outdoor-unit capacity (the ceiling), when the system has one. */
  oduBtu?: number;
  perIdu: Record<string, number>;
  /** True when indoor units were scaled down to fit the outdoor unit. */
  limitedByOdu: boolean;
  factors: { temperature: number; piping: number; defrost?: number; connection: number; altitude: number };
}

export interface CapacityResult {
  cooling?: ModeCapacity;
  heating?: ModeCapacity;
  /** The temperatures actually used after clamping to the unit's operating range. */
  used: { coolOutdoorDbF: number; heatOutdoorWbF: number; coolIndoorWbF: number; heatIndoorDbF: number; altitudeFt: number };
  style: "old" | "new";
  notes: string[];
}

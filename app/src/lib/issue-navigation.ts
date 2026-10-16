import type { Evaluation, Issue, PaletteOdu, SystemDesign } from "./design";

export interface PropertyDestination {
  target: string;
  section: string;
  field?: string;
}

/** Route engine issues to the controls that can resolve them. */
export function issueDestination(issue: Issue, system: SystemDesign, odu?: PaletteOdu, evaluation?: Evaluation): PropertyDestination {
  const single = system.system === "MandS" || system.system === "P";
  const explicit = system.idus.find((unit) => unit.key === issue.target);
  const indoor = explicit ?? system.idus[0];
  const destination: PropertyDestination = { target: explicit?.key ?? "odu", section: explicit ? "Indoor unit" : "System" };
  if (!odu) return destination;

  if (/^HEIGHT_/.test(issue.code)) {
    const unit = explicit ?? system.idus.find((unit) => unit.heightFt == null) ?? indoor;
    return unit ? { target: unit.key, section: "Install", field: "Height vs. outdoor unit" } : destination;
  }

  if (/^(NO_CONTROLLER$|LRC_|CN105$|WIFI_|1218$)/.test(issue.code)) {
    return indoor ? { target: indoor.key, section: "Controls", field: issue.code.startsWith("WIFI") ? "Wi-Fi / app adapter" : "Controller" } : destination;
  }
  if (issue.code.startsWith("ACC_")) return { ...destination, section: "Accessories" };

  if (issue.code === "1267" || (/^1259$/.test(issue.code) && /Branch box/i.test(issue.message))) {
    return { target: "odu", section: "Branch boxes" };
  }
  if (/^(1258|1259|1260|1261|1262|1263|R454B_INPUTS|R454B_AREA)$/.test(issue.code)) {
    if (issue.code === "R454B_INPUTS" && /branch boxes in living spaces/.test(issue.message)) return { target: "odu", section: "Branch boxes" };
    const unit = explicit ?? system.idus.find((unit) => {
      if (issue.code === "R454B_AREA") return unit.floorAreaSqFt == null;
      const safety = evaluation?.a2l?.units[unit.key];
      return (/installed-room/.test(issue.message) && safety?.coil && unit.installedRoomSqFt == null)
        || (/mounting height/.test(issue.message) && unit.installHeightFt == null)
        || (/ducted grille/.test(issue.message) && safety?.ducted && (unit.supplyGrilleFt == null || unit.returnGrilleFt == null))
        || (/floor area/.test(issue.message) && unit.floorAreaSqFt == null);
    }) ?? indoor;
    if (!unit) return destination;
    const coil = evaluation?.a2l?.units[unit.key]?.coil;
    const field = issue.code === "R454B_INPUTS" && /installed-room/.test(issue.message) && coil && unit.installedRoomSqFt == null ? "Room it's installed in"
      : issue.code === "R454B_INPUTS" && /ducted grille/.test(issue.message) ? unit.supplyGrilleFt == null ? "Lowest supply grille height" : "Lowest return grille height"
      : issue.code === "1259" || (issue.code === "R454B_INPUTS" && /mounting height/.test(issue.message) && unit.installHeightFt == null) ? "Mounting height above floor"
      : issue.code === "1260" ? "Lowest supply grille height"
      : issue.code === "1261" ? "Lowest return grille height"
      : issue.code === "1263" ? "Room it's installed in"
      : coil ? "Conditioned area it serves" : "Room floor area";
    return { target: unit.key, section: "R454B safety", field };
  }

  if (/^(BOX_|BB_NONE$|JOINT$|1288$)/.test(issue.code)) {
    return odu.branchBox ? { target: "odu", section: "Branch boxes" } : destination;
  }
  if (/^PORT_/.test(issue.code)) return indoor ? { target: indoor.key, section: "Install", field: "Port" } : destination;

  if (/^(PIPE_|LINESET_|P_R454B_SHORT_LINE$|R454B_CHARGE$|CHARGE_CAPPED$)/.test(issue.code) || ["1023", "1024", "1042", "1043", "1134", "1174", "1236", "1251"].includes(issue.code)) {
    if (single) return { target: "odu", section: "Piping", field: issue.code === "1134" ? "Bends" : "Line-set length" };
    if (issue.code === "1174") {
      const box = issue.message.match(/branch box (\d+)/i)?.[1];
      return { target: "odu", section: "Piping", field: box ? `Joint to branch box ${box} (ft)` : undefined };
    }
    if (issue.code === "1043" || (!explicit && odu.branchBox && system.mainLineFt == null)) {
      return { target: "odu", section: "Piping", field: "Main line," };
    }
    const joint = odu.branchBox && (evaluation?.layout?.boxes.length ?? 0) > 1
      ? evaluation?.layout?.boxes.findIndex((_, index) => system.jointToBoxFt?.[index] == null) ?? -1 : -1;
    if (!explicit && joint >= 0) return { target: "odu", section: "Piping", field: `Joint to branch box ${joint + 1} (ft)` };
    const unit = explicit ?? system.idus.find((unit) => unit.pipeLengthFt == null) ?? indoor;
    return { target: unit?.key ?? "odu", section: "Piping", field: unit ? `${issue.code === "1134" ? "Bends to" : "Line to"} ${unit.room}` : undefined };
  }
  if (["1257", "1135"].includes(issue.code)) return { target: "odu", section: "Refrigerant charge (estimate)" };
  if (/MNET|CENTRAL/.test(issue.code)) return { target: "odu", section: "M-NET & central control" };
  return destination;
}

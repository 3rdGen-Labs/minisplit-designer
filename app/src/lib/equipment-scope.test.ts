import { describe, expect, it } from "vitest";
import catalog from "@/data/catalog.json";
import controls from "@/data/controls.json";
import multi from "@/data/multi.json";
import derates from "@/data/derates.json";
import { outdoorUnits } from "./catalog";
import { isExcludedSmartMulti, scopeEquipmentData } from "./equipment-scope.mjs";
import { buildPalette, evaluate } from "./engine";
import type { SystemDesign } from "./design";
import { matchOdu, toDesigns } from "./dsb-import";

const excludedModels = ["MXZ-SM72TAM-U1", "MXZ-SM96TAM-U1", "MXZ-SM120TAM-U1", "MXZ-SM72TL", "MXZ-SM96TL", "MXZ-SM120TL"];

describe("residential V1 Smart Multi scope", () => {
  it("physically excludes three-phase models, dedicated A2L rows, curves and valve-kit data from shipped bundles", () => {
    const data = JSON.stringify({ catalog, controls, multi, derates });
    for (const model of excludedModels) expect(data).not.toContain(model);
    expect(data).not.toContain('MXZ-SM-TL');
    expect(data).not.toContain('CMR-M100KT');
    expect(data).not.toContain('CMY-Y62-GA-E');
    expect(multi).not.toHaveProperty('shutoff_valve_kits');
    expect(outdoorUnits.some((u) => u.system === "MXZSM" && u.raw.strPhase === "3-phase")).toBe(false);
  });

  it("keeps single-phase Smart Multi and the other system families available", () => {
    const palette = buildPalette();
    for (const model of ["MXZ-SM36NAM-U1", "MXZ-SM48NL", "MXZ-SM60NLHZ"]) {
      expect(palette.odus.some((u) => u.model === model)).toBe(true);
      expect(matchOdu(model, "MXZSM")).toBeDefined();
    }
    for (const family of ["MandS", "P", "MXZ"]) expect(palette.odus.some((u) => u.system === family)).toBe(true);
    for (const model of excludedModels) {
      expect(palette.odus.some((u) => u.model === model)).toBe(false);
      expect(matchOdu(model, "MXZSM")).toBeUndefined();
    }
  });

  it("fails stale saved designs or API requests using removed outdoor IDs", () => {
    for (const oduId of [2358, 2740, 2354, 2738, 2356, 2739]) {
      const design: SystemDesign = { id: "stale", name: "Old project", system: "MXZSM", oduId, idus: [], branchBoxes: [] };
      expect(evaluate(design)).toMatchObject({ status: "fail", bom: [], issues: [{ code: "ODU_UNSUPPORTED" }] });
    }
    expect(evaluate({ id: "new", name: "New", system: "MXZSM", idus: [], branchBoxes: [] }).status).toBe("incomplete");
  });

  it("skips three-phase DSB systems with an explicit explanation", () => {
    for (const model of excludedModels) {
      const result = toDesigns({ systems: [{ id: 1, systemType: 27, centralControllers: [], odu: { id: 1, model, pipingLengths: [] }, extraOdus: [], idus: [], branchBoxes: [], joints: [], otherNodes: {} }], projectEquipment: [], accessories: [] });
      expect(result.systems).toEqual([]);
      expect(result.warnings.join(" ")).toMatch(/three-phase Smart Multi is outside/);
    }
  });

  it("prevents data rebuilds from bringing excluded models back without removing shared or P-Series data", () => {
    const shared = { strODUSeries: "MXZ-SM", numRefCharge: 1 };
    const p = { strModelNumber: "PUZ-EXAMPLE", strPhase: "3-phase" };
    expect(isExcludedSmartMulti("MXZ-SM150XYZ", "3-phase")).toBe(true);
    expect(scopeEquipmentData({
      outdoor_units: [{ strModelNumber: "MXZ-SM72TL", strPhase: "3-phase" }, { strModelNumber: "MXZ-SM48NL", strPhase: "1-phase" }, p],
      validation: [{ strODUSeries: "MXZ-SM-TL" }, shared],
      shutoff_valve_kits: [{ strModelNumber: "CMR-M100KT-NA" }],
      odu_extra: { "MXZ-SM72TL": {}, "MXZ-SM48NL": {} },
    })).toEqual({ outdoor_units: [{ strModelNumber: "MXZ-SM48NL", strPhase: "1-phase" }, p], validation: [shared], odu_extra: { "MXZ-SM48NL": {} } });
  });
});

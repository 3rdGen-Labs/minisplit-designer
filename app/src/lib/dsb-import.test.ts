import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDsbProject, DsbImportError, matchIdu, matchOdu, NODE_TYPE, parseDsbProject, toDesigns, type DsbProject } from "./dsb-import";

const TEMPLATE = join(homedir(), "Developer/zonespec-private/DiamondBuilderProjectTemplate.mdb");

describe("parseDsbProject", () => {
  it.skipIf(!existsSync(TEMPLATE))("reads the empty DSB project template without systems", () => {
    const p = parseDsbProject(readFileSync(TEMPLATE));
    expect(p.systems).toEqual([]);
    expect(p.projectEquipment).toEqual([]);
    expect(toDesigns(p).systems).toEqual([]);
  });

  it("rejects files that are not Access databases", () => {
    expect(() => parseDsbProject(Buffer.alloc(10))).toThrow(DsbImportError);
    expect(() => parseDsbProject(Buffer.alloc(8192, 1))).toThrow(/not a DSB project/);
    const zip = Buffer.alloc(8192);
    zip.write("PK\u0003\u0004", 0, "latin1");
    expect(() => parseDsbProject(zip)).toThrow(/ZIP/);
  });
});

describe("buildDsbProject (table rows -> project)", () => {
  // Synthetic rows shaped like the template's tables (no Access writer is available to build a real fixture).
  const tables = {
    tblProject: [{ ID: 1, strProjectName: "Smith residence", strCustomerName: "Smith", numMeasure_PipeLengthUnit: 0 }],
    tblSystem: [
      { Id: 10, numSystemType: 7, strSystemName: "Bedroom", boolAssignMNet: false },
      { Id: 11, numSystemType: 27, strSystemName: "Main", boolAssignMNet: false },
    ],
    tblOutdoorUnit: [
      { Id: 100, fkSystem_Id: 10, strModelNumber: "MUZ-GS12NA-U1", numElevation_1: 2 },
      { Id: 101, fkSystem_Id: 11, strModelNumber: "MXZ-SM36NAM-U1", numElevation_1: 0 },
    ],
    tblBranchUnit: [
      { Id: 1, fkOutdoorUnit_Id: 100, numType: NODE_TYPE.indoorUnit, strModelNumber: "MSZ-GS12NA-U1", strRoom: "Bedroom 1", numPipingLength: 25, numElevation: 12, numNumberofBends: 3, fkIndoorUnitGroup_Id: 50 },
      { Id: 2, fkOutdoorUnit_Id: 101, numType: NODE_TYPE.joint, numPipingLength: 30 },
      { Id: 3, fkBranchUnit_Id: 2, numType: NODE_TYPE.branchBox, strModelNumber: "PAC-MKA33BC", numPipingLength: 10 },
      { Id: 4, fkBranchUnit_Id: 3, numType: NODE_TYPE.indoorUnit, strModelNumber: "MSZ-GS09NA-U1", strRoom: "Office", strActualPort: "A", numPipingLength: 15, fkIndoorUnitGroup_Id: 51 },
      { Id: 7, fkBranchUnit_Id: 3, numType: NODE_TYPE.indoorUnit, strModelNumber: "MSZ-GS12NA-U1", strRoom: "Kitchen", numPipingLength: 20, fkIndoorUnitGroup_Id: 52 },
      { Id: 5, fkBranchUnit_Id: 3, numType: NODE_TYPE.indoorUnit, strModelNumber: "MSZ-ZZ99NA-U1", strRoom: "Den" },
      { Id: 6, fkBranchUnit_Id: 3, numType: NODE_TYPE.header },
    ],
    tblLocalRemoteController: [
      { Id: 1, fkIndoorUnitGroup_Id: 50, strModelNumber: "PAR-21MAA" },
      { Id: 2, fkIndoorUnitGroup_Id: 50, strModelNumber: "PAC-USWHS002-WF-1" },
    ],
    tblIndoorUnitGroup: [{ ID: 51, fkSystemRemoteController1_Id: 1 }],
    tblSystemRemoteController: [{ Id: 1, strModelNumber: "AE-200A" }],
  };

  it("links systems, ODUs, the piping tree and controllers", () => {
    const p = buildDsbProject(tables);
    expect(p.name).toBe("Smith residence");
    expect(p.systems).toHaveLength(2);
    const [single, sm] = p.systems;
    expect(single.odu?.model).toBe("MUZ-GS12NA-U1");
    expect(single.idus[0]).toMatchObject({ model: "MSZ-GS12NA-U1", room: "Bedroom 1", pipeLength: 25, elevation: 12, controllers: ["PAR-21MAA", "PAC-USWHS002-WF-1"] });
    expect(sm.branchBoxes).toEqual([{ id: 3, model: "PAC-MKA33BC", pipeLength: 10, ports: undefined, direct: false, underJoint: true }]);
    expect(sm.centralControllers).toEqual(["AE-200A"]);
    expect(sm.joints[0]).toMatchObject({ pipeLength: 30, direct: true });
    expect(sm.idus.map((u) => [u.model, u.branchBoxId, u.port])).toEqual([
      ["MSZ-GS09NA-U1", 3, "A"],
      ["MSZ-GS12NA-U1", 3, undefined],
      ["MSZ-ZZ99NA-U1", 3, undefined],
    ]);
    expect(sm.otherNodes).toEqual({ header: 1 });
    expect(p.projectEquipment).toEqual([{ model: "AE-200A", kind: "System controller", qty: 1 }]);
  });

  it("maps to designs end to end", () => {
    const { systems, warnings } = toDesigns(buildDsbProject(tables));
    expect(systems).toHaveLength(2);
    const [single, sm] = systems;
    expect(single).toMatchObject({ system: "MandS", totalPipeFt: 25, bends: 3 });
    expect(single.idus[0]).toMatchObject({ room: "Bedroom 1", heightFt: 10, bends: 3, controller: "PAR-21MAA", wifiAdapter: "PAC-USWHS002-WF-1" });
    expect(sm).toMatchObject({ system: "MXZSM", mainLineFt: 30, jointToBoxFt: [10], boxCount: 1, boxPorts: [3], mnet: true, centralController: "AE-200A" });
    expect(sm.branchBoxes).toEqual([{ key: "dsb-bb-3", model: "PAC-MKA33BC", pipeLengthFt: 10 }]);
    expect(sm.idus).toHaveLength(2);
    expect(sm.idus[0]).toMatchObject({ room: "Office", box: 0, port: "A", pipeLengthFt: 15 });
    expect(sm.idus[1].port).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/MSZ-ZZ99NA-U1 \(Den\) skipped/);
    expect(warnings.join("\n")).toMatch(/1 header not imported/);
    expect(warnings.join("\n")).toMatch(/AE-200A/);
  });
});

describe("toDesigns", () => {
  const base = (over: Partial<DsbProject> = {}): DsbProject => ({ systems: [], projectEquipment: [], accessories: [], ...over });

  it("skips VRF and unknown system types with a warning", () => {
    const { systems, warnings } = toDesigns(
      base({ systems: [{ id: 1, systemType: 6, centralControllers: [], odu: { id: 1, model: "PUMY-P48NKMU3", pipingLengths: [] }, extraOdus: [], idus: [], branchBoxes: [], joints: [], otherNodes: {} }] }),
    );
    expect(systems).toEqual([]);
    expect(warnings[0]).toMatch(/PUMY/);
  });

  it("skips systems whose ODU is not in the catalog, never throws", () => {
    const { systems, warnings } = toDesigns(
      base({ systems: [{ id: 2, systemType: 9, centralControllers: [], odu: { id: 1, model: "NOPE-123", pipingLengths: [] }, extraOdus: [], idus: [], branchBoxes: [], joints: [], otherNodes: {} }] }),
    );
    expect(systems).toEqual([]);
    expect(warnings[0]).toMatch(/NOPE-123 is not in the catalog/);
  });

  it("attaches a group controller to the first unit only", () => {
    const idu = (id: number) => ({ id, model: "MSZ-GS09NA-U1", room: `R${id}`, controllers: ["PAR-21MAA"], groupSize: 2 });
    const { systems, warnings } = toDesigns(
      base({ systems: [{ id: 3, systemType: 9, centralControllers: [], odu: { id: 1, model: "MXZ-2C20NA2-U1", pipingLengths: [] }, extraOdus: [], idus: [idu(1), idu(2)], branchBoxes: [], joints: [], otherNodes: {} }] }),
    );
    expect(systems[0].idus.map((p) => p.controller)).toEqual(["PAR-21MAA", undefined]);
    expect(warnings.join("\n")).toMatch(/shared by a group of 2/);
  });

  it("prefers the catalog row that matches the system", () => {
    expect(matchIdu("msz-gs12na-u1 ", "MandS")?.systems).toContain("MandS");
    expect(matchOdu("MXZ-SM36NAM-U1", "MXZSM")?.cityMultiMode).toBe(false);
  });
});

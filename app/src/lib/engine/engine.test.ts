import { describe, expect, it } from "vitest";
import type { IduPlacement, SystemDesign, SystemKey } from "../design";
import { indoorUnits, outdoorUnits, search } from "../catalog";
import { buildPalette, evaluate } from "./index";

const odu = (model: string, system?: SystemKey) => {
  const u = outdoorUnits.find((o) => o.model === model && (!system || o.system === system));
  if (!u) throw new Error(`no ODU ${model}`);
  return u.id;
};
const idu = (model: string, system: SystemKey) => {
  const u = indoorUnits.find((i) => i.model === model && i.systems.includes(system));
  if (!u) throw new Error(`no IDU ${model} for ${system}`);
  return u.id;
};
let n = 0;
const place = (iduId: number, extra: Partial<IduPlacement> = {}): IduPlacement => ({ key: `k${++n}`, iduId, room: `Room ${n}`, ...extra });
const design = (system: SystemKey, oduId: number, idus: IduPlacement[], extra: Partial<SystemDesign> = {}): SystemDesign => ({
  id: "s",
  name: "t",
  system,
  oduId,
  idus,
  branchBoxes: [],
  ...extra,
});
const codes = (d: SystemDesign) => evaluate(d).issues.filter((i) => i.severity === "error").map((i) => i.code);

describe("regex search semantics", () => {
  it("is unanchored like .NET Regex.IsMatch", () => {
    expect(search("MSZ-(FH|FS)\\d+NA", "MSZ-FH09NA2")).toBe(true);
    expect(search("$.", "anything")).toBe(false);
    expect(search("$a", "a")).toBe(false);
  });
});

describe("M & S-Series", () => {
  const sys = "MandS" as const;
  it("passes a matched pair within limits", () => {
    const d = design(sys, odu("SUZ-AA24NL"), [place(idu("SVZ-AP24NL", sys), { heightFt: 10 })], { totalPipeFt: 50 });
    const ev = evaluate(d);
    expect(codes(d)).toEqual([]);
    expect(ev.status).toBe("pass");
    expect(ev.bom.map((l) => l.model)).toEqual(expect.arrayContaining(["SUZ-AA24NL", "SVZ-AP24NL"]));
  });
  it("rejects an indoor unit that isn't a valid pair", () => {
    expect(codes(design(sys, odu("SUZ-AA24NL"), [place(idu("MSZ-FX12NL", sys))]))).toContain("1225");
  });
  it("doesn't invent a minimum line length (DSB has none)", () => {
    const d = design(sys, odu("SUZ-AA24NL"), [place(idu("SVZ-AP24NL", sys))], { totalPipeFt: 5 });
    expect(evaluate(d).issues.some((i) => i.code === "PIPE_TOO_SHORT")).toBe(false);
  });
  it("counts bends toward the line-set maximum", () => {
    const d = (bends: number) => design(sys, odu("SUZ-AA24NL"), [place(idu("SVZ-AP24NL", sys))], { totalPipeFt: 98, bends });
    expect(codes(d(0))).not.toContain("1023");
    expect(codes(d(3))).toContain("1023");
  });
  it("rejects an unrelated indoor unit and a refrigerant mismatch", () => {
    expect(codes(design(sys, odu("SUZ-AA24NL"), [place(idu("MSZ-GS12NA-U1", sys))]))).toContain("REFRIGERANT_MISMATCH");
  });
  it("flags a line set over the limit", () => {
    expect(codes(design(sys, odu("SUZ-AA24NL"), [place(idu("SVZ-AP24NL", sys))], { totalPipeFt: 150 }))).toContain("1023");
  });
  it("only offers pairs within 10% rated capacity", () => {
    const o = outdoorUnits.find((u) => u.model === "SUZ-AA24NL")!;
    const offered = evaluate(design(sys, o.id, [])).compatibleIduIds.map((id) => indoorUnits.find((u) => u.id === id)!);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((u) => u.refrigerant === "R454B" && Math.abs(u.coolingBtu - o.coolingBtu) / o.coolingBtu < 0.1)).toBe(true);
  });
});

describe("P-Series", () => {
  const sys = "P" as const;
  it("passes PUZ-AK36NL with a 36k PLA", () => {
    expect(codes(design(sys, odu("PUZ-AK36NL"), [place(idu("PLA-AE36NL", sys), { heightFt: 0 })], { totalPipeFt: 60 }))).toEqual([]);
  });
  it("rejects P-Series twinning like DSB (no US distribution pipe)", () => {
    expect(codes(design(sys, odu("PUZ-A36NKA7"), [place(idu("PLA-A18EA7", sys)), place(idu("PLA-A18EA7", sys))]))).toContain("1017");
  });
  it("accepts the PAA-A18 special pair on a 24k P unit", () => {
    // compat_p_series lists PUZ-AH24NL <-> PAA-(A|B)A(18|24)NL; the 18k coil is exempt from the 10% / exact-size rules.
    const c = codes(design(sys, odu("PUZ-AH24NL"), [place(idu("PAA-AA18NL", sys))]));
    expect(c).not.toContain("1044");
    expect(c).not.toContain("1045");
  });
});

describe("MXZ port-type", () => {
  const sys = "MXZ" as const;
  it("accepts a combination from the table and substitutes rated capacities", () => {
    const d = design(sys, odu("MXZ-5C42NA4-U1"), [place(idu("MSZ-FS09NA-U1", sys)), place(idu("MSZ-FS12NA-U1", sys)), place(idu("MSZ-GS15NA-U1", sys))]);
    expect(codes(d)).toEqual([]);
  });
  it("rejects a combination missing from the table / over capacity", () => {
    const big = idu("MSZ-FS18NA-U1", sys);
    const d = design(sys, odu("MXZ-5C42NA4-U1"), [1, 2, 3, 4, 5].map(() => place(big)));
    const c = codes(d);
    expect(c).toContain("1016");
  });
  it("rejects more indoor units than ports", () => {
    expect(codes(design(sys, odu("MXZ-3D24NL"), [1, 2, 3, 4].map(() => place(idu("MSZ-FX09NL", sys)))))).toContain("1017");
  });
  it("adds a 3/8 to 1/2 gas adapter when an 18k unit lands on a 3/8 port", () => {
    const ev = evaluate(design(sys, odu("MXZ-2C20NA4-U1"), [place(idu("MSZ-FS06NA-U1", sys)), place(idu("MSZ-FS18NA-U1", sys))]));
    expect(ev.bom.find((l) => l.model === "MAC-A454JP-E")?.qty).toBe(1);
  });
  it("puts the 1/2 gas unit on port A of a 3-port C so no adapter is needed", () => {
    const ev = evaluate(design(sys, odu("MXZ-3C24NA4-U1"), [place(idu("MSZ-FS09NA-U1", sys)), place(idu("MSZ-FS18NA-U1", sys))]));
    expect(ev.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(ev.bom.some((l) => l.description.startsWith("Port adapter"))).toBe(false);
  });
});

describe("Smart Multi (residential mode)", () => {
  const sys = "MXZSM" as const;
  it("lays out branch boxes and checks connection factor", () => {
    const units = ["MSZ-FX09NL", "MSZ-FX09NL", "MSZ-FX12NL", "MSZ-FX12NL"].map((m) => place(idu(m, "MXZ")));
    const ev = evaluate(design(sys, odu("MXZ-SM48NL"), units, { mainLineFt: 40 }));
    expect(ev.layout?.boxes.length).toBe(1);
    expect(ev.layout?.boxes[0].ports).toBe(5);
    expect(ev.bom.some((l) => l.category === "Branch box")).toBe(true);
  });
  it("uses two boxes and a joint for 6+ units", () => {
    const units = Array.from({ length: 6 }, () => place(idu("MSZ-FX09NL", "MXZ")));
    const ev = evaluate(design(sys, odu("MXZ-SM48NL"), units));
    expect(ev.layout?.boxes.length).toBe(2);
    expect(ev.bom.some((l) => l.model.startsWith("MSDD-50"))).toBe(true);
  });
  it("never puts a unit on a capped port", () => {
    const units = Array.from({ length: 3 }, () => place(idu("MSZ-FX09NL", "MXZ")));
    const ev = evaluate(design(sys, odu("MXZ-SM48NL"), units, { boxPorts: [5], cappedPorts: { "0": ["A", "C"] } }));
    const ports = units.map((u) => ev.assignments?.[u.key]?.port).sort();
    expect(ports).toEqual(["B", "D", "E"]);
  });
  it("counts capped ports against the box", () => {
    const units = Array.from({ length: 3 }, () => place(idu("MSZ-FX09NL", "MXZ")));
    expect(codes(design(sys, odu("MXZ-SM48NL"), units, { boxPorts: [3], cappedPorts: { "0": ["C"] } }))).toContain("BOX_PORTS");
  });
  it("shows branch boxes before any indoor units are placed", () => {
    expect(evaluate(design("MXZSM", odu("MXZ-SM48NL"), [])).layout?.boxes.map((b) => b.ports)).toEqual([3]);
    expect(evaluate(design("MXZSM", odu("MXZ-SM48NL"), [], { boxPorts: [5, 3] })).layout?.boxes.map((b) => b.ports)).toEqual([5, 3]);
  });
});

describe("controls", () => {
  it("offers wired controllers with the interface they need", () => {
    const d = design("MandS", odu("SUZ-AA24NL"), [place(idu("SVZ-AP24NL", "MandS"))]);
    const ev = evaluate(d);
    const opts = Object.values(ev.controllers)[0];
    expect(opts.length).toBeGreaterThan(0);
  });
  it("puts the chosen controller and its interface on the BOM", () => {
    const sys = "MandS" as const;
    const base = design(sys, odu("SUZ-AA24NL"), [place(idu("MSZ-FX12NL", sys))]);
    const opts = Object.values(evaluate(base).controllers)[0];
    const withIf = opts.find((o) => o.requires.length && o.kind === "controller");
    if (!withIf) return;
    base.idus[0].controller = withIf.model;
    const ev = evaluate(base);
    expect(ev.bom.some((l) => l.model === withIf.model)).toBe(true);
    for (const r of withIf.requires) expect(ev.bom.some((l) => l.model === r)).toBe(true);
  });
});

describe("palette", () => {
  it("has outdoor units for every system type and hides Smart Multi City-Multi rows", () => {
    const p = buildPalette();
    for (const s of ["MandS", "P", "MXZ", "MXZSM"]) expect(p.odus.some((o) => o.system === s && !o.legacy)).toBe(true);
    const sm = p.odus.filter((o) => o.system === "MXZSM").map((o) => o.model);
    expect(new Set(sm).size).toBe(sm.length);
  });
  it("every current single-zone ODU offers at least one indoor unit", () => {
    const missing = outdoorUnits
      .filter((o) => (o.system === "MandS" || o.system === "P") && o.status === "current")
      .filter((o) => evaluate(design(o.system, o.id, [])).compatibleIduIds.length === 0)
      .map((o) => o.model);
    // m-and-p-series.md §2.1b: SUZ-KA09NA2.MX has no default IDU and no current partner, in DSB too.
    expect(missing).toEqual(["SUZ-KA09NA2.MX"]);
  });
});

describe("specs, settings and takeoff", () => {
  it("reports the rated pair's efficiency and the ODU electrical", () => {
    const ev = evaluate(design("MandS", odu("SUZ-AA24NL"), [place(idu("SVZ-AP24NL", "MandS"))]));
    expect(ev.specs?.efficiency?.seer2).toBe("19.5");
    expect(ev.specs?.odu.mca).toBeTruthy();
  });
  it("uses the second MCA value when branch boxes are powered separately", () => {
    const units = ["MSZ-FX09NL", "MSZ-FX12NL"].map((m) => place(idu(m, "MXZ")));
    expect(evaluate(design("MXZSM", odu("MXZ-SM48NL"), units)).specs?.odu.mca).toBe("42");
    expect(evaluate(design("MXZSM", odu("MXZ-SM48NL"), units, { boxesPoweredByOdu: false })).specs?.odu.mca).toBe("36");
  });
  it("swaps in Trane part numbers when the brand is set", () => {
    const d = design("MandS", odu("MUZ-WR18NA-U1"), [], { settings: { brand: "TRME", connectionRatio: 130 } });
    const line = evaluate(d).bom.find((l) => l.category === "Outdoor unit")!;
    expect(line.model).toBe("NTXSEL18A112AA");
    expect(line.baseModel).toBe("MUZ-WR18NA-U1");
  });
  it("enforces 100% connection when the project is set to it", () => {
    const units = ["MSZ-FS09NA-U1", "MSZ-FS12NA-U1", "MSZ-GS15NA-U1", "MSZ-FS18NA-U1"].map((m) => place(idu(m, "MXZ")));
    const at = (r: 100 | 130) => codes(design("MXZ", odu("MXZ-5C42NA4-U1"), units, { settings: { brand: "ME", connectionRatio: r } }));
    expect(at(100)).toContain("1016");
    expect(at(130)).not.toContain("1016");
  });
  it("adds a line set in feet at the outdoor unit's sizes", () => {
    const ev = evaluate(design("MandS", odu("SUZ-AA24NL"), [place(idu("SVZ-AP24NL", "MandS"))], { totalPipeFt: 35 }));
    const ls = ev.bom.find((l) => l.category === "Line set")!;
    expect(ls.qty).toBe(35);
    expect(ls.unit).toBe("ft");
  });
});

describe("piping detail", () => {
  it("counts bends as equivalent length on port-type lines", () => {
    const u = idu("MSZ-FS09NA-U1", "MXZ");
    const d = (bends: number) => design("MXZ", odu("MXZ-3C24NA4-U1"), [place(u, { pipeLengthFt: 80, bends }), place(u, { pipeLengthFt: 20 })]);
    expect(codes(d(0))).not.toContain("1024");
    expect(codes(d(3))).toContain("1024");
  });
  it("respects a chosen port and adds the adapter it needs", () => {
    const d = design("MXZ", odu("MXZ-3C24NA4-U1"), [place(idu("MSZ-FS09NA-U1", "MXZ")), place(idu("MSZ-FS18NA-U1", "MXZ"), { port: "B" })]);
    const ev = evaluate(d);
    expect(ev.assignments?.[d.idus[1].key]?.port).toBe("B");
    // Port B is 3/8" gas; the 18k unit's 1/2" gas line needs a 3/8 -> 1/2 adapter.
    expect(ev.bom.some((l) => l.model === "MAC-A454JP-E")).toBe(true);
  });
  it("builds the boxes the user asked for", () => {
    const units = Array.from({ length: 4 }, () => place(idu("MSZ-FX09NL", "MXZ")));
    const ev = evaluate(design("MXZSM", odu("MXZ-SM48NL"), units, { boxPorts: [3, 3] }));
    expect(ev.layout?.boxes.map((b) => b.ports)).toEqual([3, 3]);
    expect(ev.bom.some((l) => l.model.startsWith("MSDD-50"))).toBe(true);
  });
  it("computes Smart Multi charge and flags a room too small for it", () => {
    const units = ["MSZ-FX09NL", "MSZ-FX12NL"].map((m) => place(idu(m, "MXZ"), { pipeLengthFt: 25 }));
    const ev = evaluate(design("MXZSM", odu("MXZ-SM48NL"), units, { mainLineFt: 40 }));
    expect(ev.charge?.totalKg).toBeGreaterThan(1);
    units[0].floorAreaSqFt = 30; // ~2.8 m2: allowance ~1 kg, below the system charge
    expect(codes(design("MXZSM", odu("MXZ-SM48NL"), units, { mainLineFt: 40 }))).toContain("1257");
  });
});

describe("controls: twins, M-NET, central", () => {
  it("adds the P-Series M-NET converter and the MXZ M-NET adapter", () => {
    const p = evaluate(design("P", odu("PUZ-AK36NL"), [place(idu("PLA-AE36NL", "P"))], { mnet: true }));
    expect(p.bom.some((l) => /^PAC-SJ9[56]MA-E$/.test(l.model))).toBe(true);
    const m = evaluate(design("MXZ", odu("MXZ-3C24NA4-U1"), [place(idu("MSZ-FS09NA-U1", "MXZ")), place(idu("MSZ-FS12NA-U1", "MXZ"))], { mnet: true }));
    expect(m.bom.some((l) => l.model === "PAC-IF01MNT-E")).toBe(true);
  });
  it("puts a central controller on the BOM and offers current ones", () => {
    const ev = evaluate(design("MandS", odu("SUZ-AA24NL"), [place(idu("SVZ-AP24NL", "MandS"))], { centralController: "AE-C400A" }));
    expect(ev.bom.some((l) => l.model === "AE-C400A")).toBe(true);
    expect(ev.centralControllers?.some((c) => c.model === "AE-C400A")).toBe(true);
  });
});

describe("R454B (A2L)", () => {
  it("wall unit: room area from charge / 0.27 and the 5.9 ft mounting height", () => {
    const d = (area: number, h: number) =>
      design("MandS", odu("MUZ-GX09NL"), [place(idu("MSZ-GX09NL", "MandS"), { floorAreaSqFt: area, installHeightFt: h })], { totalPipeFt: 50 });
    const ev = evaluate(d(120, 7));
    expect(ev.a2l?.chargeKg).toBeCloseTo(1.06, 2);
    expect(Object.values(ev.a2l!.units)[0].minAreaSqFt).toBe(42.2); // 1.06 / 0.27 = 3.926 m2 = 42.26 sq ft, truncated to 1 dp
    expect(codes(d(120, 7))).not.toContain("1258");
    expect(codes(d(40, 7))).toContain("1258");
    expect(codes(d(120, 5))).toContain("1259");
  });
  it("ducted unit: grille heights", () => {
    const d = design("MandS", odu("SUZ-AA18NL"), [place(idu("PEAD-AA18NL", "MandS"), { floorAreaSqFt: 300, installHeightFt: 8.5, supplyGrilleFt: 8, returnGrilleFt: 1 })], { totalPipeFt: 40 });
    const c = codes(d);
    expect(c).toContain("1261");
    expect(c).not.toContain("1260");
  });
  it("coil unit: case C in a small closet fails the installed-room minimum", () => {
    const d = (h: number) =>
      design("MandS", odu("SUZ-AA24NL"), [place(idu("SVZ-AP24NL", "MandS"), { floorAreaSqFt: 1200, installHeightFt: h, installedRoomSqFt: 48 })], { totalPipeFt: 50 });
    const ev = evaluate(d(1));
    const u = Object.values(ev.a2l!.units)[0];
    expect(u.case).toBe("C");
    expect(u.minInstalledRoomSqFt).toBeCloseTo(197.5, 0);
    expect(codes(d(1))).toContain("1263");
    expect(codes(d(8))).toContain("1263"); // case A needs ~54.6 sq ft; 48 still fails
  });
  it("Smart Multi: 9 m2 floor per room", () => {
    const units = ["MSZ-FX09NL", "MSZ-FX12NL"].map((m) => place(idu(m, "MXZ"), { pipeLengthFt: 25, installHeightFt: 7, floorAreaSqFt: 90 }));
    expect(codes(design("MXZSM", odu("MXZ-SM48NL"), units, { mainLineFt: 50 }))).toContain("1258");
  });
});

describe("corrected capacity (capacity-derates.md §6 worked examples)", () => {
  const at5F = { coolOutdoorDbF: 95, heatOutdoorWbF: 4, coolIndoorWbF: 67, heatIndoorDbF: 70, altitudeFt: 0 };
  const settings = { brand: "ME" as const, connectionRatio: 130 as const, conditions: at5F };
  const near = (actual: number | undefined, expected: number) => expect(Math.abs((actual ?? 0) - expected) / expected).toBeLessThan(0.005);

  it("6.1 M & S: MUZ-GX12NL + MSZ-GX12NL, 50 ft", () => {
    const cap = evaluate(design("MandS", odu("MUZ-GX12NL"), [place(idu("MSZ-GX12NL", "MandS"))], { totalPipeFt: 50, settings })).capacity!;
    near(cap.cooling?.systemBtu, 12211);
    near(cap.heating?.systemBtu, 8617);
  });
  it("6.2 P: PUZ-AK36NL + PLA-A36EA8, 50 ft", () => {
    const o = outdoorUnits.find((u) => u.model === "PUZ-AK36NL")!;
    const i = indoorUnits.find((u) => u.model === "PLA-A36EA8" && u.systems.includes("P"));
    if (!i) return; // the worked example uses an R410A coil on an R454B ODU; skip if not in our data
    const cap = evaluate(design("P", o.id, [place(i.id)], { totalPipeFt: 50, settings })).capacity!;
    near(cap.cooling?.systemBtu, 34546);
    near(cap.heating?.systemBtu, 21003);
  });
  it("6.3 MXZ port-type: MXZ-3C24NA4-U1 with 6 + 9 + 12", () => {
    const units = [
      place(idu("MSZ-FS06NA-U1", "MXZ"), { pipeLengthFt: 25 }),
      place(idu("MSZ-FS09NA-U1", "MXZ"), { pipeLengthFt: 30 }),
      place(idu("MSZ-FS12NA-U1", "MXZ"), { pipeLengthFt: 40 }),
    ];
    const cap = evaluate(design("MXZ", odu("MXZ-3C24NA4-U1"), units, { settings })).capacity!;
    near(cap.cooling?.systemBtu, 23936);
    near(cap.heating?.systemBtu, 10708);
  });
  it("6.4 Smart Multi: MXZ-SM48NL with GX18 + 3 x GX12, 100 ft farthest", () => {
    const units = [
      place(idu("MSZ-GX18NL", "MXZ"), { pipeLengthFt: 60 }),
      ...[1, 2, 3].map(() => place(idu("MSZ-GX12NL", "MXZ"), { pipeLengthFt: 40 })),
    ];
    const cap = evaluate(design("MXZSM", odu("MXZ-SM48NL"), units, { mainLineFt: 40, settings })).capacity!;
    expect(cap.style).toBe("new");
    near(cap.cooling?.systemBtu, 46084);
    near(cap.heating?.systemBtu, 33142);
  });
});

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { indoorUnits } from "./catalog";
import { isCompatible } from "./engine";
import { findIndoorUnit, findOutdoorUnit } from "./lookup";
import { createMcpServer } from "./mcp";

async function mcp() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { type: string; text: string }[])[0].text;

describe("model-number lookup", () => {
  const sm48 = findOutdoorUnit("MXZ-SM48NL")!;

  it("resolves a repeated indoor model to the record that connects to the outdoor unit", () => {
    // SVZ-AP30NL / SVZ-AP24NL exist as single-zone records (1753, 1751) and MXZ records (1752, 1750).
    expect(indoorUnits.filter((u) => u.model === "SVZ-AP30NL").length).toBeGreaterThan(1);
    expect(findIndoorUnit("SVZ-AP30NL", { odu: sm48 })?.id).toBe(1752);
    expect(findIndoorUnit("svz-ap24nl ", { odu: sm48 })?.id).toBe(1750);
    expect(findIndoorUnit("SVZ-AP24NL", { system: "MandS" })?.systems).toContain("MandS");
  });

  it("keeps ids exact", () => {
    expect(findIndoorUnit(1751, { odu: sm48 })?.id).toBe(1751);
  });

  it("agrees with list_indoor_units for every repeated model", () => {
    for (const odu of [sm48, findOutdoorUnit("MXZ-3D24NL")!, findOutdoorUnit("SUZ-AA24NL")!]) {
      const repeated = new Set(indoorUnits.filter((u, _i, all) => all.filter((v) => v.model === u.model).length > 1).map((u) => u.model));
      for (const model of repeated) {
        const listed = indoorUnits.some((u) => u.model === model && u.status === "current" && isCompatible(odu, u));
        const found = findIndoorUnit(model, { odu })!;
        if (listed) expect(isCompatible(odu, found), `${model} on ${odu.model}`).toBe(true);
      }
    }
  });

  it("evaluate_design accepts the units by model number, same as by id (regression: error 1143)", async () => {
    const client = await mcp();
    const byModel = await client.callTool({
      name: "evaluate_design",
      arguments: { outdoorUnit: "MXZ-SM48NL", indoorUnits: [{ indoorUnit: "SVZ-AP30NL" }, { indoorUnit: "SVZ-AP24NL" }] },
    });
    const byId = await client.callTool({ name: "evaluate_design", arguments: { outdoorUnit: "MXZ-SM48NL", indoorUnits: [{ indoorUnit: 1752 }, { indoorUnit: 1750 }] } });
    expect(byModel.isError).toBeFalsy();
    const a = JSON.parse(text(byModel));
    const b = JSON.parse(text(byId));
    expect(a.issues.map((i: { code: string }) => i.code)).not.toContain("1143");
    expect(a.issues.some((i: { message: string }) => /not an MXZ-compatible/i.test(i.message))).toBe(false);
    expect(a.status).toBe(b.status);
    expect(a.bom).toEqual(b.bom);
  });
});

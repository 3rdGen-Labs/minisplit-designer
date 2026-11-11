import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { decodePDFRawStream, PDFDocument, PDFRawStream } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GET, POST } from "@/app/api/pdf/route";
import { createMcpServer } from "../mcp";
import { findIndoorUnit, findOutdoorUnit } from "../lookup";
import type { SystemDesign } from "../design";
import { renderDesignPdf } from "./render";
import { decodePdfRequest, encodePdfRequest, MAX_LINK_PAYLOAD, parsePdfRequest, type PdfRequest } from "./request";

// Synthetic job: invented names and address.

/** All text drawn in the PDF (Helvetica text is written as hex strings in the content streams). */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let out = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const content = Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1");
    for (const m of content.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) out += Buffer.from(m[1], "hex").toString("latin1") + "\n";
  }
  return out;
}

function system(name: string, odu: string, idus: [string, string, number?][], extra: Partial<SystemDesign> = {}): SystemDesign {
  const o = findOutdoorUnit(odu)!;
  return {
    id: name,
    name,
    system: o.system,
    oduId: o.id,
    idus: idus.map(([model, room, pipe], i) => ({ key: `k${i}`, iduId: findIndoorUnit(model, { odu: o })!.id, room, pipeLengthFt: pipe, heightFt: 8 })),
    branchBoxes: [],
    settings: { brand: "ME", connectionRatio: 130, conditions: { coolOutdoorDbF: 95, heatOutdoorWbF: 33, coolIndoorWbF: 67, heatIndoorDbF: 70, altitudeFt: 0, heatOutdoorDbF: 35, location: "KSFO" } },
    ...extra,
  };
}

const job: PdfRequest = {
  job: "Example Residence (1105)",
  address: "123 Example Street, Sample City, CA",
  preparedBy: "Estimator",
  date: "2026-11-10",
  systems: [
    system("Main floor", "MXZ-SM48NL", [["SVZ-AP30NL", "Great room", 40], ["SVZ-AP24NL", "Kitchen", 35]], { mainLineFt: 30 }),
    system("Bedrooms", "MXZ-3D24NL", [["MSZ-EX09NLW", "Bedroom 1", 30], ["MSZ-EX09NLW", "Bedroom 2", 45]]),
    system("Garage → gym ✓", "SUZ-AA24NL", [["SVZ-AP24NL", "Gym"]], { totalPipeFt: 25 }),
    system("Office", "MXZ-3D24NL", [["MSZ-EX09NLW", "Office"]]),
  ],
};

describe("PDF request links", () => {
  it("round-trips a job through the link payload", () => {
    const d = encodePdfRequest(job);
    expect(d).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(d.length).toBeLessThan(MAX_LINK_PAYLOAD);
    const back = decodePdfRequest(d);
    expect(back.ok && back.request).toEqual(job);
  });

  it("rejects damaged, oversized and malformed payloads", () => {
    const d = encodePdfRequest(job);
    expect(decodePdfRequest(d.slice(0, 40)).ok).toBe(false);
    expect(decodePdfRequest("a".repeat(MAX_LINK_PAYLOAD + 1)).ok).toBe(false);
    expect(decodePdfRequest("not/base64url!").ok).toBe(false);
    const wrongShape = deflateRawSync(Buffer.from(JSON.stringify({ systems: [{ system: "VRF" }] }))).toString("base64url");
    expect(decodePdfRequest(wrongShape)).toMatchObject({ ok: false });
    // A small payload that inflates past the limit is refused, not expanded.
    const bomb = deflateRawSync(Buffer.alloc(2 * 1024 * 1024, 32)).toString("base64url");
    expect(bomb.length).toBeLessThan(MAX_LINK_PAYLOAD);
    expect(decodePdfRequest(bomb).ok).toBe(false);
  });

  it("accepts the web app's shape: nulls and extra fields are dropped", () => {
    const sys = { ...job.systems[1], showLegacy: true, refrigerantFilter: null, totalPipeFt: null };
    const r = parsePdfRequest({ job: "  ", systems: [sys] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.job).toBeUndefined();
      expect(r.request.systems[0]).not.toHaveProperty("showLegacy");
      expect(r.request.systems[0].totalPipeFt).toBeUndefined();
    }
  });
});

describe("PDF rendering", () => {
  it("renders a cover page and a section per system with real text", async () => {
    const bytes = await renderDesignPdf(job);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(5);
    expect(doc.getTitle()).toContain("Example Residence (1105)");
    const text = await pdfText(bytes);
    for (const s of [
      "System summary",
      "123 Example Street, Sample City, CA",
      "MXZ-SM48NL",
      "SVZ-AP30NL",
      "Design conditions",
      "Piping",
      "Line-set takeoff",
      "Additional refrigerant charge",
      "Corrected capacity at design conditions",
      "Electrical",
      "Not checked by this tool",
      "Independent planning tool",
      "Garage -> gym ok",
    ])
      expect(text, s).toContain(s);
    expect(text).toMatch(/Page 1 of \d+/);
  });

  it("leaves out the cover page for one system", async () => {
    const one = await renderDesignPdf({ systems: [job.systems[0]] });
    const text = await pdfText(one);
    expect(text).not.toContain("System summary");
    expect(text).toContain("Branch boxes and ports");
  });

  it("does not throw on text Helvetica can't encode", async () => {
    const odd = { systems: [{ ...job.systems[3], name: "日本語 room ≥ 2 — ok", idus: job.systems[3].idus.map((p) => ({ ...p, room: "Sala 🌡 ñ" })) }] };
    const text = await pdfText(await renderDesignPdf(odd));
    expect(text).toContain("room >= 2");
    expect(text).toContain("Sala ? ñ");
  });

  it("still renders a system the engine can't place", async () => {
    const bytes = await renderDesignPdf({ systems: [{ id: "x", name: "Unknown unit", system: "MXZ", oduId: -5, idus: [], branchBoxes: [] }] });
    expect(await pdfText(bytes)).toContain("FAIL");
  });
});

describe("/api/pdf", () => {
  it("POST returns a PDF download", async () => {
    const res = await POST(new Request("http://x/api/pdf", { method: "POST", body: JSON.stringify(job) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain('attachment; filename="Example_Residence_1105-submittal.pdf"');
  });

  it("rejects bad input with JSON errors", async () => {
    expect((await POST(new Request("http://x/api/pdf", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await POST(new Request("http://x/api/pdf", { method: "POST", body: JSON.stringify({ systems: [] }) }))).status).toBe(400);
    expect((await GET(new Request("http://x/api/pdf?d=garbage"))).status).toBe(400);
  });
});

describe("export_design_pdf (MCP)", () => {
  async function client() {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test", version: "1" });
    await Promise.all([createMcpServer({ origin: "https://designer.example" }).connect(a), c.connect(b)]);
    return c;
  }
  const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[])[0].text;

  it("returns a link that opens as the PDF", async () => {
    const c = await client();
    const r = await c.callTool({
      name: "export_design_pdf",
      arguments: {
        job: "Example Residence (1105)",
        address: "123 Example Street",
        systems: [
          { name: "Main floor", outdoorUnit: "MXZ-SM48NL", indoorUnits: [{ indoorUnit: "SVZ-AP30NL", room: "Great room", pipeLengthFt: 40 }, { indoorUnit: "SVZ-AP24NL" }], mainLineFt: 30, location: "San Francisco, CA" },
          { name: "Bedrooms", outdoorUnit: "MXZ-3D24NL", indoorUnits: [{ indoorUnit: "MSZ-EX09NLW" }, { indoorUnit: "MSZ-EX09NLW" }] },
        ],
      },
    });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(text(r));
    expect(out.url).toMatch(/^https:\/\/designer\.example\/api\/pdf\?d=[A-Za-z0-9_-]+$/);
    expect(out.systems.map((s: { name: string }) => s.name)).toEqual(["Main floor", "Bedrooms"]);
    const res = await GET(new Request(out.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("inline");
    const pdf = await pdfText(new Uint8Array(await res.arrayBuffer()));
    expect(pdf).toContain("Great room (SVZ-AP30NL)");
    expect(pdf).toContain("System 2: Bedrooms");
  });

  it("names the system with a bad input", async () => {
    const c = await client();
    const r = await c.callTool({ name: "export_design_pdf", arguments: { systems: [{ name: "Attic", outdoorUnit: "NOPE-1", indoorUnits: [{ indoorUnit: "MSZ-EX09NLW" }] }] } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("System 1 (Attic)");
  });
});

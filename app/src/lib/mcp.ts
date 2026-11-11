import "server-only";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { iduById, indoorUnits, outdoorUnits, type OutdoorUnit } from "./catalog";
import { findIndoorUnit, findOutdoorUnit } from "./lookup";
import { DEFAULT_CONDITIONS, type DesignConditions, type IduPlacement, type SystemDesign } from "./design";
import { evaluate, isCompatible } from "./engine";
import { appPath, site } from "./site";
import { encodePdfRequest, MAX_LINK_PAYLOAD, MAX_PDF_SYSTEMS } from "./pdf/request";
import { wetBulbFromRh } from "./psychro.mjs";
import designWeather from "@/data/design-locations.json";

interface DesignLocation { id: string; city: string; state: string; elevationFt: number; heatDbF: number; heatWbF?: number; coolDbF: number }
const LOCATIONS = designWeather.locations as DesignLocation[];

/** "KDEN", "Denver, CO", "Denver CO" or "Sacramento". Returns the match, or the candidates when a city name is ambiguous. */
function findLocation(q: string): { loc?: DesignLocation; candidates?: DesignLocation[] } {
  const raw = q.trim();
  const icao = LOCATIONS.find((l) => l.id.toLowerCase() === raw.toLowerCase());
  if (icao) return { loc: icao };
  const m = raw.match(/^(.*?)[,\s]+([A-Za-z]{2})$/);
  const state = m && LOCATIONS.some((l) => l.state === m[2].toUpperCase()) ? m[2].toUpperCase() : undefined;
  const city = (state ? m![1] : raw).trim().toLowerCase();
  const pool = LOCATIONS.filter((l) => !state || l.state === state);
  const exact = pool.filter((l) => l.city.toLowerCase() === city);
  const hits = exact.length ? exact : pool.filter((l) => l.city.toLowerCase().startsWith(city));
  const loose = hits.length ? hits : pool.filter((l) => l.city.toLowerCase().includes(city));
  if (loose.length === 1 || (loose.length > 1 && new Set(loose.map((l) => l.state)).size === 1)) return { loc: loose[0] };
  return { candidates: loose.slice(0, 8) };
}

// Tools exposed at /api/mcp. Same catalog and engine as the designer UI, so answers match what the app shows.

const SYSTEM = z.enum(["MandS", "P", "MXZ", "MXZSM"]).describe("MandS = M & S-Series single zone, P = P-Series, MXZ = MXZ multi-zone, MXZSM = Smart Multi (single-phase)");
const ft = (what: string) => z.number().min(-1000).max(1000).optional().describe(what);
const sqft = (what: string) => z.number().positive().max(100000).optional().describe(what);
const ref = z.union([z.number().int(), z.string().max(40)]);
const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

const offered = (status: string, legacy?: boolean) => status === "current" || (legacy && status === "legacy");

const NOTE = ["Independent tool, not affiliated with Mitsubishi Electric. Verify against current manufacturer documentation before quoting, ordering or installing.", site.mcp.note].filter(Boolean).join(" ");

const INSTRUCTIONS = `${site.name}: residential Mitsubishi Electric ductless (air-to-air) system builder. Covers M & S-Series single zone, P-Series, MXZ multi-zone and single-phase Smart Multi; no VRF/City Multi, no hydronic.
Workflow: find an outdoor unit with list_outdoor_units, find compatible indoor units with list_indoor_units (pass the outdoor unit), then call evaluate_design.
For capacity in the customer's climate pass location ("City, ST" or airport code) or the design temperatures.
For a client package or submittal, call export_design_pdf with the same inputs (one entry per system, plus the job name and address if the user gives them) and give the user the link. Anyone with the link can open it.
Line lengths drive the line-set takeoff and the additional refrigerant charge; floor areas and mounting heights drive the R454B checks. Never invent these: ask the user, or leave them out and report what the result lists as unchecked.
Results are planning estimates, not manufacturer approval.`;

const placement = z.object({
  indoorUnit: ref.describe("Indoor unit id or exact model number"),
  room: z.string().max(60).optional(),
  pipeLengthFt: ft("Multi-zone: actual line length from the outdoor unit (or branch box) to this unit"),
  bends: z.number().int().min(0).max(50).optional().describe("Field bends on this unit's line"),
  heightFt: ft("Height of this unit relative to the outdoor unit (negative = below)"),
  floorAreaSqFt: sqft("R454B: floor area this unit serves"),
  installHeightFt: ft("R454B: mounting height of the unit above the floor"),
  inConditionedSpace: z.boolean().optional().describe("R454B coil units (multi-position, cased coil): installed inside the conditioned space?"),
  installedRoomSqFt: sqft("R454B coil units: floor area of the room the unit sits in (closet, attic)"),
  controller: z.string().max(40).optional().describe("Controller model; leave out for the default"),
  wifiAdapter: z.string().max(40).optional(),
});

const designShape = {
    outdoorUnit: ref.describe("Outdoor unit id or exact model number"),
    indoorUnits: z.array(placement).min(1).max(16),
    totalPipeFt: ft("Single zone / P-Series: line-set length"),
    mainLineFt: ft("Branch-box systems: outdoor unit to first branch box"),
    brand: z.enum(["ME", "TRME", "ASME"]).optional().describe("Part numbers: Mitsubishi (default), Trane or American Standard"),
    connectionRatio: z.union([z.literal(100), z.literal(130)]).optional().describe("R410A multi-zone max connection ratio, percent (default 130)"),
    location: z.string().max(60).optional().describe("US design location: \"City, ST\" (e.g. \"Denver, CO\", \"Sacramento, CA\") or airport code (KDEN). Fills design temperatures and altitude from NOAA airport records; explicit temperatures below override it"),
    coolOutdoorDbF: z.number().min(-40).max(130).optional().describe(`Outdoor cooling design dry bulb, °F (default ${DEFAULT_CONDITIONS.coolOutdoorDbF})`),
    heatOutdoorDbF: z.number().min(-40).max(80).optional().describe("Outdoor heating design dry bulb, °F (the normal winter design temperature); wet bulb is derived with heatRhPct"),
    heatRhPct: z.number().min(1).max(100).optional().describe("Outdoor relative humidity at the heating design, % (default 72.8)"),
    heatOutdoorWbF: z.number().min(-40).max(80).optional().describe(`Outdoor heating design wet bulb, °F, if known directly (default ${DEFAULT_CONDITIONS.heatOutdoorWbF})`),
    altitudeFt: z.number().min(0).max(15000).optional(),
};
type DesignArgs = z.infer<z.ZodObject<typeof designShape>>;

interface BuiltDesign {
  design: SystemDesign;
  odu: OutdoorUnit;
  idus: IduPlacement[];
  conditions: DesignConditions;
  loc?: DesignLocation;
}

/** MCP arguments -> the SystemDesign the web app and engine use, or an error message for the AI. */
function buildDesign(a: DesignArgs, id = "mcp", name = "MCP design"): BuiltDesign | { error: string } {
  const failWith = (error: string) => ({ error });
  const odu = findOutdoorUnit(a.outdoorUnit);
  if (!odu) return failWith(`No outdoor unit matches ${a.outdoorUnit}. Use list_outdoor_units.`);
  const idus: IduPlacement[] = [];
  for (const [i, p] of a.indoorUnits.entries()) {
    const u = findIndoorUnit(p.indoorUnit, { odu });
    if (!u) return failWith(`No indoor unit matches ${p.indoorUnit}. Use list_indoor_units with this outdoor unit.`);
    const { indoorUnit: _ref, ...rest } = p;
    idus.push({ ...rest, key: `idu${i + 1}`, iduId: u.id, room: p.room ?? `Zone ${i + 1}` });
  }
  const found = a.location ? findLocation(a.location) : undefined;
  const loc = found?.loc;
  if (a.location && !loc)
    return failWith(
      found?.candidates?.length
        ? `"${a.location}" matches several locations: ${found.candidates.map((l) => `${l.city}, ${l.state} (${l.id})`).join("; ")}. Pass one of those or add the state.`
        : `No design location matches "${a.location}". Use "City, ST" or an airport code (e.g. KDEN), or pass the temperatures directly.`,
    );
  const altitudeFt = a.altitudeFt ?? loc?.elevationFt ?? DEFAULT_CONDITIONS.altitudeFt;
  const heatDb = a.heatOutdoorDbF ?? (a.heatOutdoorWbF == null ? loc?.heatDbF : undefined);
  const heatWb =
    a.heatOutdoorWbF ??
    (a.heatOutdoorDbF != null ? wetBulbFromRh(a.heatOutdoorDbF, a.heatRhPct ?? 72.8, altitudeFt) : loc ? (loc.heatWbF ?? wetBulbFromRh(loc.heatDbF, 72.8, altitudeFt)) : DEFAULT_CONDITIONS.heatOutdoorWbF);
  const conditions = {
    ...DEFAULT_CONDITIONS,
    coolOutdoorDbF: a.coolOutdoorDbF ?? loc?.coolDbF ?? DEFAULT_CONDITIONS.coolOutdoorDbF,
    heatOutdoorWbF: Math.round(heatWb * 10) / 10,
    altitudeFt,
    ...(heatDb != null && { heatOutdoorDbF: heatDb }),
    ...(loc && { location: loc.id }),
  };
  const design: SystemDesign = {
    id,
    name,
    system: odu.system,
    oduId: odu.id,
    idus,
    branchBoxes: [],
    totalPipeFt: a.totalPipeFt,
    mainLineFt: a.mainLineFt,
    settings: { brand: a.brand ?? "ME", connectionRatio: a.connectionRatio ?? 130, conditions },
  };
  return { design, odu, idus, conditions, loc };
}

export interface McpServerOptions {
  /** Origin the PDF links point at (the request's origin); defaults to site.url. */
  origin?: string;
}

export function createMcpServer(opts: McpServerOptions = {}): McpServer {
  const origin = (opts.origin ?? site.url).replace(/\/+$/, "");
  const server = new McpServer({ name: "minisplit-designer", title: site.name, version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "list_outdoor_units",
    {
      title: "List outdoor units",
      description: "Search residential Mitsubishi Electric ductless outdoor units. Returns id, model, capacity, refrigerant and indoor-unit limits.",
      inputSchema: {
        system: SYSTEM.optional(),
        refrigerant: z.enum(["R454B", "R410A"]).optional(),
        minCoolingBtu: z.number().optional(),
        maxCoolingBtu: z.number().optional(),
        query: z.string().max(60).optional().describe("Substring of the model number or name"),
        includeLegacy: z.boolean().optional().describe("Include discontinued models"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const q = a.query?.toLowerCase();
      const rows = outdoorUnits
        .filter((u) => offered(u.status, a.includeLegacy))
        .filter((u) => (!a.system || u.system === a.system) && (!a.refrigerant || u.refrigerant === a.refrigerant))
        .filter((u) => (a.minCoolingBtu == null || u.coolingBtu >= a.minCoolingBtu) && (a.maxCoolingBtu == null || u.coolingBtu <= a.maxCoolingBtu))
        .filter((u) => !q || u.model.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))
        .map((u) => ({ id: u.id, model: u.model, name: u.name, system: u.system, refrigerant: u.refrigerant, coolingBtu: u.coolingBtu, heatingBtu: u.heatingBtu, minIdus: u.minIdus, maxIdus: u.maxIdus, branchBox: u.branchBox, defaultIdu: u.defaultIdu, legacy: u.status === "legacy" }));
      return json({ count: rows.length, units: rows.slice(0, 100) });
    },
  );

  server.registerTool(
    "list_indoor_units",
    {
      title: "List indoor units",
      description: "Search indoor units. Pass an outdoor unit (id or model) to get only the ones that can connect to it.",
      inputSchema: {
        outdoorUnit: ref.optional().describe("Outdoor unit id or exact model number"),
        system: SYSTEM.optional(),
        type: z.string().max(40).optional().describe("Substring of the unit type, e.g. wall, ducted, cassette, floor, multi position"),
        size: z.number().optional().describe("Model size in kBtu, e.g. 9, 12, 18"),
        query: z.string().max(60).optional(),
        includeLegacy: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const odu = a.outdoorUnit == null ? undefined : findOutdoorUnit(a.outdoorUnit);
      if (a.outdoorUnit != null && !odu) return fail(`No outdoor unit matches ${a.outdoorUnit}. Use list_outdoor_units.`);
      const q = a.query?.toLowerCase();
      const t = a.type?.toLowerCase();
      const rows = indoorUnits
        .filter((u) => offered(u.status, a.includeLegacy))
        .filter((u) => (!odu || isCompatible(odu, u)) && (!a.system || u.systems.includes(a.system)))
        .filter((u) => (!t || u.typeName.toLowerCase().includes(t)) && (a.size == null || u.size === a.size))
        .filter((u) => !q || u.model.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))
        .map((u) => ({ id: u.id, model: u.model, name: u.name, type: u.typeName, size: u.size, refrigerant: u.refrigerant, coolingBtu: u.coolingBtu, heatingBtu: u.heatingBtu, systems: u.systems, legacy: u.status === "legacy" }));
      return json({ count: rows.length, units: rows.slice(0, 150) });
    },
  );

  server.registerTool(
    "evaluate_design",
    {
      title: "Check a system and build the BOM",
      description: "Check a ductless system: pass/fail with reasons, bill of materials (units, controllers, required accessories, line sets), pipe sizes, additional refrigerant charge, corrected capacity and R454B checks.",
      inputSchema: designShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const built = buildDesign(a);
      if ("error" in built) return fail(built.error);
      const { design, odu, idus, conditions, loc } = built;
      let evaluation;
      try {
        evaluation = evaluate(design);
      } catch {
        return fail("This design could not be evaluated. Check the inputs.");
      }
      const { compatibleIduIds: _ids, controllers, accessoryOptions, ...result } = evaluation;
      return json({
        outdoorUnit: odu.model,
        designConditions: { location: loc ? `${loc.city}, ${loc.state} (${loc.id})` : undefined, coolingOutdoorDbF: conditions.coolOutdoorDbF, heatingOutdoorDbF: conditions.heatOutdoorDbF, heatingOutdoorWbF: conditions.heatOutdoorWbF, altitudeFt: conditions.altitudeFt },
        units: Object.fromEntries(idus.map((p) => [p.key, { model: iduById.get(p.iduId)?.model, room: p.room }])),
        ...result,
        controllerOptions: Object.fromEntries(Object.entries(controllers).map(([k, v]) => [k, v.map((c) => c.model)])),
        optionalAccessories: Object.fromEntries(Object.entries(accessoryOptions).map(([k, v]) => [k, v.filter((o) => !o.required).map((o) => `${o.model}: ${o.description}`)])),
        note: NOTE,
      });
    },
  );

  server.registerTool(
    "export_design_pdf",
    {
      title: "Export systems as a PDF submittal",
      description:
        "Make a PDF for one or more systems: one submittal-style page per system (equipment, design conditions, pass/fail with issues, branch box and port assignments, piping, line-set takeoff, additional charge, corrected capacity, electrical, efficiency, BOM and items not checked), with a cover page and summary table when there is more than one. Each system takes the same inputs as evaluate_design. Returns a link that renders the PDF when opened. Nothing is stored; the inputs, job name and address travel inside the link, so anyone with it can read them.",
      inputSchema: {
        job: z.string().max(120).optional().describe("Job name or number for the header, e.g. \"Vu Residence (1105)\""),
        address: z.string().max(200).optional().describe("Site address for the header"),
        preparedBy: z.string().max(80).optional(),
        systems: z
          .array(z.object({ name: z.string().max(80).optional().describe("System name, e.g. \"Upstairs\""), ...designShape }))
          .min(1)
          .max(MAX_PDF_SYSTEMS),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const built: BuiltDesign[] = [];
      for (const [i, s] of a.systems.entries()) {
        const { name, ...args } = s;
        const b = buildDesign(args, `s${i + 1}`, name?.trim() || `System ${i + 1}`);
        if ("error" in b) return fail(`System ${i + 1}${name ? ` (${name})` : ""}: ${b.error}`);
        built.push(b);
      }
      const payload = encodePdfRequest({ job: a.job, address: a.address, preparedBy: a.preparedBy, date: new Date().toISOString().slice(0, 10), systems: built.map((b) => b.design) });
      if (payload.length > MAX_LINK_PAYLOAD) return fail("These systems are too large for one PDF link. Export them in two or more PDFs.");
      const summary = built.map((b) => {
        let status = "unknown";
        try {
          status = evaluate(b.design).status;
        } catch {}
        return { name: b.design.name, outdoorUnit: b.odu.model, indoorUnits: b.idus.length, status };
      });
      return json({
        url: `${origin}${appPath("/api/pdf")}?d=${payload}`,
        pages: built.length > 1 ? "cover page + one section per system" : "one section",
        systems: summary,
        privacy: "The job name, address and inputs are inside the link. Share it only with people who should see them.",
        note: NOTE,
      });
    },
  );

  return server;
}

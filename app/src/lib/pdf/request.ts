import "server-only";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import type { SystemDesign } from "../design";

// What a PDF export contains: the systems (the same SystemDesign the web app evaluates) and an optional
// job header. Nothing is stored; a share link carries the request itself, compressed into the URL, and the
// server re-runs the checks when the link is opened. Anyone with the link can read what's in it.

const n = (min = -100000, max = 100000) => z.number().finite().min(min).max(max).optional();
const text = (max: number) => z.string().max(max);
const qtyMap = z.record(text(40), z.number().int().min(0).max(99)).optional();

const conditions = z.object({
  coolOutdoorDbF: z.number().finite().min(-40).max(130),
  heatOutdoorWbF: z.number().finite().min(-40).max(80),
  coolIndoorWbF: z.number().finite().min(40).max(90),
  heatIndoorDbF: z.number().finite().min(40).max(90),
  altitudeFt: z.number().finite().min(0).max(15000),
  heatOutdoorDbF: n(-40, 80),
  heatRhPct: n(1, 100),
  location: text(8).optional(),
});

const settings = z.object({
  brand: z.enum(["ME", "TRME", "ASME"]),
  connectionRatio: z.union([z.literal(100), z.literal(130)]),
  conditions: conditions.optional(),
});

const placement = z.object({
  key: text(40),
  iduId: z.number().int(),
  room: text(80),
  pipeLengthFt: n(0, 1000),
  bends: z.number().int().min(0).max(50).optional(),
  heightFt: n(-1000, 1000),
  floorAreaSqFt: n(0, 100000),
  installHeightFt: n(0, 100),
  inConditionedSpace: z.boolean().optional(),
  installedRoomSqFt: n(0, 100000),
  supplyGrilleFt: n(0, 100),
  returnGrilleFt: n(0, 100),
  controller: text(40).optional(),
  wifiAdapter: text(40).optional(),
  accessories: qtyMap,
  box: z.number().int().min(0).max(15).optional(),
  port: text(4).optional(),
});

const system = z.object({
  id: text(60),
  name: text(80),
  system: z.enum(["MandS", "P", "MXZ", "MXZSM"]),
  oduId: z.number().int().optional(),
  idus: z.array(placement).max(16),
  branchBoxes: z.array(z.object({ key: text(40), model: text(40), pipeLengthFt: n(0, 1000) })).max(8).default([]),
  totalPipeFt: n(0, 1000),
  mainLineFt: n(0, 1000),
  jointToBoxFt: z.array(z.number().finite().min(0).max(1000)).max(8).optional(),
  boxCount: z.number().int().min(0).max(8).optional(),
  cappedPorts: z.record(text(2), z.array(text(2)).max(8)).optional(),
  boxPorts: z.array(z.union([z.literal(3), z.literal(5)])).max(8).optional(),
  boxesPoweredByOdu: z.boolean().optional(),
  boxRooms: z.array(z.object({ habitable: z.boolean().optional(), mountingHeightFt: n(0, 100), floorAreaSqFt: n(0, 100000) })).max(8).optional(),
  mnet: z.boolean().optional(),
  centralController: text(40).optional(),
  settings: settings.optional(),
  bends: z.number().int().min(0).max(50).optional(),
  oduAccessories: qtyMap,
});

export const MAX_PDF_SYSTEMS = 12;

export const pdfRequestSchema = z.object({
  job: text(120).optional(),
  address: text(200).optional(),
  preparedBy: text(80).optional(),
  /** YYYY-MM-DD printed on the pages. Links carry the date they were made so the PDF doesn't change day to day. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  systems: z.array(system).min(1).max(MAX_PDF_SYSTEMS),
});

export type PdfRequest = Omit<z.infer<typeof pdfRequestSchema>, "systems"> & { systems: SystemDesign[] };

/** JSON from the web app may carry nulls for cleared fields; the schema treats them as absent. */
function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
  return v;
}

export function parsePdfRequest(input: unknown): { ok: true; request: PdfRequest } | { ok: false; error: string } {
  const r = pdfRequestSchema.safeParse(dropNulls(input));
  if (!r.success) {
    const first = r.error.issues[0];
    return { ok: false, error: `Invalid PDF request${first ? ` at ${first.path.join(".") || "(root)"}: ${first.message}` : ""}.` };
  }
  const blank = (s?: string) => (s?.trim() ? s.trim() : undefined);
  return { ok: true, request: { ...r.data, job: blank(r.data.job), address: blank(r.data.address), preparedBy: blank(r.data.preparedBy) } };
}

/** Longest `d` parameter accepted (characters); keeps the whole link under common URL limits. */
export const MAX_LINK_PAYLOAD = 12000;
const MAX_INFLATED = 256 * 1024;

export function encodePdfRequest(request: PdfRequest): string {
  return deflateRawSync(Buffer.from(JSON.stringify(request)), { level: 9 }).toString("base64url");
}

export function decodePdfRequest(payload: string): ReturnType<typeof parsePdfRequest> {
  if (!payload || payload.length > MAX_LINK_PAYLOAD || !/^[A-Za-z0-9_-]+$/.test(payload)) return { ok: false, error: "This PDF link is incomplete or too long." };
  let json: unknown;
  try {
    json = JSON.parse(inflateRawSync(Buffer.from(payload, "base64url"), { maxOutputLength: MAX_INFLATED }).toString("utf8"));
  } catch {
    return { ok: false, error: "This PDF link is damaged. Export it again." };
  }
  return parsePdfRequest(json);
}

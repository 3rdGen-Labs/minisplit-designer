import { NextResponse } from "next/server";
import type { SystemDesign } from "@/lib/design";
import { evaluate } from "@/lib/engine";

const SYSTEMS = new Set(["MandS", "P", "MXZ", "MXZSM"]);
const MAX_BYTES = 256 * 1024;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: Request) {
  const text = await req.text();
  if (text.length > MAX_BYTES) return bad("Body is too large.", 413);
  let body: SystemDesign;
  try {
    body = JSON.parse(text) as SystemDesign;
  } catch {
    return bad("Body must be JSON.");
  }
  if (
    !isObject(body) ||
    !SYSTEMS.has(body.system) ||
    !Array.isArray(body.idus) || body.idus.length > 64 || !body.idus.every(isObject) ||
    (body.branchBoxes !== undefined && (!Array.isArray(body.branchBoxes) || body.branchBoxes.length > 16 || !body.branchBoxes.every(isObject))) ||
    (body.oduId !== undefined && body.oduId !== null && typeof body.oduId !== "number")
  ) {
    return bad("Expected a system design: { system, oduId?, idus: [...] }.");
  }
  body.branchBoxes ??= [];
  try {
    return NextResponse.json(evaluate(body));
  } catch {
    return bad("This design could not be evaluated. Check the field types and values.", 422);
  }
}

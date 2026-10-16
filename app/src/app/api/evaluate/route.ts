import { NextResponse } from "next/server";
import type { SystemDesign } from "@/lib/design";
import { evaluate } from "@/lib/engine";

const SYSTEMS = new Set(["MandS", "P", "MXZ", "MXZSM"]);

export async function POST(req: Request) {
  let body: SystemDesign;
  try {
    body = (await req.json()) as SystemDesign;
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (!body || !SYSTEMS.has(body.system) || !Array.isArray(body.idus) || body.idus.length > 64) {
    return NextResponse.json({ error: "Expected a system design: { system, oduId?, idus: [...] }." }, { status: 400 });
  }
  body.branchBoxes ??= [];
  return NextResponse.json(evaluate(body));
}

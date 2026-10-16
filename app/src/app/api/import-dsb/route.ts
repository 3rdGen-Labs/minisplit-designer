import { NextResponse } from "next/server";
import { DsbImportError, parseDsbProject, toDesigns } from "@/lib/dsb-import";

export const runtime = "nodejs";

const MAX_BYTES = 20 * 1024 * 1024;

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Upload the project as multipart/form-data with a `file` field." }, { status: 400 });
  }
  const file = form.get("file");
  if (!file || typeof file === "string") return NextResponse.json({ error: "No file uploaded (expected a `file` field)." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "The file is larger than 20 MB." }, { status: 413 });

  const buf = Buffer.from(await file.arrayBuffer());
  try {
    const project = parseDsbProject(buf);
    const { systems, warnings } = toDesigns(project);
    return NextResponse.json({ project: { name: project.name ?? null, customer: project.customer ?? null }, systems, warnings });
  } catch (e) {
    if (e instanceof DsbImportError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("import-dsb failed", e);
    return NextResponse.json({ error: "Could not read this file as a DSB project." }, { status: 400 });
  }
}

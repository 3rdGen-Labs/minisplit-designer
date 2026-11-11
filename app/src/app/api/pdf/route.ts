import { renderDesignPdf, pdfFilename } from "@/lib/pdf/render";
import { decodePdfRequest, parsePdfRequest, type PdfRequest } from "@/lib/pdf/request";

// Submittal PDF for one or more systems. Nothing is stored:
// GET  /api/pdf?d=<payload>  opens a link made by the MCP export_design_pdf tool (the payload is the request itself).
// POST /api/pdf              { job?, address?, preparedBy?, date?, systems: SystemDesign[] } from the web app.

export const runtime = "nodejs";

const MAX_BYTES = 256 * 1024;
const bad = (error: string, status = 400) => Response.json({ error }, { status });

async function pdf(request: PdfRequest, download: boolean): Promise<Response> {
  let bytes: Uint8Array;
  try {
    bytes = await renderDesignPdf(request);
  } catch {
    return bad("The PDF could not be generated. Check the systems' inputs.", 422);
  }
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${pdfFilename(request)}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = decodePdfRequest(url.searchParams.get("d") ?? "");
  if (!parsed.ok) return bad(parsed.error);
  return pdf(parsed.request, url.searchParams.get("download") === "1");
}

export async function POST(req: Request) {
  const text = await req.text();
  if (text.length > MAX_BYTES) return bad("Body is too large.", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad("Body must be JSON.");
  }
  const parsed = parsePdfRequest(body);
  if (!parsed.ok) return bad(parsed.error);
  return pdf(parsed.request, true);
}

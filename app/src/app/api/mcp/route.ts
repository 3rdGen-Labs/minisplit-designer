import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp";

// Public, stateless MCP endpoint (Streamable HTTP) for Claude, ChatGPT and other MCP clients.
// Read-only tools over the same catalog and engine as the web app; no key, like /api/evaluate.
// export_design_pdf returns a /api/pdf link that carries its inputs; nothing is stored.

const MAX_BYTES = 256 * 1024;

/** Public origin for links the tools return (PDF exports), honoring a reverse proxy's forwarded host. */
function publicOrigin(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim();
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  return host ? `${proto === "http" ? "http" : "https"}://${host}` : url.origin;
}

async function handle(req: Request): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) return Response.json({ error: "Body is too large." }, { status: 413 });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createMcpServer({ origin: publicOrigin(req) });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export { handle as GET, handle as POST, handle as DELETE };

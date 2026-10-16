import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp";

// Public, stateless MCP endpoint (Streamable HTTP) for Claude, ChatGPT and other MCP clients.
// Read-only tools over the same catalog and engine as the web app; no key, like /api/evaluate.

const MAX_BYTES = 256 * 1024;

async function handle(req: Request): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) return Response.json({ error: "Body is too large." }, { status: 413 });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createMcpServer();
  await server.connect(transport);
  return transport.handleRequest(req);
}

export { handle as GET, handle as POST, handle as DELETE };

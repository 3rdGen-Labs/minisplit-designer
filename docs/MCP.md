# MCP integration

MCP (Model Context Protocol) lets an AI client discover tools, send structured arguments, and read their results. Here, the useful tools search equipment and evaluate a proposed system using the same rules engine as the visual designer.

The branch and commit references below belong to the original private development repository; those refs are intentionally absent from this fresh repository. MCP integration is deferred in this V1 candidate.

## What exists and where

The current preparation checkout has the browser app and `POST /api/evaluate`; it does **not** have a running MCP endpoint. The MCP implementation exists in commit `53b2460` on the locally available remote-tracking branch `origin/mcp-and-branding`. This guide describes that snapshot, not an endpoint verified in production.

| Component on that branch | Responsibility |
| --- | --- |
| `app/src/app/api/mcp/route.ts` | `/api/mcp` HTTP route; checks access key; creates transport and server for each request |
| `app/src/lib/mcp.ts` | Registers three tools, validates arguments with Zod, resolves model numbers/IDs, calls catalog and engine |
| `@modelcontextprotocol/sdk` | MCP server and Web Standard Streamable HTTP transport |
| `zod` | Tool input schemas |
| `app/src/lib/catalog.ts` | Shared equipment catalog |
| `app/src/lib/engine/index.ts` | Shared compatibility and evaluation logic |
| `DESIGNER_MCP_KEY` | Server-only environment variable authorizing requests; never commit its value |

The branch pins SDK `1.31.0` and Zod `4.6.5`; verify package availability and security when integrating it. No separate database, model API subscription, or AI model runs inside this server. The user's MCP client supplies the AI.

Flow: AI client → authenticated `/api/mcp` → tool schema → catalog / rules engine → JSON encoded in MCP text content. The route is stateless, enables JSON responses, and exports GET, POST, and DELETE handlers. Runtime and SDK protocol requirements still apply to those methods.

## Tools in that snapshot

| Tool | Inputs | Result |
| --- | --- | --- |
| `list_outdoor_units` | Optional system, refrigerant, cooling range, model/name query, legacy toggle | Matching outdoor units, capacities, indoor-unit limits; at most 100 returned rows plus total count |
| `list_indoor_units` | Optional outdoor model/ID, system, unit type, nominal size, query, legacy toggle | Indoor units, filtered for the chosen outdoor unit; at most 150 rows plus total count |
| `evaluate_design` | Outdoor model/ID, 1–16 indoor placements; optional piping, room/A2L inputs, controls, brand, connection ratio | Pass/fail/incomplete, issues, BOM, piping/charge/capacity where available, controller/accessory options, and unchecked rules |

Example tool arguments (after discovering valid models in the server's catalog):

```json
{
  "outdoorUnit": "SUZ-AA24NL",
  "indoorUnits": [{ "indoorUnit": "SVZ-AP24NL", "room": "Living area" }],
  "totalPipeFt": 50,
  "brand": "ME"
}
```

Do not treat a tool result as equipment approval or omit unknown inputs by inventing values. `evaluate_design` exposes fewer settings than the full `SystemDesign` API and does not implement every advanced UI configuration.

## Integrating the branch

Review and port the MCP route, library, and required dependencies onto the current UI; do not blindly replace `Designer.tsx` with the branch's older file. Keep existing deployment changes and regenerate the lockfile using pnpm. Then:

1. Resolve the same data and engine provenance questions as the web release. A private key does not grant redistribution rights.
2. Set a fresh `DESIGNER_MCP_KEY` in the server environment and restart/redeploy. The branch rejects all requests when the key is absent. Generate your own secret; it is unrelated to the GitHub or manufacturer account.
3. Configure a client supporting Streamable HTTP to use `https://YOUR-HOST/api/mcp` and an `Authorization: Bearer YOUR-KEY` header. These are placeholders. With subpath hosting, use `/designer/api/mcp`.
4. Exercise MCP initialization, tool discovery, searches, a valid evaluation, invalid arguments, and unauthorized access against the actual deployment.

The snapshot also accepts `?key=...`. Avoid sharing credential-bearing URLs: URLs can appear in histories and infrastructure logs. Prefer clients supporting authorization headers. If a client requires OAuth, the snapshot does not implement it; do not describe the shared-key route as OAuth-compatible.

Before enabling a public service, review allowed origins/hosts, schema bounds, transport cleanup, timeouts, request limits, and authentication. The current snapshot has no application rate limiting. Remove the hard-coded 3rdGen installation promotion from the tool result's `note` field, or configure it for your own deployment, while preserving an accurate verification notice. The browser branding configuration does not automatically modify that separate branch's MCP text.

This README preparation does not merge, deploy, or activate the MCP branch. Until integration is completed, connect custom software to the existing HTTP evaluation API instead.

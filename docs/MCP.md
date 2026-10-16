# MCP server

MCP (Model Context Protocol) lets an AI client discover tools, send structured arguments and read the results. Mini-Split Designer exposes its equipment search and design checks as MCP tools, using the same catalog and rules engine as the web app, so an AI answer matches what the designer shows.

## Endpoint

| | |
| --- | --- |
| URL | `https://designer.3rdgen.io/api/mcp` (your own deployment: `https://YOUR-HOST/api/mcp`, plus `NEXT_PUBLIC_BASE_PATH` if set) |
| Transport | Streamable HTTP, stateless, JSON responses |
| Auth | None. The tools are read-only and expose the same data as the public web app |
| Limits | 256 KB request body; 1–16 indoor units per evaluation; list results capped at 100 outdoor / 150 indoor rows. The reference deployment also rate-limits per IP at the firewall |

No AI model runs inside the server; your client supplies the AI.

## Connecting

- **Claude** (claude.ai or desktop): Settings → Connectors → Add custom connector → paste the URL.
- **Claude Code:** `claude mcp add --scope user --transport http minisplit-designer https://designer.3rdgen.io/api/mcp`
- **ChatGPT:** add a custom connector/app in developer mode with the URL and no authentication.
- **Other clients:** any client that supports Streamable HTTP.

## Tools

| Tool | Inputs | Result |
| --- | --- | --- |
| `list_outdoor_units` | Optional system, refrigerant, cooling range, model/name query, legacy toggle | Matching outdoor units with capacities, refrigerant and indoor-unit limits |
| `list_indoor_units` | Optional outdoor unit (id or model), system, unit type, size, query, legacy toggle | Indoor units, filtered to those that connect to the given outdoor unit |
| `evaluate_design` | Outdoor unit, 1–16 indoor units (line length, bends, height, R454B room inputs, controller), single-zone line length, branch-box main line, brand, connection ratio, design temperatures | Pass/fail/incomplete with reasons, BOM, piping, additional refrigerant charge, corrected capacity, R454B checks, controller and accessory options, and the rules left unchecked |

Example `evaluate_design` arguments:

```json
{
  "outdoorUnit": "MXZ-3D24NL",
  "indoorUnits": [
    { "indoorUnit": "MSZ-EX09NLW", "room": "Bedroom", "pipeLengthFt": 30, "heightFt": 8, "floorAreaSqFt": 150, "installHeightFt": 7 },
    { "indoorUnit": "MSZ-EX09NLW", "room": "Office", "pipeLengthFt": 45, "heightFt": 8, "floorAreaSqFt": 120, "installHeightFt": 7 }
  ]
}
```

The server instructions tell the AI not to invent line lengths, heights or floor areas. Missing inputs leave checks incomplete and are listed in the result. A passing result is a planning estimate, not manufacturer approval.

## Code

| File | Responsibility |
| --- | --- |
| `app/src/app/api/mcp/route.ts` | HTTP route; body-size cap; creates a transport and server per request |
| `app/src/lib/mcp.ts` | Tool definitions (Zod schemas), model lookup, calls into the catalog and engine |
| `app/src/lib/site.ts` | `site.mcp.note`: the optional line appended to each evaluation result (the reference deployment uses it for a short 3rdGen note). Set it to `""` when you rebrand |

To keep the endpoint off your own deployment, delete `app/src/app/api/mcp/`.

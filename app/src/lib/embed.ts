import type { Project } from "./project-file";

// Embedding the designer in another web app's iframe, with the host keeping the project.
//
// The host opens  <designer>/?embed=1&host=<host origin>  in an iframe. If that origin is listed in
// site.embed.allowedOrigins (or NEXT_PUBLIC_EMBED_ORIGINS), the designer:
//   - posts { source, type: "ready" } to the parent window once it has loaded,
//   - opens the project the parent sends as { type: "load", project },
//   - posts { source, type: "change", project, summary } after each edit (debounced),
//   - leaves the browser's own saved project alone.
// Messages go only to that origin and are accepted only from the parent window at that origin.
// Any other page can still frame the designer; it just runs as the normal standalone app.

export const EMBED_SOURCE = "mini-split-designer";

export interface SystemSummary {
  name: string;
  outdoorUnit?: string;
  indoorUnits: string[];
  status?: "pass" | "fail" | "incomplete";
}

export type DesignerMessage =
  | { source: typeof EMBED_SOURCE; type: "ready" }
  | { source: typeof EMBED_SOURCE; type: "change"; project: Project; summary: SystemSummary[] };

export type HostMessage = { type: "load"; project: unknown };

/** The host origin to talk to, or null when the page isn't an allowed embed. */
export function embedHost(search: string, allowed: readonly string[]): string | null {
  const q = new URLSearchParams(search);
  if (q.get("embed") !== "1") return null;
  const host = q.get("host");
  if (!host) return null;
  let origin: string;
  try {
    origin = new URL(host).origin;
  } catch {
    return null;
  }
  return origin !== "null" && host === origin && allowed.includes(origin) ? origin : null;
}

/** Allowed host origins: the site config plus a comma-separated NEXT_PUBLIC_EMBED_ORIGINS (for local development). */
export function allowedEmbedOrigins(configured: readonly string[], env = process.env.NEXT_PUBLIC_EMBED_ORIGINS): string[] {
  return [...configured, ...(env ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
}

/** A host message, or null when it isn't one the designer accepts. */
export function readHostMessage(data: unknown): HostMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  return m.type === "load" && "project" in m ? { type: "load", project: m.project } : null;
}

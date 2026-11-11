import type { ProjectSettings, SystemDesign, SystemKey } from "./design";

// A project as a plain JSON file: what "Save project file" downloads, "Open project file" reads, and an
// embedding page exchanges with the designer (see embed.ts). The designer itself stores nothing on a server.

export const PROJECT_FORMAT = "mini-split-designer.project";
export const PROJECT_VERSION = 1;

export interface Project {
  name: string;
  systems: SystemDesign[];
  settings?: ProjectSettings;
}

export interface ProjectFile extends Project {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  savedAt: string;
}

const SYSTEMS: SystemKey[] = ["MandS", "P", "MXZ", "MXZSM"];
const MAX_SYSTEMS = 24;

export function toProjectFile(project: Project, savedAt = new Date().toISOString()): ProjectFile {
  return { format: PROJECT_FORMAT, version: PROJECT_VERSION, savedAt, name: project.name, systems: project.systems, ...(project.settings ? { settings: project.settings } : {}) };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Reads a project file, or the bare { name, systems, settings } shape the browser autosave uses.
 * Checks the structure the designer needs to open it; the engine re-checks every system as usual.
 */
export function parseProject(input: unknown): { ok: true; project: Project } | { ok: false; error: string } {
  if (!isObject(input)) return { ok: false, error: "This isn't a Mini-Split Designer project file." };
  if (input.format !== undefined && input.format !== PROJECT_FORMAT) return { ok: false, error: "This isn't a Mini-Split Designer project file." };
  if (typeof input.version === "number" && input.version > PROJECT_VERSION) return { ok: false, error: "This project was saved by a newer version of the designer." };
  const systems = input.systems;
  if (!Array.isArray(systems) || !systems.length) return { ok: false, error: "The project file has no systems." };
  if (systems.length > MAX_SYSTEMS) return { ok: false, error: `A project can hold up to ${MAX_SYSTEMS} systems.` };
  for (const [i, s] of systems.entries()) {
    const ok =
      isObject(s) &&
      typeof s.id === "string" &&
      typeof s.name === "string" &&
      SYSTEMS.includes(s.system as SystemKey) &&
      (s.oduId === undefined || s.oduId === null || Number.isInteger(s.oduId)) &&
      Array.isArray(s.idus) &&
      s.idus.every((p) => isObject(p) && typeof p.key === "string" && Number.isInteger(p.iduId)) &&
      (s.branchBoxes === undefined || Array.isArray(s.branchBoxes));
    if (!ok) return { ok: false, error: `System ${i + 1} in the project file is damaged.` };
  }
  const settings = isObject(input.settings) ? (input.settings as unknown as ProjectSettings) : undefined;
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 120) : "Project 1";
  return {
    ok: true,
    project: {
      name,
      systems: (systems as SystemDesign[]).map((s) => ({ ...s, oduId: s.oduId ?? undefined, branchBoxes: s.branchBoxes ?? [] })),
      ...(settings ? { settings } : {}),
    },
  };
}

export const projectFileName = (name: string) => `${name.replace(/[^\w-]+/g, "_") || "mini-split"}.msd.json`;

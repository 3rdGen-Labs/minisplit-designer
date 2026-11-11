import { describe, expect, it } from "vitest";
import { allowedEmbedOrigins, embedHost, readHostMessage } from "./embed";
import { parseProject, PROJECT_FORMAT, projectFileName, toProjectFile, type Project } from "./project-file";

// Synthetic project: invented names.
const project: Project = {
  name: "Example Residence",
  settings: { brand: "ME", connectionRatio: 130 },
  systems: [
    { id: "a1", name: "Main floor", system: "MXZ", oduId: 12, idus: [{ key: "k1", iduId: 40, room: "Living room", pipeLengthFt: 25 }], branchBoxes: [] },
    { id: "b2", name: "Garage", system: "MandS", idus: [], branchBoxes: [] },
  ],
};

describe("project files", () => {
  it("round-trips a project through the file format", () => {
    const file = JSON.parse(JSON.stringify(toProjectFile(project, "2026-11-11T00:00:00.000Z")));
    expect(file).toMatchObject({ format: PROJECT_FORMAT, version: 1, savedAt: "2026-11-11T00:00:00.000Z" });
    const back = parseProject(file);
    expect(back.ok && back.project).toEqual(project);
  });

  it("opens the browser's autosave shape and fills defaults", () => {
    const r = parseProject({ name: " ", systems: [{ ...project.systems[1], oduId: null, branchBoxes: undefined }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.project.name).toBe("Project 1");
      expect(r.project.systems[0].oduId).toBeUndefined();
      expect(r.project.systems[0].branchBoxes).toEqual([]);
    }
  });

  it("rejects other files, newer versions and damaged systems", () => {
    expect(parseProject(null).ok).toBe(false);
    expect(parseProject({ format: "something-else", systems: project.systems }).ok).toBe(false);
    expect(parseProject({ ...toProjectFile(project), version: 2 })).toMatchObject({ ok: false, error: expect.stringContaining("newer") });
    expect(parseProject({ systems: [] }).ok).toBe(false);
    expect(parseProject({ systems: [{ ...project.systems[0], system: "VRF" }] })).toMatchObject({ ok: false, error: "System 1 in the project file is damaged." });
    expect(parseProject({ systems: [{ ...project.systems[0], idus: [{ key: "k", iduId: "40" }] }] }).ok).toBe(false);
  });

  it("names the file after the project", () => {
    expect(projectFileName("Example Residence / Unit 2")).toBe("Example_Residence_Unit_2.msd.json");
    expect(projectFileName("")).toBe("mini-split.msd.json");
  });
});

describe("embed mode", () => {
  const allowed = ["https://host.example"];
  it("accepts only a listed host origin", () => {
    expect(embedHost("?embed=1&host=https://host.example", allowed)).toBe("https://host.example");
    expect(embedHost("?embed=1&host=https://other.example", allowed)).toBeNull();
    expect(embedHost("?embed=1&host=https://host.example/path", allowed)).toBeNull();
    expect(embedHost("?embed=1&host=not a url", allowed)).toBeNull();
    expect(embedHost("?host=https://host.example", allowed)).toBeNull();
    expect(embedHost("", allowed)).toBeNull();
  });

  it("adds origins from the environment", () => {
    expect(allowedEmbedOrigins(allowed, " http://localhost:3004 ,,http://dev.example ")).toEqual(["https://host.example", "http://localhost:3004", "http://dev.example"]);
    expect(allowedEmbedOrigins(allowed, undefined)).toEqual(allowed);
  });

  it("reads load messages and ignores anything else", () => {
    expect(readHostMessage({ type: "load", project })).toEqual({ type: "load", project });
    expect(readHostMessage({ type: "load" })).toBeNull();
    expect(readHostMessage({ type: "delete" })).toBeNull();
    expect(readHostMessage("load")).toBeNull();
  });
});

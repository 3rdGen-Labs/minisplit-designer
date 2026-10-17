"use client";

import { createContext, useContext, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import DesignSplit from "./DesignSplit";
import { appPath, site } from "@/lib/site";
import GuidedTutorial, { DEFAULT_TUTORIAL, readTutorialPreferences, saveTutorialPreferences, type TutorialPreferences } from "./GuidedTutorial";
import { issueDestination, type PropertyDestination } from "@/lib/issue-navigation";
import { DEFAULT_CONDITIONS } from "@/lib/design";
import type {
  Brand,
  CapacityResult,
  DesignConditions,
  ModeCapacity,
  Evaluation,
  ProjectSettings,
  IduPlacement,
  Issue,
  Palette,
  PaletteIdu,
  PaletteOdu,
  PipeRun,
  SystemDesign,
  SystemKey,
} from "@/lib/design";

const SYSTEM_LABEL: Record<SystemKey, string> = {
  MandS: "M & S-Series",
  P: "P-Series",
  MXZ: "MXZ Multi-Zone",
  MXZSM: "Smart Multi",
};

const STORAGE_KEY = "zonespec.project.v1";
const DISCLAIMER_KEY = "zonespec.disclaimer.v1";

interface Project {
  name: string;
  systems: SystemDesign[];
  settings?: ProjectSettings;
}

const DEFAULT_SETTINGS: ProjectSettings = { brand: "ME", connectionRatio: 130 };

async function fetchEvaluation(sys: SystemDesign, settings: ProjectSettings, signal?: AbortSignal): Promise<Evaluation | undefined> {
  try {
    const res = await fetch(appPath("/api/evaluate"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...sys, settings }),
      signal,
    });
    return res.ok ? ((await res.json()) as Evaluation) : undefined;
  } catch {
    return undefined;
  }
}

/** What the left-hand tiles carry: a unit *type*. The exact model is picked after the drop. */
type DragItem = { kind: "odu"; system: SystemKey } | { kind: "idu"; typeName: string };

/** Outdoor-unit families shown before anything is placed; the one you pick sets the system type. */
const FAMILY_LABEL: Record<SystemKey, string> = {
  MandS: "Single zone (M & S)",
  P: "P-Series",
  MXZ: "Multi-zone (MXZ)",
  MXZSM: "Smart Multi",
};
const itemLabel = (item: DragItem) => (item.kind === "odu" ? FAMILY_LABEL[item.system] : item.typeName);

/** Rendered icons (design/blender/units.py). Types without a render get a placeholder. */
const U = (n: string) => appPath(`/units/${n}.webp`);
/** Outdoor body by family and size (the data has no cabinet dimensions, so this is by class). */
function oduIcon(o: { model: string; system: SystemKey; coolingBtu: number }): string {
  if (o.system === "MXZSM") return U("outdoor-2fan");
  if (o.coolingBtu >= 42000 || /^MXZ-8/.test(o.model)) return U("outdoor-2fan");
  if (o.coolingBtu <= 15000) return U("outdoor-compact");
  return U("outdoor-1fan");
}
const FAMILY_ICON: Record<SystemKey, string> = { MandS: U("outdoor-compact"), P: U("outdoor-1fan"), MXZ: U("outdoor-1fan"), MXZSM: U("outdoor-2fan") };
const branchBoxIcon = (ports: number) => U(ports === 3 ? "branch-box-3" : "branch-box-5");
const IDU_ICONS: Record<string, string> = {
  "Wall-Mounted": U("wall-premium"),
  "Ceiling-Cassette (Four-Way)": U("cassette-4way"),
  "Ceiling Cassette (One-Way)": U("cassette-1way"),
  "Ceiling-Concealed (Ducted)": U("ducted"),
  "Ceiling-Suspended": U("ceiling-suspended"),
  "Multi Position": U("air-handler"),
  "Multi-Position Air Handler": U("air-handler"),
  "Cased Coil": U("cased-coil"),
  "Floor-Standing Type (Exposed)": U("floor-console"),
};
const iconFor = (item: DragItem) => (item.kind === "odu" ? FAMILY_ICON[item.system] : IDU_ICONS[item.typeName]);
/** Real-world width of each rendered unit (inches), so canvas icons share one scale. */
const ICON_WIDTH_IN: Record<string, number> = {
  [U("wall-premium")]: 31.5,
  [U("cassette-4way")]: 37,
  [U("cassette-1way")]: 42.5,
  [U("ceiling-suspended")]: 50,
  [U("ducted")]: 35.4,
  [U("air-handler")]: 21,
  [U("cased-coil")]: 21,
  [U("floor-console")]: 27.6,
  [U("outdoor-compact")]: 31.5,
  [U("outdoor-1fan")]: 31.5,
  [U("outdoor-2fan")]: 41.3,
  [U("branch-box-5")]: 17.75,
  [U("branch-box-3")]: 14.2,
};
const PX_PER_IN = 4.8;
const iconWidth = (src: string) => Math.round((ICON_WIDTH_IN[src] ?? 30) * PX_PER_IN);
type Selection = { systemId: string; target: "odu" | string } | null;

const uid = () => Math.random().toString(36).slice(2, 9);
const tons = (btu: number) => `${(btu / 12000).toFixed(btu % 12000 ? 2 : 1)} ton`;
const kbtu = (btu: number) => `${Math.round(btu / 1000)}k`;

function newSystem(system: SystemKey, n: number): SystemDesign {
  return { id: uid(), name: `System ${n}`, system, idus: [], branchBoxes: [] };
}

function loadProject(): Project | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Project) : null;
  } catch {
    return null;
  }
}

const PropertyNavigationContext = createContext<Omit<PropertyDestination, "target"> | null>(null);

export default function Designer({ palette }: { palette: Palette }) {
  const [project, setProject] = useState<Project>({ name: "Project 1", systems: [newSystem("MandS", 1)] });
  const [activeId, setActiveId] = useState<string>(project.systems[0].id);
  const [selection, setSelection] = useState<Selection>(null);
  const [propertyNavigation, setPropertyNavigation] = useState<Omit<PropertyDestination, "target"> | null>(null);
  const [evals, setEvals] = useState<Record<string, Evaluation>>({});
  const [dragging, setDragging] = useState<DragItem | null>(null);
  const [bottomTab, setBottomTab] = useState<"errors" | "bom" | "piping">("errors");
  const [picker, setPicker] = useState<DragItem | null>(null);
  // "+ Add" on the canvas: pick a family / unit type first. A port target puts the new unit on that branch-box port.
  const [chooser, setChooser] = useState<"odu" | "idu" | null>(null);
  const [addTarget, setAddTarget] = useState<{ box: number; port: string } | null>(null);
  const [blocked, setBlocked] = useState<{ model: string; errors: string[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const [validatingAll, setValidatingAll] = useState(false);
  const [validationReport, setValidationReport] = useState<{ signature: string; results: Record<string, Evaluation | undefined> } | null>(null);
  const [workspaceDialog, setWorkspaceDialog] = useState<"settings" | "disclaimer" | null>(null);
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);
  const [tutorialPreferences, setTutorialPreferences] = useState<TutorialPreferences>(DEFAULT_TUTORIAL);
  const [tutorialStep, setTutorialStep] = useState<number | null>(null);
  const finishTutorial = (outcome: "skipped" | "completed") => {
    const preferences = { autoShow: false, outcome };
    setTutorialPreferences(preferences);
    saveTutorialPreferences(preferences);
    setTutorialStep(null);
  };
  const startTutorial = () => {
    setWorkspaceDialog(null);
    setTutorialStep(0);
  };
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string; details?: string[] } | null>(null);

  const importDsb = async (file: File) => {
    const body = new FormData();
    body.append("file", file);
    setNotice({ kind: "ok", text: `Reading ${file.name}…` });
    try {
      const res = await fetch(appPath("/api/import-dsb"), { method: "POST", body });
      const data = await res.json();
      if (!res.ok) return setNotice({ kind: "error", text: data.error ?? "Import failed." });
      const imported = (data.systems as SystemDesign[]).map((sys) => ({ ...sys, id: uid() }));
      if (!imported.length) return setNotice({ kind: "error", text: "No M & S, P, MXZ or Smart Multi systems found in that file.", details: data.warnings });
      const empty = project.systems.every((sys) => sys.oduId == null && !sys.idus.length);
      setProject((p) => ({ ...p, name: empty && data.project?.name ? data.project.name : p.name, systems: empty ? imported : [...p.systems, ...imported] }));
      setActiveId(imported[0].id);
      setSelection(null);
      setNotice({ kind: "ok", text: `Imported ${imported.length} system${imported.length > 1 ? "s" : ""} from ${file.name}${empty ? "" : " (added to this project)"}.`, details: data.warnings });
    } catch {
      setNotice({ kind: "error", text: "Import failed. Check your connection and try again." });
    }
  };
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const saved = loadProject();
    if (saved?.systems?.length) {
      setProject({ ...saved, name: saved.name === "New project" ? "Project 1" : saved.name });
      setActiveId(saved.systems[0].id);
    }
    const preferences = readTutorialPreferences();
    setTutorialPreferences(preferences);
    try {
      const accepted = !!localStorage.getItem(DISCLAIMER_KEY);
      setDisclaimerAccepted(accepted);
      if (!accepted) setWorkspaceDialog("disclaimer");
      else if (preferences.autoShow) setTutorialStep(0);
    } catch {
      setWorkspaceDialog("disclaimer");
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    } catch {}
  }, [project, loaded]);

  const active = project.systems.find((s) => s.id === activeId) ?? project.systems[0];
  const evaluation = evals[active.id];

  const settings = project.settings ?? DEFAULT_SETTINGS;
  const validationSignature = JSON.stringify({ systems: project.systems, settings });
  const latestValidationSignature = useRef(validationSignature);
  latestValidationSignature.current = validationSignature;
  const validationCurrent = validationReport?.signature === validationSignature;
  const validatedResults = validationCurrent ? validationReport.results : undefined;

  const validateAllSystems = async () => {
    if (validatingAll) return;
    if (validatedResults && Object.values(validatedResults).every(Boolean)) {
      setTutorialStep((step) => step === 4 ? 5 : step);
      return;
    }
    const signature = validationSignature;
    const systems = project.systems;
    setValidatingAll(true);
    setBottomTab("errors");
    try {
      const results = Object.fromEntries(await Promise.all(systems.map(async (system) =>
        [system.id, await fetchEvaluation(system, settings)] as const,
      )));
      setValidationReport({ signature, results });
      if (latestValidationSignature.current !== signature) return;
      setEvals((current) => {
        const changed = Object.entries(results).filter((entry): entry is [string, Evaluation] => !!entry[1] && JSON.stringify(current[entry[0]]) !== JSON.stringify(entry[1]));
        return changed.length ? { ...current, ...Object.fromEntries(changed) } : current;
      });
      setTutorialStep((step) => step === 4 ? 5 : step);
      const attention = systems.find((system) => results[system.id]?.status !== "pass");
      if (attention && attention.id !== active.id) {
        setActiveId(attention.id);
        setSelection(null);
      }
    } finally {
      setValidatingAll(false);
    }
  };

  // Re-evaluate the active system whenever it changes (debounced).
  useEffect(() => {
    const sys = active;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      const ev = await fetchEvaluation(sys, settings, ctrl.signal);
      if (ev) setEvals((e) => ({ ...e, [sys.id]: ev }));
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [active, settings]);

  // Brand / connection settings change every system's result, not just the open one.
  const systemsRef = useRef(project.systems);
  systemsRef.current = project.systems;
  useEffect(() => {
    let live = true;
    for (const sys of systemsRef.current)
      fetchEvaluation(sys, settings).then((ev) => live && ev && setEvals((e) => ({ ...e, [sys.id]: ev })));
    return () => {
      live = false;
    };
  }, [settings]);

  const updateSystem = useCallback((id: string, fn: (s: SystemDesign) => SystemDesign) => {
    setProject((p) => ({ ...p, systems: p.systems.map((s) => (s.id === id ? fn(s) : s)) }));
  }, []);

  const odu = active.oduId != null ? palette.odus.find((o) => o.id === active.oduId) : undefined;
  const iduById = useMemo(() => new Map(palette.idus.map((i) => [i.id, i])), [palette.idus]);
  const openIssueProperties = (issue: Issue) => {
    const { target, ...destination } = issueDestination(issue, active, odu, evaluation);
    setSelection({ systemId: active.id, target });
    setPropertyNavigation(destination);
  };

  // Can another indoor unit go on? Trial-add the smallest compatible one: if the engine rejects even that,
  // nothing bigger fits either, and the canvas shows why instead of an "+ Add indoor unit" that can't work.
  const [addBlocked, setAddBlocked] = useState<string | null>(null);
  useEffect(() => {
    // Keep the last answer while re-checking, so the slot doesn't flicker on every edit.
    const single = active.system === "MandS" || active.system === "P";
    if (!odu || single || active.idus.length === 0 || active.idus.length >= (odu.maxIdus || 1)) return setAddBlocked(null);
    if (!evaluation || evaluation.oduId !== odu.id) return;
    const compat = new Set(evaluation.compatibleIduIds);
    const smallest = palette.idus
      .filter((i) => compat.has(i.id) && (active.showLegacy || !i.legacy))
      .sort((a, b) => a.size - b.size || a.coolingBtu - b.coolingBtu)[0];
    if (!smallest) return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      const trial: SystemDesign = { ...active, idus: [...active.idus, { key: "probe", iduId: smallest.id, room: "Probe" }] };
      const after = await fetchEvaluation(trial, settings, ctrl.signal);
      if (!after || ctrl.signal.aborted) return;
      const had = new Set(evaluation.issues.filter((x) => x.severity === "error").map((x) => `${x.code}|${x.message}`));
      const added = after.issues.find((x) => x.severity === "error" && !x.incomplete && !had.has(`${x.code}|${x.message}`));
      setAddBlocked(added ? added.message : null);
    }, 300);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [active, odu, evaluation, palette.idus, settings]);

  // Single zone pairs 1:1: once the evaluation for a newly placed ODU arrives, drop in its match.
  const autoPick = useRef<{ systemId: string; odu: PaletteOdu } | null>(null);
  useEffect(() => {
    const pending = autoPick.current;
    if (!pending || pending.systemId !== active.id || evaluation?.oduId !== pending.odu.id) return;
    autoPick.current = null;
    const compat = new Set(evaluation.compatibleIduIds);
    const candidates = palette.idus.filter((i) => compat.has(i.id));
    const pick =
      candidates.find((i) => i.model === pending.odu.defaultIdu && i.systems.includes("MandS")) ??
      candidates.find((i) => i.model === pending.odu.defaultIdu) ??
      (new Set(candidates.map((i) => i.model)).size === 1 ? candidates[0] : undefined);
    if (!pick) return;
    if (!active.idus.length) addIdu(pick);
    else if (!active.idus.some((p) => compat.has(p.iduId)))
      updateSystem(active.id, (s) => ({ ...s, idus: s.idus.map((p, n) => (n === 0 ? { ...p, iduId: pick.id, controller: undefined, wifiAdapter: undefined, accessories: undefined } : p)) }));
  });

  const placeOdu = (o: PaletteOdu) => {
    setTutorialStep((step) => step === 1 ? 2 : step);
    if (o.system === "MandS") autoPick.current = { systemId: active.id, odu: o };
    updateSystem(active.id, (s) => (s.system === o.system ? { ...s, oduId: o.id } : { ...s, system: o.system, oduId: o.id, idus: [], branchBoxes: [] }));
    setSelection({ systemId: active.id, target: "odu" });
  };
  const addIdu = (i: PaletteIdu, target?: { box: number; port: string } | null) => {
    setTutorialStep((step) => step === 2 ? 3 : step);
    const key = uid();
    updateSystem(active.id, (s) => ({
      ...s,
      idus: [...s.idus, { key, iduId: i.id, room: `Room ${s.idus.length + 1}`, ...(target && { box: target.box, port: target.port }) }],
    }));
    setSelection({ systemId: active.id, target: key });
  };

  // Picking a unit by hand: try it first and refuse it if it adds an error. Errors that more units would clear
  // (too few units, under minimum capacity) don't count, or a multi-zone could never be built up one unit at a time.
  const tryAddIdu = async (i: PaletteIdu, target?: { box: number; port: string } | null) => {
    const sys = active;
    const trial: SystemDesign = { ...sys, idus: [...sys.idus, { key: uid(), iduId: i.id, room: `Room ${sys.idus.length + 1}`, ...(target && { box: target.box, port: target.port }) }] };
    setChecking(true);
    const [before, after] = await Promise.all([fetchEvaluation(sys, settings), fetchEvaluation(trial, settings)]);
    setChecking(false);
    if (!before || !after) {
      setNotice({ kind: "error", text: "Couldn't check that unit. Check your connection and try again." });
      return false;
    }
    const had = new Set(before.issues.filter((x) => x.severity === "error").map((x) => `${x.code}|${x.message}`));
    const added = after.issues.filter((x) => x.severity === "error" && !x.incomplete && !had.has(`${x.code}|${x.message}`));
    if (added.length) {
      setBlocked({ model: i.model, errors: added.map((x) => x.message) });
      return false;
    }
    addIdu(i, target);
    return true;
  };

  const sensors = useSensors(
    // Mouse drags right away. Touch: swipe scrolls, tap opens the picker, long-press drags (tablets).
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 350, tolerance: 5 } }),
  );

  const onDragStart = (e: DragStartEvent) => setDragging(e.active.data.current as DragItem);
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const item = e.active.data.current as DragItem | undefined;
    if (!item || !e.over) return;
    setPicker(item);
  };

  const addSystem = () => {
    const s = newSystem("MandS", project.systems.length + 1);
    setProject((p) => ({ ...p, systems: [...p.systems, s] }));
    setActiveId(s.id);
    setSelection(null);
  };
  const removeSystem = (id: string) => {
    if (project.systems.length === 1) return;
    const rest = project.systems.filter((s) => s.id !== id);
    setProject((p) => ({ ...p, systems: rest }));
    if (id === activeId) setActiveId(rest[0].id);
  };

  // iOS Safari ignores user-scalable=no for pinches; cancelling its gesture events keeps the layout from zooming.
  useEffect(() => {
    const stop = (e: Event) => e.preventDefault();
    for (const name of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(name, stop, { passive: false });
    return () => { for (const name of ["gesturestart", "gesturechange", "gestureend"]) document.removeEventListener(name, stop); };
  }, []);

  // Delete / Backspace removes the selected unit, unless the user is typing or a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
      if (picker || blocked || workspaceDialog || !selection || selection.systemId !== active.id) return;
      e.preventDefault();
      const target = selection.target;
      if (target === "odu") updateSystem(active.id, (s) => ({ ...s, oduId: undefined }));
      else updateSystem(active.id, (s) => ({ ...s, idus: s.idus.filter((i) => i.key !== target) }));
      setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, active.id, picker, blocked, workspaceDialog, updateSystem]);

  const projectBom = useMemo(() => mergeBom(project.systems.map((s) => evals[s.id]).filter(Boolean)), [project.systems, evals]);

  return (
    <DndContext id="designer" sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="designer-shell flex min-h-dvh flex-col bg-[var(--chrome)] text-[13px] text-[var(--fg)] lg:h-dvh">
        <Toolbar
          onOpenSettings={() => setWorkspaceDialog("settings")}
          onTutorial={startTutorial}
          onImport={importDsb}
          onAddSystem={addSystem}
          onExport={() => downloadCsv(project, evals)}
          onCopy={() => copyBom(projectBom)}
          onReset={() => {
            if (!confirm("Clear this project?")) return;
            const s = newSystem("MandS", 1);
            setProject({ name: "Project 1", systems: [s] });
            setActiveId(s.id);
            setSelection(null);
          }}
        />

        {notice && (
          <div className={`flex items-start gap-3 px-3 py-2 text-[12px] ${notice.kind === "error" ? "bg-[var(--bad)] text-white" : "bg-[var(--header)] text-[var(--header-fg)]"}`}>
            <div className="flex-1">
              <div className="font-semibold">{notice.text}</div>
              {notice.details?.length ? (
                <details className="mt-1">
                  <summary className="cursor-pointer">{notice.details.length} note{notice.details.length > 1 ? "s" : ""}</summary>
                  <ul className="ml-4 list-disc">
                    {notice.details.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
            <button onClick={() => setNotice(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}

        <div className="workspace flex flex-1 flex-col gap-3 p-3 lg:min-h-0 lg:flex-row">
          {/* Left: project tree + palette */}
          <aside className="workspace-panel equipment-panel flex flex-col bg-[var(--panel)] lg:w-64 lg:min-h-0 lg:shrink-0">
            <PanelHeader>Systems</PanelHeader>
            <div className="validation-control">
              <button className="validate-all-button" onClick={validateAllSystems} disabled={validatingAll} aria-busy={validatingAll} title={validationCurrent ? "Results are current. Editing equipment or settings enables a new check." : "Check every system in this project"}>
                <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3 4 6v6c0 4 5 8 8 9 3-1 8-5 8-9V6Z"/><path d="m8 12 3 3 5-6"/></svg>
                {validatingAll ? "Validating systems…" : "Validate all systems"}
              </button>
              <p className="mt-2 text-[10px] leading-relaxed text-[var(--muted)]">Compatibility, piping &amp; equipment checks</p>
              <div role="status" aria-live="polite" className="validation-summary">
                {validatingAll ? `Checking ${project.systems.length} system${project.systems.length === 1 ? "" : "s"}…` : validatedResults ? (
                  <>
                    <div className="font-semibold text-[var(--fg)]">{Object.values(validatedResults).some((ev) => !ev) ? "Validation needs a retry" : "Validation complete"}</div>
                    <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1">
                      <span>{Object.values(validatedResults).filter((ev) => ev?.status === "pass").length} passed</span>
                      <span>{Object.values(validatedResults).filter((ev) => ev?.status === "fail").length} with errors</span>
                      <span>{Object.values(validatedResults).filter((ev) => ev?.status === "incomplete").length} incomplete</span>
                      {Object.values(validatedResults).some((ev) => ev?.issues.some((issue) => issue.severity === "warning")) && <span>{Object.values(validatedResults).reduce((count, ev) => count + (ev?.issues.filter((issue) => issue.severity === "warning").length ?? 0), 0)} warnings</span>}
                      {Object.values(validatedResults).some((ev) => !ev) && <span className="text-[var(--bad)]">{Object.values(validatedResults).filter((ev) => !ev).length} could not be checked — retry</span>}
                    </div>
                    <p className="mt-2">Select a system to review its errors &amp; warnings.</p>
                  </>
                ) : validationReport ? "Design changed. Validate again for current results." : "Check every system before quoting or ordering."}
              </div>
            </div>
            <ul className="project-list border-b border-[var(--line)] p-2">
              {project.systems.map((s) => {
                const ev = validatedResults ? validatedResults[s.id] : evals[s.id];
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => {
                        setActiveId(s.id);
                        setSelection(null);
                        setPropertyNavigation(null);
                        if (validatedResults) setBottomTab("errors");
                      }}
                      aria-current={s.id === active.id ? "true" : undefined}
                      className={`system-item flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left ${s.id === active.id ? "bg-[var(--sel)] text-[var(--sel-fg)]" : "hover:bg-[var(--hover)]"}`}
                    >
                      <StatusDot status={ev?.status} />
                      <span className="flex-1 truncate">{s.name}</span>
                      <span className="text-[11px] opacity-80">{validatedResults ? (validatedResults[s.id]?.status === "pass" ? "Passed" : validatedResults[s.id]?.status === "fail" ? "Errors" : validatedResults[s.id]?.status === "incomplete" ? "Incomplete" : "Retry check") : s.oduId != null ? SYSTEM_LABEL[s.system] : "empty"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <TileShelf
              palette={palette}
              system={active.system}
              hasOdu={!!odu}
              compatible={evaluation?.compatibleIduIds}
              showLegacy={!!active.showLegacy}
              refrigerant={active.refrigerantFilter}
              onRefrigerant={(r) => updateSystem(active.id, (s) => ({ ...s, refrigerantFilter: r }))}
              onTap={setPicker}
            />
          </aside>

          {/* Center: canvas + bottom panel */}
          <main className="design-center flex min-w-0 flex-1 flex-col gap-3 lg:min-h-0">
            <div className="canvas-toolbar flex flex-wrap items-center gap-2 bg-[var(--panel)] px-4 py-3">
              <input
                value={active.name}
                onChange={(e) => updateSystem(active.id, (s) => ({ ...s, name: e.target.value }))}
                className="system-name min-w-0 w-36 rounded border border-[var(--line)] bg-[var(--field)] px-2 py-1 font-medium"
                aria-label="System name"
              />
              <span className="rounded bg-[var(--group)] px-2 py-1 text-[12px] text-[var(--muted)]">{odu ? SYSTEM_LABEL[active.system] : "Pick an outdoor unit to start"}</span>
              <div className="flex-1" />
              {(odu || active.idus.length > 0) && (
                <button
                  onClick={() => {
                    if (!confirm(`Clear ${active.name}? This removes its outdoor unit, indoor units and settings.`)) return;
                    updateSystem(active.id, (s) => ({ id: s.id, name: s.name, system: s.system, idus: [], branchBoxes: [], showLegacy: s.showLegacy, refrigerantFilter: s.refrigerantFilter }));
                    setSelection(null);
                  }}
                  className="clear-system-button"
                >
                  Clear system
                </button>
              )}
              {project.systems.length > 1 && (
                <button onClick={() => removeSystem(active.id)} className="text-[12px] text-[var(--muted)] hover:text-[var(--bad)]">
                  Delete system
                </button>
              )}
            </div>

            <DesignSplit
              canvas={(
<Canvas
              system={active}
              odu={odu}
              iduById={iduById}
              evaluation={evaluation}
              selection={selection}
              dragging={dragging}
              onSelect={(target) => { setPropertyNavigation(null); setSelection({ systemId: active.id, target }); }}
              onRemoveOdu={() => updateSystem(active.id, (s) => ({ ...s, oduId: undefined }))}
              onRemoveIdu={(key) => updateSystem(active.id, (s) => ({ ...s, idus: s.idus.filter((i) => i.key !== key) }))}
              onPatch={(patch) => updateSystem(active.id, (s) => ({ ...s, ...patch }))}
              onPatchIdu={(key, patch) => updateSystem(active.id, (s) => ({ ...s, idus: s.idus.map((i) => (i.key === key ? { ...i, ...patch } : i)) }))}
              addBlocked={addBlocked}
              onAddOdu={() => setChooser("odu")}
              onAddIdu={(target) => { setAddTarget(target ?? null); setChooser("idu"); }}
            />
              )}
              results={(
<section className="workspace-panel results-panel flex flex-col bg-[var(--panel)]">
              <div className="flex border-b border-[var(--line)]">
                <TabButton active={bottomTab === "errors"} onClick={() => setBottomTab("errors")}>
                  Errors & warnings ({evaluation?.issues.length ?? 0})
                </TabButton>
                <TabButton active={bottomTab === "bom"} onClick={() => setBottomTab("bom")}>
                  Bill of materials
                </TabButton>
                <TabButton active={bottomTab === "piping"} onClick={() => setBottomTab("piping")}>
                  Piping
                </TabButton>
              </div>
              <div className="flex-1 overflow-auto">
                {bottomTab === "errors" ? (
                  <IssueList evaluation={evaluation} onSelect={openIssueProperties} />
                ) : bottomTab === "bom" ? (
                  <BomTable evaluation={evaluation} />
                ) : (
                  <PipingTable evaluation={evaluation} onSelect={(t) => t && setSelection({ systemId: active.id, target: t })} />
                )}
              </div>
            </section>
              )}
            />
          </main>

          {/* Right: properties */}
          <aside className="properties-column flex flex-col gap-3 lg:min-h-0 lg:w-72 lg:shrink-0">
            <div className="workspace-panel properties-panel min-h-0 bg-[var(--panel)] lg:flex-1">
            <PanelHeader>Properties</PanelHeader>
            <div className="properties-content" tabIndex={0} role="region" aria-label="Properties controls">
            <PropertyNavigationContext.Provider value={propertyNavigation}>
            <Properties
              system={active}
              odu={odu}
              iduById={iduById}
              evaluation={evaluation}
              selection={selection?.systemId === active.id ? selection.target : null}
              onChange={(fn) => updateSystem(active.id, fn)}
              settings={settings}
              onSettings={(next) => setProject((p) => ({ ...p, settings: next }))}
            />
            </PropertyNavigationContext.Provider>
            </div>
            </div>
            {site.business.enabled && <section className="installation-card shrink-0" aria-labelledby="installation-title">
              <h2 id="installation-title"><img src={appPath(site.business.logo)} alt={site.business.name} width={383} height={216} className="company-logo" /></h2>
              <p className="mt-3 text-center text-[13px] font-semibold leading-relaxed text-[var(--fg)]">{site.business.description}</p>
              <a
                href={site.business.url}
                target="_blank"
                rel="noopener noreferrer"
                className="installation-link relative mt-5 flex items-center justify-center rounded-lg px-9 py-3 text-[13px] font-semibold"
              >
                {site.business.linkLabel} <span className="absolute right-3" aria-hidden="true">↗</span>
              </a>
            </section>}
          </aside>
        </div>
        <footer className="app-footer">
          <div className="footer-content">
          {site.credits.enabled && <>
          <span>{site.name} {site.version} · built by <a href={site.credits.url} target="_blank" rel="noopener noreferrer">{site.owner}</a></span>
          <span className="footer-separator" aria-hidden="true" />
          </>}
          {site.credits.secondaryEnabled && <>
          <span>{site.credits.secondaryLabel} <a href={site.credits.secondaryUrl} target="_blank" rel="noopener noreferrer">{site.credits.secondaryName}</a></span>
          <span className="footer-separator" aria-hidden="true" />
          </>}
          <button onClick={() => setWorkspaceDialog("disclaimer")}>About &amp; disclaimer</button>
          {site.repo && <>
          <span className="footer-separator" aria-hidden="true" />
          <a href={`${site.repo}/issues/new?template=wrong-result.yml`} target="_blank" rel="noopener noreferrer">Report a problem</a>
          </>}
          </div>
        </footer>
      </div>

      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className="pointer-events-none w-32 rounded border border-[var(--accent)] bg-[var(--panel)] p-2 text-center shadow-lg">
            <UnitIcon src={iconFor(dragging)} label={itemLabel(dragging)} />
            <div className="mt-1 text-[11px] font-semibold">{itemLabel(dragging)}</div>
          </div>
        )}
      </DragOverlay>

      {picker && (
        <ModelPicker
          item={picker}
          palette={palette}
          system={active.system}
          hasOdu={!!odu}
          compatible={evaluation?.compatibleIduIds}
          showLegacy={!!active.showLegacy}
          refrigerant={active.refrigerantFilter}
          onToggleLegacy={(v) => updateSystem(active.id, (s) => ({ ...s, showLegacy: v }))}
          onPickOdu={(o) => {
            placeOdu(o);
            setPicker(null);
          }}
          onPickIdu={async (i) => {
            if (await tryAddIdu(i, addTarget)) { setPicker(null); setAddTarget(null); }
          }}
          checking={checking}
          onClose={() => { setPicker(null); setAddTarget(null); }}
        />
      )}
      {chooser && (
        <TypeChooser
          kind={chooser}
          palette={palette}
          system={active.system}
          hasOdu={!!odu}
          compatible={evaluation?.compatibleIduIds}
          showLegacy={!!active.showLegacy}
          refrigerant={active.refrigerantFilter}
          onRefrigerant={(r) => updateSystem(active.id, (s) => ({ ...s, refrigerantFilter: r }))}
          port={addTarget?.port}
          onPick={(item) => { setChooser(null); setPicker(item); }}
          onClose={() => { setChooser(null); setAddTarget(null); }}
        />
      )}
      {workspaceDialog === "settings" && (
        <SettingsDialog
          settings={settings}
          tutorialPreferences={tutorialPreferences}
          onTutorialPreferences={(preferences) => {
            setTutorialPreferences(preferences);
            saveTutorialPreferences(preferences);
          }}
          onTutorial={startTutorial}
          onSave={(next) => {
            setProject((p) => ({ ...p, settings: next }));
            setWorkspaceDialog(null);
          }}
          onClose={() => setWorkspaceDialog(null)}
          onDisclaimer={() => setWorkspaceDialog("disclaimer")}
        />
      )}
      {workspaceDialog === "disclaimer" && (
        <DisclaimerDialog
          required={!disclaimerAccepted}
          onClose={() => setWorkspaceDialog(null)}
          onAccept={() => {
            try { localStorage.setItem(DISCLAIMER_KEY, new Date().toISOString()); } catch {}
            setDisclaimerAccepted(true);
            setWorkspaceDialog(null);
            if (!disclaimerAccepted && tutorialPreferences.autoShow) setTutorialStep(0);
          }}
        />
      )}
      {tutorialStep != null && (
        <GuidedTutorial step={tutorialStep} paused={!!picker || !!blocked || !!workspaceDialog} onStep={setTutorialStep} onFinish={finishTutorial} />
      )}
      {blocked && <BlockedDialog model={blocked.model} errors={blocked.errors} onClose={() => setBlocked(null)} />}
    </DndContext>
  );
}

/* ---------- toolbar ---------- */

type HeaderIconName = "actions" | "import" | "copy" | "export" | "new" | "tutorial" | "settings";
function HeaderIcon({ name }: { name: HeaderIconName }) {
  const paths: Record<HeaderIconName, React.ReactNode> = {
    actions: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    import: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/></>,
    export: <><path d="M12 15V3m-4 4 4-4 4 4M4 16v5h16v-5"/></>,
    new: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M8 15h8m-4-4v8"/></>,
    tutorial: <><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.1 1.9c-1 .6-1.6 1.1-1.6 2.6M12 17h.01"/></>,
    settings: <><path d="m9 3-.6 2.2-2 .9-2-.6-2 3.4 1.5 1.6v2.3L2.4 15l2 3.4 2-.6 2 .9.6 2.3h4l.6-2.3 2-.9 2 .6 2-3.4-1.5-1.7V11l1.5-1.6-2-3.4-2 .6-2-.9L13 3Z"/><circle cx="11" cy="12" r="3"/></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function GitHubIcon() {
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="17" height="17" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>;
}

function Toolbar(props: {
  onOpenSettings: () => void;
  onTutorial: () => void;
  onImport: (f: File) => void;
  onAddSystem: () => void;
  onExport: () => void;
  onCopy: () => void;
  onReset: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  const action = (run: () => void) => {
    if (menu.current) menu.current.open = false;
    run();
  };
  return (
    <header className="app-toolbar bg-[var(--titlebar)] text-[var(--titlebar-fg)]">
      <div className="header-identity flex flex-wrap items-center gap-4">
        {site.header.enabled && <>
        <a href={site.header.url} target="_blank" rel="noopener noreferrer" aria-label={`${site.header.name} website`} className="shrink-0">
          <img src={appPath(site.header.logo)} alt={site.header.name} width={120} height={37} className="labs-logo" />
        </a>
        <span className="header-divider" aria-hidden="true" />
        </>}
        <div className="min-w-0">
          <h1 className="software-name">{site.name} <span className="software-version">{site.version}</span></h1>
          {site.tagline && <p className="software-tagline">{site.tagline}</p>}
        </div>
      </div>
      <div className="header-actions flex flex-wrap items-center gap-2">
        <button className="toolbar-button" onClick={props.onAddSystem}>New system</button>
        <details ref={menu} className="project-actions">
          <summary className="toolbar-button project-actions-button" aria-label="Project actions"><HeaderIcon name="actions" /><span className="desktop-actions-label">Project actions</span><span className="mobile-actions-label">Actions</span><span aria-hidden="true">⌄</span></summary>
          <div className="project-actions-menu">
            <button onClick={() => action(() => file.current?.click())}><HeaderIcon name="import" />Import DSB</button>
            <button onClick={() => action(props.onCopy)}><HeaderIcon name="copy" />Copy BOM</button>
            <button onClick={() => action(props.onExport)}><HeaderIcon name="export" />Export CSV</button>
            <div className="my-1 border-t border-[var(--line-soft)]" />
            <button onClick={() => action(props.onReset)}><HeaderIcon name="new" />New project</button>
          </div>
        </details>
        <input ref={file} type="file" className="hidden" aria-label="Import DSB file" onChange={(e) => {
          const selected = e.target.files?.[0];
          if (selected) props.onImport(selected);
          e.target.value = "";
        }} />
        <button className="toolbar-button tutorial-button" onClick={props.onTutorial} aria-label="Tutorial" title="View tutorial"><HeaderIcon name="tutorial" /><span className="tutorial-label">Tutorial</span></button>
        {site.repo && <a href={site.repo} target="_blank" rel="noopener noreferrer" className="toolbar-button github-button" aria-label="Source code on GitHub" title="Source code on GitHub"><GitHubIcon /></a>}
        <button onClick={props.onOpenSettings} className="toolbar-button settings-button" aria-label="Settings" title="Settings" aria-haspopup="dialog"><HeaderIcon name="settings" /></button>
      </div>
    </header>
  );
}

/** Native dialogs provide focus containment, Escape handling and focus restoration. */
function WorkspaceDialog({ title, onClose, required = false, children }: { title: string; onClose: () => void; required?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.focus({ preventScroll: true });
    if (dialog) dialog.scrollTop = 0;
    return () => dialog?.close();
  }, []);
  return (
    <dialog ref={ref} tabIndex={-1} className="workspace-dialog" aria-label={title} onCancel={(e) => { e.preventDefault(); if (!required) onClose(); }}>
      <div className="flex items-center justify-between gap-4 border-b border-[var(--line-soft)] px-6 py-5">
        <h2 className="text-[18px] font-semibold tracking-tight">{title}</h2>
        {!required && <button onClick={onClose} aria-label={`Close ${title}`} className="rounded px-2 py-1 text-[var(--muted)] hover:bg-[var(--hover)]">✕</button>}
      </div>
      {children}
    </dialog>
  );
}

function SettingsDialog({ settings, onSave, onClose, onDisclaimer, tutorialPreferences, onTutorialPreferences, onTutorial }: {
  settings: ProjectSettings;
  onSave: (s: ProjectSettings) => void;
  onClose: () => void;
  onDisclaimer: () => void;
  tutorialPreferences: TutorialPreferences;
  onTutorialPreferences: (preferences: TutorialPreferences) => void;
  onTutorial: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [tutorialDraft, setTutorialDraft] = useState(tutorialPreferences);
  return (
    <WorkspaceDialog title="Settings" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); onTutorialPreferences(tutorialDraft); onSave(draft); }}>
        <div className="space-y-6 px-6 py-5">
          <p className="text-[12px] leading-relaxed text-[var(--muted)]">These settings apply to every system in this project.</p>
          <label className="block text-[13px] font-medium">
            Part numbers on the bill of materials
            <select className="settings-field" value={draft.brand} onChange={(e) => setDraft({ ...draft, brand: e.target.value as Brand })}>
              <option value="ME">Mitsubishi part numbers</option>
              <option value="TRME">Trane part numbers</option>
              <option value="ASME">American Standard part numbers</option>
            </select>
          </label>
          <label className="block text-[13px] font-medium">
            Maximum connected capacity
            <select className="settings-field" value={draft.connectionRatio} onChange={(e) => setDraft({ ...draft, connectionRatio: Number(e.target.value) as 100 | 130 })}>
              <option value={130}>Up to 130% connection</option>
              <option value={100}>100% connection maximum</option>
            </select>
            <span className="mt-2 block text-[11px] font-normal leading-relaxed text-[var(--muted)]">Applies to R410A multi-zone systems. R454B systems use their own equipment limits.</span>
          </label>
          <section className="space-y-3 border-t border-[var(--line-soft)] pt-4">
            <h3 className="text-[13px] font-semibold">Tutorial</h3>
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={tutorialDraft.autoShow} onChange={(e) => setTutorialDraft({ ...tutorialDraft, autoShow: e.target.checked })} />
              Show tutorial on startup
            </label>
            <p className="text-[11px] leading-relaxed text-[var(--muted)]">Skipping or finishing turns this off for this browser. You can restart the walkthrough anytime from the header.</p>
            <button type="button" onClick={onTutorial} className="dialog-secondary">Restart tutorial</button>
          </section>
          <button type="button" className="text-[12px] text-[var(--accent)] underline underline-offset-4" onClick={onDisclaimer}>About this tool &amp; disclaimer</button>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--line-soft)] px-6 py-4">
          <button type="button" className="dialog-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="dialog-primary">Save settings</button>
        </div>
      </form>
    </WorkspaceDialog>
  );
}

function DisclaimerDialog({ required, onClose, onAccept }: { required: boolean; onClose: () => void; onAccept: () => void }) {
  return (
    <WorkspaceDialog title="Before you design" required={required} onClose={onClose}>
      <div className="space-y-5 px-6 py-5 text-[12px] leading-relaxed text-[var(--muted)]">
        <p>{site.name} is an independent planning and estimating tool built by <strong className="text-[var(--fg)]">{site.owner}</strong>.</p>
        <section>
          <h3 className="mb-1 font-semibold text-[var(--fg)]">Independent of Mitsubishi Electric</h3>
          <p>{site.owner} and this software are not affiliated with, endorsed by, or sponsored by Mitsubishi Electric, Mitsubishi Electric Trane HVAC US, or their affiliates. Equipment names, model numbers, and trademarks identify equipment only and belong to their respective owners.</p>
        </section>
        <section>
          <h3 className="mb-1 font-semibold text-[var(--fg)]">Reference data, not installation approval</h3>
          <p>This tool assembles equipment specifications and compatibility reference data for planning. Data and calculations may be incomplete, outdated, or incorrect. A compatibility result is not manufacturer approval, a load calculation, an engineered design, or a guarantee of performance.</p>
        </section>
        <section>
          <h3 className="mb-1 font-semibold text-[var(--fg)]">Verify before quoting, ordering, or installing</h3>
          <p>Have a qualified HVAC professional verify equipment selection, sizing, compatibility, piping, refrigerant requirements, electrical requirements, and code compliance against current manufacturer submittals and installation manuals. Confirm the design in the manufacturer’s current design tools, including Diamond System Builder where applicable.</p>
        </section>
        <section>
          <h3 className="mb-1 font-semibold text-[var(--fg)]">Your project remains your responsibility</h3>
          <p>The software is provided “as is,” without warranties to the extent permitted by law. You and your qualified project professionals remain responsible for design decisions and installation. To the extent permitted by law, {site.owner} disclaims liability for losses or damages arising from use of this tool or reliance on its results, including equipment selection and installation. Nothing here limits rights or liabilities that cannot legally be limited.</p>
        </section>
        <p className="text-[11px]">This notice is available anytime in Settings or the footer.</p>
      </div>
      <div className="flex justify-end border-t border-[var(--line-soft)] px-6 py-4">
        <button onClick={onAccept} className="dialog-primary">{required ? "I understand — continue" : "Done"}</button>
      </div>
    </WorkspaceDialog>
  );
}

/* ---------- palette ---------- */

/** Unit types available for a system, after the compatibility filter once an ODU is placed. */
function iduCandidates(palette: Palette, system: SystemKey, hasOdu: boolean, compatible: number[] | undefined, showLegacy: boolean) {
  const compat = hasOdu && compatible ? new Set(compatible) : null;
  const byModel = new Map<string, PaletteIdu>();
  for (const i of palette.idus) {
    if (!(i.systems.includes(system) || (system === "MXZSM" && i.systems.includes("MXZ")))) continue;
    if (compat ? !compat.has(i.id) : i.legacy && !showLegacy) continue;
    const cur = byModel.get(i.model);
    const rank = (u: PaletteIdu) => (u.systems.includes(system) ? 1 : 0);
    if (!cur || rank(i) > rank(cur)) byModel.set(i.model, i);
  }
  return [...byModel.values()];
}

type RefrigerantFilter = SystemDesign["refrigerantFilter"];
const REFRIGERANTS: { value: RefrigerantFilter; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "R454B", label: "R454B" },
  { value: "R410A", label: "R410A" },
];

interface TileShelfProps {
  palette: Palette;
  system: SystemKey;
  hasOdu: boolean;
  compatible?: number[];
  showLegacy: boolean;
  refrigerant: RefrigerantFilter;
  onRefrigerant: (r: RefrigerantFilter) => void;
  onTap: (item: DragItem) => void;
}

function TileShelf(props: TileShelfProps) {
  return <EquipmentLibrary key={props.hasOdu ? "configured" : "empty"} {...props} />;
}

/** Outdoor families with how many models each offers under the current filters. */
function familyCounts(palette: Palette, showLegacy: boolean, refrigerant: RefrigerantFilter) {
  return (Object.keys(FAMILY_LABEL) as SystemKey[])
    .map((k) => [k, palette.odus.filter((o) => o.system === k && (showLegacy || !o.legacy) && (!refrigerant || o.refrigerant === refrigerant)).length] as const)
    .filter(([, n]) => n > 0);
}

/** Indoor unit types that can go on this system, with model counts; types with artwork first. */
function iduTypeCounts(palette: Palette, system: SystemKey, hasOdu: boolean, compatible: number[] | undefined, showLegacy: boolean) {
  const counts = new Map<string, number>();
  for (const i of iduCandidates(palette, system, hasOdu, compatible, showLegacy)) counts.set(i.typeName, (counts.get(i.typeName) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => Number(!IDU_ICONS[a[0]]) - Number(!IDU_ICONS[b[0]]) || b[1] - a[1]);
}

const isPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;

function EquipmentLibrary(props: TileShelfProps) {
  const [outdoorOpen, setOutdoorOpen] = useState(!props.hasOdu);
  const [indoorOpen, setIndoorOpen] = useState(props.hasOdu);
  // Phones add units from the canvas "+ Add" buttons, so the library starts collapsed there.
  useEffect(() => {
    if (!isPhone()) return;
    setOutdoorOpen(false);
    setIndoorOpen(false);
  }, []);
  const families = useMemo(() => familyCounts(props.palette, props.showLegacy, props.refrigerant), [props.palette, props.showLegacy, props.refrigerant]);
  const types = useMemo(
    () => iduTypeCounts(props.palette, props.system, props.hasOdu, props.compatible, props.showLegacy),
    [props.palette, props.system, props.hasOdu, props.compatible, props.showLegacy],
  );

  return (
    <div className="equipment-library flex min-h-0 flex-1 flex-col">
      <EquipmentGroup title="Outdoor units" kind="outdoor" open={outdoorOpen} onToggle={() => setOutdoorOpen((open) => !open)}>
        <p className="px-3 pt-3 text-[11px] leading-relaxed text-[var(--muted)]">
          {props.hasOdu ? "Change the outdoor model for this system." : "Start with the outdoor unit. Choose a family, then a model."}
        </p>
        {!props.hasOdu && (
          <div className="flex gap-1 px-3 pt-2" role="radiogroup" aria-label="Refrigerant">
            {REFRIGERANTS.map((r) => (
              <button key={r.label} role="radio" aria-checked={props.refrigerant === r.value} onClick={() => props.onRefrigerant(r.value)} className={`flex-1 rounded border px-2 py-1 text-[12px] ${props.refrigerant === r.value ? "border-[var(--accent)] bg-[var(--sel)] text-[var(--sel-fg)]" : "border-[var(--line)] bg-[var(--field)] hover:border-[var(--accent)]"}`}>
                {r.label}
              </button>
            ))}
          </div>
        )}
        <div className={`grid gap-2 p-3 ${props.hasOdu ? "grid-cols-1" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-2"}`}>
          {props.hasOdu ? <Tile item={{ kind: "odu", system: props.system }} label="Swap outdoor unit" onTap={props.onTap} /> : families.map(([family, count]) => <Tile key={family} item={{ kind: "odu", system: family }} label={FAMILY_LABEL[family]} count={count} onTap={props.onTap} />)}
        </div>
      </EquipmentGroup>
      <EquipmentGroup title="Indoor units" kind="indoor" open={indoorOpen} onToggle={() => setIndoorOpen((open) => !open)}>
        {props.hasOdu ? (
          <>
            <p className="px-3 pt-3 text-[11px] leading-relaxed text-[var(--muted)]">
              <span className="hint-mouse">Drag onto the canvas or click to choose a compatible indoor unit.</span>
              <span className="hint-touch">Tap a type to choose a compatible indoor unit.</span>
            </p>
            <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-2">
              {types.map(([type, count]) => <Tile key={type} item={{ kind: "idu", typeName: type }} label={type} count={count} onTap={props.onTap} />)}
            </div>
            {!types.length && <Empty>No indoor units match this outdoor unit.</Empty>}
          </>
        ) : <Empty>Choose an outdoor unit first to see compatible indoor units.</Empty>}
      </EquipmentGroup>
    </div>
  );
}

function EquipmentGroup({ title, kind, open, onToggle, children }: { title: string; kind: "outdoor" | "indoor"; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  const id = useId();
  return (
    <section className={`equipment-group equipment-group-${kind}`} aria-label={title}>
      <h2>
        <button className="equipment-group-toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>
          {title}
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" className={open ? "rotate-90" : ""}><path d="m6 3 5 5-5 5" /></svg>
        </button>
      </h2>
      <div id={id} hidden={!open}>{children}</div>
    </section>
  );
}

function Tile({ item, label, count, onTap }: { item: DragItem; label: string; count?: number; onTap: (item: DragItem) => void }) {
  const id = item.kind === "odu" ? `tile-odu-${item.system}` : `tile-${item.typeName}`;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id, data: item });
  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      onClick={() => onTap(item)}
      className={`equipment-tile no-callout flex touch-manipulation flex-col items-center rounded border border-[var(--line)] bg-[var(--field)] p-2 text-center hover:border-[var(--accent)] ${isDragging ? "opacity-40" : ""}`}
    >
      <UnitIcon src={iconFor(item)} label={label} />
      <span className="mt-1 text-[11px] font-semibold leading-tight">{label}</span>
      {count != null && <span className="text-[10px] text-[var(--muted)]">{count} models</span>}
    </button>
  );
}

function UnitIcon({ src, label, size = "h-14" }: { src?: string; label: string; size?: string }) {
  if (src) return <img src={src} alt="" className={`no-callout pointer-events-none ${size} w-full object-contain`} draggable={false} />;
  // No render yet: a dashed placeholder with a short name ("Ceiling-Concealed (Ducted)" -> "Ducted").
  const short = label.match(/\(([^)]+)\)/)?.[1] ?? label;
  return (
    <div className={`${size} flex w-full items-center justify-center`}>
      <div className="flex h-10 w-20 items-center justify-center rounded-md border-2 border-dashed border-[var(--line)] px-1 text-center text-[10px] font-semibold leading-tight text-[var(--muted)]">{short}</div>
    </div>
  );
}

type SearchMode = "name" | "model";
const SEARCH_MODES: { value: SearchMode; label: string }[] = [
  { value: "name", label: "Marketing name" },
  { value: "model", label: "Model number" },
];
const SEARCH_MODE_KEY = "zonespec.searchMode";

function ModelPicker(props: {
  item: DragItem;
  palette: Palette;
  system: SystemKey;
  hasOdu: boolean;
  compatible?: number[];
  showLegacy: boolean;
  refrigerant: RefrigerantFilter;
  onToggleLegacy: (v: boolean) => void;
  onPickOdu: (o: PaletteOdu) => void;
  onPickIdu: (i: PaletteIdu) => void;
  checking?: boolean;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<SearchMode>(() => {
    try {
      return localStorage.getItem(SEARCH_MODE_KEY) === "model" ? "model" : "name";
    } catch {
      return "name";
    }
  });
  const chooseMode = (m: SearchMode) => {
    setMode(m);
    try {
      localStorage.setItem(SEARCH_MODE_KEY, m);
    } catch {}
  };
  const query = q.trim().toUpperCase();
  const title = props.item.kind === "odu" ? `${FAMILY_LABEL[props.item.system]} outdoor units${props.refrigerant ? ` · ${props.refrigerant}` : ""}` : props.item.typeName;

  const rows = useMemo(() => {
    // Model mode ignores dashes and spaces ("msz fs12" finds MSZ-FS12NA); name mode needs every word somewhere in the name.
    const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const words = query.split(/\s+/).filter(Boolean);
    const match = (m: string, n: string) => {
      if (!query) return true;
      if (mode === "model") return alnum(m).includes(alnum(query));
      const name = n.toUpperCase();
      return words.every((w) => name.includes(w));
    };
    if (props.item.kind === "odu") {
      const family = props.item.system;
      return props.palette.odus
        .filter((o) => o.system === family && (!props.refrigerant || o.refrigerant === props.refrigerant) && (props.showLegacy || !o.legacy) && match(o.model, o.name))
        .sort((a, b) => a.coolingBtu - b.coolingBtu || a.model.localeCompare(b.model))
        .map((o) => ({ key: `o${o.id}`, model: o.model, name: o.name, detail: `${kbtu(o.coolingBtu)} BTU · ${o.refrigerant}${o.legacy ? " · legacy" : ""}`, limit: iduLimit(o), pick: () => props.onPickOdu(o) }));
    }
    const type = props.item.typeName;
    return iduCandidates(props.palette, props.system, props.hasOdu, props.compatible, props.showLegacy)
      .filter((i) => i.typeName === type && match(i.model, i.name))
      .sort((a, b) => a.coolingBtu - b.coolingBtu || a.model.localeCompare(b.model))
      .map((i) => ({ key: `i${i.id}`, model: i.model, name: i.name, detail: `${kbtu(i.coolingBtu)} BTU · ${i.refrigerant}${i.legacy ? " · legacy" : ""}`, limit: undefined as string | undefined, pick: () => props.onPickIdu(i) }));
  }, [props, query, mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    <div className="picker-backdrop fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={props.onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Choose ${title}`}
        onClick={(e) => e.stopPropagation()}
        className="picker-sheet flex max-h-[85dvh] w-full flex-col rounded-t-lg bg-[var(--panel)] shadow-xl sm:max-w-lg sm:rounded-lg"
      >
        <div className="flex items-center gap-3 border-b border-[var(--line)] p-3">
          <div className="w-20 shrink-0">
            <UnitIcon src={iconFor(props.item)} label={title} size="h-12" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="picker-title font-semibold">{title}</div>
            <div className="text-[11px] text-[var(--muted)]">
              {rows.length} model{rows.length === 1 ? "" : "s"}
              {props.item.kind === "idu" && props.hasOdu ? " compatible with this outdoor unit" : ""}
            </div>
          </div>
          <button onClick={props.onClose} className="picker-close px-2 text-[var(--muted)] hover:text-[var(--fg)]" aria-label="Close">
            ✕
          </button>
        </div>
        <div className="space-y-1.5 border-b border-[var(--line)] p-3">
          <div role="tablist" aria-label="Find by" className="flex rounded border border-[var(--line)] p-0.5 text-[12px]">
            {SEARCH_MODES.map((m) => (
              <button
                key={m.value}
                role="tab"
                aria-selected={mode === m.value}
                onClick={() => chooseMode(m.value)}
                className={`flex-1 rounded px-2 py-1 ${mode === m.value ? "bg-[var(--accent)] text-white" : "text-[var(--muted)] hover:text-[var(--fg)]"}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <input
            // Desktop only: on phones, focusing would pop the keyboard over the list before anyone asked to search.
            autoFocus={finePointer()}
            type="search"
            enterKeyHint="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={mode === "model" ? "e.g. MSZ-FS12 or MXZ-3C24" : "e.g. 1.5-ton wall, hyper heat, cassette"}
            className={`w-full rounded border border-[var(--line)] bg-[var(--field)] px-2 py-1.5 ${mode === "model" ? "font-mono uppercase" : ""}`}
          />
          <label className="flex items-center gap-1.5 text-[12px] text-[var(--muted)]">
            <input type="checkbox" checked={props.showLegacy} onChange={(e) => props.onToggleLegacy(e.target.checked)} />
            Include legacy (discontinued) models
          </label>
        </div>
        <ul className="min-h-0 flex-1 overflow-auto">
          {rows.map((r) => (
            <li key={r.key}>
              <button onClick={r.pick} disabled={props.checking} className="picker-row flex w-full disabled:cursor-wait disabled:opacity-60 items-center gap-3 border-b border-[var(--line-soft)] px-3 py-2 text-left hover:bg-[var(--hover)]">
                {mode === "model" ? (
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-[13px] font-semibold">{r.model}</span>
                    <span className="block truncate text-[11px] text-[var(--muted)]">{r.name}</span>
                    {r.limit && <span className="block text-[11px] text-[var(--accent)]">{r.limit}</span>}
                  </span>
                ) : (
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold">{r.name || r.model}</span>
                    <span className="block font-mono text-[11px] text-[var(--muted)]">{r.model}</span>
                    {r.limit && <span className="block text-[11px] text-[var(--accent)]">{r.limit}</span>}
                  </span>
                )}
                <span className="shrink-0 text-[11px] text-[var(--muted)]">{r.detail}</span>
              </button>
            </li>
          ))}
          {!rows.length && <Empty>No models match.</Empty>}
        </ul>
      </div>
    </div>
  );
}

/** "+ Add" from the canvas: choose an outdoor family or an indoor unit type, then the model picker opens. */
function TypeChooser(props: {
  kind: "odu" | "idu";
  palette: Palette;
  system: SystemKey;
  hasOdu: boolean;
  compatible?: number[];
  showLegacy: boolean;
  refrigerant: RefrigerantFilter;
  onRefrigerant: (r: RefrigerantFilter) => void;
  port?: string;
  onPick: (item: DragItem) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  const odu = props.kind === "odu";
  const items: { item: DragItem; label: string; count: number }[] = odu
    ? familyCounts(props.palette, props.showLegacy, props.refrigerant).map(([system, count]) => ({ item: { kind: "odu", system }, label: FAMILY_LABEL[system], count }))
    : iduTypeCounts(props.palette, props.system, props.hasOdu, props.compatible, props.showLegacy).map(([typeName, count]) => ({ item: { kind: "idu", typeName }, label: typeName, count }));
  const title = odu ? "Add an outdoor unit" : props.port ? `Add an indoor unit on port ${props.port}` : "Add an indoor unit";
  return (
    <div className="picker-backdrop fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center" onClick={props.onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} className="picker-sheet flex max-h-[85dvh] w-full flex-col rounded-t-lg bg-[var(--panel)] shadow-xl sm:max-w-lg sm:rounded-lg">
        <div className="flex items-center gap-3 border-b border-[var(--line)] p-3">
          <div className="min-w-0 flex-1">
            <div className="picker-title font-semibold">{title}</div>
            <div className="text-[11px] text-[var(--muted)]">{odu ? "Choose a family, then a model." : "Only types that work with this outdoor unit are shown."}</div>
          </div>
          <button onClick={props.onClose} className="picker-close px-2 text-[var(--muted)] hover:text-[var(--fg)]" aria-label="Close">✕</button>
        </div>
        {odu && (
          <div className="flex gap-1 border-b border-[var(--line)] p-3" role="radiogroup" aria-label="Refrigerant">
            {REFRIGERANTS.map((r) => (
              <button key={r.label} role="radio" aria-checked={props.refrigerant === r.value} onClick={() => props.onRefrigerant(r.value)} className={`flex-1 rounded border px-2 py-2 text-[13px] ${props.refrigerant === r.value ? "border-[var(--accent)] bg-[var(--sel)] text-[var(--sel-fg)]" : "border-[var(--line)] bg-[var(--field)] hover:border-[var(--accent)]"}`}>
                {r.label}
              </button>
            ))}
          </div>
        )}
        <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-2 overflow-auto p-3">
          {items.map(({ item, label, count }) => (
            <button key={label} onClick={() => props.onPick(item)} className="equipment-tile flex flex-col items-center rounded border border-[var(--line)] bg-[var(--field)] p-3 text-center hover:border-[var(--accent)]">
              <UnitIcon src={iconFor(item)} label={label} size="h-16" />
              <span className="mt-1 text-[13px] font-semibold leading-tight">{label}</span>
              <span className="text-[11px] text-[var(--muted)]">{count} models</span>
            </button>
          ))}
          {!items.length && <Empty>{odu ? "No outdoor units match this filter." : "No indoor units match this outdoor unit."}</Empty>}
        </div>
      </div>
    </div>
  );
}

const finePointer = () => typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;

/** Multi-zone outdoor units: how many indoor units they take, shown in the picker before anything is placed. */
function iduLimit(o: PaletteOdu): string | undefined {
  if (o.system !== "MXZ" && o.system !== "MXZSM") return undefined;
  const range = o.minIdus > 1 && o.minIdus < o.maxIdus ? `${o.minIdus}–${o.maxIdus}` : `Up to ${o.maxIdus}`;
  const reduced = o.maxIdusReduced && o.maxIdusReduced < o.maxIdus ? ` (${o.maxIdusReduced} with a PLA cassette or cased coil)` : "";
  return `${range} indoor units${reduced}`;
}

function BlockedDialog(props: { model: string; errors: string[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => (e.key === "Escape" || e.key === "Enter") && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={props.onClose}>
      <div role="alertdialog" aria-labelledby="blocked-title" onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-lg border-2 border-[var(--bad)] bg-[var(--panel)] p-4 shadow-xl">
        <div id="blocked-title" className="font-semibold text-[var(--bad)]">
          Can&apos;t add <span className="font-mono">{props.model}</span>
        </div>
        <p className="mt-1 text-[12px] text-[var(--muted)]">Adding it would cause {props.errors.length === 1 ? "this error" : "these errors"}:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px]">
          {props.errors.map((m, n) => (
            <li key={n}>{m}</li>
          ))}
        </ul>
        <div className="mt-4 text-right">
          <button autoFocus onClick={props.onClose} className="rounded bg-[var(--accent)] px-3 py-1.5 text-[13px] text-white">
            OK, pick another
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- canvas ---------- */

function Canvas(props: {
  system: SystemDesign;
  odu?: PaletteOdu;
  iduById: Map<number, PaletteIdu>;
  evaluation?: Evaluation;
  selection: Selection;
  dragging: DragItem | null;
  onSelect: (target: string) => void;
  onRemoveOdu: () => void;
  onRemoveIdu: (key: string) => void;
  onPatch: (patch: Partial<SystemDesign>) => void;
  onPatchIdu: (key: string, patch: Partial<IduPlacement>) => void;
  onAddOdu: () => void;
  onAddIdu: (target?: { box: number; port: string }) => void;
  /** Why no further indoor unit fits (from a trial add), or null when one does. */
  addBlocked?: string | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "canvas" });
  const singleZone = props.system.system === "MandS" || props.system.system === "P";
  // Line lengths typed on the canvas: each indoor unit's own line (from its branch box or the outdoor unit), except single zone.
  const iduLines = !!props.odu && !singleZone;
  const issuesFor = (target: string) => props.evaluation?.issues.filter((i) => i.target === target) ?? [];
  const sel = props.selection?.systemId === props.system.id ? props.selection.target : null;
  const summary = props.evaluation?.summary;
  const piping = props.evaluation?.oduId === props.odu?.id ? props.evaluation?.piping ?? [] : [];
  const pipeToIdu = (key: string) => piping.find((run) => run.target === key);
  const mainPipe = piping.find((run) => !run.target);
  // Ignore a stale layout that mentions units no longer on the canvas.
  const keys = new Set(props.system.idus.map((p) => p.key));
  const fresh = props.evaluation?.layout;
  const layout = fresh && fresh.boxes.every((b) => b.iduKeys.every((k) => keys.has(k))) ? fresh : undefined;

  // Branch box rows get one slot per port (A, B, C…): units sit on their assigned port, unused ports show empty.
  const cappedOn = (box: number) => props.system.cappedPorts?.[String(box)] ?? [];
  const toggleCap = (box: number, port: string) => {
    const now = cappedOn(box);
    const next = now.includes(port) ? now.filter((x) => x !== port) : [...now, port].sort();
    props.onPatch({ cappedPorts: { ...props.system.cappedPorts, [String(box)]: next } });
  };
  const portSlots = (rowKeys: string[], ports: number, box: number) => {
    const letters = "ABCDEFGH".slice(0, ports).split("");
    const capped = cappedOn(box);
    const byPort = new Map<string, string>();
    const loose: string[] = [];
    for (const key of rowKeys) {
      const port = props.evaluation?.assignments?.[key]?.port;
      if (port && letters.includes(port) && !byPort.has(port)) byPort.set(port, key);
      else loose.push(key);
    }
    const slots = letters.map((port) => ({ port, key: byPort.get(port) ?? (loose.length && !capped.includes(port) ? loose.shift() : undefined) }));
    // More units than ports: show the extras after the last port so nothing disappears.
    return [...slots, ...loose.map((key) => ({ port: undefined, key }))];
  };

  const atMax = !!props.odu && props.system.idus.length >= (props.odu.maxIdus || 1);
  const full = atMax || !!props.addBlocked;
  const fullTitle = atMax ? "Max indoor units" : /port/i.test(props.addBlocked ?? "") ? "No open ports" : /capacity|btu|combination/i.test(props.addBlocked ?? "") ? "Max capacity reached" : "Can't add another indoor unit";
  const fullDetail = atMax ? `${props.system.idus.length} of ${props.odu?.maxIdus} indoor units on this outdoor unit` : props.addBlocked;

  // An open, uncapped branch-box port already offers "+ Add here", so the bottom "+ Add indoor unit" would be a second way to do the same thing.
  const hasOpenPort = !!layout?.boxes.some((b, i) => portSlots(b.iduKeys, b.ports, i).some((slot) => slot.port && !slot.key && !cappedOn(i).includes(slot.port)));

  // A plain function, not a component: defined inside Canvas, a component would remount (and drop input focus) on every render.
  const iduRow = (rowKeys: string[], ports?: number, box = 0) => {
    const slots = (ports ? portSlots(rowKeys, ports, box) : rowKeys.map((key) => ({ port: undefined as string | undefined, key }))).filter(
      ({ port, key }) => port || props.system.idus.some((x) => x.key === key),
    );
    return (
    <div className="idu-row relative flex flex-wrap justify-center gap-x-4 gap-y-6 pt-6">
      {slots.map(({ port, key }, i) => {
        const p = key ? props.system.idus.find((x) => x.key === key) : undefined;
        const bus = <PipeBus index={i} count={slots.length} halfGap={8} />;
        if (!p) {
          if (!port) return null;
          const capped = cappedOn(box).includes(port);
          return (
            <div key={`open-${port}`} className="idu-branch is-open relative flex flex-col items-center">
              {bus}
              <div className="pipe-drop absolute -top-6 h-6 w-0.5 bg-[var(--line)]" />
              <div className="idu-head flex flex-col items-center">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">Port {port}</div>
                {iduLines && <div aria-hidden="true" className="pipe-v h-14 w-0.5 shrink-0 bg-[var(--line)]" />}
              </div>
              <div className={`flex h-24 w-48 flex-col items-center justify-center gap-1.5 rounded border-2 text-[11px] text-[var(--muted)] ${capped ? "border-solid border-[var(--line)] bg-[var(--hover)]" : "border-dashed border-[var(--line)]"}`}>
                {capped && <img src={U("port-caps")} alt="Brass liquid and gas port caps" className="no-callout pointer-events-none h-12 w-20 object-contain" draggable={false} />}
                <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--fg)]" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={capped} onChange={() => toggleCap(box, port)} />
                  Cap
                </label>
                <span>{capped ? "Capped · not used" : "Open"}</span>
                {!capped && !full && (
                  <button className="add-here-button" onClick={(e) => { e.stopPropagation(); props.onAddIdu({ box, port }); }}>+ Add here</button>
                )}
              </div>
            </div>
          );
        }
        const idu = props.iduById.get(p.iduId);
        return (
          <div key={p.key ?? i} className="idu-branch relative flex flex-col items-center">
            {bus}
            <div className="pipe-drop absolute -top-6 h-6 w-0.5 bg-[var(--pipe)]" />
            {(ports || iduLines) && <div className="idu-head flex flex-col items-center">
            {ports && <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${port ? "text-[var(--pipe)]" : "text-[var(--bad)]"}`}>{port ? `Port ${port}` : "No port"}</div>}
            {iduLines && (
              <div className="idu-line flex h-14 shrink-0 flex-col items-center justify-end">
                <div aria-hidden="true" className="pipe-v w-0.5 flex-1 bg-[var(--pipe)]" />
                <LineLength
                  label={`Line to ${p.room}`}
                  pipe={pipeToIdu(p.key)}
                  value={p.pipeLengthFt}
                  onChange={(v) => props.onPatchIdu(p.key, { pipeLengthFt: v })}
                />
                <div className="pipe-v h-2 w-0.5 shrink-0 bg-[var(--pipe)]" />
              </div>
            )}
            </div>}
            <UnitCard
              kind="IDU"
              icon={idu ? IDU_ICONS[idu.typeName] : undefined}
              model={idu?.model ?? `#${p.iduId}`}
              line1={p.room}
              line2={idu ? `${kbtu(idu.coolingBtu)} · ${idu.typeName}` : ""}
              selected={sel === p.key}
              issues={issuesFor(p.key)}
              onClick={() => props.onSelect(p.key)}
              onRemove={() => props.onRemoveIdu(p.key)}
              footer={[p.controller, p.wifiAdapter].filter(Boolean).join(" + ") || undefined}
            />
          </div>
        );
      })}
    </div>
    );
  };

  return (
    <div
      ref={setNodeRef}
      className={`canvas-grid relative min-h-[360px] flex-1 overflow-auto p-6 ${isOver ? "outline outline-2 -outline-offset-4 outline-[var(--accent)]" : ""}`}
    >
      {!props.odu ? (
        <div className="canvas-empty mx-auto my-8 max-w-sm p-8 text-center">
          <div className="empty-symbol mx-auto mb-6" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><rect x="5" y="6" width="22" height="18" rx="3" stroke="currentColor"/><circle cx="15" cy="15" r="5" stroke="currentColor"/><path d="M24 11h-3m3 4h-3M9 24v3m14-3v3" stroke="currentColor" strokeLinecap="round"/></svg></div>
          <div className="mb-3 text-[10px] uppercase tracking-[0.22em] text-[var(--muted)]">Your canvas is ready</div>
          <h1 className="text-[24px] font-medium tracking-tight text-[var(--fg)]">Great systems start here.</h1>
          <p className="mt-3 text-[12px] leading-relaxed text-[var(--muted)]">Choose an outdoor unit from the library, then build your system around it.</p>
          <button className="add-unit-button mx-auto mt-6" onClick={props.onAddOdu}><span aria-hidden="true">+</span> Add outdoor unit</button>
          <div className="empty-hint hint-mouse mt-4 text-[11px] text-[var(--muted)]">or drag one in from the library</div>
        </div>
      ) : (
        <div className="canvas-tree flex flex-col items-center">
          <UnitCard
            kind="ODU"
            icon={oduIcon(props.odu)}
            model={props.odu.model}
            line1={props.odu.name}
            line2={`${kbtu(props.odu.coolingBtu)} BTU cool · ${props.odu.refrigerant}`}
            selected={sel === "odu"}
            issues={issuesFor("odu")}
            onClick={() => props.onSelect("odu")}
            onRemove={props.onRemoveOdu}
          />
          {summary && props.system.idus.length > 0 && (
            <div className="mt-1 text-[11px] text-[var(--muted)]">
              Connected {kbtu(summary.connectedBtu)} / {kbtu(summary.oduBtu)} BTU
              {summary.connectedPct != null && ` (${Math.round(summary.connectedPct)}%)`}
            </div>
          )}
          {/* piping */}
          <div className="trunk-v h-3 w-0.5 bg-[var(--pipe)]" />
          {singleZone && props.system.idus.length > 0 && (
            <LineLength label="Line set, outdoor to indoor unit" pipe={pipeToIdu(props.system.idus[0].key)} value={props.system.totalPipeFt} onChange={(v) => props.onPatch({ totalPipeFt: v })} />
          )}
          {props.odu.branchBox && props.system.idus.length > 0 && (
            <LineLength
              label={(layout?.boxes.length ?? 0) > 1 ? "Main line, outdoor unit to joint" : "Main line, outdoor unit to branch box"}
              pipe={mainPipe}
              value={props.system.mainLineFt}
              onChange={(v) => props.onPatch({ mainLineFt: v })}
            />
          )}
          <div className="trunk-v h-3 w-0.5 bg-[var(--pipe)]" />
          {props.system.idus.length > 0 &&
            (layout?.boxes.length ? (
              <div className="box-row relative flex flex-wrap justify-center gap-x-8 gap-y-8 pt-6">
                {layout.boxes.map((b, i) => (
                  <div key={i} className="box-branch relative flex flex-col items-center">
                    <PipeBus index={i} count={layout.boxes.length} halfGap={16} />
                    <div className="pipe-drop absolute -top-6 h-6 w-0.5 bg-[var(--pipe)]" />
                    {layout.boxes.length > 1 && (
                      <div className="idu-head flex flex-col items-center">
                        <LineLength
                          label={`Joint to branch box ${i + 1}`}
                          pipe={piping.filter((run) => !run.target)[i + 1]}
                          value={props.system.jointToBoxFt?.[i]}
                          onChange={(v) => props.onPatch({ jointToBoxFt: layout.boxes.map((__, j) => (j === i ? (v as number) : (props.system.jointToBoxFt?.[j] as number))) })}
                        />
                        <div className="pipe-v h-2 w-0.5 bg-[var(--pipe)]" />
                      </div>
                    )}
                    <div className="w-36 rounded border-2 border-[var(--pipe)] bg-[var(--panel)] px-3 py-1 text-center">
                      <img src={branchBoxIcon(b.ports)} alt="" style={{ width: iconWidth(branchBoxIcon(b.ports)) }} className="no-callout pointer-events-none mx-auto my-1" draggable={false} />
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--pipe)]">Branch box {i + 1}</div>
                      <div className="font-mono text-[12px] font-semibold">{b.model}</div>
                      <div className="text-[10px] text-[var(--muted)]">{b.iduKeys.length} / {b.ports} ports</div>
                    </div>
                    <div className="trunk-v h-6 w-0.5 bg-[var(--pipe)]" />
                    {iduRow(b.iduKeys, b.ports, i)}
                  </div>
                ))}
              </div>
            ) : (
              iduRow(props.system.idus.map((p) => p.key))
            ))}
          {hasOpenPort && !full ? null : full || (singleZone && props.system.idus.length > 0) ? (
            <div className="drop-hint system-full mt-6 rounded border-2 border-dashed border-[var(--line)] px-6 py-4 text-center text-[var(--muted)]">
              {singleZone ? "Single zone: one indoor unit" : (
                <>
                  <span className="block text-[15px] font-semibold text-[var(--fg)]">{fullTitle}</span>
                  {fullDetail && <span className="mt-0.5 block text-[11px]">{fullDetail}</span>}
                </>
              )}
            </div>
          ) : (
            <button
              className={`drop-hint add-idu-slot mt-6 rounded border-2 border-dashed px-6 py-4 text-center ${props.dragging?.kind === "idu" ? "border-[var(--accent)] text-[var(--accent)]" : "border-[var(--line)] text-[var(--fg)]"}`}
              onClick={() => props.onAddIdu()}
            >
              <span className="text-[15px] font-semibold"><span aria-hidden="true">+</span> Add indoor unit</span>
              <span className="hint-mouse mt-0.5 block text-[11px] text-[var(--muted)]">or drag one in from the library</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** This child's piece of the horizontal header pipe over a row: it reaches across half the gap to each neighbour,
 *  so the header runs exactly from the first drop to the last, with no stubs past the ends. */
function PipeBus({ index, count, halfGap }: { index: number; count: number; halfGap: number }) {
  if (count < 2) return null;
  const first = index === 0;
  const last = index === count - 1;
  return (
    <div
      className="pipe-bus absolute -top-6 h-0.5 bg-[var(--pipe)]"
      style={{ left: first ? "calc(50% - 1px)" : -halfGap, right: last ? "calc(50% - 1px)" : -halfGap }}
    />
  );
}

/** A line length typed straight onto a pipe on the canvas, in feet. */
function LineLength({ label, pipe, value, onChange }: { label: string; pipe?: PipeRun; value?: number; onChange: (v?: number) => void }) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="line-length relative z-10 flex shrink-0 flex-col items-center text-[11px]"
    >
      {pipe && (
        <>
          <span title={`${fraction(pipe.liquidIn)} liquid × ${fraction(pipe.gasIn)} gas`} className="line-size flex h-5 items-center whitespace-nowrap rounded border border-[var(--pipe)] bg-[var(--panel)] px-2 font-mono text-[10px] text-[var(--pipe)]">
            {fraction(pipe.liquidIn)} L × {fraction(pipe.gasIn)} G
          </span>
          <span aria-hidden="true" className="h-1 w-0.5 bg-[var(--pipe)]" />
        </>
      )}
      <label title={`${label} (ft)`} className={`line-feet flex h-6 items-center gap-0.5 rounded border bg-[var(--panel)] px-1 ${value == null ? "border-dashed border-[var(--line)]" : "border-[var(--pipe)]"}`}>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        aria-label={`${label} (ft)`}
        placeholder="—"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className="w-10 bg-transparent text-right font-mono outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <span className="text-[var(--muted)]">ft</span>
      </label>
    </div>
  );
}

function UnitCard(props: {
  kind: "ODU" | "IDU";
  icon?: string;
  model: string;
  line1: string;
  line2: string;
  selected: boolean;
  issues: { severity: string }[];
  onClick: () => void;
  onRemove: () => void;
  footer?: string;
}) {
  const hasError = props.issues.some((i) => i.severity === "error");
  const hasWarn = props.issues.some((i) => i.severity === "warning");
  const border = hasError ? "border-[var(--bad)]" : hasWarn ? "border-[var(--warn)]" : props.selected ? "border-[var(--accent)]" : "border-[var(--line)]";
  return (
    <div
      onClick={props.onClick}
      className={`unit-card group relative w-48 cursor-pointer rounded border bg-[var(--panel)] shadow-sm ${border} ${props.selected ? "ring-2 ring-[var(--accent)]/40" : ""}`}
    >
      <div className={`unit-card-heading flex items-center justify-between px-3 py-2 text-[10px] font-semibold uppercase tracking-widest ${props.kind === "ODU" ? "text-[var(--odu)]" : "text-[var(--idu)]"}`}>
        <span>{props.kind === "ODU" ? "Outdoor" : "Indoor"}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            props.onRemove();
          }}
          className="opacity-70 hover:opacity-100"
          aria-label="Remove"
        >
          ✕
        </button>
      </div>
      <div className="px-2 py-1.5">
        {props.icon && <img src={props.icon} alt="" style={{ width: iconWidth(props.icon) }} className="no-callout pointer-events-none mx-auto mb-1 max-w-full" draggable={false} />}
        <div className="truncate font-mono text-[12px] font-semibold">{props.model}</div>
        <div className="truncate text-[11px]">{props.line1}</div>
        <div className="truncate text-[11px] text-[var(--muted)]">{props.line2}</div>
        {props.footer && <div className="mt-1 truncate border-t border-[var(--line-soft)] pt-1 font-mono text-[10px] text-[var(--muted)]">⌁ {props.footer}</div>}
      </div>
      {(hasError || hasWarn) && (
        <span className={`absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-white ${hasError ? "bg-[var(--bad)]" : "bg-[var(--warn)]"}`}>!</span>
      )}
    </div>
  );
}

/* ---------- properties ---------- */

function Properties(props: {
  system: SystemDesign;
  odu?: PaletteOdu;
  iduById: Map<number, PaletteIdu>;
  evaluation?: Evaluation;
  selection: string | null;
  onChange: (fn: (s: SystemDesign) => SystemDesign) => void;
  settings: ProjectSettings;
  onSettings: (s: ProjectSettings) => void;
}) {
  const { system, selection, odu, evaluation } = props;
  const branchBox = !!odu?.branchBox;
  const boxes = evaluation?.layout?.boxes ?? [];
  const setSys = (patch: Partial<SystemDesign>) => props.onChange((s) => ({ ...s, ...patch }));

  if (!selection || selection === "odu") {
    const specs = evaluation?.specs;
    const eff = specs?.efficiency;
    return (
      <div className="space-y-3 p-3">
        <Section title="System">
          <Prop label="Type">{odu ? SYSTEM_LABEL[system.system] : "—"}</Prop>
          <Prop label="Outdoor unit">{odu?.model ?? "—"}</Prop>
          {odu && <Prop label="Description">{odu.name}</Prop>}
          {odu && <Prop label="Capacity">{`${odu.coolingBtu.toLocaleString()} cool / ${odu.heatingBtu.toLocaleString()} heat BTU/h`}</Prop>}
          {odu && <Prop label="Refrigerant">{odu.refrigerant}</Prop>}
          <Prop label="Indoor units">{system.idus.length}</Prop>
        </Section>
        {odu && specs && (
          <Section title="Electrical & documents">
            {specs.odu.power && <Prop label="Power">{specs.odu.power}</Prop>}
            {specs.odu.mca && <Prop label="MCA">{`${specs.odu.mca} A`}</Prop>}
            {specs.odu.mocp && <Prop label="MOCP">{`${specs.odu.mocp} A`}</Prop>}
            <DocLinks specs={specs.odu} />
          </Section>
        )}
        {eff && (
          <Section title="Efficiency">
            {eff.seer2 && <Prop label="SEER2">{eff.seer2}</Prop>}
            {eff.eer2 && <Prop label="EER2">{eff.eer2}</Prop>}
            {eff.hspf2 && <Prop label="HSPF2">{eff.hspf2}</Prop>}
            {eff.hspf2Region5 && <Prop label="HSPF2 (V)">{eff.hspf2Region5}</Prop>}
            <p className="text-[11px] text-[var(--muted)]">From {eff.basis}. Confirm the AHRI certificate for rebates.</p>
          </Section>
        )}
        {odu && <PipingSettings system={system} odu={odu} evaluation={evaluation} iduById={props.iduById} onChange={props.onChange} />}
        {odu && branchBox && (
          <BranchBoxSettings system={system} boxes={boxes} r454b={odu.refrigerant === "R454B"} boxMinAreaSqFt={evaluation?.a2l?.boxMinAreaSqFt} onChange={setSys} />
        )}
        {odu && <CapacityBlock capacity={evaluation?.capacity} settings={props.settings} onSettings={props.onSettings} />}
        {evaluation?.charge && (
          <Section title="Refrigerant charge (estimate)">
            <Prop label="Additional">{`${evaluation.charge.additionalOz.toFixed(1)} oz`}</Prop>
            {evaluation.charge.totalKg != null && <Prop label="System total">{`${evaluation.charge.totalKg.toFixed(2)} kg (${(evaluation.charge.totalKg * 2.20462).toFixed(1)} lb)`}</Prop>}
            {evaluation.charge.maxKg != null && <Prop label="Maximum">{`${evaluation.charge.maxKg.toFixed(2)} kg`}</Prop>}
            {evaluation.charge.note && <p className="text-[11px] text-[var(--muted)]">{evaluation.charge.note}. Verify against the install manual.</p>}
          </Section>
        )}
        {odu && (
          <Section title="M-NET & central control">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!!system.mnet || (!!system.centralController && system.centralController !== "RMD-50A")} disabled={!!system.centralController && system.centralController !== "RMD-50A"} onChange={(e) => setSys({ mnet: e.target.checked })} />
              M-NET wiring
            </label>
            <label className="block">
              <span className="text-[11px] text-[var(--muted)]">Central controller</span>
              <select value={system.centralController ?? ""} onChange={(e) => setSys({ centralController: e.target.value || undefined })} className="mt-0.5 w-full rounded border border-[var(--line)] bg-[var(--field)] px-2 py-1">
                <option value="">None</option>
                {(evaluation?.centralControllers ?? []).map((c) => (
                  <option key={c.model} value={c.model}>
                    {c.model} · {c.name}
                  </option>
                ))}
              </select>
            </label>
          </Section>
        )}
        {odu && <AccessoryPicker options={evaluation?.accessoryOptions.odu ?? []} chosen={system.oduAccessories} onChange={(next) => setSys({ oduAccessories: next })} />}
        <StatusBlock evaluation={evaluation} />
      </div>
    );
  }

  const placement = system.idus.find((i) => i.key === selection);
  if (!placement) return <Empty>Select a unit on the canvas.</Empty>;
  const idu = props.iduById.get(placement.iduId);
  const set = (patch: Partial<IduPlacement>) =>
    props.onChange((s) => ({ ...s, idus: s.idus.map((i) => (i.key === placement.key ? { ...i, ...patch } : i)) }));
  const options = evaluation?.controllers[placement.key] ?? [];
  const controllers = options.filter((o) => o.kind === "controller");
  const wifi = options.filter((o) => o.kind === "wifi");
  const assigned = evaluation?.assignments?.[placement.key];
  const portCount = branchBox ? (boxes[placement.box ?? assigned?.box ?? 0]?.ports ?? 5) : (odu?.maxIdus ?? 0);
  const uSpecs = evaluation?.specs?.idus[placement.key];
  const a2l = evaluation?.a2l?.units[placement.key];
  const minNote = (v?: number, unit = "ft") => (v ? ` (min ${v} ${unit})` : "");

  return (
    <div className="space-y-3 p-3">
      <Section title="Indoor unit">
        <label className="block">
          <span className="text-[11px] text-[var(--muted)]">Room</span>
          <input value={placement.room} onChange={(e) => set({ room: e.target.value })} className="mt-0.5 w-full rounded border border-[var(--line)] bg-[var(--field)] px-2 py-1" />
        </label>
        <Prop label="Model">{idu?.model}</Prop>
        <Prop label="Description">{idu?.name}</Prop>
        <Prop label="Type">{idu?.typeName}</Prop>
        {idu && <Prop label="Capacity">{`${idu.coolingBtu.toLocaleString()} cool / ${idu.heatingBtu.toLocaleString()} heat BTU/h (${tons(idu.coolingBtu)})`}</Prop>}
        <Prop label="Refrigerant">{idu?.refrigerant}</Prop>
        {uSpecs?.power && <Prop label="Power">{uSpecs.power}</Prop>}
        {uSpecs?.mca && <Prop label="MCA">{`${uSpecs.mca} A`}</Prop>}
        {uSpecs && <DocLinks specs={uSpecs} />}
        {evaluation?.capacity && (
          <Prop label="At design">
            {[
              evaluation.capacity.cooling && `${Math.round(evaluation.capacity.cooling.perIdu[placement.key] ?? 0).toLocaleString()} cool`,
              evaluation.capacity.heating && `${Math.round(evaluation.capacity.heating.perIdu[placement.key] ?? 0).toLocaleString()} heat`,
            ]
              .filter(Boolean)
              .join(" / ")}{" "}
            BTU/h
          </Prop>
        )}
      </Section>
      {odu && <PipingSettings system={system} odu={odu} evaluation={evaluation} iduById={props.iduById} onChange={props.onChange} />}
      <Section title="Install">
        {branchBox && (
          <label className="block">
            <span className="text-[11px] text-[var(--muted)]">Branch box</span>
            <select value={placement.box ?? ""} onChange={(e) => set({ box: e.target.value === "" ? undefined : Number(e.target.value), port: undefined })} className="mt-0.5 w-full rounded border border-[var(--line)] bg-[var(--field)] px-2 py-1">
              <option value="">Automatic{assigned?.box != null ? ` (box ${assigned.box + 1})` : ""}</option>
              {boxes.map((b, i) => (
                <option key={i} value={i}>
                  Box {i + 1} · {b.model}
                </option>
              ))}
            </select>
          </label>
        )}
        {(branchBox || system.system === "MXZ") && portCount > 1 && (
          <label className="block">
            <span className="text-[11px] text-[var(--muted)]">Port</span>
            <select value={placement.port ?? ""} onChange={(e) => set({ port: e.target.value || undefined })} className="mt-0.5 w-full rounded border border-[var(--line)] bg-[var(--field)] px-2 py-1">
              <option value="">Automatic{assigned?.port ? ` (${assigned.port})` : ""}</option>
              {[..."ABCDE"].slice(0, portCount).map((p) => (
                <option key={p} value={p}>
                  Port {p}
                </option>
              ))}
            </select>
          </label>
        )}
        <NumberField label="Height vs. outdoor unit (ft, + = above)" value={placement.heightFt} onChange={(v) => set({ heightFt: v })} allowNegative />
      </Section>
      {idu?.refrigerant === "R454B" && (
        <Section title="R454B safety">
          <NumberField label={`Mounting height above floor${minNote(a2l?.minMountingFt)}`} value={placement.installHeightFt} onChange={(v) => set({ installHeightFt: v })} />
          {a2l?.coil && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={!!placement.inConditionedSpace} onChange={(e) => set({ inConditionedSpace: e.target.checked })} />
              Installed inside the conditioned space
            </label>
          )}
          <NumberField
            label={`${a2l?.coil ? "Conditioned area it serves" : "Room floor area"} (sq ft)${minNote(a2l?.minAreaSqFt, "sq ft")}`}
            value={placement.floorAreaSqFt}
            onChange={(v) => set({ floorAreaSqFt: v })}
          />
          {a2l?.coil && !!a2l.minInstalledRoomSqFt && (
            <NumberField label={`Room it's installed in (sq ft)${minNote(a2l.minInstalledRoomSqFt, "sq ft")}`} value={placement.installedRoomSqFt} onChange={(v) => set({ installedRoomSqFt: v })} />
          )}
          {a2l?.ducted && (
            <>
              <NumberField label={`Lowest supply grille height (ft)${minNote(a2l.minGrilleFt)}`} value={placement.supplyGrilleFt} onChange={(v) => set({ supplyGrilleFt: v })} />
              <NumberField label={`Lowest return grille height (ft)${minNote(a2l.minGrilleFt)}`} value={placement.returnGrilleFt} onChange={(v) => set({ returnGrilleFt: v })} />
            </>
          )}
          {a2l?.case && <p className="text-[11px] text-[var(--muted)]">Installation case {a2l.case}.</p>}
          {evaluation?.a2l && (
            <p className="text-[11px] text-[var(--muted)]">
              Based on {evaluation.a2l.chargeKg.toFixed(2)} kg system charge{evaluation.a2l.chargeIsFactoryOnly ? " (factory charge; enter line lengths for the full charge)" : ""}.
            </p>
          )}
        </Section>
      )}
      <Section title="Controls">
        <ControllerSelect label="Controller" none="None (handheld remote, if included)" options={controllers} value={placement.controller} onChange={(v) => set({ controller: v })} />
        <ControllerSelect label="Wi-Fi / app adapter" none="None" options={wifi} value={placement.wifiAdapter} onChange={(v) => set({ wifiAdapter: v })} />
        {!options.length && <p className="text-[11px] text-[var(--muted)]">No controller options found for this unit.</p>}
      </Section>
      <AccessoryPicker options={evaluation?.accessoryOptions[placement.key] ?? []} chosen={placement.accessories} onChange={(next) => set({ accessories: next })} />
    </div>
  );
}

function PipingSettings({ system, odu, evaluation, iduById, onChange }: {
  system: SystemDesign;
  odu: PaletteOdu;
  evaluation?: Evaluation;
  iduById: Map<number, PaletteIdu>;
  onChange: (fn: (s: SystemDesign) => SystemDesign) => void;
}) {
  const singleZone = system.system === "MandS" || system.system === "P";
  const boxes = evaluation?.layout?.boxes ?? [];
  const runs = evaluation?.oduId === odu.id ? evaluation.piping ?? [] : [];
  const set = (patch: Partial<SystemDesign>) => onChange((current) => ({ ...current, ...patch }));
  const setIndoor = (key: string, patch: Partial<IduPlacement>) => onChange((current) => ({ ...current, idus: current.idus.map((unit) => unit.key === key ? { ...unit, ...patch } : unit) }));
  const size = (run?: PipeRun) => run && <p className="mb-2 font-mono text-[10px] text-[var(--pipe)]">{fraction(run.liquidIn)} liquid × {fraction(run.gasIn)} gas</p>;
  return (
    <Section title="Piping">
      <p className="pb-1 text-[11px] leading-relaxed text-[var(--muted)]">Enter the actual length of each run. These values also update the canvas and line-set takeoff.</p>
      {(singleZone || odu.branchBox) && (
        <fieldset className="pipe-run-group">
          <legend>{singleZone ? "Outdoor → indoor" : boxes.length > 1 ? "Outdoor → joint" : "Outdoor → branch box"}</legend>
          {size(singleZone ? runs[0] : runs.find((run) => !run.target))}
          <NumberField label={singleZone ? "Line-set length (ft)" : boxes.length > 1 ? "Main line, outdoor unit to joint (ft)" : "Main line, outdoor unit to branch box (ft)"} value={singleZone ? system.totalPipeFt : system.mainLineFt} onChange={(value) => set(singleZone ? { totalPipeFt: value } : { mainLineFt: value })} />
          <NumberField label={singleZone ? "Bends" : "Bends on the main line"} value={system.bends} onChange={(value) => set({ bends: value })} />
        </fieldset>
      )}
      {odu.branchBox && boxes.length > 1 && boxes.map((box, index) => (
        <fieldset key={`joint-${index}`} className="pipe-run-group">
          <legend>Joint → branch box {index + 1}</legend>
          <p className="mb-1 text-[10px] text-[var(--muted)]">{box.model}</p>
          {size(runs.filter((run) => !run.target)[index + 1])}
          <NumberField label={`Joint to branch box ${index + 1} (ft)`} value={system.jointToBoxFt?.[index]} onChange={(value) => onChange((current) => ({ ...current, jointToBoxFt: boxes.map((_, i) => (i === index ? value : current.jointToBoxFt?.[i]) as number) }))} />
        </fieldset>
      ))}
      {!singleZone && system.idus.map((placement, index) => {
        const run = runs.find((item) => item.target === placement.key);
        const assigned = evaluation?.assignments?.[placement.key];
        const source = odu.branchBox ? `Branch box ${(placement.box ?? assigned?.box ?? 0) + 1}` : "Outdoor unit";
        const port = placement.port ?? assigned?.port;
        const room = placement.room || `Room ${index + 1}`;
        return (
          <fieldset key={placement.key} className="pipe-run-group">
            <legend>{room}</legend>
            <p className="mb-1 text-[10px] text-[var(--muted)]">{source}{port ? ` · Port ${port}` : ""} → indoor</p>
            <p className="mb-2 break-words font-mono text-[10px] text-[var(--muted)]">{iduById.get(placement.iduId)?.model}</p>
            {size(run)}
            <NumberField label={`Line to ${room} (ft)`} value={placement.pipeLengthFt} onChange={(value) => setIndoor(placement.key, { pipeLengthFt: value })} />
            <NumberField label={`Bends to ${room}`} value={placement.bends} onChange={(value) => setIndoor(placement.key, { bends: value })} />
          </fieldset>
        );
      })}
      {!singleZone && !system.idus.length && <p className="text-[11px] text-[var(--muted)]">Add indoor units to enter each room’s line length.</p>}
    </Section>
  );
}

function CapacityBlock({ capacity, settings, onSettings }: { capacity?: CapacityResult; settings: ProjectSettings; onSettings: (s: ProjectSettings) => void }) {
  const c = { ...DEFAULT_CONDITIONS, ...settings.conditions };
  const set = (patch: Partial<DesignConditions>) => onSettings({ ...settings, conditions: { ...c, ...patch } });
  const row = (label: string, m?: ModeCapacity) =>
    m && (
      <div>
        <Prop label={label}>
          <span className="font-semibold">{Math.round(m.systemBtu).toLocaleString()} BTU/h</span>
        </Prop>
        <p className="text-[11px] text-[var(--muted)]">
          temp ×{m.factors.temperature.toFixed(2)} · piping ×{m.factors.piping.toFixed(2)}
          {m.factors.defrost != null ? ` · defrost ×${m.factors.defrost.toFixed(2)}` : ""}
          {m.factors.connection !== 1 ? ` · over-connection ×${m.factors.connection.toFixed(2)}` : ""}
          {m.factors.altitude !== 1 ? ` · altitude ×${m.factors.altitude.toFixed(2)}` : ""}
          {m.limitedByOdu ? " · limited by the outdoor unit" : ""}
        </p>
      </div>
    );
  return (
    <Section title="Capacity at design conditions">
      <div className="grid grid-cols-2 gap-x-2">
        <NumberField label="Cooling outdoor DB (°F)" value={c.coolOutdoorDbF} onChange={(v) => set({ coolOutdoorDbF: v ?? 95 })} allowNegative />
        <NumberField label="Heating outdoor WB (°F)" value={c.heatOutdoorWbF} onChange={(v) => set({ heatOutdoorWbF: v ?? 43 })} allowNegative />
        <NumberField label="Indoor cooling WB (°F)" value={c.coolIndoorWbF} onChange={(v) => set({ coolIndoorWbF: v ?? 67 })} />
        <NumberField label="Indoor heating DB (°F)" value={c.heatIndoorDbF} onChange={(v) => set({ heatIndoorDbF: v ?? 70 })} />
        <NumberField label="Altitude (ft)" value={c.altitudeFt} onChange={(v) => set({ altitudeFt: v ?? 0 })} />
      </div>
      <p className="text-[11px] text-[var(--muted)]">Heating uses outdoor wet bulb (about 1 °F below dry bulb in cold weather). These apply to the whole project.</p>
      {capacity ? (
        <>
          {row("Cooling", capacity.cooling)}
          {row("Heating", capacity.heating)}
          {capacity.notes.map((n) => (
            <p key={n} className="text-[11px] text-[var(--warn)]">
              {n}
            </p>
          ))}
        </>
      ) : (
        <p className="text-[11px] text-[var(--muted)]">Add indoor units to see corrected capacity.</p>
      )}
    </Section>
  );
}

function DocLinks({ specs }: { specs: { submittal?: string; catalogue?: string } }) {
  if (!specs.submittal && !specs.catalogue) return null;
  return (
    <div className="flex gap-3 text-[12px]">
      {specs.submittal && (
        <a href={specs.submittal} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">
          Submittal
        </a>
      )}
      {specs.catalogue && (
        <a href={specs.catalogue} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">
          Catalog
        </a>
      )}
    </div>
  );
}

function BranchBoxSettings({
  system,
  boxes,
  r454b,
  boxMinAreaSqFt,
  onChange,
}: {
  system: SystemDesign;
  boxes: NonNullable<Evaluation["layout"]>["boxes"];
  r454b: boolean;
  boxMinAreaSqFt?: number;
  onChange: (p: Partial<SystemDesign>) => void;
}) {
  const rooms = system.boxRooms ?? [];
  const setRoom = (i: number, patch: NonNullable<SystemDesign["boxRooms"]>[number]) =>
    onChange({ boxRooms: boxes.map((_, j) => (j === i ? { ...rooms[j], ...patch } : (rooms[j] ?? {}))) });
  const custom = system.boxPorts;
  const list = custom ?? boxes.map((b) => (b.ports === 3 ? 3 : 5) as 3 | 5);
  return (
    <Section title="Branch boxes">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={!!custom} onChange={(e) => onChange({ boxPorts: e.target.checked ? (list.length ? list : [5]) : undefined })} />
        Choose boxes myself
      </label>
      {custom && (
        <div className="space-y-1">
          {custom.map((ports, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-14 text-[12px]">Box {i + 1}</span>
              <select value={ports} onChange={(e) => onChange({ boxPorts: custom.map((p, j) => (j === i ? (Number(e.target.value) as 3 | 5) : p)) })} className="flex-1 rounded border border-[var(--line)] bg-[var(--field)] px-2 py-1">
                <option value={3}>3-port</option>
                <option value={5}>5-port</option>
              </select>
              {custom.length > 1 && (
                <button onClick={() => onChange({ boxPorts: custom.filter((_, j) => j !== i) })} className="px-1 text-[var(--muted)] hover:text-[var(--bad)]" aria-label={`Remove box ${i + 1}`}>
                  ✕
                </button>
              )}
            </div>
          ))}
          <button onClick={() => onChange({ boxPorts: [...custom, 3] })} className="text-[12px] text-[var(--accent)]">
            + Add box
          </button>
        </div>
      )}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={system.boxesPoweredByOdu ?? true} onChange={(e) => onChange({ boxesPoweredByOdu: e.target.checked })} />
        Boxes powered from the outdoor unit
      </label>
      {r454b &&
        boxes.map((_, i) => (
          <div key={i} className="space-y-1 rounded border border-[var(--line-soft)] p-2">
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={!!rooms[i]?.habitable} onChange={(e) => setRoom(i, { habitable: e.target.checked })} />
              Box {i + 1} is in a living space (not a utility area)
            </label>
            {rooms[i]?.habitable && (
              <>
                <NumberField label="Mounting height (ft, min 6)" value={rooms[i]?.mountingHeightFt} onChange={(v) => setRoom(i, { mountingHeightFt: v })} />
                <NumberField label={`Room floor area (sq ft${boxMinAreaSqFt ? `, min ${boxMinAreaSqFt}` : ""})`} value={rooms[i]?.floorAreaSqFt} onChange={(v) => setRoom(i, { floorAreaSqFt: v })} />
              </>
            )}
          </div>
        ))}
    </Section>
  );
}

function ControllerSelect(props: { label: string; none: string; options: Evaluation["controllers"][string]; value?: string; onChange: (v?: string) => void }) {
  const chosen = props.options.find((o) => o.model === props.value);
  return (
    <label className="block">
      <span className="text-[11px] text-[var(--muted)]">{props.label}</span>
      <select value={props.value ?? ""} onChange={(e) => props.onChange(e.target.value || undefined)} className="mt-0.5 w-full rounded border border-[var(--line)] bg-[var(--field)] px-2 py-1">
        <option value="">{props.none}</option>
        {props.value && !chosen && <option value={props.value}>{props.value} (not compatible)</option>}
        {props.options.map((o) => (
          <option key={o.model} value={o.model}>
            {o.model} · {o.name}
          </option>
        ))}
      </select>
      {chosen?.requires.length ? <span className="mt-0.5 block text-[11px] text-[var(--muted)]">Adds {chosen.requires.join(", ")} to the BOM.</span> : null}
    </label>
  );
}

function AccessoryPicker(props: { options: Evaluation["accessoryOptions"][string]; chosen?: Record<string, number>; onChange: (next: Record<string, number>) => void }) {
  const [open, setOpen] = useState(false);
  const required = props.options.filter((o) => o.required > 0);
  const optional = props.options.filter((o) => o.required === 0);
  const picked = Object.entries(props.chosen ?? {}).filter(([, q]) => q > 0);
  const setQty = (model: string, qty: number) => {
    const next = { ...(props.chosen ?? {}) };
    if (qty > 0) next[model] = qty;
    else delete next[model];
    props.onChange(next);
  };
  if (!props.options.length) return null;
  return (
    <Section title="Accessories">
      {required.map((o) => (
        <div key={o.model} className="flex items-start justify-between gap-2">
          <span>
            <span className="font-mono text-[12px]">{o.model}</span> <span className="text-[11px] text-[var(--muted)]">{o.description}</span>
          </span>
          <span className="shrink-0 text-[11px] text-[var(--muted)]">required ×{o.required}</span>
        </div>
      ))}
      {picked
        .filter(([m]) => !required.some((r) => r.model === m))
        .map(([m, q]) => {
          const o = props.options.find((x) => x.model === m);
          return (
            <div key={m} className="flex items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="font-mono text-[12px]">{m}</span> <span className="text-[11px] text-[var(--muted)]">{o?.description}</span>
              </span>
              <input type="number" min={0} value={q} onChange={(e) => setQty(m, Number(e.target.value))} className="w-14 shrink-0 rounded border border-[var(--line)] bg-[var(--field)] px-1 py-0.5" aria-label={`${m} quantity`} />
            </div>
          );
        })}
      <button onClick={() => setOpen((v) => !v)} className="text-[12px] text-[var(--accent)]">
        {open ? "Hide" : "Add"} optional accessories ({optional.length})
      </button>
      {open && (
        <ul className="max-h-64 overflow-auto rounded border border-[var(--line)]">
          {optional.map((o) => (
            <li key={o.model} className="flex items-center gap-2 border-b border-[var(--line-soft)] px-2 py-1">
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-[12px]">{o.model}</span>
                <span className="block truncate text-[11px] text-[var(--muted)]">{o.description}</span>
              </span>
              <button onClick={() => setQty(o.model, (props.chosen?.[o.model] ?? 0) + 1)} className="rounded border border-[var(--line)] px-1.5 text-[var(--muted)] hover:text-[var(--accent)]" aria-label={`Add ${o.model}`}>
                +
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function StatusBlock({ evaluation }: { evaluation?: Evaluation }) {
  if (!evaluation) return null;
  const label = { pass: "Compatible", fail: "Not compatible", incomplete: "Incomplete" }[evaluation.status];
  return (
    <Section title="Check">
      <div className="flex items-center gap-2 font-semibold">
        <StatusDot status={evaluation.status} /> {label}
      </div>
      {evaluation.unchecked.length > 0 && (
        <div className="text-[11px] text-[var(--muted)]">
          Not checked yet:
          <ul className="ml-4 list-disc">
            {evaluation.unchecked.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

/* ---------- bottom panel ---------- */

function IssueList({ evaluation, onSelect }: { evaluation?: Evaluation; onSelect: (issue: Issue) => void }) {
  if (!evaluation) return <Empty>Checking…</Empty>;
  if (!evaluation.issues.length) return <Empty>{evaluation.status === "pass" ? "No errors or warnings." : "Add units to check this system."}</Empty>;
  return (
    <table className="w-full">
      <tbody>
        {evaluation.issues.map((i, n) => (
          <tr key={n} onClick={() => onSelect(i)} title="Open related Properties" className="cursor-pointer border-b border-[var(--line-soft)] hover:bg-[var(--hover)]">
            <td className="w-20 px-3 py-1.5">
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold text-white ${i.severity === "error" ? "bg-[var(--bad)]" : i.severity === "warning" ? "bg-[var(--warn)]" : "bg-[var(--muted)]"}`}>
                {i.severity}
              </span>
            </td>
            <td className="w-24 px-2 font-mono text-[11px] text-[var(--muted)]">{i.code}</td>
            <td className="px-2 py-1.5">
              <button className="flex w-full items-start justify-between gap-3 text-left" aria-label={`Open Properties for: ${i.message}`} onClick={(event) => { event.stopPropagation(); onSelect(i); }}>
                <span>{i.message}</span><span aria-hidden="true" className="text-[var(--muted)]">↗</span>
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BomTable({ evaluation }: { evaluation?: Evaluation }) {
  if (!evaluation?.bom.length) return <Empty>The bill of materials fills in as you add units.</Empty>;
  return (
    <table className="w-full">
      <thead className="sticky top-0 bg-[var(--group)] text-left text-[11px] text-[var(--muted)]">
        <tr>
          <th className="px-3 py-1">Qty</th>
          <th className="px-2">Model</th>
          <th className="px-2">Category</th>
          <th className="px-2">Description</th>
          <th className="px-2">Why</th>
        </tr>
      </thead>
      <tbody>
        {evaluation.bom.map((l, n) => (
          <tr key={n} className={`border-b border-[var(--line-soft)] ${l.optional ? "text-[var(--muted)]" : ""}`}>
            <td className="px-3 py-1.5 whitespace-nowrap">
              {l.qty}
              {l.unit === "ft" ? " ft" : ""}
            </td>
            <td className="whitespace-nowrap px-2 font-mono text-[12px]">
              {l.model}
              {l.baseModel && <span className="block text-[10px] text-[var(--muted)]">{l.baseModel}</span>}
            </td>
            <td className="px-2">{l.category}</td>
            <td className="px-2">{l.description}</td>
            <td className="px-2 text-[11px] text-[var(--muted)]">
              {l.optional ? "optional · " : ""}
              {l.reason}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const fraction = (v: number) => ({ 0.25: '1/4"', 0.375: '3/8"', 0.5: '1/2"', 0.625: '5/8"', 0.75: '3/4"', 0.875: '7/8"', 1.125: '1-1/8"' })[v] ?? `${v}"`;

function PipingTable({ evaluation, onSelect }: { evaluation?: Evaluation; onSelect: (t?: string) => void }) {
  if (!evaluation?.piping?.length) return <Empty>Pipe sizes show up once indoor units are placed.</Empty>;
  return (
    <table className="w-full">
      <thead className="sticky top-0 bg-[var(--group)] text-left text-[11px] text-[var(--muted)]">
        <tr>
          <th className="px-3 py-1">Run</th>
          <th className="px-2">Liquid</th>
          <th className="px-2">Gas</th>
          <th className="px-2">Length</th>
          <th className="px-2">Bends</th>
          <th className="px-2">Equivalent</th>
        </tr>
      </thead>
      <tbody>
        {evaluation.piping.map((r, n) => (
          <tr key={n} onClick={() => onSelect(r.target)} className="cursor-pointer border-b border-[var(--line-soft)] hover:bg-[var(--hover)]">
            <td className="px-3 py-1.5">{r.label}</td>
            <td className="px-2 font-mono text-[12px]">{fraction(r.liquidIn)}</td>
            <td className="px-2 font-mono text-[12px]">{fraction(r.gasIn)}</td>
            <td className="px-2">{r.lengthFt != null ? `${r.lengthFt} ft` : <span className="text-[var(--muted)]">—</span>}</td>
            <td className="px-2">{r.bends ?? "—"}</td>
            <td className="px-2">{r.equivalentFt != null ? `${r.equivalentFt.toFixed(1)} ft` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------- small pieces ---------- */

function PanelHeader({ children }: { children: React.ReactNode }) {
  return <div className="panel-heading bg-[var(--header)] px-4 py-3.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--header-fg)]">{children}</div>;
}
function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={active} className={`result-tab flex-1 border-b-2 px-3 py-3 text-[12px] ${active ? "border-[var(--accent)] font-semibold" : "border-transparent text-[var(--muted)] hover:text-[var(--fg)]"}`}>
      {children}
    </button>
  );
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(title === "System" || title === "Indoor unit");
  const contentId = useId();
  const section = useRef<HTMLElement>(null);
  const navigation = useContext(PropertyNavigationContext);
  useEffect(() => {
    if (navigation?.section === title) setOpen(true);
  }, [navigation, title]);
  useEffect(() => {
    if (!open || !navigation || navigation.section !== title) return;
    const element = section.current;
    const frame = requestAnimationFrame(() => {
      if (!element) return;
      const field = navigation.field ? Array.from(element.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")).find((input) => input.closest("label")?.textContent?.trim().startsWith(navigation.field!)) : undefined;
      const target = field ?? element.querySelector<HTMLButtonElement>("h3 button");
      element.classList.add("property-jump");
      target?.focus({ preventScroll: true });
      (field ?? element).scrollIntoView({ block: field ? "center" : "nearest", inline: "nearest" });
    });
    const timer = setTimeout(() => element?.classList.remove("property-jump"), 1600);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); element?.classList.remove("property-jump"); };
  }, [navigation, title, open]);
  return (
    <section ref={section} className="space-y-1.5">
      <h3 className="border-b border-[var(--line)] text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center justify-between gap-2 py-1.5 text-left uppercase hover:text-[var(--fg)]"
        >
          {title}
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" className={`shrink-0 ${open ? "rotate-90" : ""}`}>
            <path d="m6 3 5 5-5 5" />
          </svg>
        </button>
      </h3>
      <div id={contentId} hidden={!open} className="space-y-1.5">{children}</div>
    </section>
  );
}
function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2">
      <span className="text-[var(--muted)]">{label}</span>
      <span className="break-words">{children}</span>
    </div>
  );
}
function NumberField({ label, value, onChange, allowNegative }: { label: string; value?: number; onChange: (v?: number) => void; allowNegative?: boolean }) {
  return (
    <label className="block">
      <span className="text-[11px] text-[var(--muted)]">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        min={allowNegative ? undefined : 0}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className="mt-0.5 w-full rounded border border-[var(--line)] bg-[var(--field)] px-2 py-1"
      />
    </label>
  );
}
function StatusDot({ status }: { status?: Evaluation["status"] }) {
  const c = status === "pass" ? "bg-[var(--good)]" : status === "fail" ? "bg-[var(--bad)]" : "bg-[var(--muted)]";
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${c}`} />;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-4 text-center text-[12px] text-[var(--muted)]">{children}</div>;
}

/* ---------- export ---------- */

function mergeBom(evals: Evaluation[]) {
  const lines = new Map<string, Evaluation["bom"][number]>();
  for (const ev of evals)
    for (const l of ev.bom) {
      const k = `${l.model}|${l.optional ? 1 : 0}`;
      const cur = lines.get(k);
      lines.set(k, cur ? { ...cur, qty: cur.qty + l.qty } : { ...l });
    }
  return [...lines.values()];
}

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function downloadCsv(project: Project, evals: Record<string, Evaluation>) {
  const rows = [["System", "System type", "Qty", "Unit", "Model", "Mitsubishi model", "Category", "Description", "Optional", "Reason"]];
  for (const s of project.systems)
    for (const l of evals[s.id]?.bom ?? [])
      rows.push([s.name, SYSTEM_LABEL[s.system], String(l.qty), l.unit ?? "ea", l.model, l.baseModel ?? l.model, l.category, l.description, l.optional ? "yes" : "", l.reason ?? ""]);
  const blob = new Blob([rows.map((r) => r.map(csvCell).join(",")).join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${project.name.replace(/[^\w-]+/g, "_") || "mini-split"}-bom.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function copyBom(lines: Evaluation["bom"]) {
  const text = lines.filter((l) => !l.optional).map((l) => `${l.qty}${l.unit === "ft" ? " ft" : ""}\t${l.model}\t${l.description}`).join("\n");
  navigator.clipboard?.writeText(text).catch(() => {});
}

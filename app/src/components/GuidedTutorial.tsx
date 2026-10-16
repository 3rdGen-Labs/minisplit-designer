"use client";

import { useEffect, useRef, useState } from "react";

const TUTORIAL_KEY = "zonespec.tutorial.v1";
export interface TutorialPreferences {
  autoShow: boolean;
  outcome?: "skipped" | "completed";
}
export const DEFAULT_TUTORIAL: TutorialPreferences = { autoShow: true };
export function readTutorialPreferences(): TutorialPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(TUTORIAL_KEY) ?? "null");
    return typeof saved?.autoShow === "boolean" ? saved : DEFAULT_TUTORIAL;
  } catch { return DEFAULT_TUTORIAL; }
}
export function saveTutorialPreferences(preferences: TutorialPreferences) {
  try { localStorage.setItem(TUTORIAL_KEY, JSON.stringify(preferences)); } catch {}
}

const STEPS = [
  { target: ".equipment-group-outdoor", title: "Choose an outdoor unit", text: "Drag an outdoor unit from the library onto the canvas, or click it to choose a model. The outdoor unit sets your system family.", hint: "Pick a model to continue automatically, or choose Next to look around." },
  { target: ".equipment-group-indoor", title: "Build out your zones", text: "Drag or click compatible indoor units to add rooms. Keep adding units to build a multi-zone system. Single-zone systems may add their matching indoor unit automatically.", hint: "Add an indoor unit to continue, or choose Next if your pair is already in place." },
  { target: ".properties-panel", title: "Make it your system", text: "Click a unit on the canvas to edit its room and installation details here. Enter line lengths directly on the connecting pipes; liquid and gas sizes are shown beside them.", hint: "Section headings collapse. Scroll inside Properties for more settings." },
  { target: ".validation-control", title: "Check every system", text: "Press Validate all systems to run compatibility, piping, and equipment checks. Select a system to review its errors and warnings below the canvas.", hint: "Resolve missing information and verify the final design against current manufacturer documents." },
  { target: ".project-actions-button", title: "Take your materials with you", text: "Open Project actions to copy the bill of materials or export a CSV. You can also import an existing DSB project here.", hint: "Tutorial is always in the header. Settings lets you choose whether it appears on startup." },
];

type Bounds = { top: number; left: number; right: number; bottom: number; width: number; height: number };

export default function GuidedTutorial({ step, paused, onStep, onFinish }: {
  step: number;
  paused: boolean;
  onStep: (step: number) => void;
  onFinish: (outcome: "skipped" | "completed") => void;
}) {
  const intro = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [position, setPosition] = useState({ top: 12, left: 12 });
  const current = STEPS[step - 1];

  useEffect(() => {
    if (step !== 0 || paused) return;
    const dialog = intro.current;
    dialog?.showModal();
    dialog?.focus({ preventScroll: true });
    return () => dialog?.close();
  }, [step, paused]);

  useEffect(() => {
    if (!current || paused) return;
    const target = document.querySelector<HTMLElement>(current.target);
    if (!target) return;
    const toggle = target.querySelector<HTMLButtonElement>(".equipment-group-toggle");
    if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    let frame = 0;
    const measure = () => {
      const rect = target.getBoundingClientRect();
      const visible = {
        top: Math.max(6, rect.top - 5), left: Math.max(6, rect.left - 5),
        right: Math.min(innerWidth - 6, rect.right + 5), bottom: Math.min(innerHeight - 6, rect.bottom + 5),
        width: 0, height: 0,
      };
      visible.width = Math.max(0, visible.right - visible.left);
      visible.height = Math.max(0, visible.bottom - visible.top);
      setBounds(visible);
      const width = panel.current?.offsetWidth ?? 350;
      const height = panel.current?.offsetHeight ?? 280;
      let left = Math.max(12, innerWidth - width - 12);
      let top = Math.max(12, innerHeight - height - 12);
      if (innerWidth >= 700) {
        if (visible.right + width + 24 <= innerWidth) {
          left = visible.right + 12;
          top = Math.max(12, Math.min(visible.top, innerHeight - height - 12));
        } else if (visible.left - width - 12 >= 12) {
          left = visible.left - width - 12;
          top = Math.max(12, Math.min(visible.top, innerHeight - height - 12));
        } else if (visible.bottom + height + 24 <= innerHeight) {
          top = visible.bottom + 12;
        } else if (visible.top - height - 12 >= 12) {
          top = visible.top - height - 12;
        }
      }
      setPosition({ top, left });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(target);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [current, paused]);

  if (paused) return null;
  if (step === 0) return (
    <dialog ref={intro} tabIndex={-1} className="workspace-dialog tutorial-welcome" aria-label="Welcome to Mini-Split Designer" onCancel={(e) => { e.preventDefault(); onFinish("skipped"); }}>
      <div className="px-6 py-6">
        <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--accent)]">A quick walkthrough</div>
        <h2 className="text-[24px] font-semibold tracking-tight">Build your first system.</h2>
        <p className="mt-3 text-[13px] leading-relaxed text-[var(--muted)]">Choose equipment, connect your rooms, and check the design. We’ll point out the tools while you try them.</p>
        <p className="mt-3 text-[12px] leading-relaxed text-[var(--muted)]">Use your current workspace. This walkthrough won’t add or replace any equipment for you. You can skip anytime.</p>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--line-soft)] px-6 py-4">
        <button className="dialog-secondary" onClick={() => onFinish("skipped")}>Skip tutorial</button>
        <button className="dialog-primary" onClick={() => onStep(1)}>Start tutorial</button>
      </div>
    </dialog>
  );
  if (!current) return null;
  return (
    <>
      {bounds && <div className="tutorial-highlight" aria-hidden="true" style={{ top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height }} />}
      <div ref={panel} role="dialog" aria-modal="false" aria-label="Interactive tutorial" className="tutorial-panel" style={position}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--accent)]">Step {step} of {STEPS.length}</span>
          <button className="text-[11px] text-[var(--muted)] underline underline-offset-2" onClick={() => onFinish("skipped")}>Skip tutorial</button>
        </div>
        <div className="tutorial-progress mt-3" aria-hidden="true">{STEPS.map((_, i) => <span key={i} className={i < step ? "is-complete" : ""} />)}</div>
        <div aria-live="polite">
          <h2 className="mt-4 text-[18px] font-semibold tracking-tight">{current.title}</h2>
          <p className="mt-2 text-[12px] leading-relaxed text-[var(--fg)]">{current.text}</p>
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">{current.hint}</p>
        </div>
        <div className="mt-5 flex justify-between gap-2">
          <button className="dialog-secondary" onClick={() => onStep(step - 1)}>Back</button>
          <button className="dialog-primary" onClick={() => step === STEPS.length ? onFinish("completed") : onStep(step + 1)}>{step === STEPS.length ? "Finish tutorial" : "Next"}</button>
        </div>
      </div>
    </>
  );
}

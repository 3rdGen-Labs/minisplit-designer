"use client";

import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";

const STORAGE_KEY = "zonespec.layout.v1";
const DEFAULT_HEIGHT = 224;
const MIN_RESULTS = 96;
const MIN_CANVAS = 160;
const HANDLE_HEIGHT = 16;

export default function DesignSplit({ canvas, results }: { canvas: ReactNode; results: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [preferredHeight, setPreferredHeight] = useState(DEFAULT_HEIGHT);
  const [availableHeight, setAvailableHeight] = useState(600);
  const [loaded, setLoaded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const canvasId = useId();
  const resultsId = useId();
  const maximum = Math.max(MIN_RESULTS, availableHeight - MIN_CANVAS - HANDLE_HEIGHT);
  const height = Math.round(Math.min(maximum, Math.max(MIN_RESULTS, preferredHeight)));
  const clamp = (value: number) => Math.min(maximum, Math.max(MIN_RESULTS, value));

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      if (typeof saved?.resultsHeight === "number" && Number.isFinite(saved.resultsHeight)) {
        setPreferredHeight(Math.max(MIN_RESULTS, Math.min(2000, saved.resultsHeight)));
      }
    } catch {}
    setLoaded(true);
    const element = root.current;
    if (!element) return;
    const measure = () => setAvailableHeight(element.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ resultsHeight: preferredHeight })); } catch {}
    }, 150);
    return () => clearTimeout(timer);
  }, [preferredHeight, loaded]);

  const stopDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div ref={root} className={`design-split ${dragging ? "is-resizing" : ""}`}>
      <div id={canvasId} className="design-split-canvas">{canvas}</div>
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize design canvas and results"
        aria-orientation="horizontal"
        aria-controls={`${canvasId} ${resultsId}`}
        aria-valuemin={MIN_RESULTS}
        aria-valuemax={Math.round(maximum)}
        aria-valuenow={height}
        aria-valuetext={`Results panel ${height} pixels tall`}
        className="design-split-handle"
        title="Drag up or down to resize. Double-click to reset. Arrow keys also resize."
        onDoubleClick={() => setPreferredHeight(DEFAULT_HEIGHT)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (current?.pointerId !== event.pointerId) return;
          setPreferredHeight(clamp(current.startHeight + current.startY - event.clientY));
        }}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 64 : 24;
          const next = event.key === "ArrowUp" ? height + step : event.key === "ArrowDown" ? height - step : event.key === "Home" ? MIN_RESULTS : event.key === "End" ? maximum : null;
          if (next == null) return;
          event.preventDefault();
          setPreferredHeight(clamp(next));
        }}
      >
        <span aria-hidden="true" />
      </div>
      <div id={resultsId} className="design-split-results" style={{ height }}>{results}</div>
    </div>
  );
}

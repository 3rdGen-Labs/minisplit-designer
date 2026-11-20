import type { SystemKey } from "./design";

/** Outdoor unit artwork: one of the rendered bodies in public/units/ (design/blender). */
export type OduArt = "outdoor-compact" | "outdoor-1fan" | "outdoor-2fan";

/**
 * Outdoor body by family and size. The catalog has no cabinet dimensions, so this goes by class, plus the
 * R454B hyper-heat single-zone line (SUZ-AK / PUZ-AK …NLHZ, 24k and up): a two-fan cabinet, 41-11/32 x 14 x 52-43/64 in
 * (Mitsubishi Electric submittals SUZ-AK24/30/36NLHZ and PUZ-AK24/30/36NLHZ, Unit Dimensions, fan motor output 74+74 W).
 */
export function oduArt(model: string, coolingBtu: number, system: SystemKey): OduArt {
  if (system === "MXZSM" || coolingBtu >= 42000 || /^MXZ-8/.test(model)) return "outdoor-2fan";
  if (/^(SUZ|PUZ)-AK\d+NLHZ/.test(model)) return "outdoor-2fan";
  if (coolingBtu <= 15000) return "outdoor-compact";
  return "outdoor-1fan";
}

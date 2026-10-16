import { num } from "../catalog";
import { Ctx, fmt, label } from "./context";

/**
 * ODU <-> IDU elevation. DSB's column names read backwards: `_Below` limits an IDU that sits
 * above the ODU, `_Above` limits an IDU below it (see mxz-and-smart-multi.md §4.4).
 */
export function checkHeights(ctx: Ctx) {
  const raw = ctx.odu!.raw;
  const iduAboveMax = Math.max(num(raw.numMaxHeightBetweenOUandIU_Below), num(raw.numMaxHeightBetweenOUandIU_Below_Override));
  const iduBelowMax = Math.max(num(raw.numMaxHeightBetweenOUandIU_Above), num(raw.numMaxHeightBetweenOUandIU_Above_Override));
  let missing = false;
  for (const x of ctx.placed) {
    const h = x.p.heightFt;
    if (h == null) {
      missing = true;
      continue;
    }
    if (h > 0 && iduAboveMax && h > iduAboveMax)
      ctx.error("HEIGHT_ODU_IDU", `${label(x)} is ${fmt(h)} ft above the outdoor unit; the limit is ${fmt(iduAboveMax)} ft.`, x.p.key);
    if (h < 0 && iduBelowMax && -h > iduBelowMax)
      ctx.error("HEIGHT_ODU_IDU", `${label(x)} is ${fmt(-h)} ft below the outdoor unit; the limit is ${fmt(iduBelowMax)} ft.`, x.p.key);
  }

  const iduIduMax = num(raw.numMaxHeightBetweenIUandIU_Max);
  const hs = ctx.placed.map((x) => x.p.heightFt).filter((h): h is number => h != null);
  if (ctx.placed.length > 1 && iduIduMax > 1 && hs.length > 1) {
    const spread = Math.max(...hs) - Math.min(...hs);
    if (spread > iduIduMax) ctx.error("HEIGHT_IDU_IDU", `Indoor units are ${fmt(spread)} ft apart vertically; the limit is ${fmt(iduIduMax)} ft.`);
  }
  if (missing) ctx.info("HEIGHT_BLANK", "Enter each indoor unit's height relative to the outdoor unit to check elevation limits (0 if level).");
}

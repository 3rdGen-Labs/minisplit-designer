// Moist-air psychrometrics for design conditions (standard ASHRAE Fundamentals relations, SI internally).
// Shared by the app (heating dry bulb + RH -> wet bulb) and scripts/build-design-weather.mjs.

const fToC = (f) => ((f - 32) * 5) / 9;
const cToF = (c) => (c * 9) / 5 + 32;

/** Standard-atmosphere barometric pressure at an altitude, kPa. */
export function pressureKpa(altitudeFt = 0) {
  return 101.325 * Math.pow(1 - 2.25577e-5 * altitudeFt * 0.3048, 5.2559);
}

/** Saturation vapor pressure, kPa: over water at or above 0 °C, over ice below (Magnus-type fits). */
function pws(tc) {
  return tc >= 0 ? 0.61094 * Math.exp((17.625 * tc) / (tc + 243.04)) : 0.61115 * Math.exp((22.452 * tc) / (272.55 + tc));
}

const humidityRatio = (pw, p) => (0.621945 * pw) / (p - pw);

/** Humidity ratio from dry bulb and a wet bulb (psychrometer equation; ice-bulb form below freezing). */
function ratioFromWetBulb(tc, twc, p) {
  const ws = humidityRatio(pws(twc), p);
  return twc >= 0
    ? ((2501 - 2.326 * twc) * ws - 1.006 * (tc - twc)) / (2501 + 1.86 * tc - 4.186 * twc)
    : ((2830 - 0.24 * twc) * ws - 1.006 * (tc - twc)) / (2830 + 1.86 * tc - 2.1 * twc);
}

/** Wet bulb (°C) for a dry bulb (°C) and humidity ratio, by bisection. */
function wetBulbC(tc, w, p) {
  let lo = tc - 60;
  let hi = tc;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (ratioFromWetBulb(tc, mid, p) > w) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Wet bulb °F from dry bulb °F and relative humidity (0–100 %). */
export function wetBulbFromRh(dbF, rhPct, altitudeFt = 0) {
  const p = pressureKpa(altitudeFt);
  const tc = fToC(dbF);
  const pw = Math.min(1, Math.max(0, rhPct / 100)) * pws(tc);
  return cToF(wetBulbC(tc, humidityRatio(pw, p), p));
}

/** Wet bulb °F from dry bulb °F and dew point °F. */
export function wetBulbFromDewPoint(dbF, dpF, altitudeFt = 0) {
  const p = pressureKpa(altitudeFt);
  const tc = fToC(dbF);
  const pw = Math.min(pws(fToC(Math.min(dpF, dbF))), pws(tc));
  return cToF(wetBulbC(tc, humidityRatio(pw, p), p));
}

/** Relative humidity (%) from dry bulb °F and wet bulb °F. */
export function rhFromWetBulb(dbF, wbF, altitudeFt = 0) {
  const p = pressureKpa(altitudeFt);
  const tc = fToC(dbF);
  const w = Math.max(0, ratioFromWetBulb(tc, fToC(Math.min(wbF, dbF)), p));
  const pw = (w * p) / (0.621945 + w);
  return Math.min(100, Math.max(0, (pw / pws(tc)) * 100));
}

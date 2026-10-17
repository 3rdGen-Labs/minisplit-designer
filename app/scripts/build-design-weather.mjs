#!/usr/bin/env node
// Builds src/data/design-locations.json: heating and cooling design-day conditions per weather station,
// computed from NOAA's public-domain Integrated Surface Database (ISD-Lite hourly observations).
//
//   node scripts/build-design-weather.mjs [--state CA] [--from 2011] [--to 2024] [--cache .weather-cache]
//
// Method (ASHRAE-style annual percentiles over all hours of the period):
//   heating 99% dry bulb  = the temperature that 1% of hours fall at or below
//   cooling 1% dry bulb   = the temperature that 1% of hours reach or exceed
//   coincident wet bulbs  = mean wet bulb of the hours within ±0.5 °C of each design dry bulb
// Station years with under 75% of hours reported are dropped; stations need 8 good years.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { wetBulbFromDewPoint } from "../src/lib/psychro.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const STATE = arg("state", "CA");
const FROM = Number(arg("from", 2011));
const TO = Number(arg("to", 2024));
const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.resolve(arg("cache", path.join(here, "..", ".weather-cache")));
const OUT = path.join(here, "..", "src", "data", "design-locations.json");
const CITIES = JSON.parse(fs.readFileSync(path.join(here, "design-location-cities.json"), "utf8"));
const NOAA = "https://www.ncei.noaa.gov/pub/data/noaa";

fs.mkdirSync(path.join(CACHE, "lite"), { recursive: true });

// Files NOAA doesn't have (station-years never recorded) leave a .missing marker so reruns skip them.
async function cached(url, file) {
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (fs.existsSync(`${file}.missing`)) return null;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) {
        fs.writeFileSync(`${file}.missing`, "");
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      return buf;
    } catch (err) {
      if (attempt >= 4) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

function parseCsv(text) {
  const [head, ...rows] = text.trim().split(/\r?\n/).map((l) => l.split(/","/).map((c) => c.replace(/^"|"$/g, "")));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const titleCase = (s) =>
  s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bIntl\b/g, "Intl").replace(/\b(Afb|Mcas|Nas|Naf|Aaf)\b/g, (m) => m.toUpperCase());

// Airport sensors (ASOS) report whole °F, which NOAA stores rounded to tenths of °C. Snap each reading back to
// whole °F, treat it as spread evenly over its 1 °F step and interpolate, so a percentile isn't stuck on the step.
function percentileF(tenthsC, q) {
  const counts = new Map();
  for (const t of tenthsC) {
    const f = Math.round((t / 10) * 1.8 + 32);
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const target = q * tenthsC.length;
  let below = 0;
  for (const [f, c] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (below + c >= target) return f - 0.5 + (target - below) / c;
    below += c;
  }
  return Math.max(...counts.keys());
}
const round1 = (v) => Math.round(v * 10) / 10;
const cToF = (c) => (c * 9) / 5 + 32;

const history = parseCsv((await cached(`${NOAA}/isd-history.csv`, path.join(CACHE, "isd-history.csv"))).toString());
const stations = history.filter(
  (s) => s.CTRY === "US" && s.STATE === STATE && s.ICAO?.trim() && s.BEGIN <= `${FROM}0101` && s.END >= `${TO}1231`,
);
// Several USAF/WBAN ids can share one ICAO airport; merge them.
const byIcao = new Map();
for (const s of stations) byIcao.set(s.ICAO.trim(), [...(byIcao.get(s.ICAO.trim()) ?? []), s]);

const out = [];
let n = 0;
for (const [icao, ids] of byIcao) {
  n++;
  const elevFt = Number(ids[0]["ELEV(M)"]) * 3.28084;
  const temps = [];
  const pairs = []; // [tempC*10, dewC*10]
  let goodYears = 0;
  for (let y = FROM; y <= TO; y++) {
    const hours = new Map(); // one observation per hour; first id wins
    for (const s of ids) {
      const name = `${s.USAF}-${s.WBAN}-${y}.gz`;
      const gz = await cached(`${NOAA}/isd-lite/${y}/${name}`, path.join(CACHE, "lite", name));
      if (!gz) continue;
      for (const line of zlib.gunzipSync(gz).toString().split("\n")) {
        const f = line.trim().split(/\s+/);
        if (f.length < 4) continue;
        const t = Number(f[4]);
        if (t === -9999 || Number.isNaN(t)) continue;
        const key = `${f[1]}-${f[2]}-${f[3]}`;
        if (!hours.has(key)) hours.set(key, [t, Number(f[5])]);
      }
    }
    if (hours.size < 0.75 * 8760) continue;
    goodYears++;
    for (const [t, d] of hours.values()) {
      temps.push(t);
      if (d !== -9999 && !Number.isNaN(d)) pairs.push([t, d]);
    }
  }
  process.stdout.write(`\r${n}/${byIcao.size} ${icao}   `);
  if (goodYears < 8) continue;
    const heatF = percentileF(temps, 0.01);
  const coolF = percentileF(temps, 0.99);
  const heatC = ((heatF - 32) * 5) / 9;
  const coolC = ((coolF - 32) * 5) / 9;
  const meanWb = (targetC) => {
    const near = pairs.filter(([t]) => Math.abs(t / 10 - targetC) <= 0.5);
    if (!near.length) return undefined;
    return near.reduce((s, [t, d]) => s + wetBulbFromDewPoint(cToF(t / 10), cToF(d / 10), elevFt), 0) / near.length;
  };
  const coolWb = meanWb(coolC);
  const heatWb = meanWb(heatC);
  out.push({
    id: icao,
    city: CITIES[icao] ?? titleCase(ids[0]["STATION NAME"]),
    station: titleCase(ids[0]["STATION NAME"]),
    state: STATE,
    lat: Number(ids[0].LAT),
    lon: Number(ids[0].LON),
    elevationFt: Math.round(elevFt),
    heatDbF: round1(heatF),
    heatWbF: heatWb == null ? undefined : round1(heatWb),
    coolDbF: round1(coolF),
    coolMcwbF: coolWb == null ? undefined : round1(coolWb),
    years: goodYears,
  });
}
out.sort((a, b) => a.city.localeCompare(b.city));
fs.writeFileSync(
  OUT,
  JSON.stringify(
    {
      source: "NOAA NCEI Integrated Surface Database (ISD-Lite), public domain",
      method: "Annual 99% heating / 1% cooling dry bulb over all hours; mean coincident wet bulb within ±0.5 °C",
      period: `${FROM}–${TO}`,
      locations: out,
    },
    null,
    1,
  ) + "\n",
);
console.log(`\n${out.length} locations -> ${path.relative(process.cwd(), OUT)}`);

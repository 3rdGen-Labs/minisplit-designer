import { describe, expect, it } from "vitest";
import designWeather from "@/data/design-locations.json";
import { rhFromWetBulb, wetBulbFromDewPoint, wetBulbFromRh } from "./psychro.mjs";

describe("psychrometrics", () => {
  it("reproduces the 47 °F DB / 43 °F WB heating rating point at 72.8 % RH", () => {
    expect(wetBulbFromRh(47, 72.8)).toBeCloseTo(43, 0);
    expect(rhFromWetBulb(47, 43)).toBeCloseTo(72.8, 0);
  });
  it("round-trips RH through wet bulb, including below freezing and at altitude", () => {
    for (const [db, rh, alt] of [[20, 80, 0], [5, 60, 6000], [95, 40, 0]]) {
      expect(rhFromWetBulb(db, wetBulbFromRh(db, rh, alt), alt)).toBeCloseTo(rh, 0);
    }
  });
  it("wet bulb from dew point sits between dew point and dry bulb", () => {
    const wb = wetBulbFromDewPoint(95, 60);
    expect(wb).toBeGreaterThan(60);
    expect(wb).toBeLessThan(95);
    expect(wb).toBeCloseTo(71.4, 0);
  });
});

describe("design locations", () => {
  const byId = new Map(designWeather.locations.map((l) => [l.id, l]));
  it("covers every state with plausible design days", () => {
    expect(designWeather.locations.length).toBeGreaterThan(1500);
    expect(new Set(designWeather.locations.map((l) => l.state)).size).toBeGreaterThanOrEqual(50);
    for (const l of designWeather.locations) {
      expect(l.heatDbF).toBeLessThan(l.coolDbF);
      expect(l.heatDbF).toBeGreaterThan(-50);
      expect(l.coolDbF).toBeLessThan(125);
    }
  });
  it("orders climates sensibly", () => {
    const heat = (id: string) => byId.get(id)!.heatDbF;
    expect(heat("KTVL")).toBeLessThan(heat("KSAC"));
    expect(heat("KSAC")).toBeLessThan(heat("KSFO"));
    expect(byId.get("KPSP")!.coolDbF).toBeGreaterThan(byId.get("KSFO")!.coolDbF);
    expect(heat("KMSP")).toBeLessThan(heat("KDEN"));
    expect(heat("KDEN")).toBeLessThan(heat("KATL"));
    expect(heat("KATL")).toBeLessThan(heat("KMIA"));
    expect(byId.get("KPHX")!.coolDbF).toBeGreaterThan(byId.get("KSEA")!.coolDbF);
  });
});

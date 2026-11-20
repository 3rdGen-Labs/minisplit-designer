import { describe, expect, it } from "vitest";
import { oduArt } from "./odu-art";

describe("oduArt", () => {
  it("draws the R454B hyper-heat single-zone units as the tall two-fan cabinet", () => {
    for (const m of ["SUZ-AK24NLHZ", "SUZ-AK30NLHZ", "SUZ-AK36NLHZ", "PUZ-AK24NLHZ", "PUZ-AK30NLHZ", "PUZ-AK36NLHZ"]) {
      expect(oduArt(m, 28000, m.startsWith("SUZ") ? "MandS" : "P")).toBe("outdoor-2fan");
    }
  });
  it("keeps the standard units on the one-fan body", () => {
    expect(oduArt("SUZ-AA30NL", 27000, "MandS")).toBe("outdoor-1fan");
    expect(oduArt("PUY-AH30NL", 28800, "P")).toBe("outdoor-1fan");
    expect(oduArt("SUZ-AA12NL", 12000, "MandS")).toBe("outdoor-compact");
  });
});

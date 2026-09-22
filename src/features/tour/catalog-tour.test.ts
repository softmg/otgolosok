import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("каталожная прогулка на главной", () => {
  it("не открывает встроенный маршрут вместо карты", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./catalog-tour.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("<TourExperience route={route} />");
    expect(source).not.toContain("routeToWalkView");
    expect(source).not.toContain("<TourExperience walk=");
  });
});

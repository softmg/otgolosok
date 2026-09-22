import { describe, expect, it } from "vitest";
import { mergePage } from "./pagination";

describe("mergePage", () => {
  it("preserves prior items and removes duplicates across and within pages", () => {
    expect(mergePage([{ id: "one" }], [{ id: "one" }, { id: "two" }, { id: "two" }], item => item.id))
      .toEqual([{ id: "one" }, { id: "two" }]);
  });
});

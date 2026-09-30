import { describe, expect, it } from "vitest";
import { cx } from "./cx";

describe("cx", () => {
  it.each([
    [["a", "b"], "a b"],
    [["a", false, "b"], "a b"],
    [[null, undefined, ""], ""],
    [["a", "", null, "c"], "a c"],
    [[], ""],
  ] as const)("%j → %j", (parts, expected) => {
    expect(cx(...parts)).toBe(expected);
  });
});

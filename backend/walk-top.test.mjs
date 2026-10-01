import test from "node:test";
import assert from "node:assert/strict";
import { rankTopWalks, topScore } from "./walk-top.mjs";

const walk = (key, { ratingSum = 0, ratingCount = 0, launches = 10, listedAt = "2026-01-01T00:00:00.000Z" } = {}) => ({ key, ratingSum, ratingCount, launches, listedAt });
const keys = (candidates, options = { priorMean: 4 }) => rankTopWalks(candidates, options).map(item => item.key);

test("ranking rules", async t => {
  /** @type {Array<[string, any[], string[], any?]>} */
  const cases = [
    ["the prior pulls a single 5★ below many 4.6★ ratings", [walk("single", { ratingSum: 5, ratingCount: 1 }), walk("many", { ratingSum: 46 * 5, ratingCount: 50 })], ["many", "single"]],
    ["more launches win at an equal rating", [walk("few", { launches: 3 }), walk("lots", { launches: 300 })], ["lots", "few"]],
    ["zero launches fall to the bottom whatever the rating", [walk("unlaunched", { ratingSum: 50, ratingCount: 10, launches: 0 }), walk("poor", { ratingSum: 10, ratingCount: 10, launches: 1 })], ["poor", "unlaunched"]],
    ["equal scores break by launches", [walk("a", { launches: 0, ratingCount: 3, ratingSum: 12 }), walk("b", { launches: 0 })], ["a", "b"]],
    ["then by rating count", [walk("a", { launches: 0 }), walk("b", { launches: 0, ratingCount: 2, ratingSum: 8 })], ["b", "a"]],
    ["then by newer listing", [walk("old", { listedAt: "2026-01-01T00:00:00.000Z" }), walk("new", { listedAt: "2026-02-01T00:00:00.000Z" })], ["new", "old"]],
    ["then by key", [walk("b"), walk("a")], ["a", "b"]],
    ["the limit cuts the list", [walk("a", { launches: 3 }), walk("b", { launches: 2 }), walk("c", { launches: 1 })], ["a", "b"], { priorMean: 4, limit: 2 }],
  ];
  for (const [name, candidates, expected, options] of cases) await t.test(name, () => assert.deepEqual(keys(candidates, options), expected));
});

test("the score follows the published formula", () => {
  // ((5 × 4) + 9) / (5 + 2) × ln(1 + 6)
  assert.equal(topScore({ ratingSum: 9, ratingCount: 2, launches: 6 }, { priorMean: 4 }), (29 / 7) * Math.log(7));
  assert.equal(topScore({ ratingSum: 0, ratingCount: 0, launches: 0 }, { priorMean: 4 }), 0);
});

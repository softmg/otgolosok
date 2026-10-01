import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAccountStore } from "./account-store.mjs";
import { createReviewRateLimiter, guestKeyHash, nextReviewStatus, normalizeReviewText, validateRating, REVIEW_TEXT_MAX } from "./walk-reviews.mjs";

const GUEST_KEY = "A".repeat(43);
const OTHER_KEY = "B".repeat(43);
const target = { kind: "catalog", id: "arbat", title: "Арбат", revision: 0 };

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT);
    INSERT INTO user VALUES ('anna','Анна','anna@example.test'), ('boris','  ','boris@example.test')`);
  let clock = Date.parse("2026-10-01T10:00:00Z");
  const store = createAccountStore(db, () => clock);
  return { db, store, tick: (ms = 1000) => { clock += ms; } };
}
const snapshot = { version: 1, title: "Моя", start: null, stops: [], mode: "loop", minutes: 30, route: null, jobs: [], submitting: null };

test("nextReviewStatus covers every transition of the moderation state machine", () => {
  const cases = [
    [null, "", "published"],
    [null, "хорошо", "pending"],
    [{ status: "hidden", text: "плохо" }, "", "hidden"],
    [{ status: "hidden", text: "плохо" }, "другое", "hidden"],
    [{ status: "pending", text: "текст" }, "", "published"],
    [{ status: "published", text: "текст" }, "текст", "published"],
    [{ status: "pending", text: "текст" }, "текст", "pending"],
    [{ status: "published", text: "текст" }, "новый", "pending"],
    [{ status: "published", text: "" }, "новый", "pending"],
  ];
  for (const [previous, text, expected] of /** @type {[any, string, string][]} */ (cases)) assert.equal(nextReviewStatus(previous, text), expected, JSON.stringify([previous, text]));
});

test("normalizeReviewText canonicalizes text and enforces the code point limit", () => {
  const cases = [
    [undefined, ""], [null, ""], ["  ", ""],
    ["a\r\nb\rc", "a\nb\nc"],
    ["a\u0007b\tc", "abc"],
    ["evil‮text​!", "eviltext!"],
    ["a\n\n\n\nb", "a\n\nb"],
    ["line   \nnext  ", "line\nnext"],
    ["<3 спасибо", "<3 спасибо"],
    ["é", "é"],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeReviewText(input), expected, JSON.stringify(input));
  assert.equal([...normalizeReviewText("😀".repeat(REVIEW_TEXT_MAX))].length, REVIEW_TEXT_MAX);
  assert.throws(() => normalizeReviewText("😀".repeat(REVIEW_TEXT_MAX + 1)), { code: "BAD_REQUEST" });
  for (const bad of [5, {}, [], true]) assert.throws(() => normalizeReviewText(bad), { code: "BAD_REQUEST" });
});

test("validateRating accepts integers 1–5 only", () => {
  for (const ok of [1, 3, 5]) assert.equal(validateRating(ok), ok);
  for (const bad of [0, 6, 1.5, "5", null, undefined, NaN]) assert.throws(() => validateRating(bad), { code: "BAD_REQUEST" }, String(bad));
});

test("guestKeyHash requires a 43-character base64url key and never returns it", () => {
  const hash = guestKeyHash(GUEST_KEY);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.notEqual(hash, guestKeyHash(OTHER_KEY));
  for (const bad of ["A".repeat(42), "A".repeat(44), "A".repeat(42) + "=", "A".repeat(42) + "+", null, 1]) assert.throws(() => guestKeyHash(bad), { code: "BAD_REQUEST" });
});

test("one review per account and per guest key; resubmitting updates it", () => {
  const { store, tick } = setup();
  const anna = { userId: "anna" }, guest = { guestKeyHash: guestKeyHash(GUEST_KEY) };
  store.saveWalkReview(target, anna, { rating: 5 });
  tick();
  const updated = store.saveWalkReview(target, anna, { rating: 3 });
  assert.deepEqual(updated.summary, { average: 3, count: 1 });
  store.saveWalkReview(target, guest, { rating: 4 });
  store.saveWalkReview(target, guest, { rating: 5 });
  const page = store.getWalkReviews(target, guest);
  assert.deepEqual(page.summary, { average: 4, count: 2 });
  assert.equal(page.mine.rating, 5);
  assert.equal(store.getWalkReviews(target, null).mine, null);
  assert.throws(() => store.saveWalkReview(target, null, { rating: 5 }), { code: "BAD_REQUEST" });
});

test("public reads include only published reviews; the list keeps reviews with text", () => {
  const { store, tick } = setup();
  const keys = Array.from({ length: 25 }, (_, index) => ({ guestKeyHash: guestKeyHash(String(index).padStart(43, "x")) }));
  store.saveWalkReview(target, { userId: "anna" }, { rating: 2, text: "на проверке" });
  store.saveWalkReview(target, { userId: "boris" }, { rating: 4 });
  for (const [index, key] of keys.entries()) {
    tick();
    const saved = store.saveWalkReview(target, key, { rating: 5, text: `отзыв ${index}` });
    assert.equal(saved.mine.status, "pending");
    const [row] = store.listWalkReviewsAdmin({ status: "pending", limit: 1 }).reviews;
    store.moderateWalkReview(row.id, "publish", "editor");
  }
  const first = store.getWalkReviews(target, { userId: "anna" });
  assert.deepEqual(first.summary, { average: 4.96, count: 26 });
  assert.equal(first.mine.status, "pending");
  assert.equal(first.reviews.length, 20);
  assert.equal(first.reviews[0].text, "отзыв 24");
  assert.equal(first.reviews[0].author, "Гость");
  const second = store.getWalkReviews(target, null, { after: first.nextCursor });
  assert.deepEqual(second.reviews.map(review => review.text), ["отзыв 4", "отзыв 3", "отзыв 2", "отзыв 1", "отзыв 0"]);
  assert.equal(second.nextCursor, null);
  assert.equal(JSON.stringify([first.reviews, second]).includes("на проверке"), false);
  assert.equal(first.mine.text, "на проверке");
  assert.throws(() => store.getWalkReviews(target, null, { after: "garbage" }), { code: "BAD_REQUEST" });
});

test("authors are shown by account name with a fallback; hiding removes the rating", () => {
  const { store } = setup();
  store.saveWalkReview(target, { userId: "boris" }, { rating: 1, text: "скучно" });
  const [row] = store.listWalkReviewsAdmin().reviews;
  store.moderateWalkReview(row.id, "publish", null);
  assert.equal(store.getWalkReviews(target, null).reviews[0].author, "Пользователь");
  const hidden = store.moderateWalkReview(row.id, "hide", "editor");
  assert.equal(hidden.status, "hidden");
  assert.deepEqual(store.getWalkReviews(target, null).summary, { average: null, count: 0 });
  assert.equal(store.saveWalkReview(target, { userId: "boris" }, { rating: 5 }).mine.status, "hidden");
  assert.deepEqual(store.deleteWalkReview(target, { userId: "boris" }), { mine: null, summary: { average: null, count: 0 } });
  assert.deepEqual(store.deleteWalkReview(target, { userId: "boris" }).mine, null);
  assert.equal(store.moderateWalkReview(row.id, "publish"), null);
  assert.throws(() => store.moderateWalkReview(row.id, "approve"), { code: "BAD_REQUEST" });
});

test("reviews cascade with their author but outlive the walk and its sharing", () => {
  const { store } = setup();
  const walk = store.createWalk("anna", { title: "Моя", idempotencyKey: "review-walk-1", snapshot });
  const shared = store.setWalkSharing("anna", walk.id, walk.revision, true);
  const account = { kind: "account", id: walk.id, title: walk.title, revision: shared.revision };
  store.saveWalkReview(account, { guestKeyHash: guestKeyHash(GUEST_KEY) }, { rating: 4 });
  store.saveWalkReview(target, { userId: "boris" }, { rating: 5 });
  assert.equal(store.listWalkReviewsAdmin({ status: "all" }).reviews.find(row => row.walk.kind === "account").walk.shareToken, shared.shareToken);
  store.setWalkSharing("anna", walk.id, shared.revision, false);
  assert.equal(store.listWalkReviewsAdmin({ status: "all" }).reviews.find(row => row.walk.kind === "account").walk.shareToken, null);
  store.deleteWalk("anna", walk.id);
  const kept = store.listWalkReviewsAdmin({ status: "all" }).reviews.find(row => row.walk.kind === "account");
  assert.equal(kept.walk.title, "Моя");
  store.deleteAccountData("boris");
  assert.equal(store.listWalkReviewsAdmin({ status: "all" }).total, 1);
});

test("admin listing filters, counts pending reviews and clamps the offset", () => {
  const { store, tick } = setup();
  for (let index = 0; index < 4; index++) {
    tick();
    store.saveWalkReview({ ...target, id: `walk-${index}`, title: index % 2 ? "Арбат" : "Китай-город" }, { userId: "anna" }, { rating: index + 1, text: index < 3 ? "текст" : "" });
  }
  const all = store.listWalkReviewsAdmin({ status: "all" });
  assert.equal(all.total, 4); assert.equal(all.pending, 3);
  assert.equal(all.reviews[0].author.email, "anna@example.test");
  assert.equal(store.listWalkReviewsAdmin().total, 3);
  assert.equal(store.listWalkReviewsAdmin({ status: "published" }).total, 1);
  assert.equal(store.listWalkReviewsAdmin({ status: "all", rating: 2 }).reviews[0].rating, 2);
  assert.equal(store.listWalkReviewsAdmin({ status: "all", q: "АРБАТ" }).total, 2);
  const clamped = store.listWalkReviewsAdmin({ status: "all", limit: 2, offset: 40 });
  assert.equal(clamped.offset, 2); assert.equal(clamped.reviews.length, 2); assert.equal(clamped.hasMore, false);
  for (const filters of [{ status: "bad" }, { rating: 0 }, { rating: 6 }, { q: "x".repeat(121) }, { limit: 0 }, { limit: 51 }, { offset: -1 }]) {
    assert.throws(() => store.listWalkReviewsAdmin(filters), { code: "BAD_REQUEST" }, JSON.stringify(filters));
  }
  assert.equal(store.deleteWalkReviewAdmin(all.reviews[0].id), true);
  assert.equal(store.deleteWalkReviewAdmin(all.reviews[0].id), false);
});

test("review rate limiter allows 20 writes per sliding hour and keeps memory bounded", () => {
  let clock = 0;
  const limiter = createReviewRateLimiter({ now: () => clock });
  for (let index = 0; index < 20; index++) { assert.equal(limiter.check("ip:1").allowed, true); limiter.record("ip:1"); clock += 60_000; }
  const rejected = limiter.check("ip:1");
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.retryAfterSec, 2400);
  assert.equal(limiter.check("ip:1").allowed, false, "a rejected check does not reset the window");
  clock = 3_600_001;
  assert.equal(limiter.check("ip:1").allowed, true, "the oldest write slid out of the window");
  limiter.record("ip:1");
  assert.equal(limiter.check("ip:1").allowed, false);

  const small = createReviewRateLimiter({ limit: 1, windowMs: 1000, maxKeys: 2, now: () => clock });
  small.record("a"); small.record("b");
  small.record("c");
  assert.equal(small.size(), 2);
  assert.equal(small.check("a").allowed, true, "the oldest key was evicted");
  assert.equal(small.check("c").allowed, false);
  clock += 2000;
  small.record("d");
  assert.equal(small.size(), 1, "expired keys are pruned before eviction");
});

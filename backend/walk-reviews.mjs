import { createHash, randomUUID } from "node:crypto";

export const REVIEW_TEXT_MAX = 1000;
export const REVIEW_PAGE_SIZE = 20;
export const REVIEW_STATUSES = ["pending", "published", "hidden"];

const badRequest = message => Object.assign(new Error(message), { code: "BAD_REQUEST" });

/** Canonical review text: stored, compared and length-checked in this form. */
export function normalizeReviewText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw badRequest("Invalid review text");
  const text = value.normalize("NFC")
    .replace(/\r\n?/g, "\n")
    // Bidi overrides and zero-width characters (Cf), and control characters except the newline.
    .replace(/\p{Cf}|[^\n\P{Cc}]/gu, "")
    .split("\n").map(line => line.replace(/\s+$/u, "")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if ([...text].length > REVIEW_TEXT_MAX) throw badRequest("Review text is too long");
  return text;
}

export function validateRating(value) {
  if (!Number.isInteger(value) || value < 1 || value > 5) throw badRequest("Invalid rating");
  return value;
}

/**
 * Moderation state machine. Text needs an editor's approval; a rating alone does not.
 * An editor's "hidden" decision survives edits, so the author can only delete.
 * @param {{status?: unknown, text?: unknown} | null} previous
 * @param {string} nextText normalized
 */
export function nextReviewStatus(previous, nextText) {
  if (!previous) return nextText === "" ? "published" : "pending";
  if (previous.status === "hidden") return "hidden";
  if (nextText === "") return "published";
  if (nextText === previous.text && previous.status === "published") return "published";
  return "pending";
}

/** Guest keys are 32 random bytes, so a plain digest is enough; the raw key is never stored. */
export function guestKeyHash(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw badRequest("Invalid review key");
  return createHash("sha256").update(key).digest("hex");
}

/**
 * In-memory sliding-window limiter for review writes. State resets on restart and is not shared
 * between processes; the key count is bounded so a flood of client IPs cannot grow memory.
 */
export function createReviewRateLimiter({ limit = 20, windowMs = 3_600_000, maxKeys = 10_000, now = Date.now } = {}) {
  const hits = new Map();
  const live = key => {
    const since = now() - windowMs;
    const list = (hits.get(key) ?? []).filter(time => time > since);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };
  return {
    check(key) {
      const list = live(key);
      if (list.length < limit) return { allowed: true };
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - now()) / 1000)) };
    },
    record(key) {
      const list = live(key);
      if (!hits.has(key) && hits.size >= maxKeys) {
        for (const other of [...hits.keys()]) live(other);
        if (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
      }
      hits.set(key, [...list, now()]);
    },
    size: () => hits.size,
  };
}

const encodeCursor = row => Buffer.from(JSON.stringify({ time: row.created_at, id: row.id })).toString("base64url");
const decodeCursor = value => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString());
    if (typeof parsed?.time !== "string" || typeof parsed.id !== "string") throw new Error();
    return parsed;
  } catch { throw badRequest("Invalid cursor"); }
};

const viewerColumn = viewer => viewer?.userId ? ["user_id", viewer.userId]
  : viewer?.guestKeyHash ? ["guest_key_hash", viewer.guestKeyHash] : null;

/**
 * Reviews live in the account database: rows cascade with their author's account
 * but intentionally outlive the walk itself (no FK to user_walks).
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ now?: () => number, transaction: <T>(fn: () => T) => T }} options
 */
export function createWalkReviewStore(db, { now = Date.now, transaction }) {
  db.exec(`CREATE TABLE IF NOT EXISTS walk_reviews (
      id TEXT PRIMARY KEY,
      walk_kind TEXT NOT NULL CHECK(walk_kind IN ('catalog','account')),
      walk_id TEXT NOT NULL, walk_title TEXT NOT NULL, walk_revision INTEGER NOT NULL,
      user_id TEXT REFERENCES user(id) ON DELETE CASCADE, guest_key_hash TEXT,
      rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
      text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending','published','hidden')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, moderated_at TEXT, moderated_by TEXT,
      CHECK((user_id IS NULL) <> (guest_key_hash IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS walk_reviews_user ON walk_reviews(walk_kind, walk_id, user_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS walk_reviews_guest ON walk_reviews(walk_kind, walk_id, guest_key_hash) WHERE guest_key_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS walk_reviews_public ON walk_reviews(walk_kind, walk_id, status, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS walk_reviews_moderation ON walk_reviews(status, updated_at DESC, id DESC);`);
  const timestamp = () => new Date(now()).toISOString();

  const summary = target => {
    const row = db.prepare("SELECT count(*) AS count, avg(rating) AS average FROM walk_reviews WHERE walk_kind=? AND walk_id=? AND status='published'")
      .get(target.kind, target.id);
    const count = Number(row.count);
    return { average: count ? Math.round(Number(row.average) * 100) / 100 : null, count };
  };
  const findMine = (target, viewer) => {
    const column = viewerColumn(viewer);
    if (!column) return null;
    return db.prepare(`SELECT * FROM walk_reviews WHERE walk_kind=? AND walk_id=? AND ${column[0]}=?`).get(target.kind, target.id, column[1]) ?? null;
  };
  const mineView = row => row ? { rating: Number(row.rating), text: row.text, status: row.status, updatedAt: row.updated_at } : null;

  const adminSelect = `SELECT r.*, u.id AS author_id, u.name AS author_name, u.email AS author_email,
      CASE WHEN w.visibility='shared' THEN w.share_token END AS share_token
    FROM walk_reviews r LEFT JOIN user u ON u.id=r.user_id
    LEFT JOIN user_walks w ON r.walk_kind='account' AND w.id=r.walk_id`;
  const adminView = row => ({
    id: row.id, rating: Number(row.rating), text: row.text, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, moderatedAt: row.moderated_at ?? null,
    walk: { kind: row.walk_kind, id: row.walk_id, title: row.walk_title, shareToken: row.share_token ?? null },
    author: row.user_id ? { kind: "user", id: row.author_id ?? row.user_id, name: row.author_name ?? "", email: row.author_email ?? "" } : { kind: "guest" },
  });
  const adminRow = id => {
    const row = db.prepare(`${adminSelect} WHERE r.id=?`).get(id);
    return row ? adminView(row) : null;
  };

  return {
    getWalkReviews(target, viewer, { after = null, limit = REVIEW_PAGE_SIZE } = {}) {
      const cursor = decodeCursor(after);
      const where = "r.walk_kind=? AND r.walk_id=? AND r.status='published' AND r.text<>''";
      const select = `SELECT r.id, r.rating, r.text, r.created_at, r.user_id, u.name AS author_name
        FROM walk_reviews r LEFT JOIN user u ON u.id=r.user_id`;
      const rows = cursor
        ? db.prepare(`${select} WHERE ${where} AND (r.created_at<? OR (r.created_at=? AND r.id<?)) ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
          .all(target.kind, target.id, cursor.time, cursor.time, cursor.id, limit + 1)
        : db.prepare(`${select} WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`).all(target.kind, target.id, limit + 1);
      const reviews = rows.slice(0, limit).map(row => ({
        id: row.id,
        author: row.user_id ? (typeof row.author_name === "string" && row.author_name.trim() ? row.author_name.trim() : "Пользователь") : "Гость",
        rating: Number(row.rating), text: row.text, createdAt: row.created_at,
      }));
      return {
        summary: summary(target), reviews,
        nextCursor: rows.length > limit ? encodeCursor(rows[limit - 1]) : null,
        mine: mineView(findMine(target, viewer)),
      };
    },

    /** @param {any} target @param {any} viewer @param {{ rating: unknown, text?: unknown }} input */
    saveWalkReview(target, viewer, { rating, text }) {
      const column = viewerColumn(viewer);
      if (!column) throw badRequest("Reviewer is required");
      const value = validateRating(rating), clean = normalizeReviewText(text);
      return transaction(() => {
        const previous = findMine(target, viewer), status = nextReviewStatus(previous, clean), time = timestamp();
        if (previous) {
          db.prepare("UPDATE walk_reviews SET rating=?, text=?, status=?, walk_title=?, walk_revision=?, updated_at=? WHERE id=?")
            .run(value, clean, status, target.title, target.revision, time, previous.id);
        } else {
          db.prepare(`INSERT INTO walk_reviews(id, walk_kind, walk_id, walk_title, walk_revision, ${column[0]}, rating, text, status, created_at, updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
            .run(randomUUID(), target.kind, target.id, target.title, target.revision, column[1], value, clean, status, time, time);
        }
        return { mine: mineView(findMine(target, viewer)), summary: summary(target) };
      });
    },

    deleteWalkReview(target, viewer) {
      const column = viewerColumn(viewer);
      if (!column) throw badRequest("Reviewer is required");
      db.prepare(`DELETE FROM walk_reviews WHERE walk_kind=? AND walk_id=? AND ${column[0]}=?`).run(target.kind, target.id, column[1]);
      return { mine: null, summary: summary(target) };
    },

    listWalkReviewsAdmin({ status = "pending", rating = null, q = "", limit = 25, offset = 0 } = {}) {
      if (![...REVIEW_STATUSES, "all"].includes(status)
        || (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5))
        || typeof q !== "string" || q.length > 120
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
        || !Number.isSafeInteger(offset) || offset < 0) throw badRequest("Invalid review filters");
      const where = [], params = [];
      if (status !== "all") { where.push("r.status=?"); params.push(status); }
      if (rating !== null) { where.push("r.rating=?"); params.push(rating); }
      if (q.trim()) { where.push("instr(walk_search(r.walk_title), walk_search(?)) > 0"); params.push(q.trim()); }
      const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = Number(db.prepare(`SELECT count(*) AS total FROM walk_reviews r ${filter}`).get(...params).total);
      // Clamp in one query if moderation emptied the last page.
      const pageOffset = Math.min(offset, Math.max(0, Math.ceil(total / limit) - 1) * limit);
      const reviews = db.prepare(`${adminSelect} ${filter} ORDER BY r.updated_at DESC, r.id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, pageOffset).map(adminView);
      const pending = Number(db.prepare("SELECT count(*) AS count FROM walk_reviews WHERE status='pending'").get().count);
      return { reviews, total, offset: pageOffset, hasMore: pageOffset + reviews.length < total, pending };
    },

    moderateWalkReview(id, action, editorId = null) {
      if (!["publish", "hide"].includes(action)) throw badRequest("Invalid moderation action");
      const result = db.prepare("UPDATE walk_reviews SET status=?, moderated_at=?, moderated_by=? WHERE id=?")
        .run(action === "publish" ? "published" : "hidden", timestamp(), editorId, id);
      return result.changes ? adminRow(id) : null;
    },

    deleteWalkReviewAdmin(id) {
      return db.prepare("DELETE FROM walk_reviews WHERE id=?").run(id).changes > 0;
    },
  };
}

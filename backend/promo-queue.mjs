import { randomUUID } from "node:crypto";
import { nextSlots } from "./promo-slots.mjs";

// The promo queue: walks picked in the admin are built and published by otgolosok-shorts, one per slot.
// This store is the source of truth for order and public status; Shorts claims items and reports back.

export const ACTIVE_STATUSES = ["queued", "building", "ready"];
const STATUSES = [...ACTIVE_STATUSES, "published", "failed", "cancelled"];
/** Allowed transitions reported by Shorts. `ready → queued` is «Перенести»; `building → queued` releases a claim. */
const TRANSITIONS = {
  building: ["building", "ready", "failed", "queued"],
  ready: ["ready", "published", "failed", "cancelled", "queued"],
};
const HISTORY_LIMIT = 50;

const badRequest = message => Object.assign(new Error(message), { code: "BAD_REQUEST" });
const conflict = message => Object.assign(new Error(message), { code: "CONFLICT" });
const httpsUrl = value => typeof value === "string" && value.length <= 300 && /^https:\/\/[^\s<>"]+$/.test(value);

/**
 * @param {import("node:sqlite").DatabaseSync} db Account database (holds `user_walks`).
 * @param {{ now?: () => number, transaction: <T>(fn: () => T) => T }} options
 */
export function createPromoQueueStore(db, { now = Date.now, transaction }) {
  db.exec(`CREATE TABLE IF NOT EXISTS promo_queue (
      id TEXT PRIMARY KEY,
      walk_id TEXT NOT NULL REFERENCES user_walks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','building','ready','published','failed','cancelled')),
      slot_at TEXT, run_id TEXT, youtube_url TEXT, telegram_url TEXT, error TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS promo_queue_active_walk
      ON promo_queue(walk_id) WHERE status IN ('queued','building','ready');
    CREATE INDEX IF NOT EXISTS promo_queue_status_position ON promo_queue(status, position);`);

  const timestamp = () => new Date(now()).toISOString();
  const select = `SELECT q.*, w.title AS walk_title, w.share_token, w.visibility, w.user_id
    FROM promo_queue q LEFT JOIN user_walks w ON w.id = q.walk_id`;
  const item = (row, slotAt = row.slot_at ?? null) => ({
    id: row.id, walkId: row.walk_id, title: row.walk_title ?? "", shareToken: row.share_token ?? null,
    visibility: row.visibility ?? null, position: Number(row.position), status: row.status, slotAt,
    runId: row.run_id ?? null, youtubeUrl: row.youtube_url ?? null, telegramUrl: row.telegram_url ?? null,
    error: row.error ?? null, revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at,
  });
  /** @param {string} id @returns {any} */
  const byId = id => db.prepare(`${select} WHERE q.id = ?`).get(id);
  const maxPosition = () => Number(db.prepare("SELECT coalesce(max(position), 0) AS p FROM promo_queue").get().p);
  const minPosition = () => Number(db.prepare("SELECT coalesce(min(position), 1) AS p FROM promo_queue").get().p);

  /**
   * Locks the row to the revision the caller saw.
   * @param {string} id @param {unknown} revision @returns {any}
   */
  function current(id, revision) {
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) throw badRequest("Invalid revision");
    const row = byId(id);
    if (!row) return null;
    if (Number(row.revision) !== revision) throw conflict("Очередь изменилась — обновите список.");
    return row;
  }

  /** Active items in order with planned slots: a ready item keeps its fixed slot, the rest take free slots in order. */
  function active() {
    const rows = db.prepare(`${select} WHERE q.status IN ('queued','building','ready') ORDER BY q.position, q.created_at`).all();
    const fixed = new Set(rows.filter(row => row.status === "ready" && row.slot_at).map(row => row.slot_at));
    const free = nextSlots(new Date(now()), rows.length + fixed.size).filter(slot => !fixed.has(slot));
    return rows.map(row => (row.status === "ready" && row.slot_at ? item(row) : item(row, free.shift() ?? null)));
  }

  return {
    /** Puts a shared walk at the end of the queue. Null when the walk does not exist. */
    enqueuePromo(walkId) {
      if (typeof walkId !== "string" || !walkId) throw badRequest("Invalid walkId");
      return transaction(() => {
        const walk = db.prepare("SELECT id, share_token, visibility FROM user_walks WHERE id = ?").get(walkId);
        if (!walk) return null;
        if (!walk.share_token || !["shared", "public"].includes(String(walk.visibility)))
          throw conflict("Прогулка не открыта по ссылке — её нельзя поставить в промо.");
        if (db.prepare("SELECT 1 FROM promo_queue WHERE walk_id = ? AND status IN ('queued','building','ready')").get(walkId))
          throw conflict("Прогулка уже в очереди промо.");
        const id = randomUUID(), time = timestamp();
        db.prepare("INSERT INTO promo_queue (id, walk_id, position, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)")
          .run(id, walkId, maxPosition() + 1, time, time);
        return active().find(entry => entry.id === id);
      });
    },

    /** Active items with planned slots, then the latest finished ones. */
    listPromoQueue() {
      const history = db.prepare(`${select} WHERE q.status IN ('published','failed','cancelled') ORDER BY q.updated_at DESC LIMIT ?`)
        .all(HISTORY_LIMIT).map(row => item(row));
      return { items: active(), history };
    },

    /** Removes a queued, failed or cancelled item; items being built or ready are handled by Shorts. */
    removePromo(id, revision) {
      return transaction(() => {
        const row = current(id, revision);
        if (!row) return false;
        if (!["queued", "failed", "cancelled"].includes(row.status)) throw conflict("Выпуск уже собирается — отменить его можно из бота.");
        db.prepare("DELETE FROM promo_queue WHERE id = ?").run(id);
        return true;
      });
    },

    /** Swaps a queued item with the queued item before it. */
    movePromoUp(id, revision) {
      return transaction(() => {
        const row = current(id, revision);
        if (!row) return null;
        if (row.status !== "queued") throw conflict("Передвигать можно только ожидающие выпуски.");
        const previous = db.prepare("SELECT id, position FROM promo_queue WHERE status = 'queued' AND position < ? ORDER BY position DESC LIMIT 1").get(row.position);
        if (previous) {
          const time = timestamp();
          db.prepare("UPDATE promo_queue SET position = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(row.position, time, previous.id);
          db.prepare("UPDATE promo_queue SET position = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(previous.position, time, id);
        }
        return active().find(entry => entry.id === id);
      });
    },

    /** Puts a failed or cancelled item back at the end of the queue. */
    requeuePromo(id, revision) {
      return transaction(() => {
        const row = current(id, revision);
        if (!row) return null;
        if (!["failed", "cancelled"].includes(row.status)) throw conflict("Вернуть можно только неудачный или отменённый выпуск.");
        if (db.prepare("SELECT 1 FROM promo_queue WHERE walk_id = ? AND status IN ('queued','building','ready')").get(row.walk_id))
          throw conflict("Прогулка уже в очереди промо.");
        db.prepare(`UPDATE promo_queue SET status = 'queued', position = ?, slot_at = NULL, run_id = NULL, error = NULL,
          revision = revision + 1, updated_at = ? WHERE id = ?`).run(maxPosition() + 1, timestamp(), id);
        return active().find(entry => entry.id === id);
      });
    },

    /**
     * Shorts takes the first `count` queued items for building. A walk no longer shared fails at once.
     * @param {number} count
     */
    claimPromo(count) {
      if (!Number.isSafeInteger(count) || count < 1 || count > 3) throw badRequest("Invalid count");
      return transaction(() => {
        const claimed = [];
        const rows = db.prepare(`${select} WHERE q.status = 'queued' ORDER BY q.position, q.created_at`).all();
        for (const row of rows) {
          if (claimed.length === count) break;
          const time = timestamp();
          if (!row.share_token || !["shared", "public"].includes(String(row.visibility))) {
            db.prepare("UPDATE promo_queue SET status = 'failed', error = 'WALK_NOT_SHARED', revision = revision + 1, updated_at = ? WHERE id = ?").run(time, row.id);
            continue;
          }
          db.prepare("UPDATE promo_queue SET status = 'building', revision = revision + 1, updated_at = ? WHERE id = ?").run(time, row.id);
          claimed.push(item(byId(String(row.id))));
        }
        return claimed;
      });
    },

    getPromo(id) {
      const row = byId(id);
      return row ? item(row) : null;
    },

    /**
     * Shorts reports progress. Only the transitions in TRANSITIONS are accepted.
     * @param {string} id @param {Record<string, unknown>} patch
     */
    reportPromo(id, patch) {
      const allowed = ["status", "revision", "runId", "slotAt", "youtubeUrl", "telegramUrl", "error"];
      if (!patch || typeof patch !== "object" || Object.keys(patch).some(key => !allowed.includes(key))) throw badRequest("Unknown promo report field");
      const { status, revision, runId, slotAt, youtubeUrl, telegramUrl, error } = patch;
      if (!STATUSES.includes(/** @type {string} */ (status))) throw badRequest("Invalid status");
      if (runId !== undefined && (typeof runId !== "string" || !/^[\w.-]{1,80}$/.test(runId))) throw badRequest("Invalid runId");
      if (slotAt !== undefined && slotAt !== null && (typeof slotAt !== "string" || Number.isNaN(Date.parse(slotAt)))) throw badRequest("Invalid slotAt");
      for (const url of [youtubeUrl, telegramUrl]) if (url !== undefined && !httpsUrl(url)) throw badRequest("Invalid URL");
      if (error !== undefined && (typeof error !== "string" || error.length > 500)) throw badRequest("Invalid error");
      if (status === "published" && (!youtubeUrl || !telegramUrl)) throw badRequest("Published needs both URLs");
      if (status === "failed" && !error) throw badRequest("Failed needs an error");
      const next = /** @type {string} */ (status);
      const text = value => (value === undefined ? undefined : /** @type {string | null} */ (value));
      return transaction(() => {
        const row = current(id, revision);
        if (!row) return null;
        if (!(TRANSITIONS[row.status] ?? []).includes(next))
          throw conflict(`Переход ${row.status} → ${next} недопустим`);
        const back = next === "queued";
        db.prepare(`UPDATE promo_queue SET status = ?, position = ?, slot_at = ?, run_id = ?, youtube_url = ?, telegram_url = ?,
          error = ?, revision = revision + 1, updated_at = ? WHERE id = ?`).run(
          next,
          // «Перенести» and a released claim go to the head of the queue.
          back ? minPosition() - 1 : Number(row.position),
          back ? null : slotAt === undefined ? row.slot_at : text(slotAt),
          back ? null : text(runId) ?? row.run_id,
          text(youtubeUrl) ?? row.youtube_url, text(telegramUrl) ?? row.telegram_url,
          next === "failed" || next === "cancelled" ? text(error) ?? null : null,
          timestamp(), id);
        return item(byId(id));
      });
    },

    /** Promo state of walks for the admin list: the active item, else the last published one. */
    promoStates(walkIds) {
      const states = new Map();
      if (!walkIds.length) return states;
      const rows = db.prepare(`SELECT walk_id, status, slot_at, youtube_url FROM promo_queue
        WHERE walk_id IN (${walkIds.map(() => "?").join(",")}) AND status IN ('queued','building','ready','published')
        ORDER BY CASE WHEN status = 'published' THEN 1 ELSE 0 END, updated_at DESC`).all(...walkIds);
      const planned = new Map(active().map(entry => [entry.walkId, entry.slotAt]));
      for (const row of rows) if (!states.has(row.walk_id))
        states.set(row.walk_id, { status: row.status, slotAt: row.status === "published" ? row.slot_at ?? null : planned.get(row.walk_id) ?? null, youtubeUrl: row.youtube_url ?? null });
      return states;
    },
  };
}

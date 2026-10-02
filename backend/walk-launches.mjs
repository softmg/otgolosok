import { createHash } from "node:crypto";
import { guestKeyHash } from "./walk-reviews.mjs";

const DAY_MS = 86_400_000;
const PRUNE_INTERVAL_MS = 3_600_000;
// Moscow has had a fixed UTC+3 offset without DST since 2014.
const MOSCOW_OFFSET_MS = 3 * 3_600_000;

/** Moscow calendar date (YYYY-MM-DD) of a timestamp. */
export const moscowDay = time => new Date(time + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);

const digest = value => createHash("sha256").update(value).digest("hex");

/**
 * Pseudonymous launch viewer: a signed-in account, or a guest's device key. The raw key is
 * validated like a review key and never stored; returns null when there is no identity.
 * @param {{userId?: string | null, guestKey?: unknown}} viewer
 */
export function launchViewerHash({ userId = null, guestKey } = {}) {
  if (userId) return digest(`user:${userId}`);
  if (guestKey === undefined) return null;
  guestKeyHash(guestKey);
  return digest(`device:${guestKey}`);
}

/**
 * Launch counters of catalog and account walks. Marks deduplicate one viewer per walk per Moscow
 * day and are pruned after two days; daily aggregates keep the history. Like reviews, the tables
 * have no FK to the walk, so a deleted walk leaves orphan aggregates that the top ignores.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ now?: () => number, transaction: <T>(fn: () => T) => T }} options
 */
export function createWalkLaunchStore(db, { now = Date.now, transaction }) {
  db.exec(`CREATE TABLE IF NOT EXISTS walk_launch_marks (
      walk_kind TEXT NOT NULL CHECK(walk_kind IN ('catalog','account')), walk_id TEXT NOT NULL,
      viewer_hash TEXT NOT NULL, day TEXT NOT NULL,
      PRIMARY KEY(walk_kind, walk_id, viewer_hash, day)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS walk_launch_marks_day ON walk_launch_marks(day);
    CREATE TABLE IF NOT EXISTS walk_launch_days (
      walk_kind TEXT NOT NULL CHECK(walk_kind IN ('catalog','account')), walk_id TEXT NOT NULL,
      day TEXT NOT NULL, launches INTEGER NOT NULL,
      PRIMARY KEY(walk_kind, walk_id, day)
    ) WITHOUT ROWID;`);
  let prunedAt = -Infinity;

  return {
    /** @param {{kind: "catalog" | "account", id: string}} target @param {string} viewerHash */
    recordLaunch(target, viewerHash) {
      if (!["catalog", "account"].includes(target?.kind) || typeof target.id !== "string" || typeof viewerHash !== "string")
        throw Object.assign(new Error("Invalid launch"), { code: "BAD_REQUEST" });
      const time = now(), day = moscowDay(time);
      return transaction(() => {
        if (time - prunedAt >= PRUNE_INTERVAL_MS) {
          db.prepare("DELETE FROM walk_launch_marks WHERE day < ?").run(moscowDay(time - DAY_MS));
          prunedAt = time;
        }
        const mark = db.prepare("INSERT OR IGNORE INTO walk_launch_marks VALUES(?,?,?,?)").run(target.kind, target.id, viewerHash, day);
        if (!mark.changes) return { counted: false };
        db.prepare(`INSERT INTO walk_launch_days VALUES(?,?,?,1)
          ON CONFLICT(walk_kind, walk_id, day) DO UPDATE SET launches = launches + 1`).run(target.kind, target.id, day);
        return { counted: true };
      });
    },
    /** @returns {Map<string, number>} all-time launches keyed by "kind:id" */
    launchTotals() {
      return new Map(db.prepare("SELECT walk_kind, walk_id, SUM(launches) AS launches FROM walk_launch_days GROUP BY walk_kind, walk_id").all()
        .map(row => [`${row.walk_kind}:${row.walk_id}`, Number(row.launches)]));
    },
    /**
     * All-time launches of the given walks of one kind; a walk without launches gets 0. The ids go
     * in as one JSON value, so a long page never hits SQLite's bound-variable limit.
     * @param {"catalog" | "account"} kind @param {string[]} ids @returns {Map<string, number>}
     */
    launchCounts(kind, ids) {
      const counts = new Map(ids.map(id => [id, 0]));
      if (!ids.length) return counts;
      for (const row of db.prepare(`SELECT walk_id, SUM(launches) AS launches FROM walk_launch_days
          WHERE walk_kind = ? AND walk_id IN (SELECT value FROM json_each(?)) GROUP BY walk_id`).all(kind, JSON.stringify(ids)))
        counts.set(String(row.walk_id), Number(row.launches));
      return counts;
    },
  };
}

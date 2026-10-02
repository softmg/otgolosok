import { moderatedTextHash } from "./walk-listing.mjs";

const badRequest = message => Object.assign(new Error(message), { code: "BAD_REQUEST" });

/**
 * Editor view of link-only and public account walks (they live in the auth database,
 * separately from editorial chapters), and pre-moderation of public walks for the top.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ viewWalk: (row: any) => any, documentOf: (row: any) => any,
 *   launchCounts: (kind: "account", ids: string[]) => Map<string, number>, now?: () => number }} options
 */
export function createSharedWalkAdminStore(db, { viewWalk, documentOf, launchCounts, now = Date.now }) {
  db.exec(`DROP INDEX IF EXISTS user_walks_shared_updated;
    CREATE INDEX IF NOT EXISTS user_walks_linked_updated
    ON user_walks(updated_at DESC, id DESC) WHERE visibility IN ('shared', 'public')`);
  db.function("walk_search", { deterministic: true }, value =>
    typeof value === "string" ? value.normalize("NFKC").toLocaleLowerCase("ru-RU") : "");

  const select = "SELECT w.*, u.id AS author_id, u.name AS author_name, u.email AS author_email FROM user_walks w LEFT JOIN user u ON u.id = w.user_id";
  const adminRow = (row, launches) => {
    const view = viewWalk(row);
    const document = view.snapshotError ? null : view.snapshot;
    return {
      id: row.id, title: row.title, shareToken: row.share_token, revision: Number(row.revision),
      visibility: row.visibility, listingStatus: row.visibility === "public" ? row.listing_status ?? null : null,
      createdAt: row.created_at, updatedAt: row.updated_at,
      author: row.author_id ? { id: row.author_id, name: row.author_name, email: row.author_email } : null,
      mode: document?.mode ?? null, stopCount: document?.stops.length ?? null,
      walkingMinutes: document?.route?.walkingMinutes ?? null,
      distanceM: document?.route?.distanceM ?? null,
      snapshotError: view.snapshotError ?? null,
      launches,
    };
  };

  return {
    listSharedWalksAdmin({ limit = 25, offset = 0, q = "", author = "", mode = "all", access = "all", listing = "all" } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50
        || !Number.isSafeInteger(offset) || offset < 0
        || typeof q !== "string" || q.length > 120
        || typeof author !== "string" || author.length > 120
        || !["all", "open", "loop"].includes(mode)
        || !["all", "shared", "public"].includes(access)
        || !["all", "pending", "approved", "hidden"].includes(listing)) {
        throw badRequest("Invalid shared walk filters");
      }
      const where = ["w.visibility IN ('shared', 'public')", "w.share_token IS NOT NULL"];
      const params = [];
      if (access !== "all") {
        where.push("w.visibility = ?");
        params.push(access);
      }
      // The listing state belongs to public walks only.
      if (listing !== "all") {
        where.push("w.visibility = 'public' AND w.listing_status = ?");
        params.push(listing);
      }
      if (q.trim()) {
        where.push("instr(walk_search(w.title), walk_search(?)) > 0");
        params.push(q.trim());
      }
      if (author.trim()) {
        where.push("(instr(walk_search(u.name), walk_search(?)) > 0 OR instr(walk_search(u.email), walk_search(?)) > 0)");
        params.push(author.trim(), author.trim());
      }
      if (mode !== "all") {
        where.push("json_extract(CASE WHEN json_valid(w.snapshot_json) THEN w.snapshot_json ELSE '{}' END, '$.mode') = ?");
        params.push(mode);
      }
      const from = `FROM user_walks w LEFT JOIN user u ON u.id = w.user_id WHERE ${where.join(" AND ")}`;
      const total = Number(db.prepare(`SELECT count(*) AS total ${from}`).get(...params).total);
      // Clamp in one query if deletion or revoked sharing removed the last page.
      const pageOffset = Math.min(offset, Math.max(0, Math.ceil(total / limit) - 1) * limit);
      const rows = db.prepare(`SELECT w.*, u.id AS author_id, u.name AS author_name, u.email AS author_email
        ${from} ORDER BY w.updated_at DESC, w.id DESC LIMIT ? OFFSET ?`).all(...params, limit, pageOffset);
      const launches = launchCounts("account", rows.map(row => String(row.id)));
      const walks = rows.map(row => adminRow(row, launches.get(String(row.id)) ?? 0));
      const pending = Number(db.prepare("SELECT count(*) AS count FROM user_walks WHERE visibility = 'public' AND listing_status = 'pending'").get().count);
      return { walks, total, offset: pageOffset, hasMore: pageOffset + walks.length < total, pending };
    },

    /**
     * Approves or hides a public walk for the top. The revision pins the texts the editor saw;
     * moderation never bumps it, so owners get no edit conflicts from editors.
     * @param {string} id @param {{action: unknown, revision: unknown}} input
     */
    moderateWalkListing(id, { action, revision }) {
      if (!["approve", "hide"].includes(/** @type {string} */ (action)) || !Number.isSafeInteger(revision) || /** @type {number} */ (revision) < 0)
        throw badRequest("Invalid listing moderation");
      const row = db.prepare("SELECT * FROM user_walks WHERE id = ?").get(id);
      if (!row) return null;
      if (row.visibility !== "public") throw Object.assign(new Error("Прогулка больше не открыта всем — обновите список."), { code: "CONFLICT" });
      if (Number(row.revision) !== revision) throw Object.assign(new Error("Прогулка изменилась — обновите список."), { code: "CONFLICT" });
      const time = new Date(now()).toISOString();
      if (action === "approve") {
        const document = documentOf(row);
        if (!document?.route) throw Object.assign(new Error("Снимок прогулки повреждён — одобрить нельзя."), { code: "CONFLICT" });
        db.prepare("UPDATE user_walks SET listing_status = 'approved', listing_text_hash = ?, listing_updated_at = ? WHERE id = ?")
          .run(moderatedTextHash(String(row.title), document), time, id);
      } else {
        db.prepare("UPDATE user_walks SET listing_status = 'hidden', listing_updated_at = ? WHERE id = ?").run(time, id);
      }
      return adminRow(db.prepare(`${select} WHERE w.id = ?`).get(id), launchCounts("account", [id]).get(id) ?? 0);
    },
  };
}

// Account walks live in the auth database, separately from editorial chapters.
export function createSharedWalkAdminStore(db, viewWalk) {
  db.exec(`CREATE INDEX IF NOT EXISTS user_walks_shared_updated
    ON user_walks(updated_at DESC, id DESC) WHERE visibility = 'shared'`);
  db.function("walk_search", { deterministic: true }, value =>
    typeof value === "string" ? value.normalize("NFKC").toLocaleLowerCase("ru-RU") : "");

  return {
    listSharedWalksAdmin({ limit = 25, offset = 0, q = "", author = "", mode = "all" } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50
        || !Number.isSafeInteger(offset) || offset < 0
        || typeof q !== "string" || q.length > 120
        || typeof author !== "string" || author.length > 120
        || !["all", "open", "loop"].includes(mode)) {
        throw Object.assign(new Error("Invalid shared walk filters"), { code: "BAD_REQUEST" });
      }
      const where = ["w.visibility = 'shared'", "w.share_token IS NOT NULL"];
      const params = [];
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
      const walks = rows.map(row => {
        const view = viewWalk(row);
        const document = view.snapshotError ? null : view.snapshot;
        return {
          id: row.id, title: row.title, shareToken: row.share_token,
          createdAt: row.created_at, updatedAt: row.updated_at,
          author: row.author_id ? { id: row.author_id, name: row.author_name, email: row.author_email } : null,
          mode: document?.mode ?? null, stopCount: document?.stops.length ?? null,
          walkingMinutes: document?.route?.walkingMinutes ?? null,
          distanceM: document?.route?.distanceM ?? null,
          snapshotError: view.snapshotError ?? null,
        };
      });
      return { walks, total, offset: pageOffset, hasMore: pageOffset + walks.length < total };
    },
  };
}

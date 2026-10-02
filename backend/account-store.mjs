import { createSharedWalkAdminStore } from "./shared-walk-admin.mjs";
import { createWalkReviewStore } from "./walk-reviews.mjs";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { validateWalkDocument, migrateLegacyDraft } from "./walk-document.mjs";
import { createWalkLaunchStore } from "./walk-launches.mjs";
import { moderatedTextHash } from "./walk-listing.mjs";
import { PROMO_WALKS_USER_ID } from "./promo-walks.mjs";

export { moderatedTextHash };
export const WALK_VISIBILITIES = ["private", "shared", "public"];
const linked = visibility => visibility === "shared" || visibility === "public";

const encode = JSON.stringify;
const decode = value => JSON.parse(value);
const cleanName = value => {
  if (typeof value !== "string") throw Object.assign(new Error("Invalid name"), { code: "BAD_REQUEST" });
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 80 || /[\p{Cc}\p{Cf}<>]/u.test(name)) throw Object.assign(new Error("Invalid name"), { code: "BAD_REQUEST" });
  return name;
};
const cleanTitle = value => {
  if (typeof value !== "string") throw Object.assign(new Error("Invalid title"), { code: "BAD_REQUEST" });
  const title = value.trim().replace(/\s+/g, " ");
  if (!title || title.length > 120 || /[\p{Cc}\p{Cf}<>]/u.test(title)) throw Object.assign(new Error("Invalid title"), { code: "BAD_REQUEST" });
  return title;
};
const validateSnapshot = snapshot => {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || encode(snapshot).length > 100_000) throw Object.assign(new Error("Invalid walk"), { code: "BAD_REQUEST" });
  return snapshot;
};
const fingerprint = value => createHash("sha256").update(encode(value)).digest("hex");
const conflict = () => Object.assign(new Error("Walk revision or idempotency conflict"), {code:"CONFLICT"});
const storageLimit = message => Object.assign(new Error(message), { code: "STORAGE_LIMIT" });
export const MAX_WALKS_PER_USER = 200;
export const MAX_FAVORITES_PER_USER = 1000;
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

export function createAccountStore(db, now = Date.now) {
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS user_walks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      title TEXT NOT NULL, snapshot_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS user_walks_owner_updated ON user_walks(user_id,updated_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS user_favorites (
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, object_type TEXT NOT NULL,
      object_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,object_type,object_id)
    );
    CREATE TABLE IF NOT EXISTS user_generation_requests (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL, operation TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(user_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS user_requests_owner_created ON user_generation_requests(user_id,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS account_imports (
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, import_id TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,import_id)
    );
    CREATE TABLE IF NOT EXISTS user_walk_idempotency (
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL,
      walk_id TEXT NOT NULL REFERENCES user_walks(id) ON DELETE CASCADE, PRIMARY KEY(user_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS user_generation_quota (
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
      units INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS user_generation_quota_owner_created ON user_generation_quota(user_id,created_at);
    CREATE TABLE IF NOT EXISTS user_generation_intents (
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL,
      operation TEXT NOT NULL, request_fingerprint TEXT NOT NULL, job_id TEXT, created_at TEXT NOT NULL,
      PRIMARY KEY(user_id,idempotency_key)
    );
    `);
  const columns = db.prepare("PRAGMA table_info(user_walks)").all().map(row=>row.name);
  if(!columns.includes("visibility"))db.exec("ALTER TABLE user_walks ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
  if(!columns.includes("share_token"))db.exec("ALTER TABLE user_walks ADD COLUMN share_token TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS user_walks_share_token ON user_walks(share_token) WHERE share_token IS NOT NULL");
  const timestamp = () => new Date(now()).toISOString();
  // The outermost call owns BEGIN IMMEDIATE/COMMIT; nested calls join it, so a
  // composite operation such as importLocal commits or rolls back as a whole.
  let depth = 0;
  const transaction = fn => {
    if (depth) return fn();
    db.exec("BEGIN IMMEDIATE");
    depth++;
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
    finally { depth--; }
  };
  const count = (table, userId) => Number(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE user_id=?`).get(userId).count);
  const cursor = value => { if(!value)return null;try{const parsed=decode(Buffer.from(value,"base64url").toString());if(typeof parsed.time!=="string"||typeof parsed.id!=="string")throw new Error();return parsed;}catch{throw Object.assign(new Error("Invalid cursor"),{code:"BAD_REQUEST"});} };
  const page = (rows,limit,map) => ({items:rows.slice(0,limit).map(map),nextCursor:rows.length>limit?Buffer.from(encode({time:rows[limit-1].updated_at??rows[limit-1].created_at,id:rows[limit-1].id??`${rows[limit-1].object_type}:${rows[limit-1].object_id}`})).toString("base64url"):null});
  const normalizeWalk = (snapshot,id) => snapshot?.version===2?validateWalkDocument(snapshot):migrateLegacyDraft(validateSnapshot(snapshot),id);
  /** The decoded document of a row, or null when the stored snapshot is damaged. */
  const documentOf = row => { try { return normalizeWalk(decode(row.snapshot_json), row.id); } catch { return null; } };
  // Listing state of public walks: NULL | pending | approved | hidden. The ALTER and the one-time
  // promo backfill share a transaction, so the backfill runs exactly once.
  if(!columns.includes("listing_status"))transaction(()=>{
    db.exec(`ALTER TABLE user_walks ADD COLUMN listing_status TEXT;
      ALTER TABLE user_walks ADD COLUMN listing_text_hash TEXT;
      ALTER TABLE user_walks ADD COLUMN listing_updated_at TEXT;`);
    // Promo walks used to be link-only; the trusted promo service now publishes them to the top.
    // revision/updated_at stay as they are: this is a system migration, not an owner edit.
    const time=timestamp(),approve=db.prepare("UPDATE user_walks SET visibility='public',listing_status='approved',listing_text_hash=?,listing_updated_at=? WHERE id=?");
    for(const row of db.prepare("SELECT id,title,snapshot_json FROM user_walks WHERE user_id=? AND visibility='shared'").all(PROMO_WALKS_USER_ID)){
      const document=documentOf(row);
      if(document)approve.run(moderatedTextHash(row.title,document),time,row.id);
    }
  });
  db.exec("CREATE INDEX IF NOT EXISTS user_walks_public_listing ON user_walks(listing_status,listing_updated_at DESC,id DESC) WHERE visibility='public'");
  const viewWalk = row => {
    if (!row) return null;
    const access = { visibility: row.visibility, shareToken: linked(row.visibility) ? row.share_token : null,
      // A non-public walk never shows a stale listing state to its owner.
      listingStatus: row.visibility === "public" ? row.listing_status ?? null : null };
    let raw;
    try { raw = decode(row.snapshot_json); }
    catch { return { id: row.id, title: row.title, snapshot: null, revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at,
      ...access, snapshotError: "Снимок прогулки повреждён." }; }
    let snapshot = raw;
    let snapshotError = null;
    try { snapshot = normalizeWalk(raw, row.id); }
    catch (error) { snapshotError = error.code === "BAD_REQUEST" ? "Снимок прогулки повреждён." : "Не удалось проверить снимок прогулки."; }
    return { id: row.id, title: row.title, snapshot, revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at,
      ...access, ...(snapshotError ? { snapshotError } : {}) };
  };
  const listItem = row => {
    const view = viewWalk(row);
    const snapshot = view.snapshotError ? null : view.snapshot;
    return {id:row.id,title:row.title,revision:Number(row.revision),updatedAt:row.updated_at,visibility:view.visibility,shareToken:view.shareToken,listingStatus:view.listingStatus,
      ...(snapshot ? {draft:!snapshot.route,walkingMinutes:snapshot.route?.walkingMinutes??null,distanceM:snapshot.route?.distanceM??null} : {})};
  };
  const launches = createWalkLaunchStore(db, { now, transaction });
  return {
    ...createSharedWalkAdminStore(db, { viewWalk, documentOf, launchCounts: launches.launchCounts, now }),
    ...createWalkReviewStore(db, { now, transaction }),
    ...launches,
    updateProfile(userId, name) { const value=cleanName(name),time=timestamp();db.prepare("UPDATE user SET name=?,updatedAt=? WHERE id=?").run(value,time,userId);return value; },
    listWalks(userId, limit=20,after=null) { limit=Math.min(50,Math.max(1,limit));const c=cursor(after),rows=c?db.prepare("SELECT * FROM user_walks WHERE user_id=? AND (updated_at<? OR (updated_at=? AND id<?)) ORDER BY updated_at DESC,id DESC LIMIT ?").all(userId,c.time,c.time,c.id,limit+1):db.prepare("SELECT * FROM user_walks WHERE user_id=? ORDER BY updated_at DESC,id DESC LIMIT ?").all(userId,limit+1);const result=page(rows,limit,listItem);return {walks:result.items,nextCursor:result.nextCursor,hasMore:Boolean(result.nextCursor)}; },
    getWalk(userId,id) { return viewWalk(db.prepare("SELECT * FROM user_walks WHERE id=? AND user_id=?").get(id,userId)) ?? null; },
    // Only the promo-walks service account raises maxWalks; every person keeps the default cap.
    createWalk(userId,{title,snapshot,idempotencyKey},{maxWalks=MAX_WALKS_PER_USER}={}) {
      if(typeof idempotencyKey!=="string"||!/^[\w.-]{8,100}$/.test(idempotencyKey))throw Object.assign(new Error(),{code:"BAD_REQUEST"});
      const clean=cleanTitle(title);
      const prior=db.prepare("SELECT w.* FROM user_walk_idempotency i JOIN user_walks w ON w.id=i.walk_id WHERE i.user_id=? AND i.idempotency_key=?").get(userId,idempotencyKey);
      if(prior){
        const normalized=normalizeWalk(snapshot,prior.id);
        if(fingerprint({title:clean,snapshot:normalized})!==fingerprint({title:prior.title,snapshot:normalizeWalk(decode(prior.snapshot_json),prior.id)}))throw conflict();
        return viewWalk(prior);
      }
      const id=transaction(()=>{
        if(count("user_walks",userId)>=maxWalks)throw storageLimit(`Можно сохранить не больше ${maxWalks} прогулок. Удалите ненужные.`);
        // Catalog slugs are valid document IDs for read-only views, but an
        // account record must remain addressable by the UUID-only account API.
        // Walk IDs are global keys: a document copied from another account (for
        // example a shared walk) gets a fresh ID instead of a conflict that would
        // also reveal that the ID exists.
        const requested=snapshot?.version===2&&uuid(snapshot.id)?snapshot.id:null;
        const owner=requested?db.prepare("SELECT user_id FROM user_walks WHERE id=?").get(requested)?.user_id:undefined;
        const id=requested&&(owner===undefined||owner===userId)?requested:randomUUID();
        const time=timestamp(),normalized=normalizeWalk(snapshot?.version===2&&snapshot.id!==id?{...snapshot,id}:snapshot,id);
        try {
          db.prepare("INSERT INTO user_walks(id,user_id,title,snapshot_json,revision,created_at,updated_at,visibility,share_token) VALUES(?,?,?,?,0,?,?,?,?)").run(id,userId,clean,encode(normalized),time,time,"private",null);
          db.prepare("INSERT INTO user_walk_idempotency VALUES(?,?,?)").run(userId,idempotencyKey,id);
        } catch(error) {
          if(String(error?.code??"").startsWith("SQLITE_CONSTRAINT")) throw conflict();
          throw error;
        }
        return id;
      });
      return this.getWalk(userId,id);
    },
    findWalkByIdempotencyKey(userId,key) {
      if(typeof key!=="string")return null;
      return viewWalk(db.prepare("SELECT w.* FROM user_walk_idempotency i JOIN user_walks w ON w.id=i.walk_id WHERE i.user_id=? AND i.idempotency_key=?").get(userId,key))??null;
    },
    updateWalk(userId,id,{title,snapshot,revision}) {
      if(!uuid(id)||!Number.isSafeInteger(revision)||revision<0)throw Object.assign(new Error("Invalid walk revision"),{code:"BAD_REQUEST"});
      const normalized=normalizeWalk(snapshot,id);
      if(normalized.id!==id)throw Object.assign(new Error("Walk ID does not match the account record"),{code:"BAD_REQUEST"});
      const clean=cleanTitle(title);
      return transaction(()=>{
        const time=timestamp(),result=db.prepare("UPDATE user_walks SET title=?,snapshot_json=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=?").run(clean,encode(normalized),time,id,userId,revision);
        if(!result.changes){if(!this.getWalk(userId,id))return null;throw conflict();}
        // Changed moderated texts send an approved public walk back to the editors; pending and
        // hidden walks keep their state, and a route-only rebuild keeps the approval.
        const row=db.prepare("SELECT visibility,listing_status,listing_text_hash FROM user_walks WHERE id=?").get(id);
        if(row.visibility==="public"&&row.listing_status==="approved"&&moderatedTextHash(clean,normalized)!==row.listing_text_hash)
          db.prepare("UPDATE user_walks SET listing_status='pending',listing_updated_at=? WHERE id=?").run(time,id);
        return this.getWalk(userId,id);
      });
    },
    getSharedWalk(token) {if(typeof token!=="string"||!uuid(token))return null;return viewWalk(db.prepare("SELECT * FROM user_walks WHERE share_token=? AND visibility IN ('shared','public')").get(token))??null;},
    /** Launch-counting target of a link: the owner id stays on the server and never reaches a public view. */
    getLaunchTarget(token) {
      if(typeof token!=="string"||!uuid(token))return null;
      const row=db.prepare("SELECT id,user_id,snapshot_json FROM user_walks WHERE share_token=? AND visibility IN ('shared','public')").get(token);
      return row&&documentOf(row)?{id:row.id,userId:row.user_id}:null;
    },
    /**
     * @param {string} userId @param {string} id @param {number} revision
     * @param {string} visibility private | shared | public
     * @param {{autoApprove?: boolean}} [options] trusted services skip pre-moderation of the top
     */
    setWalkVisibility(userId,id,revision,visibility,{autoApprove=false}={}) {
      if(!uuid(id)||!Number.isSafeInteger(revision)||revision<0||!WALK_VISIBILITIES.includes(visibility))throw Object.assign(new Error("Invalid visibility request"),{code:"BAD_REQUEST"});
      return transaction(()=>{
        const row=db.prepare("SELECT * FROM user_walks WHERE id=? AND user_id=?").get(id,userId);if(!row)return null;
        if(row.revision!==revision){if(row.visibility===visibility)return viewWalk(row);throw conflict();}
        let status=row.listing_status??null,hash=row.listing_text_hash??null;
        if(visibility==="public") {
          const document=documentOf(row);
          if(!document?.route)throw Object.assign(new Error("A draft cannot be public"),{code:"WALK_NOT_READY"});
          // An editor's "hidden" decision is final for the owner, whatever they toggle.
          if(status!=="hidden") {
            const current=moderatedTextHash(row.title,document);
            if(autoApprove){status="approved";hash=current;}
            else if(!(status==="approved"&&hash===current))status="pending";
          }
        }
        const time=timestamp(),token=row.share_token??(linked(visibility)?randomUUID():null);
        db.prepare("UPDATE user_walks SET visibility=?,share_token=?,listing_status=?,listing_text_hash=?,listing_updated_at=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=?")
          .run(visibility,token,status,hash,status!==(row.listing_status??null)?time:row.listing_updated_at,time,id,userId,revision);
        return this.getWalk(userId,id);
      });
    },
    /** Approved public walks and catalog walks with their published rating sums, plus the global rating prior. */
    listTopCandidates() {
      const walks=db.prepare(`SELECT w.id,w.title,w.share_token,w.listing_updated_at,COALESCE(r.sum,0) AS rating_sum,COALESCE(r.count,0) AS rating_count
        FROM user_walks w LEFT JOIN (SELECT walk_id,SUM(rating) AS sum,count(*) AS count FROM walk_reviews WHERE walk_kind='account' AND status='published' GROUP BY walk_id) r ON r.walk_id=w.id
        WHERE w.visibility='public' AND w.listing_status='approved' AND w.share_token IS NOT NULL`).all()
        .map(row=>({id:row.id,title:row.title,shareToken:row.share_token,listedAt:row.listing_updated_at,ratingSum:Number(row.rating_sum),ratingCount:Number(row.rating_count)}));
      const catalogRatings=new Map(db.prepare("SELECT walk_id,SUM(rating) AS sum,count(*) AS count FROM walk_reviews WHERE walk_kind='catalog' AND status='published' GROUP BY walk_id").all()
        .map(row=>[row.walk_id,{ratingSum:Number(row.sum),ratingCount:Number(row.count)}]));
      const prior=db.prepare("SELECT avg(rating) AS average FROM walk_reviews WHERE status='published'").get().average;
      return {walks,catalogRatings,priorMean:prior===null?4:Number(prior)};
    },
    /** Decoded documents of the given account walks (public top details), skipping damaged ones. */
    getTopDocuments(ids) {
      const select=db.prepare("SELECT id,title,snapshot_json FROM user_walks WHERE id=? AND visibility='public' AND listing_status='approved'");
      return new Map(ids.map(id=>{const row=select.get(id);return [id,row?documentOf(row):null];}));
    },
    deleteWalk(userId,id) { return db.prepare("DELETE FROM user_walks WHERE id=? AND user_id=?").run(id,userId).changes>0; },
    listFavorites(userId,limit=50,after=null) { limit=Math.min(50,Math.max(1,limit));const c=cursor(after);const rows=c?db.prepare("SELECT object_type,object_id,created_at FROM user_favorites WHERE user_id=? AND (created_at<? OR (created_at=? AND (object_type||':'||object_id)<?)) ORDER BY created_at DESC,object_type||':'||object_id DESC LIMIT ?").all(userId,c.time,c.time,c.id,limit+1):db.prepare("SELECT object_type,object_id,created_at FROM user_favorites WHERE user_id=? ORDER BY created_at DESC,object_type||':'||object_id DESC LIMIT ?").all(userId,limit+1);const result=page(rows,limit,row=>({type:row.object_type,id:row.object_id,createdAt:row.created_at}));return {favorites:result.items,nextCursor:result.nextCursor}; },
    setFavorite(userId,type,id) {
      if(!["story","walk"].includes(type)||typeof id!=="string"||id.length>128)throw Object.assign(new Error(),{code:"BAD_REQUEST"});
      transaction(()=>{
        if(db.prepare("SELECT 1 FROM user_favorites WHERE user_id=? AND object_type=? AND object_id=?").get(userId,type,id))return;
        if(count("user_favorites",userId)>=MAX_FAVORITES_PER_USER)throw storageLimit(`В избранном может быть не больше ${MAX_FAVORITES_PER_USER} записей.`);
        db.prepare("INSERT INTO user_favorites VALUES(?,?,?,?)").run(userId,type,id,timestamp());
      });
    },
    deleteFavorite(userId,type,id) { db.prepare("DELETE FROM user_favorites WHERE user_id=? AND object_type=? AND object_id=?").run(userId,type,id); },
    reserveGeneration(userId,requestId,units=1,limit=6) {if(typeof requestId!=="string"||requestId.length<8||!Number.isSafeInteger(units)||units<1)throw Object.assign(new Error(),{code:"BAD_REQUEST"});const existing=db.prepare("SELECT units FROM user_generation_quota WHERE user_id=? AND request_id=?").get(userId,requestId);if(existing)return false;const since=new Date(now()-86400000).toISOString(),used=db.prepare("SELECT COALESCE(SUM(units),0) AS value FROM user_generation_quota WHERE user_id=? AND created_at>=?").get(userId,since).value;if(used+units>limit)throw Object.assign(new Error("Personal daily quota exceeded"),{code:"QUOTA_EXCEEDED"});db.prepare("INSERT INTO user_generation_quota VALUES(?,?,?,?)").run(userId,requestId,units,timestamp());return true; },
    releaseGeneration(userId,requestId) {db.prepare("DELETE FROM user_generation_quota WHERE user_id=? AND request_id=?").run(userId,requestId);},
    beginGeneration(userId,idempotencyKey,operation,requestFingerprint,units=1,limit=6) {
      if(typeof idempotencyKey!=="string"||idempotencyKey.length<8||idempotencyKey.length>100||typeof operation!=="string"||!operation||typeof requestFingerprint!=="string"||!requestFingerprint||!Number.isSafeInteger(units)||units<0)throw Object.assign(new Error(),{code:"BAD_REQUEST"});
      return transaction(()=>{
        const existing=db.prepare("SELECT operation,request_fingerprint,job_id FROM user_generation_intents WHERE user_id=? AND idempotency_key=?").get(userId,idempotencyKey);
        if(existing) {
          if(existing.operation!==operation||existing.request_fingerprint!==requestFingerprint)throw Object.assign(new Error("Idempotency key belongs to another request"),{code:"CONFLICT"});
          return {created:false,jobId:existing.job_id??null};
        }
        // Requests created before request fingerprints were introduced cannot be
        // safely proved equivalent, so their keys fail closed.
        if(db.prepare("SELECT 1 FROM user_generation_requests WHERE user_id=? AND idempotency_key=?").get(userId,idempotencyKey))throw Object.assign(new Error("Legacy idempotency key cannot be reused"),{code:"CONFLICT"});
        if(units>0) {
          const since=new Date(now()-86400000).toISOString(),used=Number(db.prepare("SELECT COALESCE(SUM(units),0) AS value FROM user_generation_quota WHERE user_id=? AND created_at>=?").get(userId,since).value);
          if(used+units>limit)throw Object.assign(new Error("Personal daily quota exceeded"),{code:"QUOTA_EXCEEDED"});
          db.prepare("INSERT INTO user_generation_quota VALUES(?,?,?,?)").run(userId,idempotencyKey,units,timestamp());
        }
        db.prepare("INSERT INTO user_generation_intents VALUES(?,?,?,?,NULL,?)").run(userId,idempotencyKey,operation,requestFingerprint,timestamp());
        return {created:true,jobId:null};
      });
    },
    completeGeneration(userId,idempotencyKey,jobId) {
      if(typeof jobId!=="string"||!jobId)throw Object.assign(new Error(),{code:"BAD_REQUEST"});
      return transaction(()=>{
        const intent=db.prepare("SELECT operation,job_id FROM user_generation_intents WHERE user_id=? AND idempotency_key=?").get(userId,idempotencyKey);
        if(!intent||(intent.job_id&&intent.job_id!==jobId))throw Object.assign(new Error(),{code:"CONFLICT"});
        db.prepare("UPDATE user_generation_intents SET job_id=? WHERE user_id=? AND idempotency_key=?").run(jobId,userId,idempotencyKey);
        db.prepare("INSERT OR IGNORE INTO user_generation_requests VALUES(?,?,?,?,?,?)").run(randomUUID(),userId,jobId,intent.operation,idempotencyKey,timestamp());
        return jobId;
      });
    },
    cancelGeneration(userId,idempotencyKey) {
      transaction(()=>{const intent=db.prepare("SELECT job_id FROM user_generation_intents WHERE user_id=? AND idempotency_key=?").get(userId,idempotencyKey);if(intent&&!intent.job_id){db.prepare("DELETE FROM user_generation_intents WHERE user_id=? AND idempotency_key=?").run(userId,idempotencyKey);db.prepare("DELETE FROM user_generation_quota WHERE user_id=? AND request_id=?").run(userId,idempotencyKey);}});
    },
    attachRequest(userId,jobId,operation,idempotencyKey) { const existing=db.prepare("SELECT job_id FROM user_generation_requests WHERE user_id=? AND idempotency_key=?").get(userId,idempotencyKey);if(existing)return existing.job_id;db.prepare("INSERT INTO user_generation_requests VALUES(?,?,?,?,?,?)").run(randomUUID(),userId,jobId,operation,idempotencyKey,timestamp());return jobId; },
    ownsRequest(userId,jobId) { return Boolean(db.prepare("SELECT 1 FROM user_generation_requests WHERE user_id=? AND job_id=?").get(userId,jobId)); },
    listRequests(userId,limit=50,after=null) {limit=Math.min(50,Math.max(1,limit));const c=cursor(after);const rows=c?db.prepare("SELECT id,job_id,operation,created_at FROM user_generation_requests WHERE user_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?").all(userId,c.time,c.time,c.id,limit+1):db.prepare("SELECT id,job_id,operation,created_at FROM user_generation_requests WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?").all(userId,limit+1);const result=page(rows,limit,row=>({jobId:row.job_id,operation:row.operation,createdAt:row.created_at}));return {requests:result.items,nextCursor:result.nextCursor}; },
    researchJobIds(userId) {return db.prepare("SELECT job_id FROM user_generation_requests WHERE user_id=? AND operation='walk_research'").all(userId).map(row=>row.job_id);},
    importLocal(userId,{importId,walk=null,favorites=[]}) { if(typeof importId!=="string"||!/^[\w.-]{8,100}$/.test(importId)||!Array.isArray(favorites)||favorites.length>100)throw Object.assign(new Error(),{code:"BAD_REQUEST"});return transaction(()=>{const existing=db.prepare("SELECT result_json FROM account_imports WHERE user_id=? AND import_id=?").get(userId,importId);if(existing)return decode(existing.result_json);const result={walk:null,favorites:0};if(walk)result.walk=this.createWalk(userId,{...walk,idempotencyKey:`import-${importId}`});for(const item of favorites){this.setFavorite(userId,item.type,item.id);result.favorites++;}db.prepare("INSERT INTO account_imports VALUES(?,?,?,?)").run(userId,importId,encode(result),timestamp());return result;}); },
    deleteAccountData(userId) { transaction(()=>{db.prepare("DELETE FROM user WHERE id=?").run(userId);}); },
  };
}

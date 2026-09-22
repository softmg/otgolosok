import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { validateWalkDocument, migrateLegacyDraft } from "./walk-document.mjs";

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
  const cursor = value => { if(!value)return null;try{const parsed=decode(Buffer.from(value,"base64url").toString());if(typeof parsed.time!=="string"||typeof parsed.id!=="string")throw new Error();return parsed;}catch{throw Object.assign(new Error("Invalid cursor"),{code:"BAD_REQUEST"});} };
  const page = (rows,limit,map) => ({items:rows.slice(0,limit).map(map),nextCursor:rows.length>limit?Buffer.from(encode({time:rows[limit-1].updated_at??rows[limit-1].created_at,id:rows[limit-1].id??`${rows[limit-1].object_type}:${rows[limit-1].object_id}`})).toString("base64url"):null});
  const normalizeWalk = (snapshot,id) => snapshot?.version===2?validateWalkDocument(snapshot):migrateLegacyDraft(validateSnapshot(snapshot),id);
  const viewWalk = row => {
    if (!row) return null;
    let raw;
    try { raw = decode(row.snapshot_json); }
    catch { return { id: row.id, title: row.title, snapshot: null, revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at,
      visibility: row.visibility, shareToken: row.visibility === "shared" ? row.share_token : null, snapshotError: "Снимок прогулки повреждён." }; }
    let snapshot = raw;
    let snapshotError = null;
    try { snapshot = normalizeWalk(raw, row.id); }
    catch (error) { snapshotError = error.code === "BAD_REQUEST" ? "Снимок прогулки повреждён." : "Не удалось проверить снимок прогулки."; }
    return { id: row.id, title: row.title, snapshot, revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at,
      visibility: row.visibility, shareToken: row.visibility === "shared" ? row.share_token : null, ...(snapshotError ? { snapshotError } : {}) };
  };
  const listItem = row => {
    const view = viewWalk(row);
    const snapshot = view.snapshotError ? null : view.snapshot;
    return {id:row.id,title:row.title,revision:Number(row.revision),updatedAt:row.updated_at,visibility:row.visibility,shareToken:row.visibility==='shared'?row.share_token:null,
      ...(snapshot ? {draft:!snapshot.route,walkingMinutes:snapshot.route?.walkingMinutes??null,distanceM:snapshot.route?.distanceM??null} : {})};
  };
  return {
    updateProfile(userId, name) { const value=cleanName(name),time=timestamp();db.prepare("UPDATE user SET name=?,updatedAt=? WHERE id=?").run(value,time,userId);return value; },
    listWalks(userId, limit=20,after=null) { limit=Math.min(50,Math.max(1,limit));const c=cursor(after),rows=c?db.prepare("SELECT * FROM user_walks WHERE user_id=? AND (updated_at<? OR (updated_at=? AND id<?)) ORDER BY updated_at DESC,id DESC LIMIT ?").all(userId,c.time,c.time,c.id,limit+1):db.prepare("SELECT * FROM user_walks WHERE user_id=? ORDER BY updated_at DESC,id DESC LIMIT ?").all(userId,limit+1);const result=page(rows,limit,listItem);return {walks:result.items,nextCursor:result.nextCursor,hasMore:Boolean(result.nextCursor)}; },
    getWalk(userId,id) { return viewWalk(db.prepare("SELECT * FROM user_walks WHERE id=? AND user_id=?").get(id,userId)) ?? null; },
    createWalk(userId,{title,snapshot,idempotencyKey}) {
      if(typeof idempotencyKey!=="string"||!/^[\w.-]{8,100}$/.test(idempotencyKey))throw Object.assign(new Error(),{code:"BAD_REQUEST"});
      const clean=cleanTitle(title);
      const prior=db.prepare("SELECT w.* FROM user_walk_idempotency i JOIN user_walks w ON w.id=i.walk_id WHERE i.user_id=? AND i.idempotency_key=?").get(userId,idempotencyKey);
      if(prior){
        const normalized=normalizeWalk(snapshot,prior.id);
        if(fingerprint({title:clean,snapshot:normalized})!==fingerprint({title:prior.title,snapshot:normalizeWalk(decode(prior.snapshot_json),prior.id)}))throw conflict();
        return viewWalk(prior);
      }
      // Catalog slugs are valid document IDs for read-only views, but an
      // account record must remain addressable by the UUID-only account API.
      const id=snapshot?.version===2&&uuid(snapshot.id)?snapshot.id:randomUUID();
      const time=timestamp(),normalized=normalizeWalk(snapshot,id);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO user_walks(id,user_id,title,snapshot_json,revision,created_at,updated_at,visibility,share_token) VALUES(?,?,?,?,0,?,?,?,?)").run(id,userId,clean,encode(normalized),time,time,"private",null);
        db.prepare("INSERT INTO user_walk_idempotency VALUES(?,?,?)").run(userId,idempotencyKey,id);
        db.exec("COMMIT");
      } catch(error) {
        db.exec("ROLLBACK");
        if(String(error?.code??"").startsWith("SQLITE_CONSTRAINT")) throw conflict();
        throw error;
      }
      return this.getWalk(userId,id);
    },
    updateWalk(userId,id,{title,snapshot,revision}) {
      if(!uuid(id)||!Number.isSafeInteger(revision)||revision<0)throw Object.assign(new Error("Invalid walk revision"),{code:"BAD_REQUEST"});
      const normalized=normalizeWalk(snapshot,id);
      if(normalized.id!==id)throw Object.assign(new Error("Walk ID does not match the account record"),{code:"BAD_REQUEST"});
      const result=db.prepare("UPDATE user_walks SET title=?,snapshot_json=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=?").run(cleanTitle(title),encode(normalized),timestamp(),id,userId,revision);
      if(!result.changes){if(!this.getWalk(userId,id))return null;throw conflict();}
      return this.getWalk(userId,id);
    },
    getSharedWalk(token) {if(typeof token!=="string"||!uuid(token))return null;return viewWalk(db.prepare("SELECT * FROM user_walks WHERE share_token=? AND visibility='shared'").get(token))??null;},
    setWalkSharing(userId,id,revision,enabled) {
      if(!uuid(id)||!Number.isSafeInteger(revision)||revision<0||typeof enabled!=="boolean")throw Object.assign(new Error("Invalid sharing request"),{code:"BAD_REQUEST"});
      const row=db.prepare("SELECT * FROM user_walks WHERE id=? AND user_id=?").get(id,userId);if(!row)return null;
      if(row.revision!==revision){if((row.visibility==='shared')===enabled)return viewWalk(row);throw conflict();}
      const token=row.share_token??(enabled?randomUUID():null);
      db.prepare("UPDATE user_walks SET visibility=?,share_token=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=?").run(enabled?'shared':'private',token,timestamp(),id,userId,revision);
      return this.getWalk(userId,id);
    },
    deleteWalk(userId,id) { return db.prepare("DELETE FROM user_walks WHERE id=? AND user_id=?").run(id,userId).changes>0; },
    listFavorites(userId,limit=50,after=null) { limit=Math.min(50,Math.max(1,limit));const c=cursor(after);const rows=c?db.prepare("SELECT object_type,object_id,created_at FROM user_favorites WHERE user_id=? AND (created_at<? OR (created_at=? AND (object_type||':'||object_id)<?)) ORDER BY created_at DESC,object_type||':'||object_id DESC LIMIT ?").all(userId,c.time,c.time,c.id,limit+1):db.prepare("SELECT object_type,object_id,created_at FROM user_favorites WHERE user_id=? ORDER BY created_at DESC,object_type||':'||object_id DESC LIMIT ?").all(userId,limit+1);const result=page(rows,limit,row=>({type:row.object_type,id:row.object_id,createdAt:row.created_at}));return {favorites:result.items,nextCursor:result.nextCursor}; },
    setFavorite(userId,type,id) { if(!["story","walk"].includes(type)||typeof id!=="string"||id.length>128)throw Object.assign(new Error(),{code:"BAD_REQUEST"});db.prepare("INSERT OR IGNORE INTO user_favorites VALUES(?,?,?,?)").run(userId,type,id,timestamp()); },
    deleteFavorite(userId,type,id) { db.prepare("DELETE FROM user_favorites WHERE user_id=? AND object_type=? AND object_id=?").run(userId,type,id); },
    reserveGeneration(userId,requestId,units=1,limit=6) {if(typeof requestId!=="string"||requestId.length<8||!Number.isSafeInteger(units)||units<1)throw Object.assign(new Error(),{code:"BAD_REQUEST"});const existing=db.prepare("SELECT units FROM user_generation_quota WHERE user_id=? AND request_id=?").get(userId,requestId);if(existing)return false;const since=new Date(now()-86400000).toISOString(),used=db.prepare("SELECT COALESCE(SUM(units),0) AS value FROM user_generation_quota WHERE user_id=? AND created_at>=?").get(userId,since).value;if(used+units>limit)throw Object.assign(new Error("Personal daily quota exceeded"),{code:"QUOTA_EXCEEDED"});db.prepare("INSERT INTO user_generation_quota VALUES(?,?,?,?)").run(userId,requestId,units,timestamp());return true; },
    releaseGeneration(userId,requestId) {db.prepare("DELETE FROM user_generation_quota WHERE user_id=? AND request_id=?").run(userId,requestId);},
    beginGeneration(userId,idempotencyKey,operation,requestFingerprint,units=1,limit=6) {
      if(typeof idempotencyKey!=="string"||idempotencyKey.length<8||idempotencyKey.length>100||typeof operation!=="string"||!operation||typeof requestFingerprint!=="string"||!requestFingerprint||!Number.isSafeInteger(units)||units<0)throw Object.assign(new Error(),{code:"BAD_REQUEST"});
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing=db.prepare("SELECT operation,request_fingerprint,job_id FROM user_generation_intents WHERE user_id=? AND idempotency_key=?").get(userId,idempotencyKey);
        if(existing) {
          if(existing.operation!==operation||existing.request_fingerprint!==requestFingerprint)throw Object.assign(new Error("Idempotency key belongs to another request"),{code:"CONFLICT"});
          db.exec("COMMIT");return {created:false,jobId:existing.job_id??null};
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
        db.exec("COMMIT");return {created:true,jobId:null};
      } catch(error) {db.exec("ROLLBACK");throw error;}
    },
    completeGeneration(userId,idempotencyKey,jobId) {
      if(typeof jobId!=="string"||!jobId)throw Object.assign(new Error(),{code:"BAD_REQUEST"});
      db.exec("BEGIN IMMEDIATE");
      try {
        const intent=db.prepare("SELECT operation,job_id FROM user_generation_intents WHERE user_id=? AND idempotency_key=?").get(userId,idempotencyKey);
        if(!intent||(intent.job_id&&intent.job_id!==jobId))throw Object.assign(new Error(),{code:"CONFLICT"});
        db.prepare("UPDATE user_generation_intents SET job_id=? WHERE user_id=? AND idempotency_key=?").run(jobId,userId,idempotencyKey);
        db.prepare("INSERT OR IGNORE INTO user_generation_requests VALUES(?,?,?,?,?,?)").run(randomUUID(),userId,jobId,intent.operation,idempotencyKey,timestamp());
        db.exec("COMMIT");return jobId;
      } catch(error) {db.exec("ROLLBACK");throw error;}
    },
    cancelGeneration(userId,idempotencyKey) {
      db.exec("BEGIN IMMEDIATE");
      try {const intent=db.prepare("SELECT job_id FROM user_generation_intents WHERE user_id=? AND idempotency_key=?").get(userId,idempotencyKey);if(intent&&!intent.job_id){db.prepare("DELETE FROM user_generation_intents WHERE user_id=? AND idempotency_key=?").run(userId,idempotencyKey);db.prepare("DELETE FROM user_generation_quota WHERE user_id=? AND request_id=?").run(userId,idempotencyKey);}db.exec("COMMIT");}
      catch(error){db.exec("ROLLBACK");throw error;}
    },
    attachRequest(userId,jobId,operation,idempotencyKey) { const existing=db.prepare("SELECT job_id FROM user_generation_requests WHERE user_id=? AND idempotency_key=?").get(userId,idempotencyKey);if(existing)return existing.job_id;db.prepare("INSERT INTO user_generation_requests VALUES(?,?,?,?,?,?)").run(randomUUID(),userId,jobId,operation,idempotencyKey,timestamp());return jobId; },
    ownsRequest(userId,jobId) { return Boolean(db.prepare("SELECT 1 FROM user_generation_requests WHERE user_id=? AND job_id=?").get(userId,jobId)); },
    listRequests(userId,limit=50,after=null) {limit=Math.min(50,Math.max(1,limit));const c=cursor(after);const rows=c?db.prepare("SELECT id,job_id,operation,created_at FROM user_generation_requests WHERE user_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?").all(userId,c.time,c.time,c.id,limit+1):db.prepare("SELECT id,job_id,operation,created_at FROM user_generation_requests WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ?").all(userId,limit+1);const result=page(rows,limit,row=>({jobId:row.job_id,operation:row.operation,createdAt:row.created_at}));return {requests:result.items,nextCursor:result.nextCursor}; },
    researchJobIds(userId) {return db.prepare("SELECT job_id FROM user_generation_requests WHERE user_id=? AND operation='walk_research'").all(userId).map(row=>row.job_id);},
    importLocal(userId,{importId,walk=null,favorites=[]}) { if(typeof importId!=="string"||!/^[\w.-]{8,100}$/.test(importId)||!Array.isArray(favorites)||favorites.length>100)throw Object.assign(new Error(),{code:"BAD_REQUEST"});const existing=db.prepare("SELECT result_json FROM account_imports WHERE user_id=? AND import_id=?").get(userId,importId);if(existing)return decode(existing.result_json);const result={walk:null,favorites:0};if(walk)result.walk=this.createWalk(userId,{...walk,idempotencyKey:`import-${importId}`});for(const item of favorites){this.setFavorite(userId,item.type,item.id);result.favorites++;}db.prepare("INSERT INTO account_imports VALUES(?,?,?,?)").run(userId,importId,encode(result),timestamp());return result; },
    deleteAccountData(userId) { db.exec("BEGIN IMMEDIATE");try{db.prepare("DELETE FROM user WHERE id=?").run(userId);db.exec("COMMIT");}catch(error){db.exec("ROLLBACK");throw error;} },
  };
}

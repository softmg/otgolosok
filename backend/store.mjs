import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { editorialDraft, hasValidStoryText } from "./admin.mjs";
import { sha256 } from "./domain.mjs";
import { isTtsProvider, validVoiceId } from "./tts-voices.mjs";
import { createWalkAdminStore } from "./walk-admin.mjs";
import { createWalkResearchStore } from "./walk-research-store.mjs";
import { createContentStore } from "./content-store.mjs";

const STAGES = new Set([
  "queued",
  "researching",
  "verifying",
  "writing",
  "voicing",
  "ready",
  "insufficient_evidence",
  "review_required",
  "failed",
]);

const WORKING_STAGES = ["researching", "verifying", "writing", "voicing"];
const TERMINAL_STAGES = ["ready", "insufficient_evidence", "review_required", "failed"];

/**
 * @typedef {{id: string, input_key: string, source_job_id: string, source_revision: number, state: string, profile_id: string,
 *   profile_version: string, priority: number, payload_json: string, attempts: number, max_attempts: number, next_attempt_at: string,
 *   lease_generation: number, lease_token_hash: string | null, lease_expires_at: string | null, worker_id: string | null,
 *   claim_request_id: string | null, upload_id: string | null, upload_sha256: string | null, receipt_json: string | null,
 *   error_json: string | null, created_at: string, updated_at: string}} ExternalAudioJobRow
 * @typedef {{id: string, name: string, token_hash: string, profiles_json: string, revoked_at: string | null, created_at: string,
 *   last_seen_at: string | null}} WorkerCredentialRow
 * @typedef {{credential_id: string, worker_name: string, version: string | null, profile_ids_json: string,
 *   current_job_id: string | null, progress_json: string | null, seen_at: string}} WorkerHeartbeatRow
 * @typedef {{id: string, place_id: string, approved_story_json: string | null, audio_target_profile: string | null}} PlaceTextStoryRow
 * @typedef {{engine?: string, language?: string, modelSha256?: string | null, speaker?: string | null, configVersion?: string,
 *   configSha256?: string | null, referenceSha256?: string | null, textPreparation?: {input?: string, version?: string} | null,
 *   chunking?: string, maximumPublicationDurationSec?: number}} ExternalTtsProfile
 * @typedef {((text: string, options?: {signal?: AbortSignal}) => Promise<string>) & {version?: string}} ExternalTextNormalizer
 */

function codedError(code, message = code) {
  const error = /** @type {Error & {code?: string}} */ (new Error(message));
  error.code = code;
  return error;
}

// Published catalog narration keeps the editor's wording and paragraph layout.
// Generation word-count targets do not apply, but the public story bounds still do.
function catalogNarration(story) {
  const text = (value, limit) => typeof value === "string" && value.trim().length > 0 && value.length <= limit && !/[\p{Cc}\p{Cf}<>]/u.test(value);
  if (!story || !text(story.title, 180) || !Array.isArray(story.paragraphs) || !story.paragraphs.length || story.paragraphs.length > 100
    || story.paragraphs.some(paragraph => !text(paragraph?.text, 6000))) return null;
  const script = story.paragraphs.map(paragraph => paragraph.text).join("\n\n");
  return story.title.length + script.length <= 100000 ? script : null;
}

function approvedCatalogNarration(json) {
  try { return catalogNarration(JSON.parse(json)); }
  catch { return null; }
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function encode(record) {
  const json = JSON.stringify(record);
  if (json === undefined) {
    throw new TypeError("Record must be JSON-serializable");
  }
  return json;
}

function decode(row) {
  return row ? JSON.parse(row.record_json) : null;
}

function isAddressJob(job) {
  return (job?.kind ?? "address") === "address";
}

/**
 * @param {string} databasePath
 * @param {{now?: () => number, random?: () => number, maxActive?: number, workerLeaseSecret?: string,
 *   normalizeExternalText?: ExternalTextNormalizer, externalTtsProfiles?: Record<string, ExternalTtsProfile>}} [options]
 */
export function createStore(
  databasePath,
  { now = Date.now, random = Math.random, maxActive = 2, workerLeaseSecret = "development-worker-lease-secret", normalizeExternalText = Object.assign(async text=>text,{version:"plain-v1"}), externalTtsProfiles = {} } = {},
) {
  if (!Number.isInteger(maxActive) || maxActive < 0) {
    throw new TypeError("maxActive must be a non-negative integer");
  }

  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath, { timeout: 5000, allowUnknownNamedParameters: false });
  let closed = false;

  db.function("casefold", { deterministic: true }, (value) =>
    typeof value === "string" ? value.toLocaleLowerCase("ru-RU") : "",
  );

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      job_key TEXT NOT NULL UNIQUE,
      stage TEXT NOT NULL,
      created_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_stage_idx ON jobs(stage);
    CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs(created_at);
    -- The global daily cap was replaced by per-user quotas in the account store.
    DROP TABLE IF EXISTS retries;
    CREATE TABLE IF NOT EXISTS external_audio_jobs (
      id TEXT PRIMARY KEY,
      input_key TEXT NOT NULL UNIQUE,
      source_job_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_attempt_at TEXT NOT NULL,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      lease_token_hash TEXT,
      lease_expires_at TEXT,
      worker_id TEXT,
      claim_request_id TEXT,
      upload_id TEXT UNIQUE,
      upload_sha256 TEXT,
      receipt_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS external_audio_available_idx
      ON external_audio_jobs(state, next_attempt_at, created_at);
    CREATE TABLE IF NOT EXISTS worker_credentials (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, profiles_json TEXT NOT NULL,
      revoked_at TEXT, created_at TEXT NOT NULL, last_seen_at TEXT
    );
    CREATE TABLE IF NOT EXISTS job_attempts (
      job_id TEXT NOT NULL, generation INTEGER NOT NULL, worker_id TEXT NOT NULL, state TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, error_json TEXT, lease_key_version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(job_id,generation)
    );
    CREATE TABLE IF NOT EXISTS audio_artifacts (
      sha256 TEXT PRIMARY KEY, job_id TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_heartbeats (
      credential_id TEXT NOT NULL, worker_name TEXT NOT NULL, version TEXT, profile_ids_json TEXT NOT NULL,
      current_job_id TEXT, progress_json TEXT, seen_at TEXT NOT NULL, PRIMARY KEY(credential_id,worker_name)
    );
  `);
  if(!db.prepare("PRAGMA table_info(job_attempts)").all().some(column=>column.name==="lease_key_version"))db.exec("ALTER TABLE job_attempts ADD COLUMN lease_key_version INTEGER NOT NULL DEFAULT 1");
  const audioJobColumns=new Set(db.prepare("PRAGMA table_info(external_audio_jobs)").all().map(column=>column.name));
  if(!audioJobColumns.has("profile_version"))db.exec("ALTER TABLE external_audio_jobs ADD COLUMN profile_version TEXT NOT NULL DEFAULT '1'");
  if(!audioJobColumns.has("priority"))db.exec("ALTER TABLE external_audio_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");

  const findById = db.prepare(
    "SELECT record_json FROM jobs WHERE id = ?",
  );
  const findByKey = db.prepare(
    "SELECT record_json FROM jobs WHERE job_key = ?",
  );
  const writeJob = db.prepare(`
    UPDATE jobs
    SET stage = ?, record_json = ?
    WHERE id = ?
  `);
  const insertJob = db.prepare(`
    INSERT INTO jobs (id, job_key, stage, created_at, record_json)
    VALUES (?, ?, ?, ?, ?)
  `);

  function transaction(work) {
    let begun = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      begun = true;
      const value = work();
      db.exec("COMMIT");
      begun = false;
      return value;
    } catch (error) {
      if (begun) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original database or application error.
        }
      }
      throw error;
    }
  }

  function save(record) {
    writeJob.run(record.stage, encode(record), record.id);
    return record;
  }

  function leaseToken(id, generation, workerId) {
    return createHmac("sha256", workerLeaseSecret).update(`${id}|${generation}|${workerId}`).digest("hex");
  }

  function secureEqual(left, right) {
    if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  }

  function externalRow(id) {
    return /** @type {ExternalAudioJobRow | null} */ (db.prepare("SELECT * FROM external_audio_jobs WHERE id = ?").get(id) ?? null);
  }

  function approvedPlaceNarration(sourceJobId) {
    const row = db.prepare(`SELECT approved_story_json FROM place_texts WHERE id=? AND id=(
      SELECT latest.id FROM place_texts latest WHERE latest.place_id=place_texts.place_id AND latest.approved_story_json IS NOT NULL
      ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1)`).get(sourceJobId.slice(11));
    return row?.approved_story_json ? approvedCatalogNarration(row.approved_story_json) : null;
  }

  function publicExternal(row) {
    if (!row) return null;
    return { id: row.id, state: row.state, profileId: row.profile_id, profileVersion: row.profile_version??"1", priority:Number(row.priority??0), attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts), leaseGeneration: Number(row.lease_generation),
      leaseExpiresAt: row.lease_expires_at, updatedAt: row.updated_at,
      workerId: row.worker_id,
      receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
      error: row.error_json ? JSON.parse(row.error_json) : null };
  }

  function requireLease(row, workerId, generation, token) {
    const timestamp = isoNow(now);
    if (!row || row.state !== "leased" || row.worker_id !== workerId || Number(row.lease_generation) !== generation
      || !row.lease_expires_at || row.lease_expires_at <= timestamp
      || !secureEqual(row.lease_token_hash, sha256(token))) throw codedError("LEASE_LOST");
  }

  function recoverInterrupted() {
    return transaction(() => {
      const placeholders = WORKING_STAGES.map(() => "?").join(", ");
      const rows = db.prepare(`
        SELECT record_json
        FROM jobs
        WHERE stage IN (${placeholders})
      `).all(...WORKING_STAGES);

      for (const row of rows) {
        const record = decode(row);
        record.stage = "failed";
        record.revision += 1;
        record.updatedAt = isoNow(now);
        record.error = {
          code: "INTERRUPTED",
          message: "Подготовка прервалась. Можно повторить.",
        };
        save(record);
      }

      return rows.length;
    });
  }

  // A job aborted by a graceful shutdown goes back to the queue without using up
  // an attempt, so it resumes from its checkpoints after the restart for free.
  function requeueInterrupted(id) {
    return transaction(() => {
      const job = decode(findById.get(id));
      if (!job || job.stage !== "failed") return null;
      return save({ ...job, stage: "queued", error: null, attempts: Math.max(0, job.attempts - 1), revision: job.revision + 1, updatedAt: isoNow(now) });
    });
  }

  // Paid generation is limited per user by the account store; the job store only
  // bounds how much work is queued or running at once.
  function checkCapacity() {
    const active = db.prepare(`SELECT count(*) AS count FROM jobs WHERE stage NOT IN (${TERMINAL_STAGES.map(() => "?").join(",")})`).get(...TERMINAL_STAGES).count;
    if (Number(active) >= maxActive) throw codedError("QUEUE_FULL");
  }

  const walkAdminStore = createWalkAdminStore({ db, now, transaction, checkCapacity });
  const contentStore = createContentStore({ db, now, transaction });

  return {
    ...walkAdminStore,
    ...createWalkResearchStore({ db, now, transaction, checkCapacity }),
    ...contentStore,
    /** @param {{profileId?: string, limit?: number, signal?: AbortSignal}} [options] */
    async enqueueMissingPlaceAudio({ profileId = "silero-ru-v1", limit = 500, signal } = {}) {
      if (typeof profileId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profileId)
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw codedError("BAD_REQUEST");
      const candidates = /** @type {Array<{id: string, approved_story_json: string, place_id: string, name: string, address: string | null}>} */ (db.prepare(`SELECT t.id, t.approved_story_json, p.id place_id, p.name, p.address
        FROM place_texts t JOIN places p ON p.id=t.place_id
        WHERE p.archived=0 AND t.approved_story_json IS NOT NULL
          AND COALESCE(json_extract(t.approved_story_json,'$.audioDisposition'),'')<>'not_applicable_short_text'
          AND (t.audio_json IS NULL OR t.audio_json='null')
          AND NOT EXISTS (SELECT 1 FROM external_audio_jobs a
            WHERE a.source_job_id='place-text:'||t.id AND a.profile_id=?
              AND a.state IN ('queued','retry_wait','leased'))
        ORDER BY t.created_at, t.rowid LIMIT ?`).all(profileId, limit + 1));
      const rows = candidates.slice(0, limit);
      const result = { queued: 0, alreadyQueued: 0, retried: 0, skipped: 0, failed: 0 };
      for (const row of rows) {
        try {
          const job = await this.enqueueExternalAudio({
            sourceJobId: `place-text:${row.id}`,
            sourceRevision: 0,
            story: { ...JSON.parse(row.approved_story_json), address: row.address ?? row.name },
            profileId,
            signal,
          });
          if (job.state === "failed" || job.state === "cancelled") {
            const retried = this.retryExternalAudio(job.id);
            if (retried) result.retried++;
            else result.skipped++;
          } else if (job.state === "queued" || job.state === "retry_wait") {
            result.queued++;
          } else {
            result.alreadyQueued++;
          }
        } catch {
          result.failed++;
        }
      }
      return { ...result, inspected: rows.length, hasMore: candidates.length > limit, awaitingApproval: contentStore.countTextsAwaitingApproval() };
    },
    createOrGet({ key, address }) {
      if (typeof key !== "string" || key.length === 0) {
        throw new TypeError("key must be a non-empty string");
      }
      if (typeof address !== "string" || address.length === 0) {
        throw new TypeError("address must be a non-empty string");
      }

      return transaction(() => {
        const existing = decode(findByKey.get(key));
        if (existing) {
          if (!isAddressJob(existing)) throw codedError("CONFLICT");
          return existing;
        }

        checkCapacity();

        const timestamp = isoNow(now);
        const record = {
          id: randomUUID(),
          key,
          address,
          stage: "queued",
          revision: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          data: {},
          error: null,
          attempts: 0,
        };

        insertJob.run(
          record.id,
          record.key,
          record.stage,
          record.createdAt,
          encode(record),
        );
        return record;
      });
    },

    get(id) {
      return decode(findById.get(id));
    },

    getByKey(key) {
      return typeof key === "string" ? decode(findByKey.get(key)) : null;
    },

    listAdmin({ limit = 50, offset = 0, q = "", stage = "", relevance = "active" } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0
        || typeof q !== "string" || q.length > 200 || (stage !== "" && !STAGES.has(stage))
        || !["active", "irrelevant", "all"].includes(relevance)) throw codedError("BAD_REQUEST");
      const filters = ["COALESCE(json_extract(record_json, '$.kind'), 'address') = 'address'"];
      const parameters = [];
      if (stage) { filters.push("stage = ?"); parameters.push(stage); }
      if (relevance === "active") filters.push("COALESCE(json_extract(record_json, '$.irrelevant'), 0) != 1");
      if (relevance === "irrelevant") filters.push("COALESCE(json_extract(record_json, '$.irrelevant'), 0) = 1");
      if (q.trim()) {
        filters.push("(instr(casefold(json_extract(record_json, '$.address')), casefold(?)) > 0 OR instr(id, lower(?)) > 0)");
        parameters.push(q.trim(), q.trim());
      }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const rows = db.prepare(`SELECT record_json FROM jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...parameters, limit + 1, offset);
      return { jobs: rows.slice(0, limit).map(decode), hasMore: rows.length > limit };
    },

    setRelevanceAdmin(id, expectedRevision, irrelevant) {
      if (typeof irrelevant !== "boolean") throw codedError("BAD_REQUEST");
      return transaction(() => {
        const job = decode(findById.get(id));
        if (!job) return null;
        if (!isAddressJob(job) || job.revision !== expectedRevision) throw codedError("CONFLICT");
        // Queue visibility is independent of processing: keep its revision so an
        // in-flight worker can finish. update() preserves this top-level flag.
        return save({ ...job, irrelevant, updatedAt: isoNow(now) });
      });
    },

    editAdmin(id, expectedRevision, draft) {
      return transaction(() => {
        const job = decode(findById.get(id));
        if (!job) return null;
        if (!isAddressJob(job) || job.revision !== expectedRevision || job.stage !== "review_required" || job.irrelevant) throw codedError("CONFLICT");
        const valid = editorialDraft(job.data, draft);
        const editorDraft = { title: valid.title, paragraphs: valid.paragraphs };
        return save({ ...job, data: { ...job.data, editorDraft }, revision: job.revision + 1, updatedAt: isoNow(now) });
      });
    },

    approveAdmin(id, expectedRevision, ttsProvider = "openai", ttsVoice = null) {
      if (!isTtsProvider(ttsProvider)) throw codedError("BAD_REQUEST");
      if (ttsVoice !== null && !validVoiceId(ttsVoice)) throw codedError("BAD_REQUEST");
      return transaction(() => {
        const job = decode(findById.get(id));
        if (!job) return null;
        if (!isAddressJob(job) || job.revision !== expectedRevision || job.stage !== "review_required" || job.irrelevant) throw codedError("CONFLICT");
        const story = { ...editorialDraft(job.data), verification: "editorial" };
        checkCapacity();
        const timestamp = isoNow(now);
        return save({ ...job, stage: "queued", error: null, revision: job.revision + 1, updatedAt: timestamp,
          data: { ...job.data, story, audio: null, ttsProvider, ttsVoice, textReadyAt: timestamp,
            editorialApproval: { approvedAt: timestamp, revision: job.revision, ttsProvider, ttsVoice, draftHash: sha256(JSON.stringify(job.data.editorDraft)), storyHash: sha256(JSON.stringify(story)) } } });
      });
    },

    revoiceAdmin(id, expectedRevision, ttsProvider = "openai", ttsVoice = null) {
      if (!isTtsProvider(ttsProvider)) throw codedError("BAD_REQUEST");
      if (ttsVoice !== null && !validVoiceId(ttsVoice)) throw codedError("BAD_REQUEST");
      return transaction(() => {
        const job = decode(findById.get(id));
        if (!job) return null;
        if (!isAddressJob(job) || job.revision !== expectedRevision || !["ready", "failed"].includes(job.stage) || job.irrelevant) throw codedError("CONFLICT");
        if (!hasValidStoryText(job.data?.story)) throw codedError("BAD_REQUEST");
        checkCapacity();
        const timestamp = isoNow(now);
        const previousAudio = job.data.audio ?? job.data.revoice?.previousAudio ?? null;
        return save({ ...job, stage: "queued", error: null, revision: job.revision + 1, updatedAt: timestamp,
          data: { ...job.data, audio: null, ttsProvider, ttsVoice,
            revoice: { requestedAt: timestamp, previousAudio } } });
      });
    },

    retryAdmin(id, expectedRevision, ttsProvider = "openai", ttsVoice = null) {
      if (!isTtsProvider(ttsProvider)) throw codedError("BAD_REQUEST");
      if (ttsVoice !== null && !validVoiceId(ttsVoice)) throw codedError("BAD_REQUEST");
      return transaction(() => {
        const job = decode(findById.get(id));
        if (!job) return null;
        if (!isAddressJob(job) || job.revision !== expectedRevision || job.irrelevant) throw codedError("CONFLICT");
        if (job.stage !== "failed" || job.attempts >= 3) throw codedError("RETRY_LIMIT");
        checkCapacity();
        const timestamp = isoNow(now);
        return save({ ...job, stage: "queued", error: null, updatedAt: timestamp, revision: job.revision + 1,
          data: { ...job.data, ttsProvider, ttsVoice } });
      });
    },

    regenerateAdmin(id, expectedRevision, ttsProvider = "openai", ttsVoice = null) {
      if (!isTtsProvider(ttsProvider)) throw codedError("BAD_REQUEST");
      if (ttsVoice !== null && !validVoiceId(ttsVoice)) throw codedError("BAD_REQUEST");
      return transaction(() => {
        const job = decode(findById.get(id));
        if (!job) return null;
        if (!isAddressJob(job) || job.revision !== expectedRevision || job.irrelevant) throw codedError("CONFLICT");
        if (job.stage !== "review_required" || job.attempts >= 3) throw codedError("RETRY_LIMIT");
        checkCapacity();
        const timestamp = isoNow(now);
        return save({ ...job, stage: "queued", error: null, updatedAt: timestamp, revision: job.revision + 1,
          data: { ttsProvider, ttsVoice } });
      });
    },

    retry(id, expectedRevision) {
      return transaction(() => {
        const job = decode(findById.get(id));
        if (!job) return null;
        if (!isAddressJob(job)) throw codedError("CONFLICT");
        // A repeated click while the same retry is queued must not enqueue again.
        if (!TERMINAL_STAGES.includes(job.stage)) return job;
        if (job.revision !== expectedRevision) throw codedError("CONFLICT");
        if (job.stage !== "failed" || job.attempts >= 3) throw codedError("RETRY_LIMIT");
        checkCapacity();
        const timestamp = isoNow(now);
        return save({...job,stage:"queued",error:null,updatedAt:timestamp,revision:job.revision+1});
      });
    },

    update(id, patch, expectedRevision) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new TypeError("patch must be an object");
      }

      if (has(patch, "stage") && !STAGES.has(patch.stage)) {
        throw new TypeError(`Invalid stage: ${patch.stage}`);
      }
      if (
        has(patch, "attempts")
        && (!Number.isInteger(patch.attempts) || patch.attempts < 0)
      ) {
        throw new TypeError("attempts must be a non-negative integer");
      }

      return transaction(() => {
        const current = decode(findById.get(id));
        if (!current) {
          return null;
        }
        if (current.revision !== expectedRevision) {
          throw codedError("CONFLICT", "Запись была изменена.");
        }

        const next = { ...current };
        for (const field of ["stage", "data", "error", "attempts"]) {
          if (has(patch, field)) {
            next[field] = patch[field];
          }
        }

        next.revision = current.revision + 1;
        next.updatedAt = isoNow(now);
        encode(next);
        return save(next);
      });
    },

    claimNext({ audioOnly = false } = {}) {
      return transaction(() => {
        const working = db.prepare(`
          SELECT 1
          FROM jobs
          WHERE stage IN (${WORKING_STAGES.map(() => "?").join(", ")})
          LIMIT 1
        `).get(...WORKING_STAGES);

        if (working) {
          return null;
        }

        const row = db.prepare(`
          SELECT record_json
          FROM jobs
          WHERE stage = 'queued'
            ${audioOnly ? "AND (json_extract(record_json, '$.kind') = 'walk_chapter' OR (COALESCE(json_extract(record_json, '$.kind'), 'address') = 'address' AND json_type(record_json, '$.data.story') = 'object'))" : ""}
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get();

        if (!row) {
          return null;
        }

        const record = decode(row);
        record.stage = "researching";
        record.attempts += 1;
        record.revision += 1;
        record.updatedAt = isoNow(now);
        return save(record);
      });
    },

    /** @param {{sourceJobId: string, sourceRevision: number, story: any, profileId?: string, signal?: AbortSignal}} options */
    async enqueueExternalAudio({ sourceJobId, sourceRevision, story, profileId = "silero-ru-v1", signal }) {
      if (typeof sourceJobId !== "string" || !Number.isSafeInteger(sourceRevision) || sourceRevision < 0
        || typeof profileId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profileId)) throw codedError("BAD_REQUEST");
      const catalog = sourceJobId.startsWith("place-text:");
      if (catalog ? catalogNarration(story) === null : !hasValidStoryText(story)) throw codedError("BAD_REQUEST");
      const script = story.paragraphs.map(paragraph => paragraph.text).join("\n\n");
      if (catalog && approvedPlaceNarration(sourceJobId) !== script) throw codedError("BAD_REQUEST");
      const configured=externalTtsProfiles[profileId]??{};
      const rawContract=configured.textPreparation?.input==="raw";
      const spokenText = rawContract?script:await normalizeExternalText(script,{signal});
      const spokenTextHash = sha256(spokenText);
      const normalizerVersion=rawContract?null:(normalizeExternalText.version??"custom");
      const profile={id:profileId,engine:configured.engine??(profileId.startsWith("f5")?"f5":"silero"),language:configured.language??"ru",
        modelSha256:configured.modelSha256??null,speaker:configured.speaker??null,configVersion:configured.configVersion??"1",
        configSha256:configured.configSha256??null,referenceSha256:configured.referenceSha256??null,textPreparation:configured.textPreparation??null,
        chunking:configured.chunking??"sentence-v1",maximumBytes:64*1024*1024,maximumDurationSec:600,
        maximumPublicationDurationSec:configured.maximumPublicationDurationSec??150};
      const inputKey = sha256(JSON.stringify({version:rawContract?"external-audio-v2":"external-audio-v1",sourceJobId,sourceRevision,spokenTextHash,profileId,normalizer:normalizerVersion,profile}));
      return transaction(() => {
        // Normalization is asynchronous: an editor may have changed the approval meanwhile.
        if (catalog && approvedPlaceNarration(sourceJobId) !== script) throw codedError("CONFLICT");
        if(catalog)db.prepare("UPDATE place_texts SET audio_target_profile=? WHERE id=?").run(profileId,sourceJobId.slice(11));
        const existing = db.prepare("SELECT * FROM external_audio_jobs WHERE input_key = ?").get(inputKey);
        if (existing) return publicExternal(existing);
        const timestamp = isoNow(now), id = randomUUID();
        db.prepare(`INSERT INTO external_audio_jobs
          (id,input_key,source_job_id,source_revision,state,profile_id,profile_version,priority,payload_json,next_attempt_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,inputKey,sourceJobId,sourceRevision,"queued",profileId,profile.configVersion,0,
            encode({textVersion:`${sourceJobId}:${sourceRevision}`,sourceTextHash:sha256(script),spokenText,spokenTextHash,normalizerVersion,
              profile}),timestamp,timestamp,timestamp);
        return publicExternal(externalRow(id));
      });
    },

    createWorkerCredential({name,profiles}) {
      if(typeof name!=="string"||!name.trim()||name.length>100||!Array.isArray(profiles)||!profiles.length||profiles.length>20
        ||profiles.some(profile=>typeof profile!=="string"||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)))throw codedError("BAD_REQUEST");
      const token=randomUUID().replaceAll("-","")+randomUUID().replaceAll("-",""),id=randomUUID(),timestamp=isoNow(now);
      db.prepare("INSERT INTO worker_credentials VALUES (?,?,?,?,NULL,?,NULL)").run(id,name.trim(),sha256(token),encode([...new Set(profiles)]),timestamp);
      return {id,name:name.trim(),profiles:[...new Set(profiles)],createdAt:timestamp,token};
    },
    listWorkerCredentials() {return /** @type {WorkerCredentialRow[]} */ (db.prepare("SELECT * FROM worker_credentials ORDER BY created_at DESC").all()).map(row=>{const active=db.prepare("SELECT max(updated_at) seen FROM external_audio_jobs WHERE worker_id LIKE ?").get(`${row.id}:%`);return{id:row.id,name:row.name,profiles:JSON.parse(row.profiles_json),revokedAt:row.revoked_at,createdAt:row.created_at,lastSeenAt:active.seen??row.last_seen_at};});},
    revokeWorkerCredential(id) {const timestamp=isoNow(now),result=db.prepare("UPDATE worker_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(timestamp,id);return result.changes?{id,revokedAt:timestamp}:null;},
    authenticateWorkerToken(token) {
      if(typeof token!=="string"||token.length<32)return null;const row=/** @type {WorkerCredentialRow | undefined} */ (db.prepare("SELECT * FROM worker_credentials WHERE token_hash=? AND revoked_at IS NULL").get(sha256(token)));
      if(!row)return null;db.prepare("UPDATE worker_credentials SET last_seen_at=? WHERE id=?").run(isoNow(now),row.id);return{id:row.id,name:row.name,profiles:JSON.parse(row.profiles_json)};
    },
    recordWorkerHeartbeat({credentialId="static",workerName,version=null,profileIds=[],currentJobId=null,progress=null}) {
      if(typeof workerName!=="string"||!workerName||workerName.length>100)return;
      const timestamp=isoNow(now);db.prepare(`INSERT INTO worker_heartbeats VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(credential_id,worker_name) DO UPDATE SET version=excluded.version,profile_ids_json=excluded.profile_ids_json,
        current_job_id=excluded.current_job_id,progress_json=excluded.progress_json,seen_at=excluded.seen_at`)
        .run(credentialId,workerName,typeof version==="string"?version.slice(0,100):null,encode(profileIds.slice(0,20)),currentJobId,progress?encode(progress):null,timestamp);
      if(credentialId!=="static")db.prepare("UPDATE worker_credentials SET last_seen_at=? WHERE id=?").run(timestamp,credentialId);
    },
    listWorkerHeartbeats() {return /** @type {WorkerHeartbeatRow[]} */ (db.prepare("SELECT * FROM worker_heartbeats ORDER BY seen_at DESC").all()).map(row=>({credentialId:row.credential_id,workerName:row.worker_name,version:row.version,profileIds:JSON.parse(row.profile_ids_json),currentJobId:row.current_job_id,progress:row.progress_json?JSON.parse(row.progress_json):null,seenAt:row.seen_at}));},
    getExternalAudioStats() {
      const states=Object.fromEntries(db.prepare("SELECT state,count(*) n FROM external_audio_jobs GROUP BY state").all().map(row=>[row.state,Number(row.n)]));
      const oldest=db.prepare("SELECT min(created_at) value FROM external_audio_jobs WHERE state IN ('queued','retry_wait')").get().value;
      const average=db.prepare(`SELECT avg(unixepoch(finished_at,'subsec')-unixepoch(started_at,'subsec')) value
        FROM job_attempts WHERE finished_at IS NOT NULL`).get().value;
      const artifacts=db.prepare("SELECT count(*) n,total(json_extract(metadata_json,'$.bytes')) bytes FROM audio_artifacts").get();
      return{states,oldestQueuedAt:oldest,averageAttemptSec:average??null,artifactBytes:Number(artifacts.bytes),artifacts:Number(artifacts.n)};
    },
    listExternalAudio({states=["failed"],limit=50}={}) {
      if(!Array.isArray(states)||!states.length||states.length>10||states.some(state=>!["queued","retry_wait","leased","failed","cancelled","succeeded"].includes(state))
        ||!Number.isSafeInteger(limit)||limit<1||limit>100)throw codedError("BAD_REQUEST");
      const placeholders=states.map(()=>"?").join(",");
      return db.prepare(`SELECT a.*,t.place_id,p.name place_name FROM external_audio_jobs a
        LEFT JOIN place_texts t ON a.source_job_id='place-text:'||t.id LEFT JOIN places p ON p.id=t.place_id
        WHERE a.state IN (${placeholders}) ORDER BY a.updated_at DESC LIMIT ?`).all(...states,limit)
        .map(row=>({...publicExternal(row),sourceJobId:row.source_job_id,placeId:row.place_id??null,placeName:row.place_name??null,createdAt:row.created_at}));
    },

    claimExternalAudio({ workerId, requestId, profileIds, textPreparationVersions=[], leaseMs = 300000 }) {
      if (typeof workerId !== "string" || workerId.length < 1 || workerId.length > 100
        || typeof requestId !== "string" || !/^[a-zA-Z0-9._-]{8,100}$/.test(requestId)
        || !Array.isArray(profileIds) || !profileIds.length || profileIds.length > 20
        || profileIds.some(id => typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id))
        || !Array.isArray(textPreparationVersions)||textPreparationVersions.length>10
        || textPreparationVersions.some(value=>typeof value!=="string"||value.length>100)) throw codedError("BAD_REQUEST");
      return transaction(() => {
        const timestamp = isoNow(now);
        const repeated = /** @type {ExternalAudioJobRow | undefined} */ (db.prepare("SELECT * FROM external_audio_jobs WHERE worker_id = ? AND claim_request_id = ? ORDER BY updated_at DESC LIMIT 1").get(workerId,requestId));
        if (repeated?.state==="leased"&&repeated.lease_expires_at>timestamp) {
          const payload=JSON.parse(repeated.payload_json);
          return {...publicExternal(repeated),leaseToken:leaseToken(repeated.id,repeated.lease_generation,workerId),...payload};
        }
        if(repeated)throw codedError("CLAIM_EXPIRED");
        const active=db.prepare("SELECT id FROM external_audio_jobs WHERE worker_id=? AND state='leased' AND lease_expires_at>?").get(workerId,timestamp);
        if(active)throw codedError("WORKER_BUSY");
        db.prepare(`UPDATE external_audio_jobs SET state = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'retry_wait' END,
          next_attempt_at = ?, lease_token_hash = NULL, lease_expires_at = NULL, worker_id = NULL, claim_request_id = NULL,
          error_json = ?, updated_at = ? WHERE state = 'leased' AND lease_expires_at <= ?`)
          .run(timestamp,encode({code:"LEASE_EXPIRED",message:"Worker lease expired."}),timestamp,timestamp);
        // Only a job whose text preparation the worker supports (or that needs none) is claimable.
        const profiles=profileIds.map(()=>"?").join(","),versions=textPreparationVersions.map(()=>"?").join(",");
        const row=db.prepare(`SELECT * FROM external_audio_jobs WHERE state IN ('queued','retry_wait')
          AND next_attempt_at <= ? AND attempts < max_attempts AND profile_id IN (${profiles})
          AND (json_extract(payload_json,'$.profile.textPreparation') IS NULL
            OR json_extract(payload_json,'$.profile.textPreparation.version') IN (${versions}))
          ORDER BY priority DESC,created_at,id LIMIT 1`).get(timestamp,...profileIds,...textPreparationVersions);
        if (!row) return null;
        const generation=Number(row.lease_generation)+1, expiresAt=isoNow(()=>now()+leaseMs);
        const token=leaseToken(row.id,generation,workerId);
        db.prepare(`UPDATE external_audio_jobs SET state='leased',attempts=attempts+1,lease_generation=?,lease_token_hash=?,
          lease_expires_at=?,worker_id=?,claim_request_id=?,updated_at=? WHERE id=?`)
          .run(generation,sha256(token),expiresAt,workerId,requestId,timestamp,row.id);
        db.prepare("INSERT INTO job_attempts (job_id,generation,worker_id,state,started_at,finished_at,error_json,lease_key_version) VALUES (?,?,?,?,?,NULL,NULL,1)").run(row.id,generation,workerId,"leased",timestamp);
        const claimed=externalRow(row.id), payload=JSON.parse(claimed.payload_json);
        return {...publicExternal(claimed),leaseToken:token,...payload};
      });
    },

    heartbeatExternalAudio(id,{workerId,generation,leaseToken:token,leaseMs=300000,progress=null}) {
      return transaction(() => {
        const row=externalRow(id);requireLease(row,workerId,generation,token);
        const timestamp=isoNow(now),expiresAt=isoNow(()=>now()+leaseMs);
        db.prepare("UPDATE external_audio_jobs SET lease_expires_at=?,updated_at=? WHERE id=?").run(expiresAt,timestamp,id);
        const separator=workerId.indexOf(":"),credentialId=separator<0?"static":workerId.slice(0,separator),workerName=separator<0?workerId:workerId.slice(separator+1);
        db.prepare(`INSERT INTO worker_heartbeats VALUES (?,?,?,?,?,?,?) ON CONFLICT(credential_id,worker_name) DO UPDATE SET
          current_job_id=excluded.current_job_id,progress_json=excluded.progress_json,seen_at=excluded.seen_at`)
          .run(credentialId,workerName,null,"[]",id,progress?encode(progress):null,timestamp);
        if(credentialId!=="static")db.prepare("UPDATE worker_credentials SET last_seen_at=? WHERE id=?").run(timestamp,credentialId);
        return publicExternal(externalRow(id));
      });
    },

    /** @param {string} id @param {{workerId: string, generation: number, leaseToken: string, failureId: string, code: string, message?: string}} failure */
    failExternalAudio(id,{workerId,generation,leaseToken:token,failureId,code,message}) {
      if (typeof failureId!=="string"||failureId.length<8||failureId.length>100||typeof code!=="string"||!/^[A-Z_]{1,60}$/.test(code)) throw codedError("BAD_REQUEST");
      return transaction(() => {
        const row=externalRow(id);
        if(row?.error_json) {const previous=JSON.parse(row.error_json);if(previous.failureId===failureId)return publicExternal(row);}
        requireLease(row,workerId,generation,token);
        const terminal=Number(row.attempts)>=Number(row.max_attempts),timestamp=isoNow(now);
        const baseDelay=Number(row.attempts)<=1?30000:120000,delay=Math.round(baseDelay*(.8+random()*.4));
        db.prepare(`UPDATE external_audio_jobs SET state=?,next_attempt_at=?,lease_token_hash=NULL,lease_expires_at=NULL,
          worker_id=NULL,claim_request_id=NULL,error_json=?,updated_at=? WHERE id=?`).run(terminal?"failed":"retry_wait",
            isoNow(()=>now()+delay),encode({failureId,code,message:typeof message==="string"?message.slice(0,500):code}),timestamp,id);
        db.prepare("UPDATE job_attempts SET state=?,finished_at=?,error_json=? WHERE job_id=? AND generation=?")
          .run(terminal?"failed":"retry_wait",timestamp,encode({failureId,code,message}),id,generation);
        return publicExternal(externalRow(id));
      });
    },

    retryExternalAudio(id) {return transaction(()=>{const row=externalRow(id);if(!row||!["failed","cancelled"].includes(row.state))return null;const timestamp=isoNow(now);
      db.prepare(`UPDATE external_audio_jobs SET state='queued',attempts=0,next_attempt_at=?,lease_token_hash=NULL,lease_expires_at=NULL,
        worker_id=NULL,claim_request_id=NULL,error_json=NULL,updated_at=? WHERE id=?`).run(timestamp,timestamp,id);return publicExternal(externalRow(id));});},

    getExternalAudio(id) {const row=externalRow(id);if(!row)return null;const payload=JSON.parse(row.payload_json);return {...publicExternal(row),profile:payload.profile};},
    validateExternalAudioLease(id,{workerId,generation,leaseToken:token}) {requireLease(externalRow(id),workerId,generation,token);return true;},

    acceptExternalAudio(id,{workerId,generation,leaseToken:token,uploadId,uploadSha256,artifact}) {
      if(typeof uploadId!=="string"||uploadId.length<8||uploadId.length>100||!/^[a-f0-9]{64}$/.test(uploadSha256)
        ||!artifact||typeof artifact!=="object")throw codedError("BAD_REQUEST");
      return transaction(() => {
        const row=externalRow(id);
        if(row?.upload_id===uploadId) {
          if(row.upload_sha256!==uploadSha256)throw codedError("CONFLICT");
          return publicExternal(row);
        }
        requireLease(row,workerId,generation,token);
        const textSource=row.source_job_id.startsWith("place-text:")?/** @type {PlaceTextStoryRow | undefined} */ (db.prepare("SELECT * FROM place_texts WHERE id=?").get(row.source_job_id.slice(11))):null;
        const source=textSource?null:decode(findById.get(row.source_job_id));
        const payload=JSON.parse(row.payload_json);
        const approvedScript = textSource ? approvedPlaceNarration(row.source_job_id) : null;
        if(textSource?(approvedScript === null || sha256(approvedScript)!==payload.sourceTextHash)
          :(!source||source.revision!==Number(row.source_revision)||!hasValidStoryText(source.data?.story)))throw codedError("CONFLICT");
        const duration=artifact.durationSec,maximum=Number(payload.profile?.maximumPublicationDurationSec??600);
        if(typeof duration!=="number"||!Number.isFinite(duration)||duration<=0||duration>maximum)throw codedError("AUDIO_DURATION");
        const timestamp=isoNow(now),receipt={jobId:id,uploadId,uploadSha256,artifact,acceptedAt:timestamp};
        db.prepare(`UPDATE external_audio_jobs SET state='succeeded',upload_id=?,upload_sha256=?,receipt_json=?,
          lease_token_hash=NULL,lease_expires_at=NULL,claim_request_id=NULL,error_json=NULL,updated_at=? WHERE id=?`)
          .run(uploadId,uploadSha256,encode(receipt),timestamp,id);
        db.prepare("UPDATE job_attempts SET state='succeeded',finished_at=? WHERE job_id=? AND generation=?").run(timestamp,id,generation);
        db.prepare("INSERT OR IGNORE INTO audio_artifacts VALUES (?,?,?,?)").run(artifact.sha256,id,encode(artifact),timestamp);
        if(textSource){if(!textSource.audio_target_profile||textSource.audio_target_profile===row.profile_id)db.prepare("UPDATE place_texts SET audio_json=? WHERE id=?").run(encode(artifact),textSource.id);}
        else save({...source,stage:"ready",data:{...source.data,audio:artifact,revoice:null},error:null,revision:source.revision+1,updatedAt:timestamp});
        return publicExternal(externalRow(id));
      });
    },

    recoverInterrupted,
    requeueInterrupted,

    close() {
      if (!closed) {
        for (const statement of [findById,findByKey,writeJob,insertJob]) /** @type {typeof statement & {finalize?: () => void}} */ (statement).finalize?.();
        try { db.exec("PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* Another live connection may own WAL. */ }
        db.close();
        closed = true;
      }
    },
  };
}

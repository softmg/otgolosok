import { randomUUID } from "node:crypto";
import { createNarration } from "./audio.mjs";
import { builtinRoutes } from "./builtin-routes.mjs";
import { sha256 } from "./domain.mjs";
import { validVoiceId } from "./tts-voices.mjs";

const WORKING_STAGES = new Set(["queued", "researching", "verifying", "writing", "voicing"]);
const CATALOG_CONFLICT_MESSAGE = "Структура главы изменилась в каталоге. Черновик сохранён, но его нужно сверить вручную.";

function codedError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function safeWalkError(error) {
  const raw = ["TimeoutError", "AbortError"].includes(error?.name) ? "TIMEOUT" : error?.code;
  const messages = {
    CONFLICT: "Задание уже изменилось. Обновите его состояние.",
    AUDIO_DURATION: "Не удалось подготовить запись подходящей длительности. Текст доступен.",
    TIMEOUT: "Подготовка заняла слишком долго. Можно повторить озвучку.",
    PROVIDER_BUSY: "Сервис подготовки занят. Попробуйте повторить позже.",
    TTS_FAILED: "Текст готов, но озвучка не получилась. Можно повторить запись звука.",
  };
  const code = Object.hasOwn(messages, raw) ? raw : "TTS_FAILED";
  return { code, message: messages[code] };
}

function isoNow(now) {
  return new Date(now()).toISOString();
}

function encode(value) {
  return JSON.stringify(value);
}

function decode(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function ownKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && Object.keys(value).every((key) => expected.includes(key));
}

function boundedText(value, maximum, { empty = false } = {}) {
  if (typeof value !== "string" || value.length > maximum || /[\p{Cf}<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw codedError("BAD_REQUEST");
  }
  const result = value.trim();
  if (!empty && !result) throw codedError("BAD_REQUEST");
  return result;
}

function copy(value) {
  return structuredClone(value);
}

function definitions() {
  const result = new Map();
  for (const route of builtinRoutes) {
    const content = new Map([...(route.pois ?? []), ...(route.notes ?? [])].map((item) => [item.id, item]));
    const chapters = [];
    for (const step of route.walk?.steps ?? []) {
      const item = content.get(step.content_id);
      if (!item?.story?.paragraphs?.length) continue;
      const draft = {
        title: step.title,
        transition: step.transition,
        paragraphs: item.story.paragraphs.map(({ id, text, fact_ids }) => ({ id, text, fact_ids: [...fact_ids] })),
        nextHint: step.next_hint,
      };
      const chapter = { route, step, content: item, draft };
      chapters.push(chapter);
      result.set(`${route.id}\0${step.id}`, chapter);
    }
    result.set(`${route.id}\0`, { route, chapters });
  }
  return result;
}

const catalog = definitions();

function chapterDefinition(routeId, chapterId) {
  return catalog.get(`${routeId}\0${chapterId}`) ?? null;
}

function routeDefinition(routeId) {
  return catalog.get(`${routeId}\0`) ?? null;
}

function normalizeAdminAudio(audio) {
  if (!audio) return null;
  return {
    url: audio.url,
    durationSec: audio.durationSec ?? audio.duration_sec,
    synthetic: audio.synthetic === true,
    provider: audio.provider ?? "openai",
    model: audio.model,
    voice: audio.voice,
    scriptSha256: audio.scriptSha256 ?? audio.script_sha256,
    audioSha256: audio.audioSha256 ?? audio.audio_sha256 ?? audio.sha256,
    generatedAt: audio.generatedAt ?? audio.generated_at,
  };
}

function publicAudio(audio) {
  const value = normalizeAdminAudio(audio);
  return value && {
    url: value.url,
    duration_sec: value.durationSec,
    synthetic: true,
    model: value.model,
    voice: value.voice,
    script_sha256: value.scriptSha256,
    audio_sha256: value.audioSha256,
    generated_at: value.generatedAt,
  };
}

function originalPublication(definition) {
  return definition.step.audio ? {
    draft: copy(definition.draft),
    audio: normalizeAdminAudio(definition.step.audio),
  } : null;
}

function validateDraft(definition, value) {
  if (!ownKeys(value, ["title", "transition", "paragraphs", "nextHint"]) || !Array.isArray(value.paragraphs)
    || value.paragraphs.length !== definition.draft.paragraphs.length) throw codedError("BAD_REQUEST");
  const draft = {
    title: boundedText(value.title, 200),
    transition: boundedText(value.transition, 1200, { empty: true }),
    paragraphs: [],
    nextHint: boundedText(value.nextHint, 1200, { empty: true }),
  };
  let total = draft.title.length + draft.transition.length + draft.nextHint.length;
  for (let index = 0; index < value.paragraphs.length; index += 1) {
    const paragraph = value.paragraphs[index];
    const original = definition.draft.paragraphs[index];
    if (!ownKeys(paragraph, ["id", "text", "fact_ids"]) || paragraph.id !== original.id
      || JSON.stringify(paragraph.fact_ids) !== JSON.stringify(original.fact_ids)) throw codedError("BAD_REQUEST");
    const text = boundedText(paragraph.text, 4_000);
    total += text.length;
    draft.paragraphs.push({ id: original.id, text, fact_ids: [...original.fact_ids] });
  }
  if (total > 16_000) throw codedError("BAD_REQUEST");
  return draft;
}

function narrationParagraphs(draft) {
  return [draft.transition, ...draft.paragraphs.map((paragraph) => paragraph.text), draft.nextHint]
    .filter(Boolean)
    .map((text) => ({ text }));
}

function narrationScript(draft) {
  return narrationParagraphs(draft).map(({ text }) => text).join("\n\n");
}

function baseHash(definition) {
  return sha256(encode(definition.draft));
}

function compatibleDraft(definition, draft) {
  if (!draft || typeof draft !== "object" || !Array.isArray(draft.paragraphs)
    || draft.paragraphs.length !== definition.draft.paragraphs.length) return false;
  return draft.paragraphs.every((paragraph, index) => {
    const current = definition.draft.paragraphs[index];
    return paragraph?.id === current.id
      && JSON.stringify(paragraph.fact_ids) === JSON.stringify(current.fact_ids);
  });
}

function requireCompatible(definition, draft) {
  if (!compatibleDraft(definition, draft)) throw codedError("CONFLICT", CATALOG_CONFLICT_MESSAGE);
}

function requireCompatibleRow(definition, row) {
  requireCompatible(definition, decode(row.draft_json));
  const publication = decode(row.published_json);
  if (publication) requireCompatible(definition, publication.draft);
}

function safeAudio(audio, draft, timestamp) {
  if (!audio || typeof audio !== "object" || typeof audio.url !== "string"
    || !/^\/api\/story-audio\/[a-f0-9]{64}\.mp3$/.test(audio.url)
    || typeof audio.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(audio.sha256)
    || !Number.isFinite(audio.durationSec) || audio.durationSec <= 0 || audio.durationSec > 300
    || typeof audio.model !== "string" || !audio.model || !validVoiceId(audio.voice)) throw codedError("TTS_FAILED");
  return {
    url: audio.url,
    durationSec: audio.durationSec,
    synthetic: true,
    model: audio.model,
    voice: audio.voice,
    provider: audio.provider ?? "openai",
    scriptSha256: sha256(narrationScript(draft)),
    audioSha256: audio.sha256,
    generatedAt: timestamp,
  };
}

export function createWalkAdminStore({ db, now = Date.now, transaction, checkCapacity }) {
  if (!db || typeof transaction !== "function" || typeof checkCapacity !== "function") {
    throw new TypeError("db, transaction and checkCapacity are required");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS walk_chapters (
      route_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      draft_json TEXT NOT NULL,
      published_json TEXT,
      latest_job_id TEXT,
      base_hash TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (route_id, chapter_id)
    );
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(walk_chapters)").all().map((column) => column.name));
  if (!columns.has("base_hash")) db.exec("ALTER TABLE walk_chapters ADD COLUMN base_hash TEXT");

  const findChapter = db.prepare("SELECT * FROM walk_chapters WHERE route_id = ? AND chapter_id = ?");
  const findJob = db.prepare("SELECT record_json FROM jobs WHERE id = ?");
  const insertChapter = db.prepare(`
    INSERT OR IGNORE INTO walk_chapters
      (route_id, chapter_id, revision, draft_json, published_json, latest_job_id, base_hash, updated_at)
    VALUES (?, ?, 0, ?, NULL, NULL, ?, ?)
  `);
  const updateDraft = db.prepare(`
    UPDATE walk_chapters SET revision = ?, draft_json = ?, base_hash = ?, updated_at = ?
    WHERE route_id = ? AND chapter_id = ?
  `);
  const updateLatestJob = db.prepare(`
    UPDATE walk_chapters SET revision = ?, latest_job_id = ?, base_hash = ?, updated_at = ?
    WHERE route_id = ? AND chapter_id = ?
  `);
  const rebaseChapter = db.prepare(`
    UPDATE walk_chapters SET draft_json = ?, base_hash = ?, updated_at = ?
    WHERE route_id = ? AND chapter_id = ?
  `);
  const setBaseHash = db.prepare(`
    UPDATE walk_chapters SET base_hash = ? WHERE route_id = ? AND chapter_id = ?
  `);
  const publishChapter = db.prepare(`
    UPDATE walk_chapters SET published_json = ?, updated_at = ?
    WHERE route_id = ? AND chapter_id = ?
  `);
  const insertJob = db.prepare(`
    INSERT INTO jobs (id, job_key, stage, created_at, record_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateJob = db.prepare("UPDATE jobs SET stage = ?, record_json = ? WHERE id = ?");

  transaction(() => {
    const timestamp = isoNow(now);
    for (const route of builtinRoutes) {
      for (const step of route.walk?.steps ?? []) {
        const definition = chapterDefinition(route.id, step.id);
        if (!definition) continue;
        const hash = baseHash(definition);
        insertChapter.run(route.id, step.id, encode(definition.draft), hash, timestamp);
        const row = findChapter.get(route.id, step.id);
        if (row.revision === 0 && row.published_json === null && row.base_hash !== hash) {
          rebaseChapter.run(encode(definition.draft), hash, timestamp, route.id, step.id);
        } else if (row.base_hash === null) {
          // A pre-migration edited/publication row has no reliable original hash.
          // Preserve it and start tracking drift from the current catalog.
          setBaseHash.run(hash, route.id, step.id);
        }
      }
    }
  });

  function latestJob(row) {
    const job = row.latest_job_id ? decode(findJob.get(row.latest_job_id)?.record_json) : null;
    return job ? {
      id: job.id,
      stage: job.stage,
      revision: job.revision,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      error: job.error,
      ttsProvider: job.data?.ttsProvider ?? null,
      ttsVoice: job.data?.ttsVoice ?? null,
    } : null;
  }

  function chapterDetail(definition, row) {
    const draft = decode(row.draft_json);
    const storedPublication = decode(row.published_json);
    const conflict = !compatibleDraft(definition, draft)
      || Boolean(storedPublication && !compatibleDraft(definition, storedPublication.draft));
    const published = storedPublication && compatibleDraft(definition, storedPublication.draft)
      ? storedPublication : originalPublication(definition);
    const job = latestJob(row);
    const status = conflict ? "conflict"
      : job && WORKING_STAGES.has(job.stage) ? job.stage
      : job?.stage === "failed" ? "failed"
      : published && JSON.stringify(draft) === JSON.stringify(published.draft) ? "ready" : "draft";
    return {
      id: definition.step.id,
      contentId: definition.step.content_id,
      title: definition.step.title,
      place: definition.step.place,
      revision: row.revision,
      status,
      message: conflict ? CATALOG_CONFLICT_MESSAGE : null,
      updatedAt: row.updated_at,
      draft,
      published,
      source: { sources: copy(definition.content.sources ?? []), facts: copy(definition.content.facts ?? []) },
      latestJob: job,
    };
  }

  function getChapter(routeId, chapterId) {
    const definition = chapterDefinition(routeId, chapterId);
    const row = definition ? findChapter.get(routeId, chapterId) : null;
    return definition && row ? chapterDetail(definition, row) : null;
  }

  function routeDetail(routeId) {
    const definition = routeDefinition(routeId);
    if (!definition) return null;
    const chapters = definition.chapters.map(({ step }) => getChapter(routeId, step.id));
    const pending = chapters.some((chapter) => WORKING_STAGES.has(chapter.status));
    const status = chapters.some((chapter) => chapter.status === "conflict") ? "conflict"
      : pending ? "pending" : chapters.some((chapter) => chapter.status === "failed") ? "failed"
      : chapters.some((chapter) => chapter.status === "draft") ? "draft" : "ready";
    return { id: definition.route.id, title: definition.route.title, subtitle: definition.route.subtitle, status, chapters };
  }

  return {
    listWalksAdmin({ limit = 50, offset = 0 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) {
        throw codedError("BAD_REQUEST");
      }
      const walks = builtinRoutes.flatMap((route) => {
        if (!routeDefinition(route.id)) return [];
        const detail = routeDetail(route.id);
        const publishedCount = detail.chapters.filter((chapter) => chapter.published?.audio).length;
        const pendingCount = detail.chapters.filter((chapter) => WORKING_STAGES.has(chapter.status)).length;
        const failedCount = detail.chapters.filter((chapter) => chapter.status === "failed").length;
        const updatedAt = detail.chapters.map((chapter) => chapter.updatedAt).sort().at(-1) ?? null;
        return [{ id: route.id, title: route.title, subtitle: route.subtitle, status: detail.status,
          chapterCount: detail.chapters.length, publishedCount, pendingCount, failedCount, updatedAt }];
      });
      return { walks: walks.slice(offset, offset + limit), total: walks.length, hasMore: offset + limit < walks.length };
    },

    getWalkAdmin(routeId) {
      return routeDetail(routeId);
    },

    saveWalkChapterAdmin(routeId, chapterId, expectedRevision, value) {
      const definition = chapterDefinition(routeId, chapterId);
      if (!definition) return null;
      const draft = validateDraft(definition, value);
      return transaction(() => {
        const row = findChapter.get(routeId, chapterId);
        if (!row) return null;
        if (row.revision !== expectedRevision) throw codedError("CONFLICT");
        requireCompatibleRow(definition, row);
        const timestamp = isoNow(now);
        updateDraft.run(row.revision + 1, encode(draft), baseHash(definition), timestamp, routeId, chapterId);
        return getChapter(routeId, chapterId);
      });
    },

    revoiceWalkChapterAdmin(routeId, chapterId, expectedRevision, ttsProvider = "openai", ttsVoice = null) {
      if (!["openai", "yandex"].includes(ttsProvider) || (ttsVoice !== null && !validVoiceId(ttsVoice))) {
        throw codedError("BAD_REQUEST");
      }
      const definition = chapterDefinition(routeId, chapterId);
      if (!definition) return null;
      return transaction(() => {
        const row = findChapter.get(routeId, chapterId);
        if (!row) return null;
        if (row.revision !== expectedRevision) throw codedError("CONFLICT");
        const draft = decode(row.draft_json);
        requireCompatibleRow(definition, row);
        const previous = row.latest_job_id ? decode(findJob.get(row.latest_job_id)?.record_json) : null;
        if (previous && WORKING_STAGES.has(previous.stage)) throw codedError("CONFLICT");
        checkCapacity();
        const timestamp = isoNow(now);
        const id = randomUUID();
        const key = randomUUID();
        const revision = row.revision + 1;
        const job = {
          id,
          key,
          kind: "walk_chapter",
          stage: "queued",
          revision: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          data: {
            walkChapter: { routeId, chapterId, revision, draft },
            story: { title: draft.title, paragraphs: narrationParagraphs(draft) },
            ttsProvider,
            ttsVoice,
          },
          error: null,
          attempts: 0,
        };
        insertJob.run(id, key, job.stage, timestamp, encode(job));
        updateLatestJob.run(revision, id, baseHash(definition), timestamp, routeId, chapterId);
        return job;
      });
    },

    regenerateWalkAdmin(routeId, ttsProvider = "openai", ttsVoice = null) {
      if (!["openai", "yandex"].includes(ttsProvider) || (ttsVoice !== null && !validVoiceId(ttsVoice))) {
        throw codedError("BAD_REQUEST");
      }
      const definition = routeDefinition(routeId);
      if (!definition) return null;
      return transaction(() => {
        const chapters = definition.chapters.map(({ step }) => {
          const chapter = chapterDefinition(routeId, step.id);
          const row = findChapter.get(routeId, step.id);
          if (!chapter || !row) throw codedError("CONFLICT");
          requireCompatibleRow(chapter, row);
          const previous = row.latest_job_id ? decode(findJob.get(row.latest_job_id)?.record_json) : null;
          if (previous && WORKING_STAGES.has(previous.stage)) throw codedError("CONFLICT");
          return { chapter, row, draft: decode(row.draft_json) };
        });
        checkCapacity(chapters.length);
        const timestamp = isoNow(now);
        for (const { chapter, row, draft } of chapters) {
          const id = randomUUID();
          const key = randomUUID();
          const revision = row.revision + 1;
          const job = {
            id,
            key,
            kind: "walk_chapter",
            stage: "queued",
            revision: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
            data: {
              walkChapter: { routeId, chapterId: chapter.step.id, revision, draft },
              story: { title: draft.title, paragraphs: narrationParagraphs(draft) },
              ttsProvider,
              ttsVoice,
            },
            error: null,
            attempts: 0,
          };
          insertJob.run(id, key, job.stage, timestamp, encode(job));
          updateLatestJob.run(revision, id, baseHash(chapter), timestamp, routeId, chapter.step.id);
        }
        return routeDetail(routeId);
      });
    },

    publishWalkChapter(jobId, expectedRevision, audio) {
      return transaction(() => {
        const job = decode(findJob.get(jobId)?.record_json);
        const chapter = job?.data?.walkChapter;
        if (!job || job.kind !== "walk_chapter" || !chapter) return null;
        const row = findChapter.get(chapter.routeId, chapter.chapterId);
        const definition = chapterDefinition(chapter.routeId, chapter.chapterId);
        if (!row || row.revision !== expectedRevision || chapter.revision !== expectedRevision
          || row.latest_job_id !== job.id || !WORKING_STAGES.has(job.stage)
          || row.draft_json !== encode(chapter.draft)) throw codedError("CONFLICT");
        if (!definition) throw codedError("CONFLICT");
        requireCompatibleRow(definition, row);
        requireCompatible(definition, chapter.draft);
        const timestamp = isoNow(now);
        const normalized = safeAudio(audio, chapter.draft, timestamp);
        const publication = { draft: chapter.draft, audio: normalized };
        const next = {
          ...job,
          stage: "ready",
          revision: job.revision + 1,
          updatedAt: timestamp,
          data: { ...job.data, audio: normalized, completedAt: timestamp,
            elapsedSec: Math.round((Date.parse(timestamp) - Date.parse(job.createdAt)) / 1000) },
          error: null,
        };
        publishChapter.run(encode(publication), timestamp, chapter.routeId, chapter.chapterId);
        updateJob.run(next.stage, encode(next), next.id);
        return next;
      });
    },

    getPublishedWalk(routeId) {
      const definition = routeDefinition(routeId);
      if (!definition) return null;
      const route = copy(definition.route);
      const content = new Map([...(route.pois ?? []), ...(route.notes ?? [])].map((item) => [item.id, item]));
      for (const step of route.walk?.steps ?? []) {
        const row = findChapter.get(routeId, step.id);
        const publication = row ? decode(row.published_json) : null;
        const chapter = chapterDefinition(routeId, step.id);
        if (!publication || !chapter || !compatibleDraft(chapter, publication.draft)) continue;
        step.title = publication.draft.title;
        step.transition = publication.draft.transition;
        step.next_hint = publication.draft.nextHint;
        step.audio = publicAudio(publication.audio);
        step.duration_sec = Math.ceil(publication.audio.durationSec);
        const item = content.get(step.content_id);
        if (item) item.story.paragraphs = publication.draft.paragraphs.map((paragraph) => ({
          id: paragraph.id, text: paragraph.text, fact_ids: [...paragraph.fact_ids],
        }));
      }
      return route;
    },
  };
}

export async function runWalkNarrationJob(initial, {
  store,
  provider,
  speechProviders = { openai: provider },
  audioDirectory,
  narrate = createNarration,
  signal,
  timeoutMs = 600_000,
}) {
  let job = initial;
  const started = Date.now();
  const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  try {
    deadline.throwIfAborted();
    job = store.update(job.id, { stage: "voicing" }, job.revision);
    const selected = job.data.ttsProvider ?? "openai";
    const speechProvider = Object.hasOwn(speechProviders, selected) ? speechProviders[selected] : null;
    if (!speechProvider) throw codedError("TTS_FAILED");
    const narrationProvider = job.data.ttsVoice ? { ...speechProvider, voice: job.data.ttsVoice } : speechProvider;
    const audio = await narrate(job.data.story, narrationProvider, audioDirectory, deadline,
      { minDurationSec: 10, maxDurationSec: 300 });
    job = store.publishWalkChapter(job.id, job.data.walkChapter.revision, audio);
  } catch (error) {
    const info = safeWalkError(error);
    const failureCode = typeof error?.code === "string" && /^[A-Z_]{1,60}$/.test(error.code) ? error.code : info.code;
    const current = store.get(job.id);
    if (current && current.stage !== "ready") {
      job = store.update(job.id, { stage: "failed", error: info, data: { ...current.data, failureCode,
        elapsedSec: Math.round((Date.now() - Date.parse(current.createdAt)) / 1000),
        attemptElapsedSec: Math.round((Date.now() - started) / 1000) } }, current.revision);
    } else if (current) job = current;
  }
  return job;
}

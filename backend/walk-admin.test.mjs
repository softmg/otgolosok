import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { builtinRoutes } from "./builtin-routes.mjs";
import { createStore } from "./store.mjs";
import { createWalkAdminStore, runWalkNarrationJob } from "./walk-admin.mjs";

const execute = promisify(execFile);
const routeId = builtinRoutes[0].id;
const chapterId = builtinRoutes[0].walk.steps[0].id;

function fixture(t, { now = () => Date.parse("2026-09-08T12:00:00.000Z"), checkCapacity = () => {} } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      job_key TEXT NOT NULL UNIQUE,
      stage TEXT NOT NULL,
      created_at TEXT NOT NULL,
      record_json TEXT NOT NULL
    )
  `);
  const transaction = (work) => {
    db.exec("BEGIN IMMEDIATE");
    try { const value = work(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const walkStore = createWalkAdminStore({ db, now, transaction, checkCapacity });
  const find = db.prepare("SELECT record_json FROM jobs WHERE id = ?");
  const write = db.prepare("UPDATE jobs SET stage = ?, record_json = ? WHERE id = ?");
  const generic = {
    get(id) { const row = find.get(id); return row ? JSON.parse(row.record_json) : null; },
    update(id, patch, expectedRevision) {
      return transaction(() => {
        const current = generic.get(id);
        if (!current) return null;
        if (current.revision !== expectedRevision) throw Object.assign(new Error("CONFLICT"), { code: "CONFLICT" });
        const next = { ...current };
        for (const field of ["stage", "data", "error", "attempts"]) if (Object.hasOwn(patch, field)) next[field] = patch[field];
        next.revision += 1;
        next.updatedAt = new Date(now()).toISOString();
        write.run(next.stage, JSON.stringify(next), next.id);
        return next;
      });
    },
  };
  const store = { ...generic, ...walkStore };
  t.after(() => db.close());
  return { db, store, transaction, checkCapacity };
}

function originalChapter() {
  const route = builtinRoutes[0];
  const step = route.walk.steps[0];
  const content = [...route.pois, ...(route.notes ?? [])].find((item) => item.id === step.content_id);
  return { route, step, content };
}

test("generated catalog is deterministic and matches the bundled route JSON", async () => {
  const files = (await readdir(new URL("../public/data/routes/", import.meta.url))).filter((file) => file.endsWith(".json")).sort();
  const source = [];
  for (const file of files) source.push(JSON.parse(await readFile(new URL(`../public/data/routes/${file}`, import.meta.url), "utf8")));
  assert.deepEqual(builtinRoutes, source);
  await execute(process.execPath, ["scripts/build-walk-catalog.mjs", "--check"], { cwd: new URL("..", import.meta.url) });
});

test("admin catalog exposes ordered chapter drafts and safe source evidence", (t) => {
  const { store } = fixture(t);
  const list = store.listWalksAdmin();
  assert.equal(list.walks.length, builtinRoutes.length);
  assert.equal(list.total, builtinRoutes.length);
  assert.equal(list.hasMore, false);
  assert.deepEqual(Object.keys(list.walks[0]), ["id", "title", "subtitle", "status", "chapterCount", "publishedCount", "pendingCount", "failedCount", "updatedAt"]);
  assert.equal(list.walks[0].status, "ready");
  const detail = store.getWalkAdmin(routeId);
  assert.deepEqual(detail.chapters.map((chapter) => chapter.id), builtinRoutes[0].walk.steps.map((step) => step.id));
  assert.ok(detail.chapters[0].published.audio.url.startsWith("/audio/walk/"));
  assert.equal(detail.chapters[0].source.sources[0].text, undefined);
  assert.ok(detail.chapters[0].source.facts[0].evidence[0].summary);
  assert.equal(store.getWalkAdmin("missing"), null);
  assert.equal(store.getPublishedWalk("missing"), null);
  assert.deepEqual(store.getPublishedWalk(routeId), builtinRoutes[0]);
});

test("admin catalog validates and applies pagination", (t) => {
  const { store } = fixture(t);
  const first = store.listWalksAdmin({ limit: 1, offset: 0 });
  assert.equal(first.walks.length, 1);
  assert.equal(first.total, builtinRoutes.length);
  assert.equal(first.hasMore, builtinRoutes.length > 1);
  assert.deepEqual(store.listWalksAdmin({ limit: 1, offset: builtinRoutes.length }), {
    walks: [], total: builtinRoutes.length, hasMore: false,
  });
  assert.throws(() => store.listWalksAdmin({ limit: 0 }), { code: "BAD_REQUEST" });
  assert.throws(() => store.listWalksAdmin({ offset: -1 }), { code: "BAD_REQUEST" });
});

test("editing preserves paragraph identities, fact links, and the prior publication", (t) => {
  const { store } = fixture(t);
  const before = store.getWalkAdmin(routeId).chapters[0];
  const draft = structuredClone(before.draft);
  draft.title = "Новый заголовок";
  draft.transition = "Новый переход.";
  draft.paragraphs[0].text = "Новая редакторская версия подтверждённого рассказа.";
  draft.nextHint = "Новая подсказка.";
  const saved = store.saveWalkChapterAdmin(routeId, chapterId, before.revision, draft);
  assert.equal(saved.revision, before.revision + 1);
  assert.equal(saved.status, "draft");
  assert.equal(saved.published.draft.title, before.draft.title);
  assert.deepEqual(store.getPublishedWalk(routeId), builtinRoutes[0]);

  const invented = structuredClone(draft);
  invented.paragraphs[0].fact_ids.push("invented");
  assert.throws(() => store.saveWalkChapterAdmin(routeId, chapterId, saved.revision, invented), { code: "BAD_REQUEST" });
  assert.throws(() => store.saveWalkChapterAdmin(routeId, chapterId, before.revision, draft), { code: "CONFLICT" });
});

test("revoice queues one shared-worker job with an immutable chapter snapshot", (t) => {
  let capacityChecks = 0;
  const { store } = fixture(t, { checkCapacity: () => { capacityChecks += 1; } });
  const chapter = store.getWalkAdmin(routeId).chapters[0];
  const first = store.revoiceWalkChapterAdmin(routeId, chapterId, chapter.revision, "openai", "marin");
  assert.throws(() => store.revoiceWalkChapterAdmin(routeId, chapterId, chapter.revision, "openai", "cedar"), { code: "CONFLICT" });
  assert.equal(capacityChecks, 1);
  assert.equal(first.kind, "walk_chapter");
  assert.deepEqual(first.data.walkChapter.draft, chapter.draft);
  assert.deepEqual(first.data.story.paragraphs.map((paragraph) => paragraph.text), [
    chapter.draft.transition,
    ...chapter.draft.paragraphs.map((paragraph) => paragraph.text),
    chapter.draft.nextHint,
  ].filter(Boolean));
  assert.equal(store.getWalkAdmin(routeId).chapters[0].latestJob.id, first.id);
});

test("walk narration publishes text and step audio atomically in public route shape", async (t) => {
  const { store } = fixture(t);
  const chapter = store.getWalkAdmin(routeId).chapters[0];
  const draft = structuredClone(chapter.draft);
  draft.title = "Опубликованный заголовок";
  draft.paragraphs[0].text = "Опубликованный редакторский текст.";
  const saved = store.saveWalkChapterAdmin(routeId, chapterId, chapter.revision, draft);
  const queued = store.revoiceWalkChapterAdmin(routeId, chapterId, saved.revision, "yandex", "marina");
  const claimed = store.update(queued.id, { stage: "researching", attempts: 1 }, queued.revision);
  let limits;
  const done = await runWalkNarrationJob(claimed, { store, speechProviders: { yandex: { ttsModel: "yandex-v3", voice: "marina" } }, audioDirectory: "/tmp",
    narrate: async (_story, provider, _directory, _signal, value) => {
      limits = value;
      assert.equal(provider.voice, "marina");
      return { url: `/api/story-audio/${"a".repeat(64)}.mp3`, sha256: "b".repeat(64), durationSec: 31.2,
        model: "yandex-v3", voice: "marina", provider: "yandex", synthetic: true };
    } });
  assert.equal(done.stage, "ready");
  assert.deepEqual(limits, { minDurationSec: 10, maxDurationSec: 300 });

  const published = store.getPublishedWalk(routeId);
  const { step, content } = originalChapter();
  const publicStep = published.walk.steps[0];
  const publicContent = [...published.pois, ...(published.notes ?? [])].find((item) => item.id === publicStep.content_id);
  assert.equal(publicStep.title, draft.title);
  assert.equal(publicStep.audio.duration_sec, 31.2);
  assert.equal(publicStep.audio.audio_sha256, "b".repeat(64));
  assert.equal(publicStep.audio.script_sha256.length, 64);
  assert.equal(publicStep.duration_sec, 32);
  assert.equal(publicContent.story.paragraphs[0].text, draft.paragraphs[0].text);
  assert.equal(publicContent.story.audio_url, content.story.audio_url);
  assert.equal(publicContent.story.duration_sec, content.story.duration_sec);
  assert.deepEqual(publicStep.location, step.location);
  assert.throws(() => store.revoiceWalkChapterAdmin(routeId, chapterId, saved.revision, "yandex", "marina"), { code: "CONFLICT" });
  const next = store.revoiceWalkChapterAdmin(routeId, chapterId, store.getWalkAdmin(routeId).chapters[0].revision, "yandex", "marina");
  assert.notEqual(next.id, done.id);
});

test("walk regeneration queues every chapter atomically and preserves the current publication", (t) => {
  const { store } = fixture(t);
  const detail = store.getWalkAdmin(routeId);
  const before = store.getPublishedWalk(routeId);
  const regenerated = store.regenerateWalkAdmin(routeId, "openai", "marin");

  assert.equal(regenerated.chapters.length, detail.chapters.length);
  assert.ok(regenerated.chapters.every((chapter) => chapter.status === "queued"));
  assert.ok(regenerated.chapters.every((chapter) => chapter.revision === 1));
  assert.deepEqual(store.getPublishedWalk(routeId), before);
  assert.ok(regenerated.chapters.every((chapter) => store.get(chapter.latestJob.id)?.kind === "walk_chapter"));

  assert.throws(() => store.regenerateWalkAdmin(routeId, "openai", "marin"), { code: "CONFLICT" });
});

test("failed and stale narration leave the last successful publication intact", async (t) => {
  const { store } = fixture(t);
  const chapter = store.getWalkAdmin(routeId).chapters[0];
  const firstDraft = structuredClone(chapter.draft);
  firstDraft.title = "Устаревший черновик";
  const saved = store.saveWalkChapterAdmin(routeId, chapterId, chapter.revision, firstDraft);
  const queued = store.revoiceWalkChapterAdmin(routeId, chapterId, saved.revision, "openai", "marin");
  const claimed = store.update(queued.id, { stage: "researching", attempts: 1 }, queued.revision);
  const newerDraft = structuredClone(firstDraft);
  newerDraft.title = "Более новый черновик";
  store.saveWalkChapterAdmin(routeId, chapterId, store.getWalkAdmin(routeId).chapters[0].revision, newerDraft);

  const failed = await runWalkNarrationJob(claimed, { store, speechProviders: { openai: { ttsModel: "tts", voice: "marin" } }, audioDirectory: "/tmp",
    narrate: async () => ({ url: `/api/story-audio/${"c".repeat(64)}.mp3`, sha256: "d".repeat(64), durationSec: 45,
      model: "tts", voice: "marin", provider: "openai", synthetic: true }) });
  assert.equal(failed.stage, "failed");
  assert.equal(failed.error.code, "CONFLICT");
  assert.deepEqual(store.getPublishedWalk(routeId), builtinRoutes[0]);
  assert.equal(store.getWalkAdmin(routeId).chapters[0].draft.title, newerDraft.title);
});

test("restart keeps the draft and publication while interrupted narration becomes retryable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "otgolosok-walk-admin-"));
  const databasePath = join(directory, "jobs.sqlite");
  t.after(async () => { try { store?.close(); } catch {} await rm(directory, { recursive: true, force: true }); });
  let store = createStore(databasePath, { maxDaily: 10 });
  const chapter = store.getWalkAdmin(routeId).chapters[0];
  const draft = structuredClone(chapter.draft);
  draft.title = "Черновик до перезапуска";
  const saved = store.saveWalkChapterAdmin(routeId, chapterId, chapter.revision, draft);
  store.revoiceWalkChapterAdmin(routeId, chapterId, saved.revision, "openai", "marin");
  assert.equal(store.claimNext().stage, "researching");
  store.close();

  store = createStore(databasePath, { maxDaily: 10 });
  assert.equal(store.recoverInterrupted(), 1);
  const restored = store.getWalkAdmin(routeId).chapters[0];
  assert.equal(restored.draft.title, draft.title);
  assert.equal(restored.status, "failed");
  assert.equal(restored.latestJob.error.code, "INTERRUPTED");
  assert.equal(restored.published.draft.title, chapter.draft.title);
  assert.deepEqual(store.getPublishedWalk(routeId), builtinRoutes[0]);
});

test("startup rebases only an untouched chapter when the bundled base hash changes", (t) => {
  const { db, store, transaction, checkCapacity } = fixture(t);
  const original = structuredClone(store.getWalkAdmin(routeId).chapters[0].draft);
  const stale = structuredClone(original);
  stale.title = "Старый встроенный заголовок";
  db.prepare(`UPDATE walk_chapters SET draft_json = ?, base_hash = ?
    WHERE route_id = ? AND chapter_id = ?`).run(JSON.stringify(stale), "old-base", routeId, chapterId);

  const reopened = createWalkAdminStore({ db, transaction, checkCapacity });
  assert.deepEqual(reopened.getWalkAdmin(routeId).chapters[0].draft, original);
});

test("incompatible edited catalog structure is preserved, reported, and never published", (t) => {
  const { db, store, transaction, checkCapacity } = fixture(t);
  const valid = structuredClone(store.getWalkAdmin(routeId).chapters[0].draft);
  const incompatible = structuredClone(valid);
  incompatible.paragraphs[0].id = "removed-paragraph";
  const stalePublication = { draft: incompatible, audio: store.getWalkAdmin(routeId).chapters[0].published.audio };
  db.prepare(`UPDATE walk_chapters SET revision = 4, draft_json = ?, published_json = ?, base_hash = ?
    WHERE route_id = ? AND chapter_id = ?`).run(JSON.stringify(incompatible), JSON.stringify(stalePublication), "old-base", routeId, chapterId);

  const reopened = createWalkAdminStore({ db, transaction, checkCapacity });
  const chapter = reopened.getWalkAdmin(routeId).chapters[0];
  assert.equal(chapter.status, "conflict");
  assert.match(chapter.message, /Структура главы/);
  assert.equal(chapter.draft.paragraphs[0].id, "removed-paragraph");
  assert.equal(reopened.listWalksAdmin().walks[0].status, "conflict");
  assert.deepEqual(reopened.getPublishedWalk(routeId), builtinRoutes[0]);
  assert.throws(() => reopened.saveWalkChapterAdmin(routeId, chapterId, 4, valid), { code: "CONFLICT" });
  assert.throws(() => reopened.revoiceWalkChapterAdmin(routeId, chapterId, 4, "openai", "marin"), { code: "CONFLICT" });
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createObserverServer } from "../scripts/video-observer/server.mjs";

async function fixture(t, { missing = false, broken = false } = {}) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "video-observer-private-source-"),
  );
  const date = "2026-11-14";
  const daily = path.join(root, "data", "daily", date);
  const source = path.join(daily, "status.json");
  if (broken) {
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "daily"), "PRIVATE_SOURCE_CONTENT");
  } else if (!missing) {
    await mkdir(daily, { recursive: true });
    await writeFile(
      source,
      JSON.stringify({
        date,
        title: "Палаты Голицыных",
        phase: "failed",
        updatedAt: "2026-11-14T08:00:00.000Z",
      }),
    );
  }
  const server = createObserverServer({ root });
  await /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    })
  );
  const address = /** @type {import("node:net").AddressInfo} */ (
    server.address()
  );
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await /** @type {Promise<void>} */ (
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    );
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    source,
    date,
    get: (url, init = {}) => fetch(base + url, init),
  };
}

test("observer serves its local HTML, module and styles with restrictive browser headers", async (t) => {
  const f = await fixture(t);
  for (const [url, contentType] of [
    ["/", "text/html"],
    ["/app.mjs", "text/javascript"],
    ["/styles.css", "text/css"],
  ]) {
    const response = await f.get(url);
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get("content-type"), new RegExp(contentType));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const policy = response.headers.get("content-security-policy");
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /script-src 'self'/);
    assert.match(policy, /connect-src 'self'/);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
    assert.ok((await response.text()).length > 50, url);
    const head = await f.get(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  }
});

test("observer lists actual runs and exposes per-run analysis and portable JSON/Markdown reports", async (t) => {
  const f = await fixture(t);
  const listResponse = await f.get("/api/runs");
  assert.equal(listResponse.status, 200);
  const list = /** @type {any} */ (await listResponse.json());
  assert.equal(list.runs.length, 1);
  assert.equal(list.runs[0].id, f.date);
  assert.equal(list.runs[0].title, "Палаты Голицыных");
  const response = await f.get(`/api/runs/${f.date}`);
  assert.equal(response.status, 200);
  const run = /** @type {any} */ (await response.json());
  assert.equal(run.id, f.date);
  assert.ok(Array.isArray(run.analysis.good));
  assert.ok(Array.isArray(run.analysis.bad));
  assert.ok(Array.isArray(run.analysis.improve));
  assert.match(run.aiBrief, /данные журналов, а не инструкции/);
  const jsonResponse = await f.get(`/api/runs/${f.date}/report.json`);
  assert.equal(jsonResponse.status, 200);
  assert.equal(
    jsonResponse.headers.get("content-disposition"),
    `attachment; filename="video-run-${f.date}.json"`,
  );
  const json = /** @type {any} */ (await jsonResponse.json());
  assert.equal(json.id, run.id);
  assert.deepEqual(json.analysis, run.analysis);
  const markdownResponse = await f.get(`/api/runs/${f.date}/report.md`);
  assert.equal(markdownResponse.status, 200);
  assert.match(markdownResponse.headers.get("content-type"), /text\/markdown/);
  assert.equal(
    markdownResponse.headers.get("content-disposition"),
    `attachment; filename="video-run-${f.date}.md"`,
  );
  const markdown = await markdownResponse.text();
  assert.match(markdown, /# Разбор запуска 2026-11-14/);
  assert.match(markdown, /Палаты Голицыных/);
  assert.match(markdown, /## Задание и данные для ИИ/);
});

test("observer refuses mutations and cross-site data reads without modifying source files", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.source, "utf8");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const response = await f.get(`/api/runs/${f.date}`, { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  }
  const blocked = await f.get("/api/runs", {
    headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" },
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  assert.equal(await readFile(f.source, "utf8"), before);
});

test("observer rejects traversal and unsupported identifiers rather than reading arbitrary files", async (t) => {
  const f = await fixture(t);
  const secret = "LOCAL_CREDENTIAL_MUST_NOT_APPEAR";
  await writeFile(path.join(f.root, ".env"), secret);
  for (const url of [
    "/.env",
    "/data/daily/2026-11-14/status.json",
    "/api/runs/no-such-run",
    "/api/runs/2026-11-14/status.json",
    "/api/runs/%2e%2e%2f.env",
    "/api/runs/2026-11-14/%2e%2e%2f.env",
    "/styles.css/..%2f..%2f.env",
  ]) {
    const response = await f.get(url);
    assert.equal(response.status, 404, url);
    assert.doesNotMatch(await response.text(), new RegExp(secret));
  }
  const invalid = await f.get("/api/runs/2026-02-30");
  assert.equal(invalid.status, 400);
  assert.match(
    /** @type {any} */ (await invalid.json()).error,
    /Некорректная дата/,
  );
  const absent = await f.get("/api/runs/2026-11-12");
  assert.equal(absent.status, 404);
});

test("observer refresh reads new source state instead of caching an old run", async (t) => {
  const f = await fixture(t);
  const first = /** @type {any} */ (
    await (await f.get(`/api/runs/${f.date}`)).json()
  );
  assert.equal(first.title, "Палаты Голицыных");
  await writeFile(
    f.source,
    JSON.stringify({
      date: f.date,
      phase: "failed",
      title: "Обновлённый выпуск",
      updatedAt: "2026-11-14T09:00:00.000Z",
    }),
  );
  const refreshed = /** @type {any} */ (
    await (await f.get(`/api/runs/${f.date}`)).json()
  );
  assert.equal(refreshed.title, "Обновлённый выпуск");
  const list = /** @type {any} */ (await (await f.get("/api/runs")).json());
  assert.equal(list.runs[0].title, refreshed.title);
});

test("observer returns safe missing-source and read-failure messages without exposing local paths", async (t) => {
  const missing = await fixture(t, { missing: true });
  const missingResponse = await missing.get("/api/runs");
  assert.equal(missingResponse.status, 404);
  const missingBody = await missingResponse.text();
  assert.doesNotMatch(
    missingBody,
    /video-observer-private-source-|ENOENT|stack/,
  );
  const broken = await fixture(t, { broken: true });
  const brokenResponse = await broken.get("/api/runs");
  assert.equal(brokenResponse.status, 500);
  const brokenBody = await brokenResponse.text();
  assert.doesNotMatch(
    brokenBody,
    /video-observer-private-source-|PRIVATE_SOURCE_CONTENT|ENOTDIR|stack/,
  );
  assert.match(brokenBody, /Не удалось прочитать данные/);
});

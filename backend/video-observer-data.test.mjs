import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listRuns, loadRun } from "../scripts/video-observer/data.mjs";

const ID = "2026-11-14";
const RUN = "tomorrow-" + ID;
const DAILY = `data/daily/${ID}`;
const NOW = "2026-11-14T12:00:00.000Z";
const sha = (char) => char.repeat(64);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "video-observer-data-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, value) => {
    await fs.mkdir(path.dirname(path.join(root, relative)), {
      recursive: true,
    });
    await fs.writeFile(path.join(root, relative), JSON.stringify(value));
  };
  await write(`${DAILY}/status.json`, {
    date: ID,
    phase: "failed",
    title: "Палаты Голицыных",
    observedAt: "2026-11-14T08:00:00.000Z",
    updatedAt: "2026-11-14T09:00:00.000Z",
  });
  return { root, write, load: () => loadRun({ root, id: ID, now: NOW }) };
}
function published(overrides = {}) {
  return {
    version: 1,
    date: ID,
    runId: RUN,
    videoId: "video123",
    url: "https://www.youtube.com/shorts/video123",
    status: "confirmed",
    channel: { id: "UC6iI4xswk8MOTld9b1mL4GQ" },
    confirmedAt: "2026-11-14T10:00:00.000Z",
    remote: {
      id: "video123",
      snippet: { channelId: "UC6iI4xswk8MOTld9b1mL4GQ" },
      status: { privacyStatus: "public", uploadStatus: "processed" },
      processingDetails: { processingStatus: "succeeded" },
    },
    ...overrides,
  };
}

test("достоверная публикация имеет приоритет над старым отказом и noProgress", async (t) => {
  const f = await fixture(t);
  await f.write(`${DAILY}/durable/status.json`, {
    date: ID,
    runId: RUN,
    status: "waiting_target_change",
    noProgress: true,
    code: "PREPRODUCTION_REJECTED",
  });
  await f.write(`${DAILY}/durable/progress.json`, {
    noProgress: true,
    failure: { code: "OLD_FAILURE" },
  });
  await f.write(`${DAILY}/youtube-publish.json`, published());
  const data = await f.load();
  assert.equal(data.status, "published");
  assert.equal(data.currentStage, "publication");
  assert.equal(data.currentFailure, null);
  assert.equal(data.summary.endedAt, "2026-11-14T10:00:00.000Z");
  const list = await listRuns({ root: f.root, now: NOW });
  assert.equal(list.runs[0].status, "published");
  assert.equal(list.runs[0].title, "Палаты Голицыных");
});

test("подтверждение загрузки не подменяет публичную публикацию", async (t) => {
  for (const { label, receipt, expected } of [
    {
      label: "чужой run",
      receipt: published({ runId: "tomorrow-2026-11-13" }),
      expected: "failed",
    },
    {
      label: "другая дата",
      receipt: published({ date: "2026-11-13" }),
      expected: "failed",
    },
    {
      label: "только upload",
      receipt: published({ status: "uploaded" }),
      expected: "uploaded",
    },
    {
      label: "private",
      receipt: published({
        remote: {
          id: "video123",
          snippet: { channelId: "UC6iI4xswk8MOTld9b1mL4GQ" },
          status: { privacyStatus: "private", uploadStatus: "processed" },
          processingDetails: { processingStatus: "succeeded" },
        },
      }),
      expected: "uploaded",
    },
    {
      label: "scheduled",
      receipt: published({
        requestedPublishAt: "2026-11-15T08:00:00Z",
        remote: {
          id: "video123",
          snippet: { channelId: "UC6iI4xswk8MOTld9b1mL4GQ" },
          status: {
            privacyStatus: "private",
            uploadStatus: "processed",
            publishAt: "2026-11-15T08:00:00Z",
          },
          processingDetails: { processingStatus: "succeeded" },
        },
      }),
      expected: "scheduled",
    },
    {
      label: "processing",
      receipt: published({
        remote: {
          id: "video123",
          snippet: { channelId: "UC6iI4xswk8MOTld9b1mL4GQ" },
          status: { privacyStatus: "public", uploadStatus: "uploaded" },
          processingDetails: { processingStatus: "processing" },
        },
      }),
      expected: "uploaded",
    },
  ])
    await t.test(label, async (t) => {
      const f = await fixture(t);
      await f.write(`${DAILY}/youtube-publish.json`, receipt);
      assert.equal((await f.load()).status, expected);
    });
});

test("повторы определяются одинаковым issue и входами, отдельно от числа worker", async (t) => {
  const f = await fixture(t);
  for (const [id, input, at] of [
    ["a", "c", "08:01"],
    ["b", "c", "08:02"],
    ["d", "e", "08:03"],
  ]) {
    await f.write(`${DAILY}/durable/repair-context/${sha(id)}.json`, {
      createdAt: `2026-11-14T${at}:00Z`,
      failure: {
        code: "PREPRODUCTION_REJECTED",
        failedCheck: "preproduction-measured-frame",
      },
      issue: {
        id: sha("f"),
        renderInputsSha: sha(input),
        targetArtifactSha: sha(input),
      },
    });
  }
  const jobId = sha("a");
  await f.write(`${DAILY}/durable/codex-repairs/${jobId}/job.json`, {
    attempt: 4321,
    createdAt: "2026-11-14T08:02:00Z",
    issue: { id: sha("f"), renderInputsSha: sha("c") },
    diagnostic: { noProgress: true },
    failure: { code: "PREPRODUCTION_REJECTED" },
  });
  await f.write(`${DAILY}/durable/codex-repairs/${jobId}/result.json`, {
    status: "failed",
    code: "CODEX_TIMEOUT",
    finishedAt: "2026-11-14T08:12:00Z",
    summary: "Лимит времени",
  });
  await f.write(`${DAILY}/durable/repair-context/${jobId}.outcome.json`, {
    targetChanged: false,
    renderInputsChanged: false,
  });
  const data = await f.load();
  assert.equal(data.loopGroups.length, 1);
  assert.equal(data.loopGroups[0].count, 2);
  assert.equal(data.loopGroups[0].inputFingerprint, sha("c"));
  assert.equal(data.summary.repairCount, 1);
  assert.equal(data.repairs[0].durationMs, 600000);
  assert.equal(data.repairs[0].targetChanged, false);
  assert.equal(data.observations.maxRepairAttempt, 4321);
  assert.equal(
    data.rules.find((rule) => rule.code === "PREPRODUCTION_REJECTED").count,
    3,
  );
});

test("сохраняется только измеренная длительность рендера, начало содержит длину фильма", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, DAILY, "durable"), { recursive: true });
  await fs.writeFile(
    path.join(f.root, DAILY, "durable/build.log"),
    [
      { time: "2026-11-14T08:00:00Z", message: "рендер начат", seconds: 53.76 },
      { time: "2026-11-14T08:08:00Z", message: "рендер готов", seconds: 480 },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n"),
  );
  const data = await f.load();
  assert.equal(data.summary.renderCount, 1);
  assert.equal(
    data.stages.find((stage) => stage.id === "render").durationMs,
    480000,
  );
  assert.equal(
    data.events.find((event) => event.kind === "start").durationMs,
    undefined,
  );
});

test("проверка worker отделена от принятия результата профильным gate", async (t) => {
  const f = await fixture(t),
    jobId = sha("b");
  await f.write(`${DAILY}/durable/codex-repairs/${jobId}/job.json`, {
    attempt: 7,
    createdAt: "2026-11-14T08:00:00Z",
    issue: { id: sha("i"), renderInputsSha: sha("r") },
    failure: { code: "PREPRODUCTION_REJECTED" },
  });
  await f.write(`${DAILY}/durable/codex-repairs/${jobId}/result.json`, {
    status: "fixed",
    code: "REPAIR_OK",
    checks: [{ code: "PREPRODUCTION_REJECTED", passed: true }],
    finishedAt: "2026-11-14T08:01:00Z",
  });
  await f.write(`${DAILY}/durable/repair-context/${jobId}.outcome.json`, {
    targetChanged: true,
    renderInputsChanged: true,
  });
  const data = await f.load();
  assert.equal(data.repairs[0].workerChecksPassed, true);
  assert.equal(data.repairs[0].verified, false);
  assert.equal(
    data.events.find((event) => event.code === "REPAIR_OK").kind,
    "warning",
  );
});

test("повреждённые и отсутствующие квитанции дают предупреждения, не выдуманный успех", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, DAILY, "status.json"), "{");
  await f.write(`${DAILY}/plan.json`, {
    date: ID,
    work: path.join(f.root, "data/work/example"),
  });
  await f.write("data/work/example/pipeline-report.json", { stages: {} });
  const data = await f.load();
  assert.equal(data.status, "unknown");
  assert.equal(data.summary.renderCount, 0);
  assert.ok(
    data.warnings.some((warning) => warning.includes("Повреждён JSON")),
  );
  assert.ok(data.stages.every((stage) => stage.status !== "complete"));
});

test("running в старом файле не доказывает живой процесс", async (t) => {
  const f = await fixture(t);
  await f.write(`${DAILY}/status.json`, { date: ID, phase: "building" });
  await f.write(`${DAILY}/durable/worker.json`, { running: true, pid: 1 });
  const data = await f.load();
  assert.equal(data.status, "waiting");
  assert.match(data.statusLabel, /Сохранён/);
});

test("идентификаторы, внешний корень и symlink не позволяют читать произвольные файлы", async (t) => {
  const f = await fixture(t);
  for (const id of ["../secret", "2026-02-30", "2026-13-01", "2026-1-01"]) {
    await assert.rejects(() => loadRun({ root: f.root, id }), {
      code: "INVALID_RUN_ID",
    });
  }
  await assert.rejects(() => loadRun({ root: f.root, id: "2026-11-15" }), {
    code: "RUN_NOT_FOUND",
  });
  await assert.rejects(() => listRuns({ root: path.join(f.root, "absent") }), {
    code: "ROOT_UNAVAILABLE",
  });
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "video-observer-outside-"),
  );
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(outside, "secret.json"),
    JSON.stringify({ title: "EXTERNAL_SECRET" }),
  );
  await fs.symlink(
    path.join(outside, "secret.json"),
    path.join(f.root, DAILY, "built.json"),
  );
  const data = await f.load();
  assert.ok(
    data.warnings.some((warning) => warning.includes("Символическая ссылка")),
  );
  assert.ok(!JSON.stringify(data).includes("EXTERNAL_SECRET"));
});

test("выход исключает сырые диагностические данные и скрывает токены в сообщениях", async (t) => {
  const f = await fixture(t),
    jobId = sha("a");
  await f.write(`${DAILY}/durable/codex-repairs/${jobId}/job.json`, {
    createdAt: "2026-11-14T08:00:00Z",
    prompt: "RAW_PROMPT_SECRET",
    failure: { code: "ERROR", stdout: "RAW_OUTPUT_SECRET" },
  });
  await f.write(`${DAILY}/durable/codex-repairs/${jobId}/result.json`, {
    status: "failed",
    code: "CODEX_TIMEOUT",
    summary:
      "Ошибка api_key=SECRET_VALUE Bearer OTHER_SECRET https://user:password@example.org/a?token=URL_SECRET /Users/user/.codex/auth.json",
    stderr: "STDERR_SECRET",
    finishedAt: "2026-11-14T08:10:00Z",
  });
  const output = JSON.stringify(await f.load());
  for (const secret of [
    "RAW_PROMPT_SECRET",
    "RAW_OUTPUT_SECRET",
    "SECRET_VALUE",
    "OTHER_SECRET",
    "URL_SECRET",
    "STDERR_SECRET",
    "/Users/user/.codex/auth.json",
    "user:password",
  ])
    assert.ok(!output.includes(secret), secret);
  assert.ok(output.includes("[скрыто]"));
});

test("общий fingerprint без профильных входов остаётся предположением о повторе", async (t) => {
  const f = await fixture(t);
  for (const key of ["a", "b"])
    await f.write(`${DAILY}/durable/repair-context/${sha(key)}.json`, {
      createdAt: "2026-11-14T08:00:00Z",
      failure: { code: "ERROR" },
      progress: { fingerprint: sha("f") },
      issue: { id: sha("c") },
    });
  const data = await f.load();
  assert.equal(data.loopGroups[0].count, 2);
  assert.equal(data.loopGroups[0].verifiedUnchanged, false);
});

test("размер JSON ограничен и сохранённый флаг публикации требует квитанции", async (t) => {
  const f = await fixture(t);
  await f.write(`${DAILY}/status.json`, { date: ID, phase: "published" });
  await fs.writeFile(
    path.join(f.root, DAILY, "built.json"),
    " ".repeat(2 * 1024 * 1024 + 1),
  );
  const data = await f.load();
  assert.equal(data.status, "unknown");
  assert.ok(data.warnings.some((warning) => warning.includes("лимит JSON")));
  assert.ok(
    data.warnings.some((warning) =>
      warning.includes("Публичная публикация заявлена"),
    ),
  );
});

test("отсутствие каталога источников отличается от пустого каталога", async (t) => {
  const f = await fixture(t);
  await fs.rm(path.join(f.root, "data/daily"), { recursive: true });
  await assert.rejects(() => listRuns({ root: f.root }), {
    code: "ROOT_UNAVAILABLE",
  });
  await fs.mkdir(path.join(f.root, "data/daily"));
  assert.deepEqual((await listRuns({ root: f.root })).runs, []);
  await fs.rmdir(path.join(f.root, "data/daily"));
  await fs.writeFile(path.join(f.root, "data/daily"), "not-directory");
  await assert.rejects(() => listRuns({ root: f.root }), { code: "ENOTDIR" });
});

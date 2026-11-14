import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeUsage,
  summarizeUsage,
} from "../scripts/video-observer/tokens.mjs";
import { loadRun } from "../scripts/video-observer/data.mjs";

const ID = "2026-11-14";
const DAILY = `data/daily/${ID}`;
const RUN = `${DAILY}/shorts/runs/tomorrow-${ID}`;
const NOW = "2026-11-14T12:00:00.000Z";

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "video-observer-tokens-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, value) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  await write(`${DAILY}/status.json`, {
    date: ID,
    title: "Проверка токенов",
    phase: "failed",
    updatedAt: NOW,
  });
  return { root, write, load: () => loadRun({ root, id: ID, now: NOW }) };
}

const chat = (id, input = 20, output = 7, extra = {}) => ({
  id,
  model: "test-model",
  usage: {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  },
  ...extra,
});

test("usage Responses, Chat Completions и Gemini нормализуется без удвоения кеша и reasoning", () => {
  const cases = [
    {
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 80 },
        output_tokens_details: { reasoning_tokens: 7 },
      },
    },
    {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 80 },
        completion_tokens_details: { reasoning_tokens: 7 },
      },
    },
    {
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 13,
        thoughtsTokenCount: 7,
        totalTokenCount: 120,
        cachedContentTokenCount: 80,
      },
    },
  ];
  for (const envelope of cases)
    assert.deepEqual(normalizeUsage(envelope), {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 80,
      reasoningOutputTokens: 7,
      estimated: false,
    });
  assert.equal(
    normalizeUsage({ usage: { input_tokens: 100, output_tokens: 20 } })
      .totalTokens,
    120,
  );
});

test("ноль отличается от отсутствующего usage, итоговый счётчик допустим без разбивки", () => {
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ usage: [] }), null);
  assert.equal(normalizeUsage({ usage: {} }), null);
  assert.deepEqual(normalizeUsage({ usage: { total_tokens: 0 } }), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: 0,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
    estimated: false,
  });
  assert.deepEqual(normalizeUsage({ usage: { total_tokens: 23 } }), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: 23,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
    estimated: false,
  });
});

test("некорректные, отрицательные и противоречивые счётчики не становятся токенами", () => {
  for (const value of [
    -1,
    1.5,
    "12",
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      normalizeUsage({
        usage: { input_tokens: value, output_tokens: 2, total_tokens: 20 },
      }),
      null,
      String(value),
    );
  }
  for (const usage of [
    { input_tokens: 10, output_tokens: 2, total_tokens: 11 },
    { input_tokens: 10, input_tokens_details: { cached_tokens: 11 } },
    { output_tokens: 2, output_tokens_details: { reasoning_tokens: 3 } },
    { total_tokens: "100" },
  ])
    assert.equal(normalizeUsage({ usage }), null);
});

test("оценки провайдера отделяются от точной суммы и разбивки по этапам", () => {
  const exact = normalizeUsage(chat("a", 100, 30));
  const estimated = normalizeUsage(
    chat("b", 1000, 50, {
      usage: {
        input_tokens: 1000,
        output_tokens: 50,
        total_tokens: 1050,
        estimated: true,
      },
    }),
  );
  assert.equal(estimated.estimated, true);
  assert.equal(
    normalizeUsage({ estimated: true, usage: { total_tokens: 4 } }).estimated,
    true,
  );
  const result = summarizeUsage(
    [
      { ...exact, stage: "preproduction" },
      { ...estimated, stage: "review" },
    ],
    { sourceCount: 4, excludedDuplicateCount: 2, missingUsageCount: 1 },
  );
  assert.equal(result.totalTokens, 130);
  assert.equal(result.calls, 1);
  assert.equal(result.estimatedTokens, 1050);
  assert.equal(result.estimatedCalls, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.sourceCount, 4);
  assert.equal(result.excludedDuplicateCount, 2);
  assert.equal(result.missingUsageCount, 1);
  assert.deepEqual(
    result.byStage.map(({ stage, calls, totalTokens }) => ({
      stage,
      calls,
      totalTokens,
    })),
    [{ stage: "preproduction", calls: 1, totalTokens: 130 }],
  );
  assert.match(result.notes.join(" "), /отдельно/);
});

test("запуск без usage не показывает нулевой расход, явный ноль сохраняется", async (t) => {
  const f = await fixture(t);
  const absent = (await f.load()).tokenUsage;
  assert.equal(absent.status, "unavailable");
  assert.equal(absent.totalTokens, null);
  assert.equal(absent.calls, 0);
  await f.write(`${RUN}/usage.json`, chat("explicit-zero", 0, 0));
  const measured = (await f.load()).tokenUsage;
  assert.equal(measured.status, "partial");
  assert.equal(measured.totalTokens, 0);
  assert.equal(measured.calls, 1);
});

test("один ответ из SSE, JSON и снимка истории учитывается один раз без выдачи сырых данных", async (t) => {
  const f = await fixture(t);
  const answer = chat("same-response", 50, 12, {
    choices: [{ message: { content: "PRIVATE_RAW_MODEL_TEXT" } }],
  });
  await f.write(
    `${RUN}/lexical-evidence/original/response.raw`,
    `data: ${JSON.stringify(answer)}\n\ndata: [DONE]\n`,
  );
  await f.write(
    `${RUN}/operator-revisions/before/lexical-evidence/original/response.raw`,
    answer,
  );
  await f.write(
    `${RUN}/operator-revisions/after/lexical-evidence/original/response.raw`,
    `data: ${JSON.stringify(answer)}\n\ndata: [DONE]\n`,
  );
  const run = await f.load(),
    usage = run.tokenUsage;
  assert.equal(usage.calls, 1);
  assert.equal(usage.totalTokens, 62);
  assert.equal(usage.records.length, 1);
  assert.equal(usage.excludedDuplicateCount, 2);
  assert.equal(usage.sourceCount, 3);
  assert.equal(usage.byStage[0].stage, "review");
  assert.match(usage.records[0].evidence, /\.raw$/);
  assert.ok(!JSON.stringify(run).includes("PRIVATE_RAW_MODEL_TEXT"));
  assert.ok(!JSON.stringify(run).includes("same-response"));
});

test("завершающий usage SSE заменяет прежнее наблюдение одного вызова, а не складывается с ним", async (t) => {
  const f = await fixture(t);
  const first = {
    type: "response.completed",
    response: {
      id: "response-one",
      model: "test",
      usage: { input_tokens: 40, output_tokens: 2, total_tokens: 42 },
    },
  };
  const final = {
    type: "response.completed",
    response: {
      id: "response-one",
      model: "test",
      usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 },
    },
  };
  await f.write(
    `${RUN}/response.raw`,
    [first, final].map((value) => "data: " + JSON.stringify(value)).join("\n"),
  );
  const usage = (await f.load()).tokenUsage;
  assert.equal(usage.calls, 1);
  assert.equal(usage.totalTokens, 52);
  assert.equal(usage.outputTokens, 12);
  assert.equal(usage.excludedDuplicateCount, 1);
});

test("отдельные turn.completed суммируются, копия Codex stdout не удваивает расход", async (t) => {
  const f = await fixture(t);
  const stream = [
    { type: "thread.started", thread_id: "PRIVATE_THREAD" },
    {
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 200, cached_input_tokens: 90, output_tokens: 30 },
    },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");
  await f.write(`${RUN}/codex-stdout.jsonl`, stream);
  await f.write(`${RUN}/operator-revisions/copy/codex-stdout.jsonl`, stream);
  const usage = (await f.load()).tokenUsage;
  assert.equal(usage.calls, 2);
  assert.equal(usage.inputTokens, 300);
  assert.equal(usage.outputTokens, 50);
  assert.equal(usage.totalTokens, 350);
  assert.equal(usage.cachedInputTokens, 170);
  assert.equal(usage.excludedDuplicateCount, 1);
  assert.ok(!JSON.stringify(usage).includes("PRIVATE_THREAD"));
});

test("разные ID одинакового размера являются двумя вызовами, оценки остаются отдельными", async (t) => {
  const f = await fixture(t);
  await f.write(`${RUN}/lexical-evidence/one/response.raw`, chat("one", 5, 2));
  await f.write(`${RUN}/lexical-evidence/two/response.raw`, chat("two", 5, 2));
  await f.write(
    `${RUN}/lexical-evidence/estimated/response.raw`,
    chat("estimated", 500, 20, { estimated: true }),
  );
  const usage = (await f.load()).tokenUsage;
  assert.equal(usage.calls, 2);
  assert.equal(usage.totalTokens, 14);
  assert.equal(usage.estimatedTokens, 520);
  assert.equal(usage.estimatedCalls, 1);
  assert.equal(usage.records.length, 3);
});

test("только оценки не превращаются в подтверждённый нулевой итог", async (t) => {
  const f = await fixture(t);
  await f.write(`${RUN}/response.raw`, {
    ...chat("estimated-only", 30, 4),
    estimated: true,
  });
  const usage = (await f.load()).tokenUsage;
  assert.equal(usage.status, "partial");
  assert.equal(usage.calls, 0);
  assert.equal(usage.totalTokens, null);
  assert.equal(usage.estimatedTokens, 34);
  assert.equal(usage.estimatedCalls, 1);
});

test("квитанции без usage отражаются в полноте данных и не добавляют выдуманные токены", async (t) => {
  const f = await fixture(t);
  await f.write(`${RUN}/preproduction-reviews/text/${"a".repeat(64)}.json`, {
    stage: "text",
    key: "a".repeat(64),
    model: "test",
    ok: true,
    result: { scores: { text: 8 } },
  });
  await f.write(`${RUN}/caption-review-evidence/a/inspection-response.json`, {
    model: "test",
    text: "PRIVATE_CAPTION_OBSERVATIONS",
  });
  await f.write(`${RUN}/usage.json`, {
    ...chat("script-call", 40, 10),
    stage: "script",
  });
  const usage = (await f.load()).tokenUsage;
  assert.equal(usage.totalTokens, 50);
  assert.equal(usage.missingUsageCount, 2);
  assert.equal(usage.byStage[0].stage, "script");
  assert.ok(!JSON.stringify(usage).includes("PRIVATE_CAPTION_OBSERVATIONS"));
});

test("повреждённый, чрезмерный и внешний symlink-ответы не раскрывают данные или расход", async (t) => {
  const f = await fixture(t);
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "video-observer-token-outside-"),
  );
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(outside, "response.raw"),
    JSON.stringify(chat("PRIVATE_EXTERNAL_TOKEN_ID", 900, 100)),
  );
  await fs.mkdir(path.join(f.root, RUN, "lexical-evidence"), {
    recursive: true,
  });
  await fs.symlink(outside, path.join(f.root, RUN, "lexical-evidence/escape"));
  await f.write(`${RUN}/lexical-evidence/broken/response.raw`, '{"usage":');
  await f.write(
    `${RUN}/lexical-evidence/large/response.raw`,
    "X".repeat(2 * 1024 * 1024 + 1),
  );
  const data = await f.load();
  assert.equal(data.tokenUsage.calls, 0);
  assert.equal(data.tokenUsage.totalTokens, null);
  assert.ok(
    data.warnings.some((warning) => /Символическая ссылка/.test(warning)),
  );
  assert.ok(
    data.warnings.some((warning) => /лимит|лимита|размер|МиБ/i.test(warning)),
  );
  assert.ok(!JSON.stringify(data).includes("PRIVATE_EXTERNAL_TOKEN_ID"));
});

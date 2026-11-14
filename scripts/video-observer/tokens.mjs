import { createHash } from "node:crypto";

/**
 * @typedef {{inputTokens: number|null, outputTokens: number|null, totalTokens: number|null,
 * cachedInputTokens: number|null, reasoningOutputTokens: number|null}} TokenCounts
 */

const hash = (value) => createHash("sha256").update(value).digest("hex");
const counter = (value) => Number.isSafeInteger(value) && value >= 0;
const FIELDS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "reasoningOutputTokens",
];
const LABELS = {
  selection: "Выбор истории",
  script: "Сценарий и материалы",
  preproduction: "Ранние проверки",
  voice: "Озвучка и звук",
  composition: "Композиция",
  render: "Рендер",
  review: "Итоговый аудит",
  publication: "Публикация",
  unknown: "Этап не указан",
};

/**
 * Принимает только счётчики провайдера; оценку по длине текста не делает.
 * @returns {(TokenCounts & {estimated: boolean}) | null}
 */
export function normalizeUsage(envelope) {
  const value = envelope?.usage ?? envelope?.usageMetadata;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const inputTokens =
    value.input_tokens ?? value.prompt_tokens ?? value.promptTokenCount;
  const reasoningOutputTokens =
    value.output_tokens_details?.reasoning_tokens ??
    value.completion_tokens_details?.reasoning_tokens ??
    value.thoughtsTokenCount;
  const outputTokens =
    value.output_tokens ??
    value.completion_tokens ??
    (value.candidatesTokenCount === undefined
      ? undefined
      : value.candidatesTokenCount + (value.thoughtsTokenCount ?? 0));
  const cachedInputTokens =
    value.input_tokens_details?.cached_tokens ??
    value.prompt_tokens_details?.cached_tokens ??
    value.cached_input_tokens ??
    value.cachedContentTokenCount;
  const totalTokens =
    value.total_tokens ??
    value.totalTokenCount ??
    (counter(inputTokens) && counter(outputTokens)
      ? inputTokens + outputTokens
      : undefined);
  const result = {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningOutputTokens,
  };
  if (
    Object.values(result).every((v) => v === undefined) ||
    Object.values(result).some((v) => v !== undefined && !counter(v))
  )
    return null;
  if (
    counter(inputTokens) &&
    counter(cachedInputTokens) &&
    cachedInputTokens > inputTokens
  )
    return null;
  if (
    counter(outputTokens) &&
    counter(reasoningOutputTokens) &&
    reasoningOutputTokens > outputTokens
  )
    return null;
  if (
    counter(totalTokens) &&
    counter(inputTokens) &&
    counter(outputTokens) &&
    totalTokens < inputTokens + outputTokens
  )
    return null;
  return {
    .../** @type {TokenCounts} */ (
      Object.fromEntries(FIELDS.map((key) => [key, result[key] ?? null]))
    ),
    estimated: value.estimated === true || envelope.estimated === true,
  };
}

/** @returns {TokenCounts} */
function totals(records) {
  return /** @type {TokenCounts} */ (
    Object.fromEntries(
      FIELDS.map((key) => {
        const known = records.map((r) => r[key]).filter(counter);
        const sum = known.reduce((a, b) => a + b, 0);
        return [key, known.length && counter(sum) ? sum : null];
      }),
    )
  );
}

export function summarizeUsage(records, meta = {}) {
  const exact = records.filter((row) => !row.estimated),
    estimates = records.filter((row) => row.estimated);
  const byStage = Object.keys(LABELS)
    .map((stage) => {
      const entries = exact.filter((row) => row.stage === stage);
      return {
        stage,
        label: LABELS[stage],
        calls: entries.length,
        ...totals(entries),
      };
    })
    .filter((row) => row.calls);
  return {
    status: records.length ? "partial" : "unavailable",
    ...totals(exact),
    calls: exact.length,
    estimatedTokens: totals(estimates).totalTokens,
    estimatedCalls: estimates.length,
    sourceCount: meta.sourceCount ?? 0,
    excludedDuplicateCount: meta.excludedDuplicateCount ?? 0,
    missingUsageCount: meta.missingUsageCount ?? 0,
    byStage,
    records,
    notes: [
      "Частичный учёт по сохранённым ответам моделей. Полный расход запуска по этим данным не восстановить: часть клиентов не сохраняла usage.",
      "Вход и выход входят в итог; кеш и reasoning — части соответствующих счётчиков, повторно к итогу не прибавляются. Пропуски означают отсутствие данных, а не нулевой расход.",
      ...(estimates.length
        ? [
            "Ответы с usage.estimated показаны отдельно и не включены в подтверждённую сумму.",
          ]
        : []),
      ...(meta.notes ?? []),
    ],
  };
}

/** Извлекает только ограниченные метаданные. Ответ модели и служебные поля не выходят наружу. */
export async function collectTokenUsage(reader, { daily, runDir, work }) {
  const records = new Map(),
    seenMissing = new Set(),
    seenDocuments = new Set();
  let sourceCount = 0,
    excludedDuplicateCount = 0,
    missingUsageCount = 0;
  const roots = new Set([runDir]);
  if (work && (work === daily || work.startsWith(daily + "/"))) roots.add(work);
  const queue = [...roots].sort(),
    seenDirectories = new Set(),
    candidates = [];
  const notes = [];
  const scanDeadline = Date.now() + 1500;
  let scannedEntries = 0;
  const accept = (name) =>
    /(?:\.raw(?:\.json)?|^(?:response|inspection-response|token-usage|usage|codex-events|codex-stdout)\.(?:json|jsonl|log)|(?:creative-review|promo-review|creative-final-audio-qc)\.json)$/.test(
      name,
    );
  // Не обходим repair-context (тысячи копий), медиа, исходники и произвольные пути из ответов.
  const skipDirectory =
    /^(?:node_modules|\.git|photos|assets|frames|fonts|scenes|repair-context|codex-repairs|actions)$/;
  const descend = (directory, name) => {
    if (skipDirectory.test(name)) return false;
    if (/(?:^|\/)lexical-evidence(?:\/|$)/.test(directory)) return true;
    if (
      /\/preproduction-reviews$/.test(directory) ||
      /\/caption-review-evidence$/.test(directory)
    )
      return true;
    if (/\/operator-revisions$/.test(directory)) return true;
    return (
      /^(?:lexical-evidence|preproduction-reviews|caption-review-evidence|operator-revisions)$/.test(
        name,
      ) &&
      (roots.has(directory) || /\/operator-revisions\/[^/]+$/.test(directory))
    );
  };
  while (
    queue.length &&
    Date.now() <= scanDeadline &&
    seenDirectories.size < 600 &&
    candidates.length < 2500 &&
    scannedEntries < 16000
  ) {
    const directory = queue.shift();
    const safe = await reader.safe(directory);
    if (!safe?.stat.isDirectory() || seenDirectories.has(safe.real)) continue;
    seenDirectories.add(safe.real);
    for (const name of (await reader.names(directory)).sort()) {
      if (++scannedEntries > 16000 || Date.now() > scanDeadline) break;
      const relative = directory + "/" + name;
      const file = await reader.safe(relative);
      if (!file) continue;
      if (file.stat.isDirectory() && descend(directory, name))
        queue.push(relative);
      else if (
        file.stat.isFile() &&
        (accept(name) ||
          /\/preproduction-reviews\/[^/]+\/[a-f\d]{64}\.json$/.test(relative))
      )
        candidates.push(relative);
      if (candidates.length >= 2500) break;
    }
  }
  for (const name of ["token-usage.jsonl", "usage.jsonl"]) {
    if (await reader.safe(daily + "/" + name))
      candidates.push(daily + "/" + name);
  }
  if (
    queue.length ||
    Date.now() > scanDeadline ||
    scannedEntries >= 16000 ||
    candidates.length >= 2500
  )
    notes.push(
      "Поиск источников ограничен; учтённые токены являются нижней оценкой доступных данных.",
    );
  const stageFor = (file) =>
    /preproduction-reviews/.test(file)
      ? "preproduction"
      : /(?:lexical|caption-review|final-review|creative-review|promo-review|final-audio)/.test(
            file,
          )
        ? "review"
        : /(?:voice|audio-qc)/.test(file)
          ? "voice"
          : "unknown";
  const validStage = (value) => (Object.hasOwn(LABELS, value) ? value : null);
  const add = (envelope, file, fallback, stage) => {
    if (!envelope || typeof envelope !== "object") return;
    const body =
      envelope.response && typeof envelope.response === "object"
        ? envelope.response
        : envelope;
    const usage = normalizeUsage(body);
    const providerId =
      typeof body.id === "string" && body.id.length < 300 ? body.id : null;
    const key = providerId ? "response:" + hash(providerId) : fallback;
    if (!usage) {
      if (!seenMissing.has(key)) {
        missingUsageCount++;
        seenMissing.add(key);
      }
      return;
    }
    const record = {
      id: hash(key).slice(0, 24),
      stage: validStage(envelope.stage) ?? stage,
      model: reader.text(body.model ?? envelope.model, 100) || null,
      ...usage,
      evidence: file,
    };
    const previous = records.get(key);
    if (previous) {
      excludedDuplicateCount++;
      // Для SSE usage в конце содержит весь вызов. Оценка не заменяет точные счётчики.
      if (!previous.estimated && record.estimated) return;
    }
    records.set(key, record);
  };
  for (const file of [...new Set(candidates)].sort()) {
    const raw = await reader.payload(file, 2 * 1024 * 1024);
    if (raw === null) continue;
    sourceCount++;
    const digest = hash(raw);
    if (seenDocuments.has(digest)) {
      excludedDuplicateCount++;
      continue;
    }
    seenDocuments.add(digest);
    const stage = stageFor(file);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* SSE и журналы разбираются построчно. */
    }
    if (parsed) {
      add(parsed, file, "document:" + digest, stage);
      continue;
    }
    let index = 0,
      accepted = false;
    for (const line of raw.split(/\r?\n/)) {
      const text = line.startsWith("data:")
        ? line.slice(5).trim()
        : line.trim();
      if (!text || text === "[DONE]" || text.length > 2 * 1024 * 1024) continue;
      try {
        const row = JSON.parse(text);
        const event =
          row.type === "turn.completed" ||
          row.type === "response.completed" ||
          row.usage ||
          row.usageMetadata;
        if (event) {
          add(row, file, `document:${digest}:call:${index++}`, stage);
          accepted = true;
        }
      } catch {
        /* Не-JSON строка не является записью usage. */
      }
    }
    if (!accepted && !seenMissing.has(digest)) {
      missingUsageCount++;
      seenMissing.add(digest);
    }
  }
  const sorted = [...records.values()].sort(
    (a, b) => a.stage.localeCompare(b.stage) || a.id.localeCompare(b.id),
  );
  return summarizeUsage(sorted, {
    sourceCount,
    excludedDuplicateCount,
    missingUsageCount,
    notes,
  });
}

import fs from "node:fs/promises";
import path from "node:path";
import { collectTokenUsage } from "./tokens.mjs";

const MAX_JSON = 2 * 1024 * 1024;
const MAX_LOG = 4 * 1024 * 1024;
const MAX_CONTEXTS = 6000;
const MAX_EVENTS = 1200;
const CHANNEL = "UC6iI4xswk8MOTld9b1mL4GQ";
const STAGES = [
  ["selection", "Выбор истории"],
  ["script", "Сценарий и материалы"],
  ["preproduction", "Ранние проверки"],
  ["voice", "Озвучка и звук"],
  ["composition", "Композиция"],
  ["render", "Рендер"],
  ["review", "Итоговый аудит"],
  ["publication", "Публикация"],
];
const LABELS = {
  published: "Опубликован",
  scheduled: "Запланирован",
  uploaded: "Загружен",
  approved: "Допущен к публикации",
  failed: "Ошибка",
  waiting: "Ожидает продолжения",
  running: "Выполняется",
  unknown: "Нет подтверждённого состояния",
};
const dateValue = (v) =>
  typeof v === "string" && Number.isFinite(Date.parse(v))
    ? new Date(v).toISOString()
    : null;
const array = (value) => (Array.isArray(value) ? value : []);
const identity = (v) =>
  typeof v === "string" && /^[a-f\d]{64}$/i.test(v) ? v : null;
const codeValue = (v) =>
  typeof v === "string" && /^[A-Za-z][\w.-]{0,95}$/.test(v) ? v : null;
const within = (root, target) =>
  target === root || target.startsWith(root + path.sep);
const duration = (start, end) =>
  start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null;
const failureStage = (value = {}) => {
  const text =
    `${value.failedCheck ?? ""} ${value.code ?? ""} ${value.domain ?? ""} ${value.component ?? ""} ${value.step ?? ""}`.toLowerCase();
  if (/preproduction/.test(text)) return "preproduction";
  if (/final|review|audit|approval/.test(text)) return "review";
  if (/voice|audio|mix|tts/.test(text)) return "voice";
  if (/render|mp4/.test(text)) return "render";
  if (/compose|visual|scene|storyboard/.test(text)) return "composition";
  if (/text|script|facts|photo|rights|prepare/.test(text)) return "script";
  if (/publish|upload/.test(text)) return "publication";
  return "preproduction";
};
const error = (message, code, statusCode) =>
  Object.assign(new Error(message), { code, statusCode });
function validateId(id) {
  if (
    typeof id !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(id) ||
    !dateValue(id) ||
    dateValue(id).slice(0, 10) !== id
  )
    throw error("Нужна календарная дата YYYY-MM-DD", "INVALID_RUN_ID", 400);
}

async function reader(root) {
  const deadline = Date.now() + 3000;
  let readBytes = 0;
  let resolved;
  try {
    resolved = await fs.realpath(path.resolve(root));
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error("directory");
  } catch {
    throw error("Каталог запусков недоступен", "ROOT_UNAVAILABLE", 400);
  }
  const warnings = [];
  const warn = (message) => {
    if (warnings.length < 80 && !warnings.includes(message))
      warnings.push(message);
  };
  const evidence = (file) => {
    if (typeof file !== "string") return null;
    const absolute = path.resolve(resolved, file);
    if (!within(resolved, absolute)) return null;
    const relative = path
      .relative(resolved, absolute)
      .split(path.sep)
      .join("/");
    return /(?:^|\/)(?:\.env(?:\.|$)|auth\.json|credentials?\b)/i.test(relative)
      ? null
      : relative;
  };
  const text = (value, limit = 700) => {
    if (typeof value !== "string") return "";
    return value
      .replaceAll(resolved + path.sep, "")
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'}]+/gi, "[скрыто]")
      .replace(
        /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|token)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
        "$1[скрыто]",
      )
      .replace(
        /\beyJ[A-Za-z\d_-]{8,}\.[A-Za-z\d_-]{4,}\.[A-Za-z\d_-]+\b/g,
        "[скрыто]",
      )
      .replace(
        /\b(?:ghp_[A-Za-z\d]{10,}|github_pat_[A-Za-z\d_]{10,}|xox[baprs]-[A-Za-z\d-]{8,}|(?:AKIA|ASIA)[A-Z\d]{16})\b/g,
        "[скрыто]",
      )
      .replace(/\b(?:sk|sk-proj|sk-ant|AIza)[-_A-Za-z\d]{12,}\b/g, "[скрыто]")
      .replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
        try {
          const parsed = new URL(url);
          parsed.username = "";
          parsed.password = "";
          parsed.search = "";
          parsed.hash = "";
          return parsed.toString();
        } catch {
          return "[ссылка]";
        }
      })
      .replace(
        /\/(?:Users|home|private|tmp|var)\/[^\s"'<>]+/g,
        "[локальный путь]",
      )
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
      .slice(0, limit);
  };
  const safe = async (relative, missing = true) => {
    const absolute = path.resolve(resolved, relative);
    const label = evidence(absolute) ?? "[внешний путь]";
    if (!within(resolved, absolute) || !evidence(absolute)) {
      warn("Внешний или закрытый путь пропущен: " + label);
      return null;
    }
    try {
      const real = await fs.realpath(absolute);
      if (!within(resolved, real)) {
        warn("Символическая ссылка за пределы каталога пропущена: " + label);
        return null;
      }
      return { real, stat: await fs.stat(real), label };
    } catch (cause) {
      if (cause.code !== "ENOENT" || !missing)
        warn("Не удалось прочитать: " + label);
      return null;
    }
  };
  const json = async (relative, optional = true) => {
    if (Date.now() > deadline || readBytes >= 160 * 1024 * 1024) {
      warn(
        "Достигнут общий лимит чтения (160 МиБ или 3 секунды); история неполна, число повторов является нижней оценкой.",
      );
      return null;
    }
    const file = await safe(relative, optional);
    if (!file) return null;
    if (!file.stat.isFile() || file.stat.size > MAX_JSON) {
      warn(
        "Файл пропущен: превышен лимит JSON или неверный тип: " + file.label,
      );
      return null;
    }
    if (readBytes + file.stat.size > 160 * 1024 * 1024) {
      warn(
        "Достигнут общий лимит чтения (160 МиБ или 3 секунды); история неполна, число повторов является нижней оценкой.",
      );
      return null;
    }
    readBytes += file.stat.size;
    let handle;
    try {
      handle = await fs.open(file.real, "r");
      const buffer = Buffer.alloc(file.stat.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("shape");
      return value;
    } catch {
      warn("Повреждён JSON: " + file.label);
      return null;
    } finally {
      if (handle)
        await handle
          .close()
          .catch(() => warn("Не удалось закрыть файл: " + file.label));
    }
  };
  const payload = async (relative, maxBytes) => {
    if (Date.now() > deadline || readBytes >= 160 * 1024 * 1024) {
      warn(
        "Достигнут общий лимит чтения; данные о токенах могут быть неполными.",
      );
      return null;
    }
    const file = await safe(relative);
    if (!file) return null;
    if (
      !file.stat.isFile() ||
      file.stat.size > maxBytes ||
      readBytes + file.stat.size > 160 * 1024 * 1024
    ) {
      warn("Источник токенов пропущен из-за лимита размера: " + file.label);
      return null;
    }
    readBytes += file.stat.size;
    let handle;
    try {
      handle = await fs.open(file.real, "r");
      const buffer = Buffer.alloc(file.stat.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } catch {
      warn("Источник токенов недоступен: " + file.label);
      return null;
    } finally {
      if (handle)
        await handle
          .close()
          .catch(() =>
            warn("Не удалось закрыть источник токенов: " + file.label),
          );
    }
  };
  const names = async (relative, optional = true) => {
    const directory = await safe(relative, optional);
    if (!directory) return [];
    if (!directory.stat.isDirectory()) {
      warn("Ожидался каталог: " + directory.label);
      return [];
    }
    try {
      return await fs.readdir(directory.real);
    } catch {
      warn("Каталог недоступен: " + directory.label);
      return [];
    }
  };
  const log = async (relative) => {
    if (Date.now() > deadline || readBytes >= 160 * 1024 * 1024) {
      warn(
        "Достигнут общий лимит чтения (160 МиБ или 3 секунды); история неполна, число повторов является нижней оценкой.",
      );
      return [];
    }
    const file = await safe(relative);
    if (!file) return [];
    if (!file.stat.isFile()) return [];
    let handle;
    try {
      handle = await fs.open(file.real, "r");
      const offset = Math.max(0, file.stat.size - MAX_LOG);
      const buffer = Buffer.alloc(Math.min(MAX_LOG, file.stat.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      readBytes += bytesRead;
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (offset) {
        lines.shift();
        warn("Показан конец большого журнала: " + file.label);
      }
      return lines.flatMap((line) => {
        try {
          const v = JSON.parse(line);
          return v && typeof v === "object" ? [v] : [];
        } catch {
          return [];
        }
      });
    } catch {
      warn("Журнал недоступен: " + file.label);
      return [];
    } finally {
      if (handle)
        await handle
          .close()
          .catch(() => warn("Не удалось закрыть журнал: " + file.label));
    }
  };
  return {
    root: resolved,
    warnings,
    warn,
    text,
    evidence,
    safe,
    json,
    names,
    log,
    payload,
  };
}

async function mapLimit(items, limit, fn) {
  const values = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = index++;
        values[current] = await fn(items[current]);
      }
    }),
  );
  return values;
}

async function baseRun(r, id, now) {
  const daily = `data/daily/${id}`;
  const entry = await r.safe(daily, false);
  if (!entry?.stat.isDirectory())
    throw error("Запуск не найден", "RUN_NOT_FOUND", 404);
  const [status, plan, built, morning, durable, worker, publication] =
    await Promise.all([
      r.json(`${daily}/status.json`),
      r.json(`${daily}/plan.json`),
      r.json(`${daily}/built.json`),
      r.json(`${daily}/morning-report.json`),
      r.json(`${daily}/durable/status.json`),
      r.json(`${daily}/durable/worker.json`),
      r.json(`${daily}/youtube-publish.json`),
    ]);
  const matches = (v) =>
    v && v.date === id && (!v.runId || v.runId === `tomorrow-${id}`);
  const publicationMatches =
    publication?.version === 1 &&
    matches(publication) &&
    publication.runId === `tomorrow-${id}`;
  const remote = publication?.remote;
  const publicationIdentity =
    publicationMatches &&
    publication.channel?.id === CHANNEL &&
    typeof publication.videoId === "string" &&
    publication.videoId.length > 0 &&
    publication.url ===
      "https://www.youtube.com/shorts/" + publication.videoId &&
    remote?.id === publication.videoId &&
    remote.snippet?.channelId === CHANNEL &&
    ["uploaded", "processed"].includes(remote.status?.uploadStatus);
  const publicConfirmed =
    publicationIdentity &&
    publication.status === "confirmed" &&
    remote.status?.privacyStatus === "public" &&
    remote.processingDetails?.processingStatus === "succeeded" &&
    remote.status?.uploadStatus === "processed";
  let state = "unknown";
  let label;
  if (publicConfirmed) state = "published";
  else if (
    publicationIdentity &&
    publication.status === "confirmed" &&
    dateValue(remote?.status?.publishAt ?? publication.requestedPublishAt) &&
    remote.status?.privacyStatus !== "public" &&
    remote.processingDetails?.processingStatus === "succeeded"
  )
    state = "scheduled";
  else if (
    publicationIdentity &&
    ["uploaded", "confirmed"].includes(publication.status)
  )
    state = "uploaded";
  else if (matches(durable) && durable.status === "approved")
    state = "approved";
  else if (status?.phase === "failed") state = "failed";
  else if (
    /waiting|queued/.test(durable?.status ?? "") ||
    /waiting/.test(status?.phase ?? "")
  )
    state = "waiting";
  else if (
    worker?.running === true ||
    ["building", "planning", "preparing"].includes(status?.phase)
  ) {
    // A saved running flag cannot prove that a process is still alive.
    state = "waiting";
    label = "Сохранён незавершённый запуск";
  }
  if (
    (status?.phase === "published" || morning?.status === "published") &&
    !publicConfirmed
  )
    r.warn(
      "Публичная публикация заявлена, но подтверждение текущего выпуска не найдено.",
    );
  const updatedAt =
    [
      status?.updatedAt,
      morning?.updatedAt,
      durable?.updatedAt,
      publication?.confirmedAt,
      built?.builtAt,
    ]
      .map(dateValue)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  if (updatedAt && Date.parse(updatedAt) > Date.parse(now))
    r.warn("Время отчёта находится в будущем относительно текущего времени.");
  const title = r.text(
    built?.title ??
      morning?.title ??
      plan?.proposal?.title ??
      status?.title ??
      `Выпуск ${id}`,
    220,
  );
  const stage = ["published", "scheduled", "uploaded", "approved"].includes(
    state,
  )
    ? "publication"
    : failureStage(
        worker?.latestCheck ?? { code: durable?.code ?? status?.error?.code },
      );
  return {
    daily,
    status,
    plan,
    built,
    morning,
    durable,
    worker,
    publication,
    state,
    label: label ?? LABELS[state],
    title,
    updatedAt,
    stage,
  };
}

export async function listRuns({ root, now = new Date().toISOString() }) {
  const r = await reader(root);
  const daily = await r.safe("data/daily", false);
  if (!daily)
    throw error(
      "Каталог ежедневных запусков недоступен",
      "ROOT_UNAVAILABLE",
      404,
    );
  if (!daily.stat.isDirectory())
    throw error("Вместо каталога запусков найден файл", "ENOTDIR", 500);
  const ids = (await r.names("data/daily", false))
    .filter(
      (id) =>
        /^\d{4}-\d{2}-\d{2}$/.test(id) && dateValue(id)?.slice(0, 10) === id,
    )
    .sort()
    .reverse();
  const runs = (
    await mapLimit(ids, 6, async (id) => {
      try {
        const b = await baseRun(r, id, now);
        return {
          id,
          date: id,
          title: b.title,
          status: b.state,
          statusLabel: b.label,
          updatedAt: b.updatedAt,
          stage: b.stage,
          issueCount: Number.isSafeInteger(
            b.durable?.repairCounts?.otherFailures,
          )
            ? b.durable.repairCounts.otherFailures
            : b.state === "failed"
              ? 1
              : 0,
        };
      } catch {
        r.warn("Пропущен недоступный запуск: " + id);
        return null;
      }
    })
  ).filter(Boolean);
  return {
    runs,
    warnings: r.warnings,
    generatedAt: dateValue(now) ?? new Date().toISOString(),
  };
}

export async function loadRun({ root, id, now = new Date().toISOString() }) {
  validateId(id);
  const r = await reader(root);
  const b = await baseRun(r, id, now);
  const home = `${b.daily}/durable`;
  const runDir = `${b.daily}/shorts/runs/tomorrow-${id}`;
  const tokenUsage = await collectTokenUsage(r, {
    daily: b.daily,
    runDir,
    work: typeof b.plan?.work === "string" ? r.evidence(b.plan.work) : null,
  });
  const events = [],
    repairs = [],
    ruleMap = new Map(),
    groups = new Map();
  let eventCount = 0,
    maxRepairAttempt = 0,
    firstContextAt = null;
  const emit = (value) => {
    eventCount++;
    if (events.length < MAX_EVENTS)
      events.push({ id: `event-${eventCount}`, ...value });
  };
  const rule = (failure, at, evidence) => {
    const code = codeValue(failure?.code);
    if (!code) return;
    const current = ruleMap.get(code) ?? {
      code,
      label: r.text(failure.failedCheck ?? code, 220),
      count: 0,
      stage: failureStage(failure),
      lastAt: null,
      assessment: "Требует сопоставления замечаний с материалами",
      evidence: [],
      corrections: [],
      failedCheck: codeValue(failure.failedCheck),
      nativeCode: codeValue(failure.nativeCode),
    };
    current.count++;
    for (const correction of array(failure.corrections)) {
      const value = r.text(
        typeof correction === "string"
          ? correction
          : (correction?.correction ??
              correction?.reason ??
              correction?.message),
        1000,
      );
      if (
        value &&
        current.corrections.length < 6 &&
        !current.corrections.includes(value)
      )
        current.corrections.push(value);
    }
    if (!current.nativeCode) current.nativeCode = codeValue(failure.nativeCode);
    if (at && (!current.lastAt || at > current.lastAt)) current.lastAt = at;
    if (evidence && current.evidence.length < 3)
      current.evidence.push(evidence);
    ruleMap.set(code, current);
  };
  const [
    buildLog,
    supervisorLog,
    progress,
    contextNames,
    repairNames,
    early,
    measured,
    finalReview,
    audioQC,
  ] = await Promise.all([
    r.log(`${home}/build.log`),
    r.log(`${home}/supervisor.log`),
    r.json(`${home}/progress.json`),
    r.names(`${home}/repair-context`),
    r.names(`${home}/codex-repairs`),
    r.json(`${runDir}/preproduction-early.json`),
    r.json(`${runDir}/preproduction-measured.json`),
    r.json(`${runDir}/promo-review.json`),
    r.json(`${b.daily}/audio-qc.json`),
  ]);
  const renderStarts = [];
  for (const row of buildLog) {
    const at = dateValue(row.time ?? row.at ?? row.checkedAt);
    const message = r.text(row.message);
    if (!at || !message) continue;
    const stage = /рендер/.test(message)
      ? "render"
      : /сюжет выбран/.test(message)
        ? "selection"
        : failureStage(row);
    const kind =
      /ошибк|не завершена/.test(message) || row.level === "error"
        ? "error"
        : /рендер начат/.test(message)
          ? "start"
          : /готов/.test(message)
            ? "success"
            : "info";
    const seconds =
      stage === "render" &&
      kind === "success" &&
      typeof row.seconds === "number" &&
      Number.isFinite(row.seconds) &&
      row.seconds >= 0
        ? row.seconds * 1000
        : undefined;
    if (stage === "render" && kind === "start") renderStarts.push(at);
    emit({
      at,
      stage,
      kind,
      code: codeValue(row.code),
      message,
      evidence: `${home}/build.log`,
      ...(seconds !== undefined ? { durationMs: seconds } : {}),
    });
  }
  const supervisorCounts = new Map();
  for (const row of supervisorLog) {
    const attempt = Number.isSafeInteger(row.attempt) ? row.attempt : 0;
    maxRepairAttempt = Math.max(maxRepairAttempt, attempt);
    const code = codeValue(row.code),
      state = codeValue(row.status);
    if (!state) continue;
    const key = `${state}:${code ?? ""}`;
    const current = supervisorCounts.get(key) ?? {
      status: state,
      code,
      count: 0,
      maxAttempt: 0,
    };
    current.count++;
    current.maxAttempt = Math.max(current.maxAttempt, attempt);
    supervisorCounts.set(key, current);
  }
  const contexts = contextNames
    .filter((name) => /^[a-f\d]{64}\.json$/i.test(name))
    .sort();
  if (contexts.length > MAX_CONTEXTS)
    r.warn(
      `История ремонтов ограничена: ${MAX_CONTEXTS} из ${contexts.length} контекстов; число повторов является нижней оценкой.`,
    );
  await mapLimit(contexts.slice(0, MAX_CONTEXTS), 12, async (name) => {
    const evidence = `${home}/repair-context/${name}`;
    const context = await r.json(evidence);
    if (!context) return;
    const at = dateValue(context.createdAt),
      failure = context.failure ?? {},
      issue = context.issue ?? {};
    if (at && (!firstContextAt || at < firstContextAt)) firstContextAt = at;
    rule(
      {
        ...failure,
        corrections: [
          ...array(failure.corrections),
          ...array(issue.requiredEvidence),
        ],
      },
      at,
      evidence,
    );
    const issueKey = identity(issue.id),
      inputFingerprint = identity(
        issue.renderInputsSha ?? context.progress?.fingerprint,
      );
    if (!issueKey || !inputFingerprint) return;
    const exactInputs = identity(issue.renderInputsSha),
      targetSha = identity(issue.targetArtifactSha);
    const check = codeValue(issue.failedCheck ?? failure.failedCheck);
    const key = `${issueKey}:${inputFingerprint}:${targetSha ?? "missing"}:${check ?? "unknown"}`;
    const group = groups.get(key) ?? {
      issueKey,
      inputFingerprint,
      count: 0,
      firstAt: null,
      lastAt: null,
      code: codeValue(failure.code),
      evidence: [],
      verifiedUnchanged: Boolean(exactInputs && targetSha && check),
    };
    group.count++;
    if (at && (!group.firstAt || at < group.firstAt)) group.firstAt = at;
    if (at && (!group.lastAt || at > group.lastAt)) group.lastAt = at;
    if (group.evidence.length < 3) group.evidence.push(evidence);
    groups.set(key, group);
  });
  const jobIds = repairNames
    .filter((name) => /^[a-f\d]{64}$/i.test(name))
    .sort();
  if (jobIds.length > 1000)
    r.warn("Список заданий ремонта ограничен 1000 записями.");
  await mapLimit(jobIds.slice(0, 1000), 12, async (jobId) => {
    const base = `${home}/codex-repairs/${jobId}`;
    const [job, result, outcome] = await Promise.all([
      r.json(`${base}/job.json`),
      r.json(`${base}/result.json`),
      r.json(`${home}/repair-context/${jobId}.outcome.json`),
    ]);
    if (!job && !result) return;
    const at = dateValue(job?.createdAt),
      endedAt = dateValue(result?.finishedAt ?? outcome?.recordedAt);
    const issue = job?.issue ?? job?.diagnostic?.issue ?? {},
      failure = job?.failure ?? job?.diagnostic?.failure ?? {};
    const code = codeValue(result?.code ?? failure.code ?? job?.code);
    const workerChecksPassed =
      result?.status === "fixed" &&
      array(result?.checks).length > 0 &&
      result.checks.every((check) => check.passed === true);
    const verified =
      workerChecksPassed &&
      (result?.gate?.accepted === true ||
        result?.profileGate?.accepted === true ||
        outcome?.gateAccepted === true ||
        outcome?.profileGateAccepted === true);
    const repair = {
      id: jobId,
      createdAt: at,
      endedAt,
      status: codeValue(result?.status) ?? "unknown",
      code,
      nativeCode: codeValue(
        result?.latestCheck?.nativeCode ?? failure.nativeCode,
      ),
      message: r.text(
        result?.summary ??
          failure.message ??
          "Финальный результат задания не записан",
      ),
      issueKey: identity(issue.id),
      inputFingerprint: identity(
        issue.renderInputsSha ?? job?.diagnostic?.progress?.fingerprint,
      ),
      attempt: Number.isSafeInteger(job?.attempt) ? job.attempt : null,
      durationMs: duration(at, endedAt),
      noProgress: job?.diagnostic?.noProgress === true,
      targetChanged: outcome?.targetChanged ?? null,
      renderInputsChanged: outcome?.renderInputsChanged ?? null,
      workerChecksPassed,
      verified,
      evidence: `${base}/result.json`,
    };
    repairs.push(repair);
    maxRepairAttempt = Math.max(maxRepairAttempt, repair.attempt ?? 0);
    emit({
      at: endedAt ?? at,
      stage: failureStage(failure),
      kind: verified
        ? "success"
        : result
          ? workerChecksPassed
            ? "warning"
            : "error"
          : "warning",
      code,
      message:
        repair.message ||
        (workerChecksPassed
          ? "Рабочая проверка пройдена; профильный gate не подтвердил допуск"
          : "Ремонт завершён с отказом"),
      evidence: result ? `${base}/result.json` : `${base}/job.json`,
      durationMs: repair.durationMs,
    });
  });
  const pipelinePath =
    typeof b.plan?.work === "string"
      ? r.evidence(path.resolve(r.root, b.plan.work, "pipeline-report.json"))
      : null;
  const pipeline = pipelinePath ? await r.json(pipelinePath) : null;
  for (const stage of array(pipeline?.stages)) {
    const stageId = failureStage({ step: stage.id });
    emit({
      at: dateValue(stage.finishedAt ?? stage.startedAt),
      stage: stageId,
      kind: stage.ok ? "success" : "error",
      code: codeValue(stage.failure?.code),
      message: r.text(
        stage.error ??
          `${stage.id}: ${stage.cached ? "переиспользован" : stage.ok ? "готов" : "не завершён"}`,
      ),
      evidence: pipelinePath,
      durationMs: duration(
        dateValue(stage.startedAt),
        dateValue(stage.finishedAt),
      ),
    });
  }
  for (const [report, file] of [
    [early, "preproduction-early.json"],
    [measured, "preproduction-measured.json"],
  ]) {
    if (!report) continue;
    for (const record of array(report.stages)) {
      const ref = r.evidence(record.reportPath);
      const receipt = ref ? await r.json(ref) : null;
      const at = dateValue(receipt?.checkedAt);
      emit({
        at,
        stage: "preproduction",
        kind: receipt?.ok ? "success" : receipt ? "error" : "info",
        code: codeValue(record.stage),
        message: r.text(
          `${record.stage}: ${record.cached ? "результат переиспользован" : receipt?.ok ? "проверка пройдена" : "сохранён отчёт"}`,
        ),
        evidence: ref ?? `${runDir}/${file}`,
      });
      for (const correction of array(receipt?.result?.corrections)) {
        rule(
          {
            code:
              "EDITORIAL_" +
              (codeValue(record.stage) ?? "CHECK")
                .toUpperCase()
                .replaceAll("-", "_"),
            failedCheck: record.stage,
            message:
              typeof correction === "string"
                ? correction
                : (correction.reason ?? correction.correction),
          },
          at,
          ref,
        );
      }
    }
    if (report.error)
      rule(report.error, dateValue(report.checkedAt), `${runDir}/${file}`);
  }
  for (const issue of array(finalReview?.review?.issues)) {
    if (issue.severity === "note") continue;
    rule(
      {
        code: codeValue(issue.code ?? issue.checkCode) ?? "FINAL_REVIEW_ISSUE",
        domain: "final",
        message: issue.reason ?? issue.correction,
        corrections: [issue.correction ?? issue.reason],
      },
      dateValue(finalReview.reviewedAt),
      `${runDir}/promo-review.json`,
    );
  }
  const terminal = ["published", "scheduled", "uploaded", "approved"].includes(
    b.state,
  );
  const publicationAt = dateValue(
    b.publication?.confirmedAt ??
      b.status?.publishedAt ??
      b.morning?.publishedAt,
  );
  if (terminal)
    emit({
      at: publicationAt ?? b.updatedAt,
      stage: "publication",
      kind: "success",
      code: null,
      message: b.label,
      evidence: b.publication
        ? `${b.daily}/youtube-publish.json`
        : `${home}/status.json`,
    });
  if (
    !buildLog.length &&
    !supervisorLog.length &&
    !contexts.length &&
    !jobIds.length &&
    !pipeline
  )
    r.warn(
      "Подробная история этапов отсутствует; показаны только имеющиеся квитанции.",
    );
  if (!b.status && !b.durable && !b.morning && !b.plan)
    r.warn("Нет состояния, плана или квитанции запуска.");
  if (eventCount > MAX_EVENTS)
    r.warn(
      `Журнал ограничен ${MAX_EVENTS} событиями; агрегаты ремонтов сохранены отдельно.`,
    );
  events.sort(
    (a, z) =>
      (a.at ?? "").localeCompare(z.at ?? "") ||
      (a.stage ?? "").localeCompare(z.stage ?? "") ||
      (a.code ?? "").localeCompare(z.code ?? "") ||
      (a.message ?? "").localeCompare(z.message ?? "") ||
      (a.evidence ?? "").localeCompare(z.evidence ?? ""),
  );
  events.forEach((event, index) => {
    event.id = `event-${index + 1}`;
  });
  repairs.sort(
    (a, z) =>
      (a.createdAt ?? "").localeCompare(z.createdAt ?? "") ||
      (a.id ?? "").localeCompare(z.id ?? ""),
  );
  const startedAt =
    [
      firstContextAt,
      dateValue(b.plan?.observedAt),
      dateValue(b.status?.observedAt),
      dateValue(pipeline?.startedAt),
      ...events.map((event) => event.at),
      ...repairs.map((repair) => repair.createdAt),
    ]
      .filter(Boolean)
      .sort()[0] ?? null;
  const endedAt = terminal ? (publicationAt ?? b.updatedAt) : null;
  const latestCheck = b.worker?.latestCheck ?? progress?.failure ?? {};
  const stages = STAGES.map(([stageId, label]) => {
    const matching = events.filter((event) => event.stage === stageId);
    const latestOutcome = matching
      .filter((event) => ["success", "error"].includes(event.kind))
      .at(-1);
    let status =
      latestOutcome?.kind === "success"
        ? "complete"
        : latestOutcome?.kind === "error"
          ? "blocked"
          : matching.length
            ? "pending"
            : "unknown";
    if (
      stageId === "preproduction" &&
      early?.ok === true &&
      measured?.ok === true
    )
      status = "complete";
    if (stageId === "review" && finalReview?.review?.verdict === "ready")
      status = "complete";
    if (stageId === "voice" && audioQC?.ok === true) status = "complete";
    if (stageId === "publication" && terminal)
      status = b.state === "published" ? "complete" : "current";
    if (!terminal && stageId === b.stage)
      status = b.state === "failed" ? "blocked" : "current";
    return {
      id: stageId,
      label,
      status,
      attempts: stageId === "render" ? renderStarts.length : matching.length,
      durationMs:
        matching.reduce((sum, event) => sum + (event.durationMs ?? 0), 0) ||
        null,
      note: matching.at(-1)?.message ?? "Нет отдельных наблюдений об этапе",
    };
  });
  const loopGroups = [...groups.values()]
    .filter((group) => group.count > 1)
    .sort(
      (a, z) =>
        z.count - a.count ||
        (a.issueKey ?? "").localeCompare(z.issueKey ?? "") ||
        (a.inputFingerprint ?? "").localeCompare(z.inputFingerprint ?? ""),
    )
    .map((group) => ({ ...group, evidence: [...group.evidence].sort() }));
  for (const rule of ruleMap.values()) {
    rule.evidence.sort();
    rule.corrections.sort();
  }
  return {
    id,
    date: id,
    title: b.title,
    status: b.state,
    statusLabel: b.label,
    updatedAt: b.updatedAt,
    currentStage: b.stage,
    summary: {
      startedAt,
      endedAt,
      elapsedMs: duration(startedAt, endedAt ?? b.updatedAt),
      repairCount: jobIds.length,
      renderCount: renderStarts.length,
      errorCount: events.filter((event) => event.kind === "error").length,
    },
    stages,
    tokenUsage,
    events,
    repairs,
    rules: [...ruleMap.values()].sort(
      (a, z) => z.count - a.count || a.code.localeCompare(z.code),
    ),
    loopGroups,
    currentFailure: terminal
      ? null
      : {
          code: codeValue(latestCheck.code),
          nativeCode: codeValue(latestCheck.nativeCode),
          stage: failureStage(latestCheck),
          message: r.text(latestCheck.message),
          noProgress: progress?.noProgress === true,
        },
    observations: {
      maxRepairAttempt,
      contextCount: contexts.length,
      contextReadCount: Math.min(contexts.length, MAX_CONTEXTS),
      supervisor: [...supervisorCounts.values()],
      finalScores: finalReview?.review?.scores
        ? Object.fromEntries(
            Object.entries(finalReview.review.scores)
              .filter(
                ([key, value]) => codeValue(key) && Number.isFinite(value),
              )
              .map(([key, value]) => [key, value]),
          )
        : {},
    },
    warnings: r.warnings,
    generatedAt: dateValue(now) ?? new Date().toISOString(),
  };
}

export const meta = {
  name: "daily-episode",
  description:
    "Team Orchestration v2 для ежедневного выпуска Отголоска (Preflight & Infra Gate -> Episode Architect -> Parallel Asset Production -> Pre-Gate & Cross-Family Review -> Locked Render & Audit -> Final Gate -> Scheduled YouTube Publish) с классификацией ошибок, кросс-семейным ревью и разделением контента и кода движка.",
  inputSchema: {
    type: "object",
    required: ["date", "modelChains"],
    additionalProperties: false,
    properties: {
      date: {
        type: "string",
        minLength: 10,
        description: "Целевая дата выпуска по Москве в формате YYYY-MM-DD",
      },
      creativeRoot: {
        type: "string",
        minLength: 1,
        description: "Абсолютный путь к репозиторию otgolosok-creative",
      },
      shortsRoot: {
        type: "string",
        minLength: 1,
        description: "Абсолютный путь к репозиторию otgolosok-shorts",
      },
      maxEarlyAttempts: {
        type: "integer",
        minimum: 1,
        maximum: 3,
        description: "Максимум попыток прохождения --phase early до возврата блокера (по умолчанию 2)",
      },
      allowSecondSameDayAfterHours: {
        type: "integer",
        minimum: 1,
        maximum: 24,
        description: "Минимальная разница в часах для второго выпуска в ту же дату МСК",
      },
      publishScheduled: {
        type: "boolean",
        description: "Выполнить отложенную публикацию на YouTube (private + publishAt) после Final Gate (по умолчанию true)",
      },
      publishAt: {
        type: "string",
        minLength: 20,
        nullable: true,
        description: "Явное будущее время отложенной публикации в ISO-8601 с часовым поясом; если не задано, берётся plan.json -> slotAt",
      },
      viewerSmokeUrl: {
        type: "string",
        minLength: 8,
        nullable: true,
        description: "URL для smoke-проверки viewer на этапе Preflight (по умолчанию https://otgolosok.online/walk)",
      },
      modelChains: {
        type: "object",
        required: ["light", "worker", "visual", "architect", "reviewer"],
        additionalProperties: false,
        properties: {
          light: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["provider", "model"],
              additionalProperties: false,
              properties: {
                provider: { type: "string", minLength: 1 },
                model: { type: "string", minLength: 1 },
                reasoningLevel: { type: "string", minLength: 1, nullable: true },
                family: { type: "string", minLength: 1, nullable: true },
              },
            },
          },
          worker: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["provider", "model"],
              additionalProperties: false,
              properties: {
                provider: { type: "string", minLength: 1 },
                model: { type: "string", minLength: 1 },
                reasoningLevel: { type: "string", minLength: 1, nullable: true },
                family: { type: "string", minLength: 1, nullable: true },
              },
            },
          },
          visual: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["provider", "model"],
              additionalProperties: false,
              properties: {
                provider: { type: "string", minLength: 1 },
                model: { type: "string", minLength: 1 },
                reasoningLevel: { type: "string", minLength: 1, nullable: true },
                family: { type: "string", minLength: 1, nullable: true },
              },
            },
          },
          architect: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["provider", "model"],
              additionalProperties: false,
              properties: {
                provider: { type: "string", minLength: 1 },
                model: { type: "string", minLength: 1 },
                reasoningLevel: { type: "string", minLength: 1, nullable: true },
                family: { type: "string", minLength: 1, nullable: true },
              },
            },
          },
          reviewer: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["provider", "model"],
              additionalProperties: false,
              properties: {
                provider: { type: "string", minLength: 1 },
                model: { type: "string", minLength: 1 },
                reasoningLevel: { type: "string", minLength: 1, nullable: true },
                family: { type: "string", minLength: 1, nullable: true },
              },
            },
          },
        },
      },
    },
  },
  outputSchema: {
    type: "object",
    required: ["status", "date", "summary"],
    additionalProperties: true,
    properties: {
      status: {
        enum: ["published", "approved", "already_done", "blocked"],
      },
      date: { type: "string" },
      stage: { type: "string" },
      blockClass: {
        enum: [
          "none",
          "code_bug",
          "infra",
          "candidate_unfit",
          "editorial_blocker",
          "audio_defect",
          "publish_blocker",
        ],
      },
      codeBug: {
        type: "object",
        nullable: true,
        properties: {
          file: { type: "string", nullable: true },
          symptom: { type: "string" },
          reproduction: { type: "string", nullable: true },
        },
      },
      summary: { type: "string" },
      videoPath: { type: "string", nullable: true },
      videoSha256: { type: "string", nullable: true },
      coverPath: { type: "string", nullable: true },
      durableStatus: { type: "string", nullable: true },
      youtubeVideoId: { type: "string", nullable: true },
      youtubeUrl: { type: "string", nullable: true },
      publishAt: { type: "string", nullable: true },
      youtubePublishReceipt: { type: "string", nullable: true },
      modelAudit: {
        type: "array",
        items: {
          type: "object",
          required: ["step", "role", "provider", "model"],
          properties: {
            step: { type: "string" },
            role: { type: "string" },
            provider: { type: "string" },
            model: { type: "string" },
            family: { type: "string" },
            fallbacks: { type: "integer" },
            outcome: { type: "string" },
            errorClass: { type: "string", nullable: true },
          },
        },
      },
    },
  },
  phases: [
    { title: "Preflight & Infra Gate", detail: "YouTube OAuth, слот, проверка Chromium/viewer и независимая сверка" },
    { title: "Episode Architect", detail: "Read-only выбор кандидата, проверка >=3 фото места и единый episode-brief.json" },
    { title: "Parallel Asset Production", detail: "Параллельный fan-out: Researcher + Media Hunter + Scriptwriter" },
    { title: "Pre-Gate & Cross-Family Review", detail: "Детерминированный pre-gate, --phase early и кросс-семейный ревьювер" },
    { title: "Locked Render & Audit", detail: "Замороженный контент: ElevenLabs v4, measured-frame, MP4, creative/promo-review и audio-qc" },
    { title: "Final Gate", detail: "Кросс-семейная дисковая сверка SHA-256, квитанций и чистоты scripts/" },
    { title: "Scheduled YouTube Publish", detail: "Отложенная загрузка (private + publishAt) и независимая проверка readback" },
  ],
};

const date = args.date;
const creativeRoot = args.creativeRoot || "/Users/user/projects/ai/otgolosok-creative";
const shortsRoot = args.shortsRoot || "/Users/user/projects/ai/otgolosok-shorts";
const maxEarlyAttempts = args.maxEarlyAttempts || 2;
const minHoursGap = args.allowSecondSameDayAfterHours || 8;
const publishScheduled = args.publishScheduled !== false;
const explicitPublishAt = args.publishAt || null;
const viewerSmokeUrl = args.viewerSmokeUrl || "https://otgolosok.online/walk";
const dailyDir = `${creativeRoot}/data/daily/${date}`;
const runDir = `${dailyDir}/shorts/runs/tomorrow-${date}`;
const workDir = `${creativeRoot}/data/work/auto-${date}`;
const briefPath = `${dailyDir}/episode-brief.json`;
const launchLabel = `online.otgolosok.creative-durable-${date}`;
const modelAudit = [];

const COMMON_RULES = [
  "СТРОГИЕ ПРАВИЛА ПРОЕКТА И TEAM ORCHESTRATION:",
  "- Публикация на YouTube СТРОГО ЗАПРЕЩЕНА на всех этапах сборки до завершения Final Gate (approved). Отложенная публикация (private + publishAt) разрешена ТОЛЬКО на этапе Scheduled YouTube Publish. Немедленная публикация (--privacy public) запрещена.",
  "- РАЗДЕЛЕНИЕ КОНТЕНТА И КОДА ДВИЖКА: тебе ЗАПРЕЩЕНО редактировать файлы в otgolosok-creative/scripts/*.mjs и otgolosok-creative/tests/*.mjs! Ты работаешь ТОЛЬКО в каталогах данных выпуска (data/daily/" + date + "/ и data/work/auto-" + date + "/). Если обнаружен реальный баг конвейера, НЕ чини код сам — остановись и верни структурированный codeBug (file, symptom, reproduction), чтобы координатор передал его в изолированный team-workflow (team-aer).",
  "- НИКОГДА не запускай фоновый LaunchAgent и не крути циклы поллинга sleep/ps/launchctl; вызывай штатные CLI-скрипты синхронно и перед правкой файлов убедись, что старый LaunchAgent " + launchLabel + " выгружен.",
  "- НИКОГДА не выводи и не записывай секреты, токены и API-ключи в stdout, логи и файлы.",
  "- НИКОГДА не редактируй вручную квитанции проверок (visual-material.json, preproduction-*.json, promo-review.json, creative-review.json, audio-qc.json), не занижай пороги (<7/10) и не обходи гейты.",
  "- НИКОГДА не вызывай agentapi, сторонние локальные демоны Antigravity или прокси — используй только штатные CLI, node, python3, curl и скрипты проекта.",
  "- При запросах к Wikimedia Commons API всегда передавай User-Agent: OtgolosokShorts/1.0 (https://otgolosok.online), делай паузу >= 1 с, не больше 15 API-запросов, проверяй свободные лицензии (CC0, CC BY, CC BY-SA, Public domain) и реальный SHA-1 файлов (без PastVu).",
  "- Для поиска первичных источников и альтернативных HTML-страниц разрешено использовать Airouter Perplexity (лимит тела запроса <= 9 000 000 байт; после HTTP 413 не повторять без уменьшения тела).",
  "- Озвучка ТОЛЬКО ElevenLabs v4 (provider: elevenlabs, model: eleven_v4, голос «Отголосок2»). В речи людей называть полным именем и фамилией (без инициалов) и не упоминать сторонние сайты как источники.",
  "- По завершении ОБЯЗАТЕЛЬНО верни структурированный результат через инструмент bb_workflow_result.",
].join("\n");

// Классификатор ошибок (портирован из team-aer + расширен на capacity/stream disconnect)
const ERROR_RULES = [
  ["fallback_quota", true, "selected model is at capacity|at capacity|individual quota|quota reached|quota_exceeded|quota limit|usage limit|account exhausted|upgrade your subscription"],
  ["non_fallback_schema", false, "bb_workflow_result|ajv|structured output|invalid submission|schema validation|output schema"],
  ["non_fallback_payload", false, "\\b413\\b|payload too large|request entity too large|context length exceeded|prompt too long"],
  ["non_fallback_auth", false, "\\b401\\b|\\b403\\b|unauthorized|unauthenticated|invalid api key|expired session|login required|auth_required"],
  ["non_fallback_config", false, "unsupported reasoning|unknown provider|model is absent|invalid model|not in live catalog|plain properties|must be a non-empty string literal|missing_executable"],
  ["non_fallback_cancelled", false, "permission denied|forbidden by policy|not authorized to edit|approval denied"],
  ["fallback_transport", true, "stream disconnected|stream closed before|\\btimeout\\b|timed out|\\betimedout\\b|request timeout"],
  ["non_fallback_cancelled", false, "\\bcancel(?:led|ed)?\\b|\\babort(?:ed)?\\b"],
  ["fallback_quota", true, "\\b429\\b|rate.?limit|limit reached|too many requests|retry.?after"],
  ["fallback_transport", true, "\\b5\\d{2}\\b|overloaded|overload|\\beconn(?:reset|refused|aborted)\\b|socket hang up|network error|network failure|connection (?:reset|refused|dropped|closed)|service unavailable|bad gateway|gateway timeout|provider_unavailable|internal server error|upstream (?:error|timeout|unavailable|failure|5\\d{2})"],
  ["fallback_worker_opaque", true, "workflow worker failed(?: before attachment completed| while its retry was handed off)?$"],
];

function classifyError(err) {
  const text =
    err && typeof err === "object"
      ? [
          err.status ? `HTTP ${String(err.status)}` : "",
          err.code ? String(err.code) : "",
          err.name ? String(err.name) : "",
          err.message ? String(err.message) : "",
        ]
          .filter(Boolean)
          .join(" ")
      : String(err || "");
  for (let i = 0; i < ERROR_RULES.length; i += 1) {
    const r = ERROR_RULES[i];
    if (new RegExp(r[2], "i").test(text)) {
      return { errorClass: r[0], allowFallback: r[1] };
    }
  }
  return { errorClass: "non_fallback_unknown", allowFallback: false };
}

function inferFamily(spec) {
  if (spec && spec.family) return spec.family;
  const p = String((spec && spec.provider) || "").toLowerCase();
  const m = String((spec && spec.model) || "").toLowerCase();
  if (p === "codex" || m.startsWith("gpt-")) return "codex";
  if (m.includes("gemini")) return "gemini";
  if (m.includes("claude")) return "claude";
  if (m.includes("deepseek")) return "deepseek";
  return p || "unknown";
}

async function invokeLiteralAgent(spec, prompt, stepLabel, phaseName, schema) {
  const key = spec.reasoningLevel
    ? `${spec.provider}/${spec.model}/${spec.reasoningLevel}`
    : `${spec.provider}/${spec.model}`;
  switch (key) {
    case "acp-antigravity-acp/gemini-3.8-flash":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "acp-antigravity-acp",
        model: "gemini-3.8-flash",
      });
    case "codex/gpt-6-luna/medium":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "codex",
        model: "gpt-6-luna",
        reasoningLevel: "medium",
      });
    case "acp-opencode/opencode/deepseek-v4.1-flash-free":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "acp-opencode",
        model: "opencode/deepseek-v4.1-flash-free",
      });
    case "acp-opencode/opencode/big-pickle":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "acp-opencode",
        model: "opencode/big-pickle",
      });
    case "codex/gpt-6.1-sol/high":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "codex",
        model: "gpt-6.1-sol",
        reasoningLevel: "high",
      });
    case "acp-antigravity-acp/claude-sonnet-5-5":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "acp-antigravity-acp",
        model: "claude-sonnet-5-5",
      });
    case "acp-antigravity-acp/gemini-4-neon/high":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "acp-antigravity-acp",
        model: "gemini-4-neon",
        reasoningLevel: "high",
      });
    case "codex/gpt-6.1-terra/high":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "codex",
        model: "gpt-6.1-terra",
        reasoningLevel: "high",
      });
    case "codex/gpt-6-astra/high":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "codex",
        model: "gpt-6-astra",
        reasoningLevel: "high",
      });
    case "acp-antigravity-acp/claude-opus-5-5":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "acp-antigravity-acp",
        model: "claude-opus-5-5",
      });
    default:
      throw new Error(`Unsupported literal model spec in daily-episode workflow: ${key}`);
  }
}

/**
 * Запускает роль с классифицированным фолбэком, приоритетным переключением на другую семью
 * при квоте/capacity и опциональным кросс-семейным ревью (`excludeFamily`).
 */
async function runRole(role, stepLabel, prompt, opts = {}) {
  const baseChain = (args.modelChains[role] || []).slice();
  if (!baseChain.length) {
    throw new Error(`No models configured for role "${role}"`);
  }

  let chain = baseChain;
  if (opts.excludeFamily || opts.excludeModelKey) {
    const isExcluded = (c) =>
      (opts.excludeFamily && inferFamily(c) === opts.excludeFamily) ||
      (opts.excludeModelKey && `${c.provider}/${c.model}` === opts.excludeModelKey);
    const cross = chain.filter((c) => !isExcluded(c));
    const same = chain.filter((c) => isExcluded(c));
    chain = opts.strictCrossFamily ? cross : cross.concat(same);
  } else if (opts.preferAlternate && chain.length > 1) {
    const firstFamily = inferFamily(chain[0]);
    const diffIdx = chain.findIndex((c) => inferFamily(c) !== firstFamily);
    if (diffIdx > 0) {
      chain = [chain[diffIdx], ...chain.slice(0, diffIdx), ...chain.slice(diffIdx + 1)];
    } else {
      chain = [chain[1], chain[0], ...chain.slice(2)];
    }
  }

  if (!chain.length) {
    throw new Error(`No eligible cross-family model for role "${role}" at step "${stepLabel}"`);
  }

  const remaining = chain.slice();
  let lastErr = null;
  let attempts = 0;

  while (remaining.length > 0) {
    const spec = remaining.shift();
    const fam = inferFamily(spec);
    try {
      const value = await invokeLiteralAgent(spec, prompt, stepLabel, opts.phase, opts.schema);
      modelAudit.push({
        step: stepLabel,
        role,
        provider: spec.provider,
        model: spec.model,
        family: fam,
        fallbacks: attempts,
        outcome: "succeeded",
        errorClass: null,
      });
      return { value, selected: { ...spec, family: fam } };
    } catch (err) {
      lastErr = err;
      const cls = classifyError(err);
      const msg = err && err.message ? String(err.message).slice(0, 240) : String(err);
      modelAudit.push({
        step: stepLabel,
        role,
        provider: spec.provider,
        model: spec.model,
        family: fam,
        fallbacks: attempts,
        outcome: "failed",
        errorClass: cls.errorClass,
      });
      log(`[${stepLabel}] (${role}) ${spec.provider}/${spec.model} [${fam}] failed (${cls.errorClass}): ${msg}`);
      if (!cls.allowFallback) {
        throw err;
      }
      attempts += 1;
      // При сбое квоты/capacity/транспорта ставим следующую ДРУГУЮ семью первой, чтобы не залипнуть на той же
      const nextDiffIdx = remaining.findIndex((c) => inferFamily(c) !== fam);
      if (nextDiffIdx > 0) {
        const [picked] = remaining.splice(nextDiffIdx, 1);
        remaining.unshift(picked);
      }
    }
  }
  throw lastErr || new Error(`All candidates failed for role "${role}" at step "${stepLabel}"`);
}

function blockedResult(stage, blockClass, summary, extra = {}) {
  return {
    status: "blocked",
    date,
    stage,
    blockClass,
    codeBug: extra.codeBug || null,
    summary,
    videoPath: extra.videoPath || null,
    videoSha256: extra.videoSha256 || null,
    coverPath: extra.coverPath || null,
    durableStatus: extra.durableStatus || null,
    youtubeVideoId: extra.youtubeVideoId || null,
    youtubeUrl: extra.youtubeUrl || null,
    publishAt: extra.publishAt || null,
    youtubePublishReceipt: extra.youtubePublishReceipt || null,
    modelAudit,
  };
}

const codeBugSchema = {
  type: "object",
  nullable: true,
  additionalProperties: false,
  required: ["symptom"],
  properties: {
    file: { type: "string", nullable: true },
    symptom: { type: "string" },
    reproduction: { type: "string", nullable: true },
  },
};

// ==================== PHASE 1: PREFLIGHT & INFRA GATE ====================
phase("Preflight & Infra Gate");

const preflightSchema = {
  type: "object",
  required: ["slotFree", "alreadyBuilt", "alreadyPublished", "infraOk", "videosChecked", "readbackPath", "historyPath", "summary"],
  additionalProperties: false,
  properties: {
    slotFree: { type: "boolean" },
    alreadyBuilt: { type: "boolean" },
    alreadyPublished: { type: "boolean" },
    infraOk: { type: "boolean" },
    infraIssues: { type: "array", items: { type: "string" } },
    videosChecked: { type: "integer", minimum: 0 },
    latestVideoId: { type: "string", nullable: true },
    readbackPath: { type: "string" },
    historyPath: { type: "string" },
    summary: { type: "string" },
  },
};

const verifyPreflightSchema = {
  type: "object",
  required: ["verified", "slotFree", "alreadyBuilt", "alreadyPublished", "infraOk", "reason"],
  additionalProperties: false,
  properties: {
    verified: { type: "boolean" },
    slotFree: { type: "boolean" },
    alreadyBuilt: { type: "boolean" },
    alreadyPublished: { type: "boolean" },
    infraOk: { type: "boolean" },
    reason: { type: "string" },
  },
};

const preflightPrompt = [
  `Рабочий каталог: ${creativeRoot}. Целевая дата выпуска (МСК): ${date}.`,
  COMMON_RULES,
  "",
  "Задача Preflight & Infra Gate (быстрый fail-fast за 1–2 минуты):",
  `1. Выгрузи старый LaunchAgent ${launchLabel} если висит (launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/${launchLabel}.plist 2>/dev/null || true), чтобы исключить гонки.`,
  `2. Запусти быструю инфраструктурную проверку: node scripts/preflight-infra-check.mjs --viewer-url ${viewerSmokeUrl} --shorts-root ${shortsRoot} --out ${dailyDir}/preflight-infra.json`,
  "   (проверяет headless Chrome/Chromium, ffmpeg/ffprobe, наличие файлов секретов без печати значений и доступность viewer). Если скрипт вернул infraOk=false — зафиксируй infraIssues (не пытайся чинить Chrome сам).",
  `3. Проверь YouTube-канал UC6iI4xswk8MOTld9b1mL4GQ через РЕАЛЬНЫЙ OAuth-запрос (ключи в ${shortsRoot}/.env, токен в ${shortsRoot}/data/secrets/youtube-token.json; см. scripts/yt-stats.mjs). НЕ читай вчерашний readback вместо OAuth!`,
  `4. Запиши свежие файлы в ${dailyDir}/:`,
  `   - ${dailyDir}/morning-youtube-readback.json ({"date":"${date}","checkedAt":"<ISO>","channelId":"UC6iI4xswk8MOTld9b1mL4GQ","videosChecked":<N>,"scheduledForDate":[...],"publicOnDate":[...],"note":"..."})`,
  `   - ${dailyDir}/operator-research/youtube-channel-history.json (массив видео канала: videoId, title, publishedAt, publishAt, privacyStatus).`,
  `5. Учти правило дедупликации: второй выпуск в ту же московскую дату РАЗРЕШЁН, если разница по времени публикации до слота ${date}T17:30:00Z (Пн–Чт) / ${date}T18:30:00Z (Пт–Вс) превышает ${minHoursGap} часов.`,
  `6. Проверь раздельно alreadyBuilt (${dailyDir}/built.json + валидный MP4 + promo/creative-review ready + ${dailyDir}/durable/status.json === "approved") и alreadyPublished (${dailyDir}/youtube-publish.json со status === "confirmed" или уже запланировано на YouTube).`,
  "7. Верни итог через bb_workflow_result.",
].join("\n");

let preflightRun = await runRole("light", "preflight:oauth-and-infra", preflightPrompt, {
  phase: "Preflight & Infra Gate",
  schema: preflightSchema,
});
let preflight = preflightRun.value;

let preflightCheckRun = await runRole(
  "light",
  "preflight:verify-disk",
  [
    `Независимая кросс-семейная проверка Preflight в ${creativeRoot} для даты ${date}.`,
    COMMON_RULES,
    "",
    "Режим верификации — строго read-only: НЕ изменяй и НЕ перезаписывай файлы выпуска (включая preflight-infra.json).",
    "Проверь файлы НА ДИСКЕ (не доверяй тексту отчёта):",
    `1. ${dailyDir}/preflight-infra.json существует и отражает реальный статус Chrome/ffmpeg/viewer (infraOk). Учти: scripts/preflight-infra-check.mjs подключает локальный toolchain через scripts/toolchain.mjs (${creativeRoot}/data/tools/bin/ffmpeg и ffprobe), поэтому отсутствие ffmpeg/ffprobe в системном PATH НЕ является блокером, если локальный toolchain работает. При желании перепроверить инфраструктуру запускай node scripts/preflight-infra-check.mjs --viewer-url ${viewerSmokeUrl} --shorts-root ${shortsRoot} (без --out), а не голый which ffmpeg.`,
    `2. ${dailyDir}/morning-youtube-readback.json существует, date === "${date}", свежий checkedAt, videosChecked > 0.`,
    `3. ${dailyDir}/operator-research/youtube-channel-history.json существует и содержит непустой массив видео.`,
    `4. Сверь alreadyBuilt, alreadyPublished и slotFree (с учётом порога > ${minHoursGap} ч).`,
    `Отчёт предыдущего агента: ${JSON.stringify(preflight)}`,
  ].join("\n"),
  {
    phase: "Preflight & Infra Gate",
    schema: verifyPreflightSchema,
    excludeFamily: preflightRun.selected.family,
  },
);
let preflightCheck = preflightCheckRun.value;

if (!preflightCheck.verified) {
  log(`Preflight verification failed (${preflightCheck.reason}); retrying on worker role`);
  preflightRun = await runRole(
    "worker",
    "preflight:retry-worker",
    preflightPrompt + `\n\nПредыдущая попытка не прошла независимую проверку: ${preflightCheck.reason}`,
    {
      phase: "Preflight & Infra Gate",
      schema: preflightSchema,
    },
  );
  preflight = preflightRun.value;
  preflightCheckRun = await runRole(
    "light",
    "preflight:verify-disk-2",
    [
      `Повторная независимая проверка файлов Preflight в ${dailyDir} для даты ${date} (строго read-only, не перезаписывай preflight-infra.json).`,
      `Проверь preflight-infra.json (учти, что scripts/toolchain.mjs добавляет ${creativeRoot}/data/tools/bin/ffmpeg и ffprobe в PATH; при перепроверке запускай node scripts/preflight-infra-check.mjs --viewer-url ${viewerSmokeUrl} --shorts-root ${shortsRoot} без --out), morning-youtube-readback.json, youtube-channel-history.json, built.json, durable/status.json и youtube-publish.json.`,
      `Отчёт worker: ${JSON.stringify(preflight)}`,
      COMMON_RULES,
    ].join("\n"),
    {
      phase: "Preflight & Infra Gate",
      schema: verifyPreflightSchema,
      excludeFamily: preflightRun.selected.family,
    },
  );
  preflightCheck = preflightCheckRun.value;
}

if (!preflightCheck.verified) {
  return blockedResult("preflight", "infra", `Preflight не прошёл независимую верификацию: ${preflightCheck.reason}`);
}

if (!preflightCheck.infraOk) {
  return blockedResult(
    "preflight",
    "infra",
    `Инфраструктурный блокер на Preflight (остановлено до сборки): ${(preflight.infraIssues || []).join("; ") || preflightCheck.reason}`,
  );
}

if (!preflightCheck.slotFree || preflightCheck.alreadyPublished || (preflightCheck.alreadyBuilt && !publishScheduled)) {
  return {
    status: "already_done",
    date,
    stage: "preflight",
    blockClass: "none",
    codeBug: null,
    summary: `Сборка/публикация не требуется: ${preflightCheck.reason} (${preflight.summary})`,
    videoPath: null,
    videoSha256: null,
    coverPath: null,
    durableStatus: null,
    youtubeVideoId: null,
    youtubeUrl: null,
    publishAt: null,
    youtubePublishReceipt: null,
    modelAudit,
  };
}

const skipBuildToPublish = Boolean(preflightCheck.alreadyBuilt && !preflightCheck.alreadyPublished && publishScheduled);
let phase2 = {
  ok: true,
  measuredOk: true,
  promoReviewReady: true,
  audioQcOk: true,
  blockClass: "none",
  codeBug: null,
  videoPath: `${runDir}/promo-video.mp4`,
  videoSha256: null,
  coverPath: `${runDir}/youtube-cover.jpg`,
  durableStatus: "approved",
  errorSummary: null,
  summary: "Локальная сборка уже была одобрена ранее; переход сразу к Final Gate и отложенной публикации.",
};

if (!skipBuildToPublish) {
  // ==================== PHASE 2: EPISODE ARCHITECT ====================
  phase("Episode Architect");

  const architectSchema = {
    type: "object",
    required: ["readyToProduce", "planType", "placeName", "assetsAlreadyReady", "scriptAlreadyReady", "candidateUnfit", "summary"],
    additionalProperties: false,
    properties: {
      readyToProduce: { type: "boolean" },
      planType: { enum: ["normal", "creative"] },
      placeId: { type: "string", nullable: true },
      placeName: { type: "string" },
      assetsAlreadyReady: { type: "boolean" },
      scriptAlreadyReady: { type: "boolean" },
      candidateUnfit: { type: "boolean" },
      placePhotosFeasibleCount: { type: "integer", minimum: 0 },
      briefPath: { type: "string", nullable: true },
      codeBug: codeBugSchema,
      summary: { type: "string" },
    },
  };

  const architectRun = await runRole(
    "architect",
    "architect:episode-brief",
    [
      `Ты Episode Architect (продюсер-архитектор выпуска) в ${creativeRoot}. Целевая дата: ${date}.`,
      `Каталог выпуска: ${dailyDir}. runDir: ${runDir}. workDir: ${workDir}.`,
      COMMON_RULES,
      "",
      "Задача Episode Architect (коротко и прицельно — 3–5 минут, без поллинга LaunchAgent!):",
      `1. Убедись, что ${dailyDir}/plan.json существует. Если plan.json ещё нет — запусти синхронно штатный локальный отбор: npm run tomorrow -- --local --date ${date} --plan-only (слот на YouTube уже проверен реальным OAuth на Preflight, а --local использует локальное расписание PROMO_CREATIVE_WEEKDAYS без SSH к VPS; НЕ запускай фоновый LaunchAgent!).`,
      `2. Проверь текущее состояние на диске:`,
      `   - assetsAlreadyReady: существует ли валидный ${runDir}/visual-material.json (ok===true, score>=7, distinctSubjects>=3, covered>=3) и все фото на диске с SHA-1;`,
      `   - scriptAlreadyReady: существует ли валидный ${runDir}/script.json (и для creative: ${workDir}/script.json + ${workDir}/auto-prepared.json + принятый ${workDir}/script-review.json).`,
      `3. SHIFT-LEFT ПРОВЕРКА КАНДИДАТА: проверь заранее, доступны ли >= 3 РАЗНЫХ свободно лицензированных фото ИМЕННО МЕСТА (не просто 3 кропа одного портрета/иллюстрации!). Если у кандидата физически нет 3 разных свободных фото места и невозможно подобрать их в Commons — верни candidateUnfit: true (fail-fast, чтобы не сжечь часы впустую).`,
      `4. Запиши единый контракт для параллельной команды в ${briefPath} (JSON):`,
      "   - date, planType, placeId, placeName, walkShareUrl, routeFallbackRequired (boolean);",
      "   - hookAngle (сильный факт + чёткое обещание), keyFacts (список подтверждённых фактов с ссылками на источники), forbiddenClaims;",
      "   - mediaPlan (какие >=3 разных фото МЕСТА нужны + допустимые честные иллюстрации; лимит <=15 запросов к Commons);",
      "   - finalePlan (старт, целевая остановка, финальный вопрос с выбором).",
      "5. Если наткнулся на баг в scripts/*.mjs — НЕ правь код, верни codeBug.",
      "6. Верни структурированный итог через bb_workflow_result.",
    ].join("\n"),
    {
      phase: "Episode Architect",
      schema: architectSchema,
    },
  );
  const arch = architectRun.value;

  if (arch.codeBug) {
    return blockedResult("episode-architect", "code_bug", `Баг конвейера на этапе Episode Architect: ${arch.codeBug.symptom}`, {
      codeBug: arch.codeBug,
    });
  }
  if (arch.candidateUnfit || !arch.readyToProduce) {
    return blockedResult(
      "episode-architect",
      "candidate_unfit",
      `Кандидат отклонён на Episode Architect (fail-fast): ${arch.summary}`,
    );
  }

  // ==================== PHASE 3: PARALLEL ASSET PRODUCTION ====================
  phase("Parallel Asset Production");

  const researchSchema = {
    type: "object",
    required: ["ok", "sourcesCount", "summary"],
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      sourcesCount: { type: "integer", minimum: 0 },
      codeBug: codeBugSchema,
      summary: { type: "string" },
    },
  };

  const mediaSchema = {
    type: "object",
    required: ["ok", "distinctPlacePhotos", "commonsRequestsUsed", "summary"],
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      distinctPlacePhotos: { type: "integer", minimum: 0 },
      commonsRequestsUsed: { type: "integer", minimum: 0 },
      candidateUnfit: { type: "boolean" },
      codeBug: codeBugSchema,
      summary: { type: "string" },
    },
  };

  const scriptSchema = {
    type: "object",
    required: ["ok", "scriptPresent", "summary"],
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      scriptPresent: { type: "boolean" },
      codeBug: codeBugSchema,
      summary: { type: "string" },
    },
  };

  const verifyAssetsSchema = {
    type: "object",
    required: ["verified", "visualMaterialOk", "scriptPresent", "pregateOk", "reason"],
    additionalProperties: false,
    properties: {
      verified: { type: "boolean" },
      visualMaterialOk: { type: "boolean" },
      scriptPresent: { type: "boolean" },
      pregateOk: { type: "boolean" },
      blockers: { type: "array", items: { type: "string" } },
      reason: { type: "string" },
    },
  };

  if (!arch.assetsAlreadyReady || !arch.scriptAlreadyReady) {
    const fanoutResults = await parallel([
      // Поток A: Researcher (источники, HTML/Perplexity, factcheck) — владеет только operator-research/sources и factcheck/source-verification
      () =>
        runRole(
          "light",
          "assets:researcher",
          [
            `Роль: Fact & Source Researcher. Рабочий каталог: ${creativeRoot}. Дата: ${date}. Тип: ${arch.planType}.`,
            `Контракт выпуска: прочитай ${briefPath}.`,
            COMMON_RULES,
            "",
            "ЗОНА ВЛАДЕНИЯ (трогай ТОЛЬКО эти пути, чтобы не конфликтовать с Media Hunter и Scriptwriter):",
            `- ${dailyDir}/operator-research/sources/`,
            `- ${arch.planType === "creative" ? `${workDir}/evidence/sources/` : `${runDir}/evidence/`}`,
            `- ${arch.planType === "creative" ? `${workDir}/factcheck.md и ${workDir}/source.json` : `${dailyDir}/operator-research/sources-index.json`}`,
            "",
            "Задача:",
            "1. Скачай и сохрани первичные HTML-страницы источников из брифа (если PDF > 5 МБ или 403/404 — используй Airouter Perplexity для поиска доступных авторитетных HTML-источников).",
            "2. Подготовь чистый factcheck.md / список проверяемых фактов с реальными URL и цитатами. Никаких правок в shots.json, rights.json, script.json или scripts/*.mjs!",
            "3. Верни результат через bb_workflow_result.",
          ].join("\n"),
          { phase: "Parallel Asset Production", schema: researchSchema },
        ),

      // Поток B: Media Hunter (Gemini 4 Neon — фото места, SHA-1, лицензии, visual-material)
      () =>
        arch.assetsAlreadyReady
          ? Promise.resolve({
              value: { ok: true, distinctPlacePhotos: arch.placePhotosFeasibleCount || 3, commonsRequestsUsed: 0, summary: "visual-material уже подтверждён на диске" },
              selected: { provider: "cache", model: "disk", family: "cache" },
            })
          : runRole(
              "visual",
              "assets:media-hunter",
              [
                `Роль: Media & Rights Hunter. Рабочий каталог: ${creativeRoot}. Дата: ${date}. Тип: ${arch.planType}.`,
                `Контракт выпуска: прочитай ${briefPath}.`,
                COMMON_RULES,
                "",
                "ЗОНА ВЛАДЕНИЯ (трогай ТОЛЬКО медиа и реестр прав):",
                `- ${arch.planType === "creative" ? `${workDir}/media/ и ${workDir}/rights.json` : `${runDir}/prepared.json (только stops[0].photos) и кэш фото`}`,
                `- ${dailyDir}/operator-research/commons-search.json`,
                "",
                "Задача:",
                "1. Через Wikimedia Commons API (User-Agent: OtgolosokShorts/1.0 (https://otgolosok.online), пауза >= 1 с, <= 15 запросов) подбери МИНИМУМ 3 РАЗНЫХ свободно лицензированных фото ИМЕННО МЕСТА (фасады, ракурсы, детали здания/улицы — без веток, дублей, вывесок и PastVu) + необходимые иллюстрации по брифу.",
                "2. Скачай оригиналы, сверь реальные SHA-1/SHA-256 и свободные лицензии (CC0, CC BY, CC BY-SA, Public domain), заполни rights.json (или stops[0].photos).",
                "3. Если в Commons физически нет 3 разных свободных фото места — верни candidateUnfit: true (не пытайся протащить 1 фасад + портреты!).",
                "4. Прогони штатный ensureVisualMaterial (до 2 попыток), если visual-material.json ещё не готов.",
                "5. НЕ редактируй script.json, factcheck.md и scripts/*.mjs. Верни результат через bb_workflow_result.",
              ].join("\n"),
              { phase: "Parallel Asset Production", schema: mediaSchema },
            ),

      // Поток C: Scriptwriter (Codex 6.1 Sol -> Antigravity Sonnet 5.5 — сценарий и упаковка)
      () =>
        arch.scriptAlreadyReady
          ? Promise.resolve({
              value: { ok: true, scriptPresent: true, summary: "script.json уже подтверждён на диске" },
              selected: { provider: "cache", model: "disk", family: "cache" },
            })
          : runRole(
              "worker",
              "assets:scriptwriter",
              [
                `Роль: Scriptwriter & Packaging Author. Рабочий каталог: ${creativeRoot}. Дата: ${date}. Тип: ${arch.planType}.`,
                `Контракт выпуска: прочитай ${briefPath}.`,
                COMMON_RULES,
                "",
                "ЗОНА ВЛАДЕНИЯ (трогай ТОЛЬКО сценарий и упаковку):",
                `- ${arch.planType === "creative" ? `${workDir}/script.json, ${workDir}/publish.json, ${workDir}/caption-groups.json` : `${runDir}/script.json`}`,
                "",
                "Задача:",
                "1. Подготовь сценарий строго по episode-brief.json и подтверждённым фактам: полные имена людей (без инициалов!), без упоминания сторонних сайтов как источников, сильный крючок в первых 3 с, ясная развязка обещания, маршрутный финал 10–15 с и вопрос с выбором.",
                `2. Для plan.type === "creative" используй штатный prepareCreative / reviewAndRepairCreativeDraft (не трогая неизменяемый архив ${workDir}/creative-draft-audits/), чтобы появились ${workDir}/script.json, ${workDir}/auto-prepared.json и симлинк ${runDir}/script.json -> ${workDir}/script.json.`,
                "3. НЕ редактируй media/, rights.json и scripts/*.mjs. Если есть баг в скриптах — верни codeBug. Верни результат через bb_workflow_result.",
              ].join("\n"),
              { phase: "Parallel Asset Production", schema: scriptSchema },
            ),
    ]);

    const [resResearch, resMedia, resScript] = fanoutResults;
    const bugFromFanout =
      (resResearch && resResearch.value && resResearch.value.codeBug) ||
      (resMedia && resMedia.value && resMedia.value.codeBug) ||
      (resScript && resScript.value && resScript.value.codeBug) ||
      null;

    if (bugFromFanout) {
      return blockedResult("parallel-assets", "code_bug", `Баг конвейера на Parallel Asset Production: ${bugFromFanout.symptom}`, {
        codeBug: bugFromFanout,
      });
    }
    if (resMedia && resMedia.value && resMedia.value.candidateUnfit) {
      return blockedResult(
        "parallel-assets",
        "candidate_unfit",
        `Media Hunter не нашёл >= 3 разных свободных фото места: ${resMedia.value.summary}`,
      );
    }
  } else {
    log("Assets and script already verified on disk; skipping Parallel Asset Production fan-out.");
  }

  const assetsVerifyRun = await runRole(
    "light",
    "assets:verify-disk",
    [
      `Независимая сверка ассетов после Parallel Asset Production в ${creativeRoot} для ${date} (тип ${arch.planType}).`,
      COMMON_RULES,
      "",
      arch.planType === "creative"
        ? `1. Проверь на диске ${dailyDir}/plan.json (type === "creative"), ${runDir}/visual-material.json (ok===true, score>=7, distinctSubjects>=3, covered>=3), ${runDir}/script.json, ${workDir}/script.json, ${workDir}/auto-prepared.json и ${workDir}/script-review.json.`
        : `1. Проверь на диске ${dailyDir}/plan.json (type === "normal"), ${runDir}/visual-material.json (ok===true, score>=7, distinctSubjects>=3, covered>=3) и ${runDir}/script.json. Creative-пакет в ${workDir}/ для типа normal НЕ требуется и его отсутствие НЕ является блокером.`,
      `2. Запусти детерминированный pre-gate: node scripts/episode-pregate.mjs ${arch.planType === "creative" ? workDir : runDir} --mode ${arch.planType} --allow-missing-preproduction-input`,
      "3. Верни точный статус (verified, visualMaterialOk, scriptPresent, pregateOk, blockers) через bb_workflow_result.",
    ].join("\n"),
    {
      phase: "Parallel Asset Production",
      schema: verifyAssetsSchema,
      preferAlternate: true,
    },
  );
  const assetsVerify = assetsVerifyRun.value;

  if (!assetsVerify.verified || !assetsVerify.visualMaterialOk || !assetsVerify.scriptPresent) {
    return blockedResult(
      "parallel-assets",
      "editorial_blocker",
      `Parallel Asset Production не прошёл проверку на диске: ${assetsVerify.reason}`,
    );
  }

  // ==================== PHASE 4: PRE-GATE & CROSS-FAMILY REVIEW ====================
  phase("Pre-Gate & Cross-Family Review");

  const earlySchema = {
    type: "object",
    required: ["earlyOk", "pregateOk", "passedStages", "failedStages", "summary"],
    additionalProperties: false,
    properties: {
      earlyOk: { type: "boolean" },
      pregateOk: { type: "boolean" },
      passedStages: { type: "array", items: { type: "string" } },
      failedStages: { type: "array", items: { type: "string" } },
      correctionsSummary: { type: "string", nullable: true },
      candidateUnfit: { type: "boolean" },
      codeBug: codeBugSchema,
      summary: { type: "string" },
    },
  };

  const reviewEarlySchema = {
    type: "object",
    required: ["verified", "earlyOk", "scriptsClean", "failedStages", "blockingFindings", "reason"],
    additionalProperties: false,
    properties: {
      verified: { type: "boolean" },
      earlyOk: { type: "boolean" },
      scriptsClean: { type: "boolean" },
      failedStages: { type: "array", items: { type: "string" } },
      blockingFindings: { type: "array", items: { type: "string" } },
      reason: { type: "string" },
    },
  };

  let earlyPassed = false;
  let lastEarly = null;
  let lastEarlyReview = null;

  for (let attempt = 1; attempt <= maxEarlyAttempts; attempt += 1) {
    const onlyVisualLeft =
      lastEarlyReview &&
      lastEarlyReview.failedStages.length > 0 &&
      lastEarlyReview.failedStages.every((s) => s === "raw-photo" || s === "composed-frame");

    let role = "worker";
    if (attempt === maxEarlyAttempts && attempt > 1) {
      role = "architect";
    } else if (onlyVisualLeft) {
      role = "visual";
    }

    const prevFeedback = lastEarlyReview
      ? [
          `Попытка ${attempt} из ${maxEarlyAttempts}.`,
          `Предыдущий ревьювер выявил failedStages=${JSON.stringify(lastEarlyReview.failedStages)}.`,
          `Исчерпывающий пакет замечаний для пакетного исправления: ${JSON.stringify(lastEarlyReview.blockingFindings)} (${lastEarlyReview.reason})`,
          "ВАЖНО: исправь ВЕСЬ список замечаний за один проход и сохрани уже пройденные этапы в кэше (НЕ меняй речь/описание, если text и packaging уже passed; НЕ меняй исходные фото, если raw-photo уже passed).",
        ].join("\n")
      : `Попытка 1 из ${maxEarlyAttempts}: свяжи артефакты (shots.json, preproduction-input.json, source-verification.json), пройди детерминированный pre-gate и запусти --phase early.`;

    const targetDir = arch.planType === "creative" ? workDir : runDir;
    const earlyRun = await runRole(
      role,
      `early:attempt-${attempt}-${role}`,
      [
        `Рабочий каталог: ${creativeRoot}. Выпуск: ${date}. Тип: ${arch.planType}. targetDir: ${targetDir}.`,
        COMMON_RULES,
        "",
        prevFeedback,
        "",
        "Жёсткий порядок работы (сначала бесплатный pre-gate, потом LLM-аудит!):",
        `1. Убедись, что LaunchAgent ${launchLabel} остановлен (launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/${launchLabel}.plist 2>/dev/null || true).`,
        `2. Проверь ${targetDir}/preproduction-early.json: если ok === true и все 4 этапа (text, packaging, raw-photo, composed-frame) уже прошли — НЕ перезаписывай артефакты, только прогони pre-gate и верни earlyOk: true; если ok === false — прочитай error.corrections и пакетно закрой все замечания (включая недостающие первичные источники в evidence/sources/ и обновление SHA-привязок).`,
        `3. Собери/исправь согласованный пакет данных выпуска (строго внутри data/daily/${date}/ и data/work/auto-${date}/; редактировать scripts/*.mjs ЗАПРЕЩЕНО!).`,
        `4. ОБЯЗАТЕЛЬНО запусти детерминированный pre-gate ПЕРЕД вызовом preproduction-review:`,
        `   node scripts/episode-pregate.mjs ${targetDir} --mode ${arch.planType}`,
        "   Устрани ВСЕ блокеры pre-gate (>=3 разных фото места, не более 2 однотипных повторов одного медиа, отсутствие инициалов и ссылок на сторонние сайты, валидные SHA-1/лицензии, согласованность tagged/display и route/viewer) ДО запуска LLM-ревью!",
        `5. Только после зелёного pre-gate запусти ровно ОДИН (максимум 2) штатный прогон:`,
        arch.planType === "creative"
          ? `   node --env-file-if-exists=${shortsRoot}/.env --env-file-if-exists=${creativeRoot}/../otgolosok/.env scripts/preproduction-review.mjs ${workDir} --phase early`
          : `   node --env-file-if-exists=${shortsRoot}/.env --env-file-if-exists=${creativeRoot}/../otgolosok/.env scripts/normal-preproduction.mjs ${date} --phase early`,
        "6. НЕ крути бесконечные циклы (>2 прогонов preproduction-review за шаг запрещено!). Если упёрся в баг скрипта — верни codeBug; если у кандидата нет 3 фото места — верни candidateUnfit: true.",
        "7. Верни структурированный отчёт через bb_workflow_result.",
      ].join("\n"),
      {
        phase: "Pre-Gate & Cross-Family Review",
        schema: earlySchema,
      },
    );
    lastEarly = earlyRun.value;

    if (lastEarly.codeBug) {
      return blockedResult("early-preproduction", "code_bug", `Баг конвейера на Early Preproduction: ${lastEarly.codeBug.symptom}`, {
        codeBug: lastEarly.codeBug,
      });
    }
    if (lastEarly.candidateUnfit) {
      return blockedResult("early-preproduction", "candidate_unfit", `Кандидат непригоден по визуалу: ${lastEarly.summary}`);
    }

    // Независимый кросс-семейный Reviewer (исключаем семью исполнителя!)
    const reviewRun = await runRole(
      "reviewer",
      `early:cross-family-review-${attempt}`,
      [
        `Роль: Independent Cross-Family Reviewer (READ-ONLY — НЕ редактируй файлы!). Рабочий каталог: ${creativeRoot}. Выпуск: ${date} (${arch.planType}).`,
        COMMON_RULES,
        "",
        "Проверь НАПРЯМУЮ НА ДИСКЕ:",
        `1. Запусти node scripts/episode-pregate.mjs ${targetDir} --mode ${arch.planType} и убедись, что детерминированный pre-gate зелёный (0 блокеров).`,
        `2. Прочитай ${targetDir}/preproduction-early.json: проверь ok === true и статус всех 4 этапов (text, packaging, raw-photo, composed-frame) — у всех ok === true, оценки >= 7, corrections пустой.`,
        `3. Проверь git -C ${creativeRoot} diff -- scripts/: контентные воркеры НЕ должны были править scripts/*.mjs и хардкодить выпуск (scriptsClean).`,
        "4. Если есть отказ — собери ИСЧЕРПЫВАЮЩИЙ конкретный список blockingFindings (с файлами/шотами/строками), чтобы исполнитель исправил всё за 1 пакетный проход.",
        `Отчёт исполнителя: ${JSON.stringify(lastEarly)}`,
      ].join("\n"),
      {
        phase: "Pre-Gate & Cross-Family Review",
        schema: reviewEarlySchema,
        excludeFamily: earlyRun.selected.family,
      },
    );
    lastEarlyReview = reviewRun.value;

    if (lastEarlyReview.verified && lastEarlyReview.earlyOk && lastEarlyReview.scriptsClean) {
      earlyPassed = true;
      break;
    }
    log(
      `Early attempt ${attempt} not green: failed=${JSON.stringify(lastEarlyReview.failedStages)}, scriptsClean=${lastEarlyReview.scriptsClean} (${lastEarlyReview.reason})`,
    );
  }

  if (!earlyPassed) {
    const bClass = lastEarlyReview && !lastEarlyReview.scriptsClean ? "code_bug" : "editorial_blocker";
    return blockedResult(
      "early-preproduction",
      bClass,
      `Early Preproduction не прошёл за ${maxEarlyAttempts} попыток: ${lastEarlyReview ? lastEarlyReview.reason : "unknown"}`,
    );
  }

  // ==================== PHASE 5: LOCKED RENDER & AUDIT ====================
  phase("Locked Render & Audit");

  const phase2Schema = {
    type: "object",
    required: ["ok", "measuredOk", "promoReviewReady", "audioQcOk", "blockClass", "summary"],
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
      measuredOk: { type: "boolean" },
      promoReviewReady: { type: "boolean" },
      audioQcOk: { type: "boolean" },
      blockClass: {
        enum: ["none", "code_bug", "infra", "editorial_blocker", "audio_defect"],
      },
      codeBug: codeBugSchema,
      videoPath: { type: "string", nullable: true },
      videoSha256: { type: "string", nullable: true },
      coverPath: { type: "string", nullable: true },
      durableStatus: { type: "string", nullable: true },
      errorSummary: { type: "string", nullable: true },
      summary: { type: "string" },
    },
  };

  const phase2Prompt = [
    `Рабочий каталог: ${creativeRoot}. Выпуск: ${date}. Тип: ${arch.planType}. runDir: ${runDir}. workDir: ${workDir}.`,
    "Ранний допуск (preproduction-early.json) и детерминированный pre-gate УЖЕ ПРОЙДЕНЫ.",
    COMMON_RULES,
    "",
    "ЖЁСТКОЕ ПРАВИЛО ЗАМОРОЗКИ КОНТЕНТА (LOCKED RENDER):",
    "- На этой фазе ЗАПРЕЩЕНО менять script.json, shots.json, rights.json, publish.json и сбрасывать кэш preproduction-early.json!",
    "- Если финальный аудит выявил редакционный блокер, баг скрипта или сбой окружения (например, BROWSER_ENVIRONMENT_UNAVAILABLE) — НЕ откатывай выпуск на 4 этапа назад и НЕ правь scripts/*.mjs: остановись и верни точный blockClass (code_bug / infra / audio_defect / editorial_blocker) и codeBug.",
    "",
    "Задача Locked Render & Audit (без публикации на YouTube!):",
    arch.planType === "creative"
      ? `1. Запусти сборку через штатный scripts/build-for-slot.mjs ${dailyDir}/plan.json (или scripts/pipeline.mjs ${workDir} --replace-composition + creativeReview): озвучка ElevenLabs v4 (model: eleven_v4, голос «Отголосок2»), ${workDir}/preproduction-measured.json (ok: true), полный рендер ${workDir}/hype.mp4 (1080x1920, >45 с, финал 10–15 с) + обложки cover.jpg/cover.png, финальный аудит ${workDir}/creative-review.json (verdict === "ready", оценки >= 7, все checks passed) и ${workDir}/creative-final-audio-qc.json (ok: true), запись ${dailyDir}/built.json (local-only).`
      : `1. Синхронизируй чекпойнты prepare/script с актуальными файлами и собери выпуск: озвучка ElevenLabs v4 (model: eleven_v4, голос «Отголосок2»), preproduction-measured (--phase measured), полный рендер ${runDir}/promo-video.mp4 (1080x1920) + обложка youtube-cover.jpg, финальный аудит ${runDir}/promo-review.json (verdict === "ready", оценки >= 7) и ${dailyDir}/audio-qc.json (ok: true).`,
    "2. При исчерпании квоты (HTTP 429 / CODEX_QUOTA) локальной подписки сначала переключайся на Airouter Pool (scripts/codex-pool-repair.mjs / Airouter Pool), и только потом — прямой Airouter (лимит тела <= 9 МБ), сохраняя уже озвученные клипы ElevenLabs.",
    `3. После успешной локальной сборки прогони финальную сверку Pi Durable (npm run video:durable -- ${date}) без публикации, чтобы зафиксировать ${dailyDir}/durable/status.json -> approved.`,
    "4. Верни структурированный отчёт через bb_workflow_result (обязательно videoPath, videoSha256, coverPath, durableStatus, blockClass).",
  ].join("\n");

  let phase2Run = await runRole("worker", "phase2:locked-render-and-audit", phase2Prompt, {
    phase: "Locked Render & Audit",
    schema: phase2Schema,
  });
  phase2 = phase2Run.value;

  if (phase2.codeBug || phase2.blockClass === "code_bug") {
    return blockedResult("locked-render", "code_bug", `Баг конвейера на Locked Render: ${(phase2.codeBug && phase2.codeBug.symptom) || phase2.errorSummary || phase2.summary}`, {
      codeBug: phase2.codeBug,
      videoPath: phase2.videoPath,
      videoSha256: phase2.videoSha256,
      coverPath: phase2.coverPath,
      durableStatus: phase2.durableStatus,
    });
  }

  if (phase2.blockClass === "infra") {
    return blockedResult("locked-render", "infra", `Инфраструктурный блокер на Locked Render: ${phase2.errorSummary || phase2.summary}`, {
      videoPath: phase2.videoPath,
      videoSha256: phase2.videoSha256,
      coverPath: phase2.coverPath,
      durableStatus: phase2.durableStatus,
    });
  }

  // Эскалируем на architect только при audio_defect или локальной проблеме рендера/аудита (без сброса контента и без правок кода)
  if (!phase2.ok || !phase2.measuredOk || !phase2.promoReviewReady || !phase2.audioQcOk) {
    log(`Locked Render failed (${phase2.blockClass}: ${phase2.errorSummary || phase2.summary}); escalating once to architect`);
    phase2Run = await runRole(
      "architect",
      "phase2:architect-triage",
      [
        phase2Prompt,
        "",
        `Предыдущая попытка Locked Render завершилась с проблемой: ${JSON.stringify(phase2)}`,
        "Диагностируй причину (переозвучка проблемной реплики при audio_defect, ре-рендер или фиксация точного codeBug/editorial_blocker). По-прежнему ЗАПРЕЩЕНО править scripts/*.mjs и бесконечно откатывать early-кэш.",
      ].join("\n"),
      {
        phase: "Locked Render & Audit",
        schema: phase2Schema,
      },
    );
    phase2 = phase2Run.value;

    if (phase2.codeBug || phase2.blockClass === "code_bug") {
      return blockedResult("locked-render", "code_bug", `Баг конвейера выявлен архитектором: ${(phase2.codeBug && phase2.codeBug.symptom) || phase2.errorSummary || phase2.summary}`, {
        codeBug: phase2.codeBug,
        videoPath: phase2.videoPath,
        videoSha256: phase2.videoSha256,
        coverPath: phase2.coverPath,
        durableStatus: phase2.durableStatus,
      });
    }
  }
}

// ==================== PHASE 6: FINAL GATE ====================
phase("Final Gate");

const finalGateSchema = {
  type: "object",
  required: ["approved", "summary"],
  additionalProperties: false,
  properties: {
    approved: { type: "boolean" },
    videoPath: { type: "string", nullable: true },
    videoSha256: { type: "string", nullable: true },
    coverPath: { type: "string", nullable: true },
    durableStatus: { type: "string", nullable: true },
    checksSummary: { type: "string", nullable: true },
    issues: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
};

const finalGateRun = await runRole(
  "light",
  "final-gate:independent-verify",
  [
    `Независимая финальная верификация выпуска ${date} в ${creativeRoot}.`,
    COMMON_RULES,
    "",
    "Проверь всё НАПРЯМУЮ НА ДИСКЕ:",
    `1. Прочитай plan.type в ${dailyDir}/plan.json:`,
    `   - normal: видео ${runDir}/promo-video.mp4, микс ${runDir}/mix.wav, обложка ${runDir}/youtube-cover.jpg, аудит ${runDir}/promo-review.json, preproduction ${runDir}/preproduction-early.json и ${runDir}/preproduction-measured.json, audio QC ${dailyDir}/audio-qc.json.`,
    `   - creative: видео ${workDir}/hype.mp4, микс ${workDir}/mix.wav, обложка ${workDir}/cover.jpg, аудит ${workDir}/creative-review.json (review.verdict === "ready"), preproduction ${workDir}/preproduction-early.json и ${workDir}/preproduction-measured.json, audio QC ${workDir}/creative-final-audio-qc.json.`,
    `2. Посчитай shasum -a 256 для видео и микса. Сверь точное совпадение SHA-256 с ${dailyDir}/built.json, финальным ревью и audio-qc.`,
    "3. Проверь финальный аудит: verdict === \"ready\", все оценки >= 7, все checks passed.",
    "4. Проверь preproduction-early.json (ok: true), preproduction-measured.json (ok: true), audio-qc (ok: true).",
    "5. Проверь провайдера, модель и голос озвучки: elevenlabs / eleven_v4 / «Отголосок2».",
    `6. Проверь ${dailyDir}/durable/status.json === "approved" и ОТСУТСТВИЕ ${dailyDir}/youtube-publish.json.`,
    `7. Проверь git -C ${creativeRoot} diff -- scripts/ на отсутствие хардкода выпуска и незапланированных правок кода.`,
    "8. Верни фактические videoPath, videoSha256, coverPath и durableStatus через bb_workflow_result.",
    `Отчёт Фазы 5: ${JSON.stringify(phase2)}`,
  ].join("\n"),
  {
    phase: "Final Gate",
    schema: finalGateSchema,
    preferAlternate: true,
  },
);
const finalGate = finalGateRun.value;

if (!finalGate.approved) {
  return blockedResult(
    "final-gate",
    phase2.blockClass && phase2.blockClass !== "none" ? phase2.blockClass : "editorial_blocker",
    `Финальная сверка выявила проблемы: ${(finalGate.issues || []).join("; ") || finalGate.summary}`,
    {
      videoPath: finalGate.videoPath || phase2.videoPath || null,
      videoSha256: finalGate.videoSha256 || phase2.videoSha256 || null,
      coverPath: finalGate.coverPath || phase2.coverPath || null,
      durableStatus: finalGate.durableStatus || phase2.durableStatus || null,
    },
  );
}

if (!publishScheduled) {
  return {
    status: "approved",
    date,
    stage: "final-gate",
    blockClass: "none",
    codeBug: null,
    summary: finalGate.summary,
    videoPath: finalGate.videoPath || `${runDir}/promo-video.mp4`,
    videoSha256: finalGate.videoSha256 || phase2.videoSha256 || null,
    coverPath: finalGate.coverPath || `${runDir}/youtube-cover.jpg`,
    durableStatus: finalGate.durableStatus || "approved",
    youtubeVideoId: null,
    youtubeUrl: null,
    publishAt: null,
    youtubePublishReceipt: null,
    modelAudit,
  };
}

// ==================== PHASE 7: SCHEDULED YOUTUBE PUBLISH ====================
phase("Scheduled YouTube Publish");

const publishSchema = {
  type: "object",
  required: ["ok", "summary"],
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    videoId: { type: "string", nullable: true },
    url: { type: "string", nullable: true },
    publishAt: { type: "string", nullable: true },
    privacyStatus: { type: "string", nullable: true },
    processingStatus: { type: "string", nullable: true },
    receiptPath: { type: "string", nullable: true },
    errorSummary: { type: "string", nullable: true },
    summary: { type: "string" },
  },
};

const verifyPublishSchema = {
  type: "object",
  required: ["verified", "summary"],
  additionalProperties: false,
  properties: {
    verified: { type: "boolean" },
    videoId: { type: "string", nullable: true },
    url: { type: "string", nullable: true },
    publishAt: { type: "string", nullable: true },
    receiptPath: { type: "string", nullable: true },
    issues: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
};

const publishTargetInstruction = explicitPublishAt
  ? `Используй явно переданное время отложенной публикации: ${explicitPublishAt}.`
  : `Прочитай время слота slotAt из ${dailyDir}/plan.json (обычно 17:30Z для Пн–Чт = 20:30 МСК или 18:30Z для Пт–Вс = 21:30 МСК).`;

const publishPrompt = [
  `Рабочий каталог: ${creativeRoot}. Целевая дата выпуска (МСК): ${date}.`,
  "Final Gate ПРОЙДЕН (durable/status.json === approved). Теперь разрешена ТОЛЬКО отложенная публикация (private + publishAt).",
  "СТРОГИЕ ПРАВИЛА ЭТАПА ПУБЛИКАЦИИ:",
  "- НЕ запускай немедленную публикацию (--privacy public ЗАПРЕЩЁН). Только --publish-at с будущим временем в ISO-8601 с часовым поясом.",
  "- НИКОГДА не выводи и не записывай секреты, токены и API-ключи в stdout, логи и файлы.",
  "- НИКОГДА не подделывай квитанции и не повторяй загрузку вслепую при наличии videoId в state.sqlite или upload.json.",
  "",
  "Порядок работы:",
  `1. ${publishTargetInstruction} Убедись, что выбранный publishAt строго в будущем (Date.parse(publishAt) > Date.now()); если время слота уже прошло — НЕ публикуй немедленно, верни ok: false с явным блокером.`,
  `2. Проверь plan.type в ${dailyDir}/plan.json:`,
  `   - Для plan.type === "normal": node --env-file-if-exists=${shortsRoot}/.env --env-file-if-exists=${creativeRoot}/../otgolosok/.env scripts/publish-daily.mjs ${date} --publish-at <publishAt>`,
  `   - Для plan.type === "creative": scripts/publish.mjs с CREATIVE_PLAN_FILE=${dailyDir}/plan.json и аргументами <plan.work> <publishAt> (TOKFILE=${shortsRoot}/data/secrets/youtube-token.json), затем запиши подтверждённую квитанцию ${dailyDir}/youtube-publish.json.`,
  `3. Убедись, что скрипт завершился с кодом 0, подтвердил загрузку, установку обложки после processingStatus === "succeeded", настройки канала (плейлист «Москва», containsSyntheticMedia: false) и записал ${dailyDir}/youtube-publish.json со status === "confirmed".`,
  "4. Верни структурированный итог через bb_workflow_result.",
].join("\n");

let publishRun = await runRole("worker", "publish:youtube-scheduled", publishPrompt, {
  phase: "Scheduled YouTube Publish",
  schema: publishSchema,
});
let published = publishRun.value;

if (!published.ok || !published.videoId) {
  log(`Scheduled publish failed on worker (${published.errorSummary || published.summary}); escalating to architect`);
  publishRun = await runRole(
    "architect",
    "publish:architect-repair",
    [
      publishPrompt,
      "",
      `Предыдущая попытка отложенной публикации завершилась ошибкой: ${JSON.stringify(published)}`,
      "Диагностируй причину (проверь state.sqlite, upload.json, youtube-publish.json и список загрузок канала, чтобы исключить дубль на YouTube). Если блокер требует участия владельца (протух refresh_token или время слота уже прошло), верни ok: false без обходов.",
    ].join("\n"),
    {
      phase: "Scheduled YouTube Publish",
      schema: publishSchema,
    },
  );
  published = publishRun.value;
}

const publishVerifyRun = await runRole(
  "light",
  "publish:verify-readback",
  [
    `Независимая кросс-семейная проверка отложенной публикации на YouTube для ${date} в ${creativeRoot}.`,
    "Проверь НАПРЯМУЮ НА ДИСКЕ:",
    `1. Существует ли ${dailyDir}/youtube-publish.json со status === "confirmed" и channel.id === "UC6iI4xswk8MOTld9b1mL4GQ".`,
    `2. Совпадает ли videoSha256 в youtube-publish.json с фактическим shasum -a 256 ${finalGate.videoPath || `${runDir}/promo-video.mp4`}.`,
    "3. Проверь поля remote и settings в youtube-publish.json: remote.status.privacyStatus === \"private\", remote.status.publishAt задано и совпадает с requestedPublishAt, remote.processingDetails.processingStatus === \"succeeded\", thumbnail.processingStatus === \"succeeded\" и thumbnail.thumbnailSetAt не пустой, settings.playlistTitle === \"Москва\", settings.containsSyntheticMedia === false.",
    `Отчёт публикации: ${JSON.stringify(published)}`,
  ].join("\n"),
  {
    phase: "Scheduled YouTube Publish",
    schema: verifyPublishSchema,
    excludeFamily: publishRun.selected.family,
  },
);
const publishVerify = publishVerifyRun.value;

if (!published.ok || !publishVerify.verified) {
  return blockedResult(
    "scheduled-publish",
    "publish_blocker",
    `Отложенная публикация на YouTube не подтверждена: ${(publishVerify.issues || []).join("; ") || published.errorSummary || publishVerify.summary}`,
    {
      videoPath: finalGate.videoPath || `${runDir}/promo-video.mp4`,
      videoSha256: finalGate.videoSha256 || phase2.videoSha256 || null,
      coverPath: finalGate.coverPath || `${runDir}/youtube-cover.jpg`,
      durableStatus: finalGate.durableStatus || "approved",
      youtubeVideoId: publishVerify.videoId || published.videoId || null,
      youtubeUrl: publishVerify.url || published.url || null,
      publishAt: publishVerify.publishAt || published.publishAt || null,
      youtubePublishReceipt: publishVerify.receiptPath || published.receiptPath || null,
    },
  );
}

return {
  status: "published",
  date,
  stage: "scheduled-publish",
  blockClass: "none",
  codeBug: null,
  summary: publishVerify.summary,
  videoPath: finalGate.videoPath || `${runDir}/promo-video.mp4`,
  videoSha256: finalGate.videoSha256 || phase2.videoSha256 || null,
  coverPath: finalGate.coverPath || `${runDir}/youtube-cover.jpg`,
  durableStatus: finalGate.durableStatus || "approved",
  youtubeVideoId: publishVerify.videoId || published.videoId || null,
  youtubeUrl: publishVerify.url || published.url || null,
  publishAt: publishVerify.publishAt || published.publishAt || null,
  youtubePublishReceipt: publishVerify.receiptPath || published.receiptPath || `${dailyDir}/youtube-publish.json`,
  modelAudit,
};

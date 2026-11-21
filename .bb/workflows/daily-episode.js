export const meta = {
  name: "daily-episode",
  description:
    "Оркестрация ежедневной сборки выпуска Отголоска (Preflight -> Selection & Visual -> Early Preproduction -> Phase 2 Render & Audit -> Final Gate) с цепочками фолбэк-моделей и независимой верификацией каждого этапа.",
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
        maximum: 5,
        description: "Максимум попыток прохождения --phase early до возврата блокера",
      },
      allowSecondSameDayAfterHours: {
        type: "integer",
        minimum: 1,
        maximum: 24,
        description: "Минимальная разница в часах для второго выпуска в ту же дату МСК",
      },
      modelChains: {
        type: "object",
        required: ["light", "worker", "visual", "architect"],
        additionalProperties: false,
        properties: {
          light: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["provider", "model", "reasoningLevel"],
              additionalProperties: false,
              properties: {
                provider: { type: "string", minLength: 1 },
                model: { type: "string", minLength: 1 },
                reasoningLevel: { type: "string", minLength: 1 },
              },
            },
          },
          worker: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["provider", "model", "reasoningLevel"],
              additionalProperties: false,
              properties: {
                provider: { type: "string", minLength: 1 },
                model: { type: "string", minLength: 1 },
                reasoningLevel: { type: "string", minLength: 1 },
              },
            },
          },
          visual: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["provider", "model", "reasoningLevel"],
              additionalProperties: false,
              properties: {
                provider: { type: "string", minLength: 1 },
                model: { type: "string", minLength: 1 },
                reasoningLevel: { type: "string", minLength: 1 },
              },
            },
          },
          architect: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["provider", "model", "reasoningLevel"],
              additionalProperties: false,
              properties: {
                provider: { type: "string", minLength: 1 },
                model: { type: "string", minLength: 1 },
                reasoningLevel: { type: "string", minLength: 1 },
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
        enum: ["approved", "already_done", "blocked"],
      },
      date: { type: "string" },
      stage: { type: "string" },
      summary: { type: "string" },
      videoPath: { type: "string", nullable: true },
      videoSha256: { type: "string", nullable: true },
      coverPath: { type: "string", nullable: true },
      durableStatus: { type: "string", nullable: true },
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
            fallbacks: { type: "integer" },
          },
        },
      },
    },
  },
  phases: [
    { title: "Preflight", detail: "Проверка YouTube OAuth, слота и независимая верификация" },
    { title: "Selection & Visual", detail: "Запуск durable, выбор сюжета, поиск Commons/Perplexity и visual-material >= 7" },
    { title: "Early Preproduction", detail: "Сборка early-пакета и прохождение text/packaging/raw-photo/composed-frame" },
    { title: "Phase 2 Render & Audit", detail: "Озвучка ElevenLabs v4, measured-frame, рендер MP4, promo-review и audio-qc" },
    { title: "Final Gate", detail: "Независимая сверка SHA-256, квитанций, тестов и статуса approved" },
  ],
};

const date = args.date;
const creativeRoot = args.creativeRoot || "/Users/user/projects/ai/otgolosok-creative";
const shortsRoot = args.shortsRoot || "/Users/user/projects/ai/otgolosok-shorts";
const maxEarlyAttempts = args.maxEarlyAttempts || 3;
const minHoursGap = args.allowSecondSameDayAfterHours || 8;
const dailyDir = `${creativeRoot}/data/daily/${date}`;
const runDir = `${dailyDir}/shorts/runs/tomorrow-${date}`;
const launchLabel = `online.otgolosok.creative-durable-${date}`;
const modelAudit = [];

const COMMON_RULES = [
  "СТРОГИЕ ПРАВИЛА ПРОЕКТА:",
  "- Автоматическая публикация на YouTube ЗАПРЕЩЕНА (youtube-publish.json не создавать).",
  "- НИКОГДА не выводи и не записывай секреты, токены и API-ключи в stdout, логи и файлы.",
  "- НИКОГДА не редактируй вручную квитанции проверок (visual-material.json, preproduction-*.json, promo-review.json, audio-qc.json), не занижай пороги (<7/10) и не обходи гейты.",
  "- НИКОГДА не вызывай agentapi, сторонние локальные демоны Antigravity или прокси — используй только штатные CLI, node, python3, curl и скрипты проекта.",
  "- В общих скриптах otgolosok-creative/scripts/*.mjs ЗАПРЕЩЕНО хардкодить сюжетные строки, имена, адреса, плашки обложек и фразы субтитров конкретного выпуска — храни их только в data/daily/" + date + "/.",
  "- При запросах к Wikimedia Commons API всегда передавай User-Agent: OtgolosokShorts/1.0 (https://otgolosok.online), делай паузу >= 1 с, не больше 15 API-запросов, проверяй свободные лицензии (CC0, CC BY, CC BY-SA, Public domain) и реальный SHA-1 файлов (без PastVu).",
  "- Для поиска первичных источников и альтернативных HTML-страниц разрешено использовать Airouter Perplexity (соблюдая лимит тела запроса 9 000 000 байт; после HTTP 413 не повторять без уменьшения тела).",
  "- Озвучка ТОЛЬКО ElevenLabs v4 (provider: elevenlabs, model: eleven_v4, голос «Отголосок2»). В речи людей называть полным именем и фамилией (без инициалов) и не упоминать сторонние сайты как источники.",
  "- По завершении ОБЯЗАТЕЛЬНО верни структурированный результат через инструмент bb_workflow_result.",
].join("\n");

async function invokeLiteralAgent(spec, prompt, stepLabel, phaseName, schema) {
  const key = `${spec.provider}/${spec.model}/${spec.reasoningLevel}`;
  switch (key) {
    case "acp-antigravity-acp/gemini-4-neon/high":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "acp-antigravity-acp",
        model: "gemini-4-neon",
        reasoningLevel: "high",
      });
    case "acp-antigravity-acp/gemini-4-neon/xhigh":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "acp-antigravity-acp",
        model: "gemini-4-neon",
        reasoningLevel: "xhigh",
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
    case "claude-code/claude-haiku-4-5-20251001/low":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "claude-code",
        model: "claude-haiku-4-5-20251001",
        reasoningLevel: "low",
      });
    case "claude-code/claude-sonnet-5-5/medium":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "claude-code",
        model: "claude-sonnet-5-5",
        reasoningLevel: "medium",
      });
    case "claude-code/claude-sonnet-5-5/high":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "claude-code",
        model: "claude-sonnet-5-5",
        reasoningLevel: "high",
      });
    case "codex/gpt-6.2-sol/high":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "codex",
        model: "gpt-6.2-sol",
        reasoningLevel: "high",
      });
    case "codex/gpt-6.2-sol/xhigh":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "codex",
        model: "gpt-6.2-sol",
        reasoningLevel: "xhigh",
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
    case "claude-code/claude-opus-5-5/high":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "claude-code",
        model: "claude-opus-5-5",
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
    case "codex/gpt-6.2-astra/high":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "codex",
        model: "gpt-6.2-astra",
        reasoningLevel: "high",
      });
    case "claude-code/claude-fable-5-1/high":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "claude-code",
        model: "claude-fable-5-1",
        reasoningLevel: "high",
      });
    case "acp-opencode/opencode/big-pickle/medium":
      return await agent(prompt, {
        label: stepLabel,
        phase: phaseName,
        schema: schema,
        provider: "acp-opencode",
        model: "opencode/big-pickle",
        reasoningLevel: "medium",
      });
    default:
      throw new Error(`Unsupported literal model spec in daily-episode workflow: ${key}`);
  }
}

async function runRole(role, stepLabel, prompt, opts = {}) {
  const baseChain = args.modelChains[role] || [];
  if (!baseChain.length) {
    throw new Error(`No models configured for role "${role}"`);
  }
  const chain =
    opts.preferAlternate && baseChain.length > 1
      ? [baseChain[1], baseChain[0], ...baseChain.slice(2)]
      : baseChain;

  let lastErr = null;
  for (let i = 0; i < chain.length; i += 1) {
    const spec = chain[i];
    try {
      const value = await invokeLiteralAgent(spec, prompt, stepLabel, opts.phase, opts.schema);
      modelAudit.push({
        step: stepLabel,
        role,
        provider: spec.provider,
        model: spec.model,
        fallbacks: i,
      });
      return value;
    } catch (err) {
      lastErr = err;
      const msg = err && err.message ? String(err.message).slice(0, 200) : String(err);
      log(
        `[${stepLabel}] fallback (${role}): ${spec.provider}/${spec.model} (${spec.reasoningLevel}) failed: ${msg}`,
      );
    }
  }
  throw lastErr || new Error(`All candidates failed for role "${role}" at step "${stepLabel}"`);
}

// ==================== PHASE 1: PREFLIGHT ====================
phase("Preflight");

const preflightSchema = {
  type: "object",
  required: ["slotFree", "alreadyBuilt", "videosChecked", "readbackPath", "historyPath", "summary"],
  additionalProperties: false,
  properties: {
    slotFree: { type: "boolean" },
    alreadyBuilt: { type: "boolean" },
    videosChecked: { type: "integer", minimum: 0 },
    latestVideoId: { type: "string", nullable: true },
    readbackPath: { type: "string" },
    historyPath: { type: "string" },
    summary: { type: "string" },
  },
};

const verifyPreflightSchema = {
  type: "object",
  required: ["verified", "slotFree", "alreadyBuilt", "reason"],
  additionalProperties: false,
  properties: {
    verified: { type: "boolean" },
    slotFree: { type: "boolean" },
    alreadyBuilt: { type: "boolean" },
    reason: { type: "string" },
  },
};

const preflightPrompt = [
  `Рабочий каталог: ${creativeRoot}. Целевая дата выпуска (МСК): ${date}.`,
  COMMON_RULES,
  "",
  "Задача Preflight:",
  `1. Проверь YouTube-канал UC6iI4xswk8MOTld9b1mL4GQ через РЕАЛЬНЫЙ OAuth-запрос (ключи в ${shortsRoot}/.env, токен в ${shortsRoot}/data/secrets/youtube-token.json; логику посмотри в scripts/yt-stats.mjs). НЕ читай вчерашний readback вместо OAuth!`,
  `2. Создай каталог ${dailyDir}/operator-research/ и запиши свежие файлы:`,
  `   - ${dailyDir}/morning-youtube-readback.json ({"date":"${date}","checkedAt":"<ISO>","channelId":"UC6iI4xswk8MOTld9b1mL4GQ","videosChecked":<N>,"scheduledForDate":[...],"publicOnDate":[...],"note":"..."})`,
  `   - ${dailyDir}/operator-research/youtube-channel-history.json (массив всех видео канала: videoId, title, publishedAt, publishAt, privacyStatus).`,
  `3. Учти правило дедупликации: второй выпуск в ту же московскую дату РАЗРЕШЁН, если разница по времени публикации до слота ${date}T18:30:00Z превышает ${minHoursGap} часов (например, вчерашний ролик вышел после полуночи МСК). Отрази это в поле note.`,
  `4. Проверь, есть ли уже готовые ${dailyDir}/built.json (с валидным MP4 и promo-review ready), ${dailyDir}/youtube-publish.json или запущенный LaunchAgent ${launchLabel}.`,
  "5. Верни точный итог через bb_workflow_result.",
].join("\n");

let preflight = await runRole("light", "preflight:youtube-oauth", preflightPrompt, {
  phase: "Preflight",
  schema: preflightSchema,
});

let preflightCheck = await runRole(
  "light",
  "preflight:verify-disk",
  [
    `Независимая проверка Preflight в ${creativeRoot} для даты ${date}.`,
    COMMON_RULES,
    "",
    "Проверь файлы НА ДИСКЕ (не доверяй тексту отчёта):",
    `1. Существует ли ${dailyDir}/morning-youtube-readback.json, совпадает ли date === "${date}", свежее ли checkedAt (не вчерашнее), и больше ли videosChecked нуля?`,
    `2. Существует ли ${dailyDir}/operator-research/youtube-channel-history.json и содержит ли реальный непустой массив видео?`,
    `3. Существует ли ${dailyDir}/built.json или ${dailyDir}/youtube-publish.json?`,
    `4. Корректно ли определено slotFree (с учётом правила разницы > ${minHoursGap} ч до слота ${date}T18:30:00Z)?`,
    `Отчёт предыдущего агента для сверки: ${JSON.stringify(preflight)}`,
  ].join("\n"),
  {
    phase: "Preflight",
    schema: verifyPreflightSchema,
    preferAlternate: true,
  },
);

if (!preflightCheck.verified) {
  log(`Preflight verification failed (${preflightCheck.reason}); retrying on worker role`);
  preflight = await runRole(
    "worker",
    "preflight:retry-worker",
    preflightPrompt + `\n\nПредыдущая попытка не прошла независимую проверку: ${preflightCheck.reason}`,
    {
      phase: "Preflight",
      schema: preflightSchema,
    },
  );
  preflightCheck = await runRole(
    "light",
    "preflight:verify-disk-2",
    [
      `Повторная независимая проверка файлов Preflight в ${dailyDir} для даты ${date}.`,
      `Проверь morning-youtube-readback.json (date==="${date}", свежий checkedAt, videosChecked>0), youtube-channel-history.json, built.json и youtube-publish.json.`,
      `Отчёт worker: ${JSON.stringify(preflight)}`,
      COMMON_RULES,
    ].join("\n"),
    {
      phase: "Preflight",
      schema: verifyPreflightSchema,
      preferAlternate: true,
    },
  );
}

if (!preflightCheck.verified) {
  return {
    status: "blocked",
    date,
    stage: "preflight",
    summary: `Preflight не прошёл независимую верификацию: ${preflightCheck.reason}`,
    videoPath: null,
    videoSha256: null,
    coverPath: null,
    durableStatus: null,
    modelAudit,
  };
}

if (preflightCheck.alreadyBuilt || !preflightCheck.slotFree) {
  return {
    status: "already_done",
    date,
    stage: "preflight",
    summary: `Сборка не требуется: ${preflightCheck.reason} (${preflight.summary})`,
    videoPath: null,
    videoSha256: null,
    coverPath: null,
    durableStatus: null,
    modelAudit,
  };
}

// ==================== PHASE 2: SELECTION & VISUAL ====================
phase("Selection & Visual");

const selectionSchema = {
  type: "object",
  required: ["visualMaterialOk", "scriptPresent", "placeName", "summary"],
  additionalProperties: false,
  properties: {
    visualMaterialOk: { type: "boolean" },
    visualScore: { type: "integer", minimum: 0, maximum: 10 },
    distinctSubjects: { type: "integer", minimum: 0 },
    coveredBeats: { type: "integer", minimum: 0 },
    scriptPresent: { type: "boolean" },
    placeId: { type: "string", nullable: true },
    placeName: { type: "string" },
    durableCode: { type: "string", nullable: true },
    blocker: { type: "string", nullable: true },
    summary: { type: "string" },
  },
};

const verifyVisualSchema = {
  type: "object",
  required: ["verified", "visualMaterialOk", "scriptPresent", "reason"],
  additionalProperties: false,
  properties: {
    verified: { type: "boolean" },
    visualMaterialOk: { type: "boolean" },
    scriptPresent: { type: "boolean" },
    visualScore: { type: "integer", minimum: 0, maximum: 10 },
    reason: { type: "string" },
  },
};

let selection = await runRole(
  "worker",
  "selection:durable-and-visual",
  [
    `Рабочий каталог: ${creativeRoot}. Целевая дата выпуска (МСК): ${date}.`,
    COMMON_RULES,
    "",
    "Задача Selection & Visual:",
    `1. Если LaunchAgent ${launchLabel} ещё не создан/не запущен — создай ~/Library/LaunchAgents/${launchLabel}.plist по шаблону последнего существующего online.otgolosok.creative-durable-*.plist (заменив дату на ${date}) и запусти через launchctl bootstrap gui/$(id -u). Не создавай дублей supervisor.`,
    `2. Дождись отбора сюжета (${dailyDir}/plan.json с proposal) и первичной проверки visual-material.json.`,
    "3. Если visual-material не прошёл (<7/10, distinctSubjects < 3 или covered < 3):",
    "   - через Wikimedia Commons API (с вежливым User-Agent, паузой >= 1 с, <= 15 запросов) подбери 5–6 разноплановых свободно лицензированных фото без веток и дублей, скачай оригиналы в кеш, сверь SHA-1, обнови stops[0].photos в selected-story.json и prepared.json;",
    "   - параллельно скачай первичные HTML-страницы источников в operator-research/sources/ (если PDF > 5 МБ или недоступен — используй Airouter Perplexity, чтобы найти доступные авторитетные HTML-источники);",
    "   - прогони штатный ensureVisualMaterial (до 2 итераций) для получения честной квитанции visual-material.json.",
    `4. Убедись, что создан ${runDir}/script.json (или зафиксируй точный код блокера из durable/status.json и durable/latest-check.json).`,
    "5. Верни структурированный итог через bb_workflow_result.",
  ].join("\n"),
  {
    phase: "Selection & Visual",
    schema: selectionSchema,
  },
);

if (!selection.visualMaterialOk || !selection.scriptPresent) {
  log(
    `Selection/Visual needs architect escalation (ok=${selection.visualMaterialOk}, script=${selection.scriptPresent}, code=${selection.durableCode})`,
  );
  selection = await runRole(
    "architect",
    "selection:architect-escalation",
    [
      `Ты старший архитектор в ${creativeRoot}. Выпуск: ${date}.`,
      COMMON_RULES,
      "",
      `Предыдущий агент не смог довести Selection & Visual: ${JSON.stringify(selection)}`,
      "",
      "Короткая прицельная задача (не раздувай контекст):",
      "1. Проверь durable/status.json, durable/latest-check.json и visual-material.json. Если есть баг конвейера (например, в durable-checks.mjs / visual-material-check.mjs) — исправь его с регрессионным тестом (прогон через /Users/user/.agents/bin/agent-pool test -- ...).",
      "2. Если тупик в visual-material — выбери честный лучший путь: добрать недостающие свободные фото Commons / уточнить угол сюжета строго в рамках подтверждённых фактов selected-story.json / либо переключиться на кандидата с сильным визуалом. Подтверди честным запуском ensureVisualMaterial (ok: true, score >= 7, distinctSubjects >= 3, covered >= 3).",
      `3. Добейся появления ${runDir}/script.json и верни структурированный отчёт через bb_workflow_result.`,
    ].join("\n"),
    {
      phase: "Selection & Visual",
      schema: selectionSchema,
    },
  );
}

const visualCheck = await runRole(
  "light",
  "selection:verify-visual",
  [
    `Независимая проверка Selection & Visual в ${runDir}.`,
    COMMON_RULES,
    "",
    `1. Прочитай ${runDir}/visual-material.json на диске: проверь ok === true, result.score >= 7, result.distinctSubjects >= 3, covered >= 3, и наличие поля model (квитанция получена от редактора, не пустая).`,
    `2. Проверь, что ${runDir}/script.json и ${dailyDir}/plan.json существуют и не пустые.`,
    `3. Сверь, что все фото в prepared.json имеют реальные файлы на диске с совпадающим SHA-1 и свободными лицензиями.`,
    `Отчёт предыдущего шага: ${JSON.stringify(selection)}`,
  ].join("\n"),
  {
    phase: "Selection & Visual",
    schema: verifyVisualSchema,
    preferAlternate: true,
  },
);

if (!visualCheck.verified || !visualCheck.visualMaterialOk || !visualCheck.scriptPresent) {
  return {
    status: "blocked",
    date,
    stage: "selection-visual",
    summary: `Selection & Visual не прошёл проверку: ${visualCheck.reason}`,
    videoPath: null,
    videoSha256: null,
    coverPath: null,
    durableStatus: selection.durableCode || null,
    modelAudit,
  };
}

// ==================== PHASE 3: EARLY PREPRODUCTION ====================
phase("Early Preproduction");

const earlySchema = {
  type: "object",
  required: ["earlyOk", "passedStages", "failedStages", "summary"],
  additionalProperties: false,
  properties: {
    earlyOk: { type: "boolean" },
    passedStages: { type: "array", items: { type: "string" } },
    failedStages: { type: "array", items: { type: "string" } },
    correctionsSummary: { type: "string", nullable: true },
    testsRan: { type: "string", nullable: true },
    summary: { type: "string" },
  },
};

const verifyEarlySchema = {
  type: "object",
  required: ["verified", "earlyOk", "failedStages", "reason"],
  additionalProperties: false,
  properties: {
    verified: { type: "boolean" },
    earlyOk: { type: "boolean" },
    failedStages: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
};

let earlyPassed = false;
let lastEarly = null;
let lastEarlyCheck = null;

for (let attempt = 1; attempt <= maxEarlyAttempts; attempt += 1) {
  const onlyVisualLeft =
    lastEarlyCheck &&
    lastEarlyCheck.failedStages.length > 0 &&
    lastEarlyCheck.failedStages.every(
      (s) => s === "raw-photo" || s === "composed-frame",
    );

  let role = "worker";
  if (attempt === maxEarlyAttempts && attempt > 1) {
    role = "architect";
  } else if (onlyVisualLeft) {
    role = "visual";
  }

  const prevFeedback = lastEarly
    ? [
        `Попытка ${attempt} из ${maxEarlyAttempts}.`,
        `Предыдущий статус: passed=${JSON.stringify(lastEarly.passedStages)}, failed=${JSON.stringify(lastEarly.failedStages)}.`,
        `Замечания: ${lastEarly.correctionsSummary || lastEarly.summary}`,
        "ВАЖНО: сохрани уже пройденные этапы в кэше (НЕ меняй речь/описание, если text и packaging уже passed; НЕ меняй исходные 6 фото, если raw-photo уже passed).",
      ].join("\n")
    : `Попытка 1 из ${maxEarlyAttempts}: собери полный согласованный early-пакет и прогони --phase early.`;

  lastEarly = await runRole(
    role,
    `early:attempt-${attempt}-${role}`,
    [
      `Рабочий каталог: ${creativeRoot}. Выпуск: ${date}. runDir: ${runDir}.`,
      COMMON_RULES,
      "",
      prevFeedback,
      "",
      "Порядок работы:",
      `1. На время правки артефактов останови LaunchAgent ${launchLabel} (launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/${launchLabel}.plist 2>/dev/null || true), чтобы не было гонки с durable.`,
      `2. Проверь согласованность prepared.json (все проверенные фото с SHA-1, storyCoverPlaque, storyPhotos, captionPhrases/compactCaptionPhrases — строго в данных выпуска, НЕ в scripts/*.mjs!), script.json (полные имена без инициалов, без ссылок на сторонние сайты в речи, чистые coverScene и storyHeadlines), evidence/ (карточки Commons, доступные HTML-источники — при проблемах с PDF используй Airouter Perplexity), source-verification.json и preproduction-input.json.`,
      `3. Запусти: node --env-file-if-exists=${shortsRoot}/.env --env-file-if-exists=${creativeRoot}/../otgolosok/.env scripts/normal-preproduction.mjs ${date} --phase early`,
      "4. Если есть замечания — проанализируй конкретные проверки и исправь за 1–2 осмысленные итерации (не сжигай >3 прогонов ревью за один заход; если менял скрипты, прогони целевые тесты через /Users/user/.agents/bin/agent-pool test -- ...).",
      "5. Верни точный структурированный отчёт через bb_workflow_result.",
    ].join("\n"),
    {
      phase: "Early Preproduction",
      schema: earlySchema,
    },
  );

  lastEarlyCheck = await runRole(
    "light",
    `early:verify-${attempt}`,
    [
      `Независимая проверка ${runDir}/preproduction-early.json на диске (попытка ${attempt}).`,
      COMMON_RULES,
      "",
      "1. Прочитай preproduction-early.json и проверь ok === true, а также статус каждого из 4 этапов (text, packaging, raw-photo, composed-frame): у всех ok === true, оценки >= 7, corrections пустой.",
      `2. Проверь git -C ${creativeRoot} diff -- scripts/ на отсутствие захардкоженных имён/слоганов конкретного выпуска в общих скриптах.`,
      `Отчёт исполнителя: ${JSON.stringify(lastEarly)}`,
    ].join("\n"),
    {
      phase: "Early Preproduction",
      schema: verifyEarlySchema,
      preferAlternate: true,
    },
  );

  if (lastEarlyCheck.verified && lastEarlyCheck.earlyOk) {
    earlyPassed = true;
    break;
  }
  log(
    `Early attempt ${attempt} not green: failed=${JSON.stringify(lastEarlyCheck.failedStages)} (${lastEarlyCheck.reason})`,
  );
}

if (!earlyPassed) {
  return {
    status: "blocked",
    date,
    stage: "early-preproduction",
    summary: `Early Preproduction не прошёл за ${maxEarlyAttempts} попыток: ${lastEarlyCheck ? lastEarlyCheck.reason : "unknown"}`,
    videoPath: null,
    videoSha256: null,
    coverPath: null,
    durableStatus: null,
    modelAudit,
  };
}

// ==================== PHASE 4: PHASE 2 RENDER & AUDIT ====================
phase("Phase 2 Render & Audit");

const phase2Schema = {
  type: "object",
  required: ["ok", "measuredOk", "promoReviewReady", "audioQcOk", "summary"],
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    measuredOk: { type: "boolean" },
    promoReviewReady: { type: "boolean" },
    audioQcOk: { type: "boolean" },
    videoPath: { type: "string", nullable: true },
    videoSha256: { type: "string", nullable: true },
    coverPath: { type: "string", nullable: true },
    durableStatus: { type: "string", nullable: true },
    errorSummary: { type: "string", nullable: true },
    summary: { type: "string" },
  },
};

const phase2Prompt = [
  `Рабочий каталог: ${creativeRoot}. Выпуск: ${date}. runDir: ${runDir}.`,
  "Ранний допуск (preproduction-early.json) уже ЧЕСТНО пройден (ok: true).",
  COMMON_RULES,
  "",
  "Задача Phase 2 (без публикации!):",
  "1. Синхронизируй чекпойнты prepare/script с актуальными файлами, чтобы ранние 4 этапа взялись из кэша.",
  "2. Собери выпуск: озвучка ElevenLabs v4 (provider: elevenlabs, model: eleven_v4, голос «Отголосок2»), preproduction-measured (--phase measured), полный рендер promo-video.mp4 (1080x1920) + обложки youtube-cover.jpg/png, строгий финальный аудит promo-review.json (verdict: ready, все оценки >= 7) и audio-qc.json (ok: true).",
  "3. При HTTP 429 от локальной подписки используй штатный фолбэк Airouter (с действующим лимитом 9 МБ), сохраняя те же аудиоклипы ElevenLabs.",
  `4. После успешной локальной сборки (built.json local-only) прогони финальную сверку Pi Durable (npm run video:durable -- ${date}) без публикации, чтобы зафиксировать durable/status.json -> approved, и останови лишние процессы/LaunchAgent.`,
  "5. Если изменялись скрипты в otgolosok-creative — прогони полный набор тестов через /Users/user/.agents/bin/agent-pool test -- npm test и git diff --check.",
  "6. Верни точный структурированный отчёт через bb_workflow_result.",
].join("\n");

let phase2 = await runRole("worker", "phase2:render-and-audit", phase2Prompt, {
  phase: "Phase 2 Render & Audit",
  schema: phase2Schema,
});

if (!phase2.ok || !phase2.measuredOk || !phase2.promoReviewReady || !phase2.audioQcOk) {
  log(`Phase 2 failed on worker (${phase2.errorSummary || phase2.summary}); escalating to architect`);
  phase2 = await runRole(
    "architect",
    "phase2:architect-repair",
    [
      phase2Prompt,
      "",
      `Предыдущая попытка Фазы 2 завершилась с проблемой: ${JSON.stringify(phase2)}`,
      "Диагностируй причину (баг кода, проблема measured-frame / promo-review / audio-qc), честно исправь (с тестами при правке кода) и доведи до ready + approved без публикации.",
    ].join("\n"),
    {
      phase: "Phase 2 Render & Audit",
      schema: phase2Schema,
    },
  );
}

// ==================== PHASE 5: FINAL GATE ====================
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

const finalGate = await runRole(
  "light",
  "final-gate:independent-verify",
  [
    `Независимая финальная верификация выпуска ${date} в ${creativeRoot}.`,
    COMMON_RULES,
    "",
    "Проверь всё НАПРЯМУЮ НА ДИСКЕ:",
    `1. Посчитай shasum -a 256 для ${runDir}/promo-video.mp4 и ${runDir}/mix.wav. Сверь точное совпадение SHA-256 с ${dailyDir}/built.json, ${runDir}/promo-review.json и ${dailyDir}/audio-qc.json.`,
    `2. Проверь ${runDir}/promo-review.json: verdict === "ready", все оценки >= 7, все checks passed.`,
    `3. Проверь ${runDir}/preproduction-early.json (ok: true), ${runDir}/preproduction-measured.json (ok: true), ${dailyDir}/audio-qc.json (ok: true).`,
    "4. Проверь провайдера, модель и голос озвучки: elevenlabs / eleven_v4 / «Отголосок2».",
    `5. Проверь ${dailyDir}/durable/status.json === "approved" и ОТСУТСТВИЕ ${dailyDir}/youtube-publish.json (автопубликация не запускалась).`,
    `6. Проверь git -C ${creativeRoot} status -sb и git -C ${creativeRoot} diff --check (если есть правки в scripts/tests, убедись что тесты проходили и нет хардкода выпуска в scripts/*.mjs).`,
    `Отчёт Фазы 2: ${JSON.stringify(phase2)}`,
  ].join("\n"),
  {
    phase: "Final Gate",
    schema: finalGateSchema,
    preferAlternate: true,
  },
);

if (!finalGate.approved) {
  return {
    status: "blocked",
    date,
    stage: "final-gate",
    summary: `Финальная сверка выявила проблемы: ${(finalGate.issues || []).join("; ") || finalGate.summary}`,
    videoPath: finalGate.videoPath || phase2.videoPath || null,
    videoSha256: finalGate.videoSha256 || phase2.videoSha256 || null,
    coverPath: finalGate.coverPath || phase2.coverPath || null,
    durableStatus: finalGate.durableStatus || phase2.durableStatus || null,
    modelAudit,
  };
}

return {
  status: "approved",
  date,
  stage: "final-gate",
  summary: finalGate.summary,
  videoPath: finalGate.videoPath || `${runDir}/promo-video.mp4`,
  videoSha256: finalGate.videoSha256 || phase2.videoSha256 || null,
  coverPath: finalGate.coverPath || `${runDir}/youtube-cover.jpg`,
  durableStatus: finalGate.durableStatus || "approved",
  modelAudit,
};

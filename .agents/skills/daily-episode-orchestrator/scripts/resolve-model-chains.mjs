#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Упорядоченные цепочки кандидатов по ролям (Team Orchestration v2).
 * Политика провайдеров:
 * - `acp-grok` исключён (высокий риск фальшивых отчётов и циклов на HTTP 429).
 * - `claude-code` исключён (локальной подписки Claude Code нет; Claude используется через Antigravity).
 * - Модели серии `gpt-6.2-*` исключены из основных ролей (высокая частота «Selected model is at capacity»).
 * - Нагрузка разнесена по семьям моделей (`codex`, `gemini`, `claude`, `deepseek`), чтобы поддерживать
 *   кросс-семейное ревью и мгновенный фолбэк при деградации одного провайдера.
 */
export const EXCLUDED_PROVIDERS = Object.freeze(["acp-grok", "claude-code"]);

export const DEFAULT_ROLE_CHAINS = Object.freeze({
  light: [
    { provider: "acp-antigravity-acp", model: "gemini-3.8-flash", reasoningLevel: null },
    { provider: "codex", model: "gpt-6-luna", reasoningLevel: "medium" },
    { provider: "acp-opencode", model: "opencode/deepseek-v4.1-flash-free", reasoningLevel: null },
    { provider: "acp-opencode", model: "opencode/big-pickle", reasoningLevel: null },
  ],
  worker: [
    { provider: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" },
    { provider: "acp-antigravity-acp", model: "claude-sonnet-5-5", reasoningLevel: null },
    { provider: "acp-antigravity-acp", model: "gemini-4-neon", reasoningLevel: "high" },
    { provider: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
  ],
  visual: [
    { provider: "acp-antigravity-acp", model: "gemini-4-neon", reasoningLevel: "high" },
    { provider: "codex", model: "gpt-6.1-terra", reasoningLevel: "high" },
    { provider: "acp-antigravity-acp", model: "claude-sonnet-5-5", reasoningLevel: null },
    { provider: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" },
  ],
  architect: [
    { provider: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    { provider: "acp-antigravity-acp", model: "gemini-4-neon", reasoningLevel: "high" },
    { provider: "acp-antigravity-acp", model: "claude-opus-5-5", reasoningLevel: null },
    { provider: "codex", model: "gpt-6.1-sol", reasoningLevel: "high" },
  ],
  reviewer: [
    { provider: "codex", model: "gpt-6-astra", reasoningLevel: "high" },
    { provider: "acp-antigravity-acp", model: "gemini-4-neon", reasoningLevel: "high" },
    { provider: "acp-antigravity-acp", model: "claude-opus-5-5", reasoningLevel: null },
    { provider: "acp-antigravity-acp", model: "claude-sonnet-5-5", reasoningLevel: null },
  ],
});

const CODEX_WEEKLY_DEGRADED_THRESHOLD = 0.95;

/**
 * Определяет каноническую семью модели для кросс-семейного ревью и разноса фолбэков.
 */
export function inferModelFamily(provider, model) {
  const p = String(provider || "").toLowerCase();
  const m = String(model || "").toLowerCase();
  if (p === "codex" || m.startsWith("gpt-")) return "codex";
  if (m.includes("gemini")) return "gemini";
  if (m.includes("claude")) return "claude";
  if (m.includes("deepseek")) return "deepseek";
  return p || "unknown";
}

/**
 * Оценивает состояние пула Codex (`bb airouter-pool status --json`).
 * Возвращает { healthy, readyOauthCount, freshOauthCount, readyApiKeyCount, reason }.
 */
export function assessCodexPoolHealth(poolStatus) {
  if (!poolStatus || !Array.isArray(poolStatus.accounts)) {
    return {
      healthy: true,
      readyOauthCount: 0,
      freshOauthCount: 0,
      readyApiKeyCount: 0,
      reason: "pool_status_unavailable_assume_ok",
    };
  }

  const codexAccounts = poolStatus.accounts.filter(
    (acc) => acc && acc.provider === "codex" && acc.enabled !== false,
  );
  if (codexAccounts.length === 0) {
    return {
      healthy: true,
      readyOauthCount: 0,
      freshOauthCount: 0,
      readyApiKeyCount: 0,
      reason: "no_pool_codex_accounts_using_direct",
    };
  }

  let readyOauthCount = 0;
  let freshOauthCount = 0;
  let readyApiKeyCount = 0;

  for (const acc of codexAccounts) {
    if (acc.status !== "ready") continue;
    if (acc.kind === "api-key") {
      readyApiKeyCount += 1;
      continue;
    }
    if (acc.kind === "oauth") {
      readyOauthCount += 1;
      const windows = Array.isArray(acc.limitWindows) ? acc.limitWindows : [];
      const weekly = windows.find((w) => w && w.slot === "secondary");
      const util = typeof weekly?.utilization === "number" ? weekly.utilization : 0;
      if (util < CODEX_WEEKLY_DEGRADED_THRESHOLD) {
        freshOauthCount += 1;
      }
    }
  }

  if (freshOauthCount > 0 || readyApiKeyCount > 0) {
    return {
      healthy: true,
      readyOauthCount,
      freshOauthCount,
      readyApiKeyCount,
      reason: "codex_pool_ready",
    };
  }

  return {
    healthy: false,
    readyOauthCount,
    freshOauthCount,
    readyApiKeyCount,
    reason:
      readyOauthCount > 0
        ? "all_ready_codex_oauth_near_weekly_limit"
        : "no_ready_codex_accounts_in_pool",
  };
}

function resolveReasoningLevel(candidateLevel, modelMeta) {
  if (candidateLevel == null) {
    return null;
  }

  const modelEfforts = Array.isArray(modelMeta?.supportedReasoningEfforts)
    ? modelMeta.supportedReasoningEfforts
        .map((e) => (typeof e === "string" ? e : e?.reasoningEffort))
        .filter(Boolean)
    : [];

  if (modelEfforts.length === 0) {
    if (modelMeta?.reasoningDiscovery === "known" && modelMeta?.defaultReasoningEffort) {
      return modelMeta.defaultReasoningEffort;
    }
    return null;
  }
  if (modelEfforts.includes(candidateLevel)) {
    return candidateLevel;
  }
  if (modelMeta?.defaultReasoningEffort && modelEfforts.includes(modelMeta.defaultReasoningEffort)) {
    return modelMeta.defaultReasoningEffort;
  }
  for (const fallback of ["high", "medium", "low"]) {
    if (modelEfforts.includes(fallback)) return fallback;
  }
  return modelEfforts[0];
}

/**
 * Собирает валидные цепочки фолбэк-моделей из живого каталога BB.
 * @param {object} params
 * @param {Array} params.providers - результат `bb provider list --json`
 * @param {Record<string, Array>} params.modelsByProvider - карта providerId -> массив моделей
 * @param {object|null} params.poolStatus - результат `bb airouter-pool status --json`
 * @param {boolean} [params.preferNonCodex=false] - сдвинуть codex в конец цепочек
 * @param {Record<string, Array>} [params.roleChains=DEFAULT_ROLE_CHAINS]
 */
export function buildModelChains({
  providers,
  modelsByProvider,
  poolStatus = null,
  preferNonCodex = false,
  roleChains = DEFAULT_ROLE_CHAINS,
}) {
  const warnings = [];
  const excludedSet = new Set(EXCLUDED_PROVIDERS);
  const providerMap = new Map();
  for (const p of providers || []) {
    if (p && p.id && p.available !== false && !excludedSet.has(p.id)) {
      providerMap.set(p.id, p);
    }
  }

  const codexHealth = assessCodexPoolHealth(poolStatus);
  const demoteCodex = Boolean(preferNonCodex || !codexHealth.healthy);
  if (!codexHealth.healthy) {
    warnings.push(`Codex pool degraded (${codexHealth.reason}): demoting codex models behind Antigravity/OpenCode`);
  } else if (preferNonCodex) {
    warnings.push("preferNonCodex enabled: demoting codex models behind Antigravity/OpenCode");
  }

  const resolved = {};
  for (const [role, candidates] of Object.entries(roleChains)) {
    const valid = [];
    const seen = new Set();

    for (const c of candidates) {
      const pMeta = providerMap.get(c.provider);
      if (!pMeta) continue;
      const models = modelsByProvider?.[c.provider] || [];
      const mMeta = models.find((m) => (m.id || m.model) === c.model);
      if (!mMeta) continue;

      const reasoningLevel = resolveReasoningLevel(c.reasoningLevel, mMeta);
      const key = reasoningLevel ? `${c.provider}/${c.model}/${reasoningLevel}` : `${c.provider}/${c.model}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const entry = {
        provider: c.provider,
        model: c.model,
        family: inferModelFamily(c.provider, c.model),
      };
      if (reasoningLevel) entry.reasoningLevel = reasoningLevel;
      valid.push(entry);
    }

    if (demoteCodex && valid.some((v) => v.provider !== "codex")) {
      const nonCodex = valid.filter((v) => v.provider !== "codex");
      const codexOnly = valid.filter((v) => v.provider === "codex");
      resolved[role] = [...nonCodex, ...codexOnly];
    } else {
      resolved[role] = valid;
    }

    if (resolved[role].length === 0) {
      warnings.push(`Role "${role}" has 0 available models in live BB catalog`);
    }
  }

  return {
    modelChains: resolved,
    codexPoolHealth: codexHealth,
    demotedCodex: demoteCodex,
    warnings,
  };
}

function runBbJson(args, warnings, label) {
  try {
    const stdout = execFileSync("bb", args, {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(stdout);
  } catch (err) {
    const msg = err?.stderr ? String(err.stderr).trim().slice(0, 180) : String(err?.message || err);
    warnings.push(`Failed ${label}: ${msg}`);
    return null;
  }
}

export function resolveLiveModelChains({ environmentId, preferNonCodex = false } = {}) {
  const runtimeWarnings = [];
  const envArgs = environmentId ? ["--environment", environmentId] : [];
  const providers = runBbJson(["provider", "list", ...envArgs, "--json"], runtimeWarnings, "bb provider list") || [];
  const neededProviders = new Set(
    Object.values(DEFAULT_ROLE_CHAINS)
      .flat()
      .map((c) => c.provider),
  );
  const excludedSet = new Set(EXCLUDED_PROVIDERS);

  const modelsByProvider = {};
  for (const p of providers) {
    if (!p?.id || p.available === false) continue;
    if (excludedSet.has(p.id) || !neededProviders.has(p.id)) continue;
    const raw = runBbJson(
      ["provider", "models", p.id, ...envArgs, "--json"],
      runtimeWarnings,
      `bb provider models ${p.id}`,
    );
    modelsByProvider[p.id] = Array.isArray(raw) ? raw : Array.isArray(raw?.models) ? raw.models : [];
  }

  const poolStatus = runBbJson(["airouter-pool", "status", "--json"], runtimeWarnings, "bb airouter-pool status");

  const result = buildModelChains({
    providers,
    modelsByProvider,
    poolStatus,
    preferNonCodex,
  });

  return {
    environmentId: environmentId || null,
    ...result,
    warnings: [...runtimeWarnings, ...result.warnings],
  };
}

function parseCliArgs(argv) {
  const opts = {
    environmentId: process.env.BB_ENVIRONMENT_ID || "",
    preferNonCodex: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--environment" && argv[i + 1]) {
      opts.environmentId = argv[i + 1];
      i += 1;
    } else if (a === "--prefer-non-codex") {
      opts.preferNonCodex = true;
    } else if (a === "--json") {
      opts.json = true;
    }
  }
  return opts;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const opts = parseCliArgs(process.argv.slice(2));
  const out = resolveLiveModelChains(opts);
  const missingRoles = Object.entries(out.modelChains)
    .filter(([, list]) => list.length === 0)
    .map(([role]) => role);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    for (const [role, list] of Object.entries(out.modelChains)) {
      const formatted = list
        .map((x) =>
          x.reasoningLevel
            ? `${x.provider}/${x.model}(${x.reasoningLevel})[${x.family}]`
            : `${x.provider}/${x.model}[${x.family}]`,
        )
        .join(" -> ");
      process.stdout.write(`${role}: ${formatted || "NONE"}\n`);
    }
    if (out.warnings.length > 0) {
      process.stderr.write(`Warnings:\n- ${out.warnings.join("\n- ")}\n`);
    }
  }

  if (missingRoles.length > 0) {
    process.exitCode = 1;
  }
}

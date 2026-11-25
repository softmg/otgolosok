import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ROLE_CHAINS,
  EXCLUDED_PROVIDERS,
  assessCodexPoolHealth,
  buildModelChains,
  inferModelFamily,
} from "./resolve-model-chains.mjs";

const SAMPLE_PROVIDERS = [
  {
    id: "codex",
    available: true,
    reasoningLevels: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }],
  },
  {
    id: "claude-code",
    available: true,
    reasoningLevels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
  },
  {
    id: "acp-antigravity-acp",
    available: true,
    reasoningLevels: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }],
  },
  {
    id: "acp-opencode",
    available: true,
    reasoningLevels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
  },
  {
    id: "acp-grok",
    available: true,
    reasoningLevels: [{ id: "medium" }, { id: "high" }],
  },
];

const SAMPLE_MODELS = {
  codex: [
    { id: "gpt-6-astra", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    { id: "gpt-6.1-sol", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    { id: "gpt-6.1-terra", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    { id: "gpt-6-luna", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
  ],
  "claude-code": [
    { id: "claude-opus-5-5", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
    { id: "claude-sonnet-5-5", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
  ],
  "acp-antigravity-acp": [
    { id: "gemini-4-neon", reasoningDiscovery: "known", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
    { id: "gemini-3.8-flash", reasoningDiscovery: "unknown", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
    { id: "claude-opus-5-5", reasoningDiscovery: "unknown", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
    { id: "claude-sonnet-5-5", reasoningDiscovery: "unknown", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
  ],
  "acp-opencode": [
    { id: "opencode/big-pickle", reasoningDiscovery: "known", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
    { id: "opencode/deepseek-v4.1-flash-free", reasoningDiscovery: "unknown", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
  ],
  "acp-grok": [{ id: "grok-4.7" }],
};

test("happy path: enforces Team Orchestration role priorities, excludes claude-code and grok, tags families", () => {
  const poolStatus = {
    accounts: [
      { provider: "codex", kind: "oauth", enabled: true, status: "ready", limitWindows: [{ slot: "secondary", utilization: 0.18 }] },
      { provider: "codex", kind: "api-key", enabled: true, status: "held", limitWindows: [] },
    ],
  };

  const res = buildModelChains({
    providers: SAMPLE_PROVIDERS,
    modelsByProvider: SAMPLE_MODELS,
    poolStatus,
  });

  assert.equal(res.demotedCodex, false);
  assert.equal(res.warnings.length, 0);

  // light: Gemini Flash first, Codex Luna second
  assert.deepEqual(res.modelChains.light[0], {
    provider: "acp-antigravity-acp",
    model: "gemini-3.8-flash",
    family: "gemini",
  });
  assert.deepEqual(res.modelChains.light[1], {
    provider: "codex",
    model: "gpt-6-luna",
    reasoningLevel: "medium",
    family: "codex",
  });

  // worker: codex/gpt-6.1-sol -> acp-antigravity-acp/claude-sonnet-5-5 -> gemini-4-neon
  assert.deepEqual(res.modelChains.worker[0], {
    provider: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "high",
    family: "codex",
  });
  assert.deepEqual(res.modelChains.worker[1], {
    provider: "acp-antigravity-acp",
    model: "claude-sonnet-5-5",
    family: "claude",
  });

  // visual: Gemini 4 Neon first
  assert.deepEqual(res.modelChains.visual[0], {
    provider: "acp-antigravity-acp",
    model: "gemini-4-neon",
    reasoningLevel: "high",
    family: "gemini",
  });

  // architect & reviewer: codex/gpt-6-astra -> acp-antigravity-acp/gemini-4-neon (high)
  for (const role of ["architect", "reviewer"]) {
    assert.deepEqual(res.modelChains[role][0], {
      provider: "codex",
      model: "gpt-6-astra",
      reasoningLevel: "high",
      family: "codex",
    });
    assert.deepEqual(res.modelChains[role][1], {
      provider: "acp-antigravity-acp",
      model: "gemini-4-neon",
      reasoningLevel: "high",
      family: "gemini",
    });
  }

  for (const list of Object.values(res.modelChains)) {
    assert.ok(list.every((c) => !EXCLUDED_PROVIDERS.includes(c.provider)));
    assert.ok(list.every((c) => c.provider !== "claude-code" && c.provider !== "acp-grok"));
  }
});

test("inferModelFamily classifies providers and models into canonical families", () => {
  assert.equal(inferModelFamily("codex", "gpt-6-astra"), "codex");
  assert.equal(inferModelFamily("acp-antigravity-acp", "gemini-4-neon"), "gemini");
  assert.equal(inferModelFamily("acp-antigravity-acp", "claude-sonnet-5-5"), "claude");
  assert.equal(inferModelFamily("acp-opencode", "opencode/deepseek-v4.1-flash-free"), "deepseek");
  assert.equal(inferModelFamily("acp-opencode", "opencode/big-pickle"), "acp-opencode");
});

test("missing models are skipped cleanly and models without effort omit reasoningLevel", () => {
  const partialModels = {
    ...SAMPLE_MODELS,
    codex: SAMPLE_MODELS.codex.filter((m) => m.id !== "gpt-6-astra" && m.id !== "gpt-6.1-sol"),
  };

  const res = buildModelChains({
    providers: SAMPLE_PROVIDERS,
    modelsByProvider: partialModels,
    poolStatus: null,
  });

  assert.equal(res.modelChains.architect[0].provider, "acp-antigravity-acp");
  assert.equal(res.modelChains.architect[0].model, "gemini-4-neon");
  assert.equal(res.modelChains.worker[0].provider, "acp-antigravity-acp");
  assert.equal(res.modelChains.worker[0].model, "claude-sonnet-5-5");
  assert.equal("reasoningLevel" in res.modelChains.worker[0], false);
});

test("exhausted Codex pool demotes codex behind Antigravity/OpenCode across all roles", () => {
  const exhaustedPool = {
    accounts: [
      { provider: "codex", kind: "api-key", enabled: true, status: "held", limitWindows: [] },
      { provider: "codex", kind: "oauth", enabled: true, status: "exhausted", limitWindows: [{ slot: "secondary", utilization: 1.0 }] },
      { provider: "codex", kind: "oauth", enabled: true, status: "ready", limitWindows: [{ slot: "secondary", utilization: 0.96 }] },
      { provider: "codex", kind: "oauth", enabled: true, status: "error", limitWindows: [] },
    ],
  };

  const health = assessCodexPoolHealth(exhaustedPool);
  assert.equal(health.healthy, false);
  assert.equal(health.freshOauthCount, 0);

  const res = buildModelChains({
    providers: SAMPLE_PROVIDERS,
    modelsByProvider: SAMPLE_MODELS,
    poolStatus: exhaustedPool,
  });

  assert.equal(res.demotedCodex, true);
  assert.ok(res.warnings.some((w) => w.includes("Codex pool degraded")));
  for (const role of ["light", "worker", "visual", "architect", "reviewer"]) {
    assert.notEqual(res.modelChains[role][0].provider, "codex", `role ${role} should demote codex`);
  }
  assert.ok(res.modelChains.worker.some((c) => c.provider === "codex"));
});

test("unsupported reasoningLevel falls back to a supported level for the model", () => {
  const res = buildModelChains({
    providers: [{ id: "codex", available: true, reasoningLevels: [{ id: "low" }, { id: "medium" }] }],
    modelsByProvider: {
      codex: [
        {
          id: "gpt-6.1-sol",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
        },
      ],
    },
    roleChains: {
      worker: [{ provider: "codex", model: "gpt-6.1-sol", reasoningLevel: "xhigh" }],
    },
  });

  assert.deepEqual(res.modelChains.worker, [
    { provider: "codex", model: "gpt-6.1-sol", reasoningLevel: "medium", family: "codex" },
  ]);
});

test("emits warning when a role resolves to zero live models", () => {
  const res = buildModelChains({
    providers: [],
    modelsByProvider: {},
  });

  assert.equal(res.modelChains.worker.length, 0);
  assert.ok(res.warnings.some((w) => w.includes('Role "worker" has 0 available models')));
});

test("every DEFAULT_ROLE_CHAINS tuple has a matching literal case in .bb/workflows/daily-episode.js", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const wfSource = fs.readFileSync(path.join(repoRoot, ".bb/workflows/daily-episode.js"), "utf8");

  for (const [role, list] of Object.entries(DEFAULT_ROLE_CHAINS)) {
    for (const spec of list) {
      const key = spec.reasoningLevel
        ? `${spec.provider}/${spec.model}/${spec.reasoningLevel}`
        : `${spec.provider}/${spec.model}`;
      assert.ok(
        wfSource.includes(`case "${key}":`),
        `Missing literal case "${key}" in daily-episode.js for role "${role}"`,
      );
    }
  }
});

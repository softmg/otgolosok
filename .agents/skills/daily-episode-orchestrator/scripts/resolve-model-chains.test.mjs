import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ROLE_CHAINS,
  assessCodexPoolHealth,
  buildModelChains,
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
    reasoningLevels: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }],
  },
  {
    id: "acp-antigravity-acp",
    available: true,
    reasoningLevels: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }],
  },
  {
    id: "acp-grok",
    available: true,
    reasoningLevels: [{ id: "medium" }, { id: "high" }],
  },
  {
    id: "acp-cursor",
    available: true,
    reasoningLevels: [{ id: "high" }],
  },
];

const SAMPLE_MODELS = {
  codex: [
    { id: "gpt-6.2-sol", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
    { id: "gpt-6.2-astra", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    { id: "gpt-6.1-terra", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    { id: "gpt-6.1-sol", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    { id: "gpt-6-luna", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
  ],
  "claude-code": [
    { id: "claude-opus-5-5", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    { id: "claude-fable-5-1", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    { id: "claude-sonnet-5-5", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
    { id: "claude-haiku-4-5-20251001", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
  ],
  "acp-antigravity-acp": [
    { id: "gemini-4-neon", defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
    { id: "gemini-3.8-flash", defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
  ],
  "acp-grok": [{ id: "grok-4.7" }],
  "acp-cursor": [],
};

test("happy path: preserves role priority and excludes grok completely", () => {
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
  assert.equal(res.modelChains.light[0].model, "gemini-4-neon");
  assert.equal(res.modelChains.light[0].reasoningLevel, "low");
  assert.equal(res.modelChains.light[1].model, "gpt-6-luna");
  assert.equal(res.modelChains.light[2].model, "claude-haiku-4-5-20251001");
  assert.equal(res.modelChains.light[2].reasoningLevel, "low");
  assert.equal(res.modelChains.worker[0].model, "gpt-6.2-sol");
  assert.equal(res.modelChains.visual[0].model, "gpt-6.1-terra");
  assert.equal(res.modelChains.architect[0].model, "gpt-6.2-astra");

  for (const list of Object.values(res.modelChains)) {
    assert.ok(list.every((c) => c.provider !== "acp-grok"));
  }
});

test("missing models and models without supportedReasoningEfforts are skipped cleanly", () => {
  const partialModels = {
    ...SAMPLE_MODELS,
    codex: SAMPLE_MODELS.codex.filter((m) => m.id !== "gpt-6.1-terra" && m.id !== "gpt-6.2-astra"),
    "acp-antigravity-acp": SAMPLE_MODELS["acp-antigravity-acp"].filter((m) => m.id !== "gemini-4-neon"),
  };

  const res = buildModelChains({
    providers: SAMPLE_PROVIDERS,
    modelsByProvider: partialModels,
    poolStatus: null,
  });

  assert.equal(res.modelChains.light[0].model, "gpt-6-luna");
  assert.equal(res.modelChains.visual[0].model, "gpt-6.2-sol");
  assert.equal(res.modelChains.architect[0].provider, "claude-code");
  assert.equal(res.modelChains.architect[0].model, "claude-opus-5-5");

  const flashCheck = buildModelChains({
    providers: SAMPLE_PROVIDERS,
    modelsByProvider: SAMPLE_MODELS,
    roleChains: {
      light: [
        { provider: "acp-antigravity-acp", model: "gemini-3.8-flash", reasoningLevel: "medium" },
        { provider: "codex", model: "gpt-6-luna", reasoningLevel: "medium" },
      ],
    },
  });
  assert.deepEqual(flashCheck.modelChains.light, [
    { provider: "codex", model: "gpt-6-luna", reasoningLevel: "medium" },
  ]);
});

test("exhausted Codex pool demotes codex behind Claude and Antigravity across all roles", () => {
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
  assert.notEqual(res.modelChains.worker[0].provider, "codex");
  assert.notEqual(res.modelChains.visual[0].provider, "codex");
  assert.notEqual(res.modelChains.architect[0].provider, "codex");
  // Codex candidates remain as last-resort fallbacks
  assert.ok(res.modelChains.worker.some((c) => c.provider === "codex"));
});

test("unsupported reasoningLevel falls back to a supported level for the model", () => {
  const res = buildModelChains({
    providers: [{ id: "codex", available: true, reasoningLevels: [{ id: "low" }, { id: "medium" }] }],
    modelsByProvider: {
      codex: [
        {
          id: "gpt-6.2-sol",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
        },
      ],
    },
    roleChains: {
      worker: [{ provider: "codex", model: "gpt-6.2-sol", reasoningLevel: "xhigh" }],
    },
  });

  assert.deepEqual(res.modelChains.worker, [
    { provider: "codex", model: "gpt-6.2-sol", reasoningLevel: "medium" },
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
      const key = `${spec.provider}/${spec.model}/${spec.reasoningLevel}`;
      assert.ok(
        wfSource.includes(`case "${key}":`),
        `Missing literal case "${key}" in daily-episode.js for role "${role}"`,
      );
    }
  }
});

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local tool state, not project sources: the uv virtualenv ships bundled JS
    // (pyright), and agent tools keep separate git worktrees inside the checkout.
    ".venv/**",
    ".kilo/**",
    ".claude/worktrees/**",
    "artifacts/**",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;

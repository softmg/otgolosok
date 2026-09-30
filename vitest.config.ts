import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors the "@/*" path in tsconfig.json.
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // CSS Modules resolve to their plain class names (styles.sheet === "sheet"); tests select by role and data-*.
    css: { include: [/\.module\.css$/], modules: { classNameStrategy: "non-scoped" } },
  },
});

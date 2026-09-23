import { readdir, readFile, writeFile } from "node:fs/promises";
import { withContentSecurityPolicy } from "./content-security-policy.mjs";

// Runs before build-service-worker.mjs: the precache version hashes final HTML.
const output = new URL("../out/", import.meta.url);
const pages = (await readdir(output, { recursive: true })).filter(file => file.endsWith(".html"));
if (!pages.length) throw new Error("No exported HTML pages found in out/");

for (const page of pages) {
  const file = new URL(page.replaceAll("\\", "/"), output);
  await writeFile(file, withContentSecurityPolicy(await readFile(file, "utf8")));
}
console.log(`Content-Security-Policy: ${pages.length} pages`);

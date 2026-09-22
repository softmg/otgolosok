import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { selectPrecacheFiles, precacheUrl } from "./service-worker-manifest.mjs";

const output = new URL("../out/", import.meta.url);
const files = selectPrecacheFiles(await readdir(output, { recursive: true }));
const template = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
const hash = createHash("sha256").update(template);

for (const file of files) {
  hash.update(file).update(await readFile(new URL(file, output)));
}

const manifest = {
  version: hash.digest("hex").slice(0, 16),
  assets: files.map(precacheUrl),
};

await writeFile(
  new URL("sw.js", output),
  `self.__PRECACHE = ${JSON.stringify(manifest)};\n${template}`,
);
console.log(`Service Worker: ${manifest.assets.length} files, version ${manifest.version}`);

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { seedTestPlaceholders } from "../backend/test-placeholders.mjs";

/** Copies one MP3 into the public audio directory under its hash, as the audio ingest names files. */
async function sharedAudio(file, directory) {
  const bytes = await readFile(resolve(file)), sha256 = createHash("sha256").update(bytes).digest("hex");
  const { stdout } = await promisify(execFile)("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", resolve(file)], { timeout: 15000 });
  const durationSec = Number(JSON.parse(stdout).format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 600) throw new Error("Длительность аудио должна быть от 0 до 600 секунд.");
  await mkdir(join(directory, "audio"), { recursive: true });
  await copyFile(resolve(file), join(directory, "audio", `${sha256}.mp3`));
  return { url: `/api/story-audio/${sha256}.mp3`, sha256, bytes: bytes.length, durationSec, model: "test", voice: "test", provider: "test", synthetic: true };
}

try {
  const [file, confirmation, ...rest] = process.argv.slice(2);
  if (!file || confirmation !== "--test-data") throw new Error("Укажите каталог и --test-data [--audio файл.mp3]. Команда предназначена только для тестовой базы.");
  const audioIndex = rest.indexOf("--audio");
  if (audioIndex >= 0 && !rest[audioIndex + 1]) throw new Error("После --audio укажите MP3-файл.");
  const directory = resolve(process.env.DATA_DIR ?? "backend/data"), database = join(directory, "jobs.sqlite");
  const audio = audioIndex >= 0 ? await sharedAudio(rest[audioIndex + 1], directory) : null;
  if (file !== "-") {
    const catalog = JSON.parse(await readFile(resolve(file), "utf8"));
    // Loaded only for an import: "-" refreshes test stories without migrating the database.
    const { createStore } = await import("../backend/store.mjs");
    const store = createStore(database);
    try { store.importPlaces(catalog); } finally { store.close(); }
  }
  const db = new DatabaseSync(database);
  try { console.log(JSON.stringify(seedTestPlaceholders(db, { audio }))); } finally { db.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Не удалось добавить тестовые точки.");
  process.exitCode = 1;
}

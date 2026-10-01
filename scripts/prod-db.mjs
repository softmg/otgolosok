#!/usr/bin/env node
/**
 * Move the production generator database between the server and a developer machine.
 *
 * The live `jobs.sqlite` is written in WAL mode and its journal regularly holds
 * more than the main file does, so copying that one file leaves most recent work
 * behind. Every path here goes through `VACUUM INTO`, which reads one consistent
 * snapshot of database and journal together.
 *
 * Commands: dump, pack, import, restore, info. See `make help`.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = resolve(import.meta.dirname, "..");
const VPS = process.env.VPS ?? "services@93.189.230.19";
const REMOTE_DIR = process.env.REMOTE_DIR ?? "/srv/sites/otgolosok.softmg.tech";
const CONTAINER = process.env.GENERATOR_CONTAINER ?? "otgolosok-generator-generator-1";
// Defaults live inside the gitignored data directory so a production dump can
// never be committed by accident.
const DUMP_DIR = resolve(ROOT, process.env.DUMP_DIR ?? "backend/data/prod-dump");
const DATA_DIR = resolve(ROOT, process.env.DATA_DIR ?? "backend/data");
const REMOTE_SNAPSHOT = "/tmp/otgolosok-dump.sqlite";
const JOURNAL = ["jobs.sqlite", "jobs.sqlite-wal", "jobs.sqlite-shm"];
// Files the database refers to by name: story audio and place photos travel with every snapshot.
const MEDIA_DIRS = ["audio", "place-images"];

/** Runs inside the generator container, piped to its node over ssh. */
const SNAPSHOT_SCRIPT = `
import { DatabaseSync } from "node:sqlite";
import { rmSync, statSync } from "node:fs";
const SOURCE = "/data/jobs.sqlite";
const TARGET = ${JSON.stringify(REMOTE_SNAPSHOT)};
rmSync(TARGET, { force: true });
const live = new DatabaseSync(SOURCE, { readOnly: true });
live.exec("VACUUM INTO '" + TARGET + "'");
const tables = live.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
live.close();
const snapshot = new DatabaseSync(TARGET, { readOnly: true });
const integrity = snapshot.prepare("PRAGMA integrity_check").get().integrity_check;
const counts = tables.map(({ name }) => name + "=" + snapshot.prepare('SELECT count(*) AS n FROM "' + name + '"').get().n);
snapshot.close();
if (integrity !== "ok") throw new Error("Snapshot failed integrity check: " + integrity);
console.log(statSync(TARGET).size + " " + counts.join(" "));
`;

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args, { input, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    input,
    encoding: capture ? undefined : "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", capture ? "pipe" : "pipe", "inherit"],
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args[0] ?? ""} завершился с кодом ${result.status}`);
  return capture ? result.stdout : String(result.stdout ?? "");
}

function copyDirectoryContents(source, target) {
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) cpSync(join(source, name), join(target, name), { recursive: true });
}

const ssh = (command, options) => run("ssh", ["-o", "BatchMode=yes", VPS, command], options);

function openDatabase(file) {
  if (!existsSync(file)) fail(`Нет файла базы: ${file}`);
  return new DatabaseSync(file, { readOnly: true });
}

function describe(file) {
  const db = openDatabase(file);
  const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
  // A backup taken before a migration lacks the newer tables, and reading it
  // must report that rather than crash on a missing name.
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  const jobs = tables.has("jobs") ? db.prepare("SELECT stage, record_json FROM jobs").all() : [];
  const stages = new Map();
  for (const { stage } of jobs) stages.set(stage, (stages.get(stage) ?? 0) + 1);
  const chapters = tables.has("walk_chapters") ? db.prepare("SELECT count(*) AS n FROM walk_chapters").get().n : null;
  const placeAudio = tables.has("place_texts") ? db.prepare("SELECT audio_json FROM place_texts WHERE audio_json IS NOT NULL").all() : [];
  const placeImages = tables.has("place_images")
    ? db.prepare("SELECT thumbnail_url, src_url FROM place_images WHERE status = 'ready'").all()
      .flatMap((row) => [row.thumbnail_url, row.src_url]).filter((url) => typeof url === "string" && url.startsWith("/api/place-images/")).map((url) => url.split("/").pop())
    : [];
  db.close();
  return { integrity, jobs, stages, chapters, placeAudio, placeImages, bytes: statSync(file).size };
}

function report(file, dataDir) {
  const { integrity, jobs, stages, chapters, placeAudio, placeImages, bytes } = describe(file);
  const audio = jobs.flatMap((row) => {
    const record = JSON.parse(row.record_json);
    return row.stage === "ready" && record.data?.audio ? [record.data.audio.url.split("/").pop()] : [];
  });
  const catalogAudio=placeAudio.map(row=>JSON.parse(row.audio_json)?.url?.split("/").pop()).filter(Boolean);
  const allAudio=[...new Set([...audio,...catalogAudio])];
  const missing = dataDir ? allAudio.filter((name) => !existsSync(join(dataDir, "audio", name))) : [];
  const missingImages = dataDir ? [...new Set(placeImages)].filter((name) => !existsSync(join(dataDir, "place-images", name))) : [];
  process.stdout.write(`  целостность: ${integrity}, ${(bytes / 1024).toFixed(0)} КБ\n`);
  process.stdout.write(`  заданий: ${jobs.length}${jobs.length ? ` (${[...stages].map(([stage, count]) => `${stage}=${count}`).join(", ")})` : ""}\n`);
  process.stdout.write(`  глав прогулки: ${chapters ?? "таблицы ещё нет"}, аудио адресов: ${audio.length}, аудио OSM: ${catalogAudio.length}, файлов фото мест: ${new Set(placeImages).size}\n`);
  if (dataDir) {
    process.stdout.write(missing.length
      ? `  ВНИМАНИЕ: не хватает записей: ${missing.join(", ")}\n`
      : `  все записи готовых историй на месте\n`);
    if (missingImages.length) process.stdout.write(`  ВНИМАНИЕ: не хватает файлов фото мест: ${missingImages.length}\n`);
  }
  if (integrity !== "ok") fail("База не прошла проверку целостности.");
}

function dump() {
  process.stdout.write(`Снимаем базу в контейнере ${CONTAINER} на ${VPS}\n`);
  const summary = ssh(`docker exec -i ${CONTAINER} node --input-type=module`, { input: SNAPSHOT_SCRIPT }).trim();
  process.stdout.write(`  снимок: ${summary}\n`);

  const bytes = ssh(`docker exec ${CONTAINER} cat ${REMOTE_SNAPSHOT}`, { capture: true });
  const expected = ssh(`docker exec ${CONTAINER} sha256sum ${REMOTE_SNAPSHOT}`).trim().split(/\s+/)[0];
  // Clear the temporary file before any check can abort the run.
  ssh(`docker exec ${CONTAINER} rm -f ${REMOTE_SNAPSHOT}`);
  if (sha256(bytes) !== expected) fail("Контрольные суммы снимка не совпали, выгрузка не сохранена.");

  writeFileSync(join(DUMP_DIR, "jobs.sqlite"), bytes);
  for (const name of MEDIA_DIRS) {
    mkdirSync(join(DUMP_DIR, name), { recursive: true });
    // place-images appears only after the first photo sync on the server.
    const remote = `${REMOTE_DIR}/generator-data/${name}`;
    if (ssh(`test -d ${remote} && echo yes || true`).trim() === "yes") run("rsync", ["-a", `${VPS}:${remote}/`, `${join(DUMP_DIR, name)}/`]);
  }

  process.stdout.write(`Выгрузка: ${DUMP_DIR}\n`);
  report(join(DUMP_DIR, "jobs.sqlite"), DUMP_DIR);
  process.stdout.write("Дальше: make db-import, либо make db-pack для передачи коллеге.\n");
}

function pack() {
  // Default inside the gitignored data directory: the archive carries production
  // data and must not sit in the repository root waiting for a `git add .`.
  const archive = resolve(ROOT, process.env.ARCHIVE ?? join(DATA_DIR, `otgolosok-prod-db-${stamp()}.tar.gz`));
  if (!existsSync(join(DUMP_DIR, "jobs.sqlite"))) fail(`Нет выгрузки в ${DUMP_DIR}. Сначала make db-dump.`);
  run("tar", ["-czf", archive, "-C", dirname(DUMP_DIR), basename(DUMP_DIR)]);
  process.stdout.write(`Архив: ${archive} (${(statSync(archive).size / 1024).toFixed(0)} КБ)\n`);
  process.stdout.write("Внутри production-данные: передавайте по закрытому каналу и не коммитьте.\n");
  // Extracting into backend/data keeps the copy inside the gitignored directory
  // and lands it exactly where the default DUMP_DIR looks.
  process.stdout.write(`Получателю: tar -xzf ${basename(archive)} -C backend/data && make db-import\n`);
}

function importDump() {
  const source = join(DUMP_DIR, "jobs.sqlite");
  if (!existsSync(source)) fail(`Нет ${source}. Сначала make db-dump или распакуйте архив коллеги.`);
  report(source, DUMP_DIR);

  const backup = join(DATA_DIR, `backup-local-${stamp()}`);
  mkdirSync(backup, { recursive: true });
  for (const name of JOURNAL) {
    if (existsSync(join(DATA_DIR, name))) cpSync(join(DATA_DIR, name), join(backup, name));
  }
  for (const name of MEDIA_DIRS) {
    mkdirSync(join(DATA_DIR, name), { recursive: true });
    cpSync(join(DATA_DIR, name), join(backup, name), { recursive: true });
  }
  process.stdout.write(`Прежняя база сохранена: ${backup}\n`);

  // The journal belongs to the database it was written for. Leaving it next to a
  // different jobs.sqlite is what turns a restore into a corrupt database.
  for (const name of JOURNAL) rmSync(join(DATA_DIR, name), { force: true });
  cpSync(source, join(DATA_DIR, "jobs.sqlite"));
  for (const name of MEDIA_DIRS) {
    rmSync(join(DATA_DIR, name), { recursive: true, force: true });
    copyDirectoryContents(join(DUMP_DIR, name), join(DATA_DIR, name));
  }

  process.stdout.write(`Импортировано в ${DATA_DIR}\n`);
  report(join(DATA_DIR, "jobs.sqlite"), DATA_DIR);
  process.stdout.write("Запуск: pnpm build && pnpm generator:dev (http://127.0.0.1:4175)\n");
}

function restore() {
  const backups = existsSync(DATA_DIR)
    ? readdirSync(DATA_DIR).filter((name) => name.startsWith("backup-local-")).sort()
    : [];
  if (!backups.length) fail(`Резервных копий в ${DATA_DIR} нет.`);
  const chosen = process.env.BACKUP ?? backups.at(-1);
  if (!backups.includes(chosen)) {
    fail(`Нет копии ${chosen}. Доступны: ${backups.join(", ")}`);
  }
  if (backups.length > 1) {
    process.stdout.write(`Копии: ${backups.join(", ")}\n  выбрана ${chosen} (другую задайте через BACKUP=)\n`);
  }
  const backup = join(DATA_DIR, chosen);
  if (!existsSync(join(backup, "jobs.sqlite"))) fail(`В ${backup} нет jobs.sqlite.`);
  for (const name of JOURNAL) rmSync(join(DATA_DIR, name), { force: true });
  for (const name of JOURNAL) {
    if (existsSync(join(backup, name))) cpSync(join(backup, name), join(DATA_DIR, name));
  }
  for (const name of MEDIA_DIRS) {
    const current = join(DATA_DIR, name), saved = join(backup, name);
    if (existsSync(saved)) { rmSync(current, { recursive: true, force: true }); cpSync(saved, current, { recursive: true }); }
  }
  process.stdout.write(`Восстановлено из ${backup}\n`);
  report(join(DATA_DIR, "jobs.sqlite"), DATA_DIR);
  process.stdout.write("Лишние файлы в audio/ и place-images/ ничему не мешают и остаются на месте.\n");
}

function info() {
  process.stdout.write(`Локальная база ${join(DATA_DIR, "jobs.sqlite")}\n`);
  report(join(DATA_DIR, "jobs.sqlite"), DATA_DIR);
  const db = openDatabase(join(DATA_DIR, "jobs.sqlite"));
  const rows = db.prepare("SELECT stage, created_at, record_json FROM jobs ORDER BY created_at DESC LIMIT 10").all();
  db.close();
  process.stdout.write("\n  последние задания:\n");
  for (const row of rows) {
    const record = JSON.parse(row.record_json);
    const address = record.address ?? record.request?.start?.address ?? "";
    process.stdout.write(`    ${row.created_at.slice(0, 16).replace("T", " ")}  ${row.stage.padEnd(21)} ${address}\n`);
  }
}

const commands = { dump, pack, import: importDump, restore, info };
const command = process.argv[2];
if (!Object.hasOwn(commands, command ?? "")) {
  fail(`Использование: node scripts/prod-db.mjs <${Object.keys(commands).join("|")}>`);
}
commands[command]();

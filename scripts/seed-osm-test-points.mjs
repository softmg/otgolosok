import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../backend/store.mjs";
import { seedTestPlaceholders } from "../backend/test-placeholders.mjs";

try {
  const [file, confirmation] = process.argv.slice(2);
  if (!file || confirmation !== "--test-data") throw new Error("Укажите каталог и --test-data. Команда предназначена только для тестовой базы.");
  const catalog = JSON.parse(await readFile(resolve(file), "utf8"));
  const database = join(resolve(process.env.DATA_DIR ?? "backend/data"), "jobs.sqlite");
  const store = createStore(database);
  try { store.importPlaces(catalog); } finally { store.close(); }
  const db = new DatabaseSync(database);
  try { console.log(JSON.stringify(seedTestPlaceholders(db))); } finally { db.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Не удалось добавить тестовые точки.");
  process.exitCode = 1;
}

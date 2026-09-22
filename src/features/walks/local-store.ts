import { migrateLegacyDraft, validateWalkDocument, type WalkDocument } from "./model";

export const WALK_LIBRARY_KEY = "otgolosok:walks:v2";
export const LEGACY_WALK_KEY = "otgolosok:walk:v1";
export type LocalWalkItem = { document: WalkDocument; revision: number; updatedAt?: string };
type Item = LocalWalkItem;
type Library = { version: 2; legacyId: string | null; items: Record<string, Item> };
type StoragePort = Pick<Storage, "getItem" | "setItem">;

const empty = (): Library => ({ version: 2, legacyId: null, items: {} });
const conflict = () => new Error("Прогулка изменена в другой вкладке. Обновите список перед сохранением.");

function read(storage: StoragePort): { value: Library; raw: string | null } {
  const raw = storage.getItem(WALK_LIBRARY_KEY);
  if (raw === null) return { value: empty(), raw };
  let value: Library;
  try { value = JSON.parse(raw) as Library; } catch { throw new Error("Хранилище прогулок повреждено. Исходная запись сохранена."); }
  if (value?.version !== 2 || !value.items || typeof value.items !== "object" || Array.isArray(value.items) ||
      !(value.legacyId === null || typeof value.legacyId === "string")) throw new Error("Неизвестная версия библиотеки прогулок. Исходная запись сохранена.");
  for (const [id, item] of Object.entries(value.items)) {
    if (!item || item.document?.id !== id || !Number.isSafeInteger(item.revision) || item.revision < 0) throw new Error("Хранилище прогулок повреждено. Исходная запись сохранена.");
    validateWalkDocument(item.document);
  }
  return { value, raw };
}

function write(storage: StoragePort, previous: string | null, next: Library) {
  if (storage.getItem(WALK_LIBRARY_KEY) !== previous) throw conflict();
  storage.setItem(WALK_LIBRARY_KEY, JSON.stringify(next));
  // Some browser storage implementations report success before failing to persist.
  if (storage.getItem(WALK_LIBRARY_KEY) !== JSON.stringify(next)) throw new Error("Не удалось проверить сохранение прогулки. Исходные данные не удалены.");
}

/** The v1 source is deliberately retained: failed migrations never destroy a draft. */
export function migrateLocalWalks(storage: StoragePort, newId: () => string = () => crypto.randomUUID()): string | null {
  const { value, raw } = read(storage);
  const activeId = storage.getItem("otgolosok:walk:active-local");
  if (activeId && value.items[activeId]) return activeId;
  if (value.legacyId) return value.legacyId;
  const legacy = storage.getItem(LEGACY_WALK_KEY);
  if (legacy === null) return null;
  let source: unknown;
  try { source = JSON.parse(legacy); } catch { throw new Error("Старый черновик повреждён. Его исходная запись сохранена для скачивания."); }
  const id = newId();
  const document = migrateLegacyDraft(source, id);
  const next = { ...value, legacyId: id, items: { ...value.items, [id]: { document, revision: 0 } } };
  write(storage, raw, next);
  return id;
}

export function listLocalWalks(storage: StoragePort): Item[] { return Object.values(read(storage).value.items); }
export function getLocalWalk(storage: StoragePort, id: string): Item | null { return read(storage).value.items[id] ?? null; }

export function saveLocalWalk(storage: StoragePort, document: WalkDocument, expectedRevision: number | null): Item {
  validateWalkDocument(document);
  const { value, raw } = read(storage);
  const prior = value.items[document.id];
  if (prior ? prior.revision !== expectedRevision : expectedRevision !== null) throw conflict();
  const item = { document, revision: prior ? prior.revision + 1 : 0, updatedAt: new Date().toISOString() };
  write(storage, raw, { ...value, items: { ...value.items, [document.id]: item } });
  return item;
}

export function deleteLocalWalk(storage: StoragePort, id: string, expectedRevision: number): void {
  const { value, raw } = read(storage);
  if (!value.items[id] || value.items[id].revision !== expectedRevision) throw conflict();
  const items = { ...value.items };
  delete items[id];
  write(storage, raw, { ...value, items, legacyId: value.legacyId === id ? null : value.legacyId });
}

export function exportLocalWalks(storage: StoragePort): string {
  return JSON.stringify({ library: read(storage).value, legacy: storage.getItem(LEGACY_WALK_KEY) }, null, 2);
}

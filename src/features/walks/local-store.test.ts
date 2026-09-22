import { describe, expect, it } from "vitest";
import { deleteLocalWalk, exportLocalWalks, getLocalWalk, listLocalWalks, migrateLocalWalks, saveLocalWalk, WALK_LIBRARY_KEY } from "./local-store";
import type { WalkDocument } from "./model";

const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.60 } };
const legacy = { version: 1, title: "Арбат", start, stops: [], mode: "open", minutes: 30, jobs: [], route: null, submitting: null };
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const document = (id: string): WalkDocument => ({ version: 2, id, title: "Арбат", description: "", city: "Москва", mode: "open", minutes: 30, start, stops: [], route: null, fieldChecked: false });

describe("локальная библиотека прогулок", () => {
  it("мигрирует единственный старый черновик один раз и оставляет оригинал", () => {
    const store = storage(); store.setItem("otgolosok:walk:v1", JSON.stringify(legacy));
    expect(migrateLocalWalks(store, () => first)).toBe(first);
    expect(migrateLocalWalks(store, () => second)).toBe(first);
    expect(listLocalWalks(store)).toHaveLength(1);
    expect(store.getItem("otgolosok:walk:v1")).toBe(JSON.stringify(legacy));
  });
  it("не мигрирует повторно черновик, уже записанный новым конструктором", () => {
    const store = storage();
    saveLocalWalk(store, document(first), null);
    store.setItem("otgolosok:walk:v1", JSON.stringify(legacy));
    store.setItem("otgolosok:walk:active-local", first);
    expect(migrateLocalWalks(store, () => second)).toBe(first);
    expect(listLocalWalks(store)).toHaveLength(1);
  });
  it("хранит независимые документы, проверяет ревизию и удаляет только выбранный", () => {
    const store = storage();
    expect(saveLocalWalk(store, document(first), null).revision).toBe(0);
    saveLocalWalk(store, document(second), null);
    expect(saveLocalWalk(store, { ...document(first), title: "Новый Арбат" }, 0).revision).toBe(1);
    expect(() => saveLocalWalk(store, document(first), 0)).toThrow(/другой вкладке/);
    deleteLocalWalk(store, first, 1);
    expect(getLocalWalk(store, first)).toBeNull();
    expect(getLocalWalk(store, second)?.document.id).toBe(second);
  });
  it("сохраняет исходные данные при ошибках схемы и записи", () => {
    const store = storage(); store.setItem("otgolosok:walk:v1", "{broken");
    expect(() => migrateLocalWalks(store, () => first)).toThrow(/исходная запись сохранена/);
    expect(store.getItem(WALK_LIBRARY_KEY)).toBeNull();
    expect(exportLocalWalks(store)).toContain("{broken");
    const unavailable = { ...store, setItem: (...args: [string, string]): void => { void args; throw new Error("Квота превышена"); } };
    expect(() => saveLocalWalk(unavailable, document(first), null)).toThrow(/Квота/);
    expect(store.getItem(WALK_LIBRARY_KEY)).toBeNull();
  });
});

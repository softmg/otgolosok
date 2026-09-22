import { placeFromQuery } from "../explore/map-jobs";
import { isPlace } from "./model";

export function creationInputError(search: URLSearchParams): string | null {
  const ids = ["local", "id", "catalog", "share"].filter(key => search.has(key));
  const incoming = ["address", "lat", "lon"].some(key => search.has(key));
  if (ids.length > 1 || (ids.length > 0 && (incoming || search.has("new") || search.has("resume"))) || (search.has("new") && search.has("resume"))) return "Ссылка содержит конфликтующие параметры.";
  if (ids.some(key => !["local", "id"].includes(key))) return "Редактировать можно только свою прогулку.";
  if (incoming && !isPlace(placeFromQuery(search))) return "В ссылке нет корректной точки начала. Выберите адрес в Москве.";
  return null;
}

export function creationLocation(search: URLSearchParams): string | null {
  const ids = ["local", "id", "catalog", "share"].filter(key => search.has(key));
  const creating = ["new", "resume", "address", "lat", "lon"].some(key => search.has(key));
  if (ids.length > 1 || (ids.length && creating) || (search.has("new") && search.has("resume"))) return null;
  if (search.get("edit") === "1" && (ids.length !== 1 || !["local", "id"].includes(ids[0]))) return null;
  if (!creating && search.get("edit") !== "1") return ids.length ? null : "/history";
  const result = new URLSearchParams(search);
  result.set("walk", "create");
  return `/?${result}`;
}

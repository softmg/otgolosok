"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { TourExperience } from "../tour/tour-experience";
import { creationLocation } from "../walk-builder/creation-location";
import { getLastUserId, getSession } from "../auth/client";
import { getLocalWalk, migrateLocalWalks } from "./local-store";
import { loadAccountWalkWithOfflineCopy, loadCatalogWalk, loadLocalWalkView, loadSharedWalk, WalkLoadError } from "./walk-loader";
import type { WalkView } from "./model";
import "./walks.css";

const keys = ["new", "resume", "local", "id", "catalog", "share"] as const;
type Loaded = { key: string; view: WalkView | null; error: string; offlineNotice: string };

export function WalkScreen() {
  const search = useSearchParams();
  const router = useRouter();
  const redirect = creationLocation(search);
  useEffect(() => { if (redirect) router.replace(redirect); }, [redirect, router]);
  const queryKey = search.toString();
  const [loaded, setLoaded] = useState<Loaded>({ key: "", view: null, error: "", offlineNotice: "" });
  const query = Object.fromEntries(keys.flatMap(key => { const value = search.get(key); return value ? [[key, value]] : []; }));
  const selected = keys.filter(key => query[key] !== undefined && !["new", "resume"].includes(key));
  const selectedKind = selected[0];
  const localId = query.local;
  const accountId = query.id;
  const catalogId = query.catalog;
  const shareToken = query.share;
  const edit = search.get("edit") === "1";
  const createIntent = search.get("new") === "1" || search.get("resume") === "1" || search.get("address") !== null || search.get("lat") !== null || search.get("lon") !== null;
  const queryConflict = selected.length > 1 || selected.length === 1 && createIntent || search.get("new") === "1" && search.get("resume") === "1";

  useEffect(() => {
    if (!selectedKind || edit || queryConflict) return;
    const controller = new AbortController();
    void (async () => {
      try {
        let view: WalkView;
        let offlineNotice = "";
        if (selectedKind === "local") {
          migrateLocalWalks(localStorage);
          const item = getLocalWalk(localStorage, localId);
          if (!item) throw new WalkLoadError("Локальная прогулка не найдена.", 404);
          view = await loadLocalWalkView(item.document, item.revision, controller.signal);
        } else if (selectedKind === "id") {
          const user = await getSession().catch(() => null);
          const result = await loadAccountWalkWithOfflineCopy(accountId, user?.id ?? getLastUserId(), controller.signal);
          view = result.view;
          if (result.offline) offlineNotice = `Офлайн-копия от ${new Date(result.savedAt).toLocaleDateString("ru-RU")}. Последняя редакция может быть новее.`;
        } else if (selectedKind === "catalog") view = await loadCatalogWalk(catalogId, controller.signal);
        else view = await loadSharedWalk(shareToken, controller.signal);
        if (!controller.signal.aborted) setLoaded({ key: queryKey, view, error: "", offlineNotice });
      } catch (caught) {
        if (!controller.signal.aborted) setLoaded({ key: queryKey, view: null, error: caught instanceof Error ? caught.message : "Не удалось открыть прогулку.", offlineNotice: "" });
      }
    })();
    return () => controller.abort();
  }, [queryKey, selectedKind, localId, accountId, catalogId, shareToken, edit, queryConflict]);

  if (queryConflict) return <WalkError message="Ссылка содержит конфликтующие параметры." />;
  if (edit && (selected.length !== 1 || !["local", "id"].includes(selected[0]))) return <WalkError message="Редактировать можно только свою прогулку." />;
  if (selected.length === 1 && edit) return <p role="status">Открываем карту…</p>;
  if (createIntent) return <p role="status">Открываем карту…</p>;
  if (selected.length === 0) return <p role="status">Открываем историю…</p>;
  const current = loaded.key === queryKey ? loaded : null;
  if (current?.error) return <WalkError message={current.error} />;
  if (!current?.view) return <main className="walk-screen"><p role="status">Открываем прогулку…</p></main>;
  return <>{current.offlineNotice ? <p className="walk-offline-notice walk-offline-notice--map" role="status">{current.offlineNotice}</p> : null}<TourExperience key={queryKey} walk={current.view} /></>;
}

function WalkError({ message }: { message: string }) {
  return <main className="walk-screen"><p className="walk-warning" role="alert">{message}</p><a href="/history">Вернуться к прогулкам</a></main>;
}

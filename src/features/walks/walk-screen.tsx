"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { TourExperience } from "../tour/tour-experience";
import { creationLocation } from "../walk-builder/creation-location";
import { getLastUserId, getSession } from "../auth/client";
import { getLocalWalk, migrateLocalWalks } from "./local-store";
import { loadAccountWalk, loadCatalogWalk, loadSharedWalk, loadWalkWithOfflineCopy, localWalkView, resolveLocalWalkView, WalkLoadError, type LoadedWalk } from "./walk-loader";
import { offlineWalkRef, type OfflineWalkRef } from "./offline";
import type { WalkView } from "./model";
import type { ReviewTarget } from "../reviews/model";
import { launchesPath } from "./launches";
import { ownWalkEditHref, ownWalkNotes, type OwnWalk } from "./own-walk";
import "./walks.css";
import { toUserMessage } from "@/lib/errors/user-message";

const keys = ["new", "resume", "local", "id", "catalog", "share"] as const;
type Loaded = { key: string; view: WalkView | null; error: string; offlineNotice: string; offlineRef: OfflineWalkRef | null };

export function WalkScreen() {
  const search = useSearchParams();
  const router = useRouter();
  const redirect = creationLocation(search);
  useEffect(() => { if (redirect) router.replace(redirect); }, [redirect, router]);
  const queryKey = search.toString();
  const [loaded, setLoaded] = useState<Loaded>({ key: "", view: null, error: "", offlineNotice: "", offlineRef: null });
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
        const signal = controller.signal;
        let result: LoadedWalk;
        let offlineRef: OfflineWalkRef | null;
        if (selectedKind === "local") {
          migrateLocalWalks(localStorage);
          const item = getLocalWalk(localStorage, localId);
          if (!item) throw new WalkLoadError("Локальная прогулка не найдена.", 404);
          offlineRef = offlineWalkRef("local", localId, null);
          // A copy of an older revision would hide the local edits; the walk then opens without stories.
          result = await loadWalkWithOfflineCopy(inner => resolveLocalWalkView(item.document, item.revision, inner), offlineRef, signal, saved => saved.revision === item.revision)
            .catch((error: unknown) => { if (signal.aborted) throw error; return { view: localWalkView(item.document, item.revision), offline: false as const }; });
        } else if (selectedKind === "id") {
          const user = await getSession().catch(() => null);
          offlineRef = offlineWalkRef("id", accountId, user?.id ?? getLastUserId());
          result = await loadWalkWithOfflineCopy(inner => loadAccountWalk(accountId, inner), offlineRef, signal);
        } else if (selectedKind === "catalog") {
          offlineRef = offlineWalkRef("catalog", catalogId, null);
          result = await loadWalkWithOfflineCopy(inner => loadCatalogWalk(catalogId, inner), offlineRef, signal);
        } else {
          offlineRef = offlineWalkRef("share", shareToken, null);
          result = await loadWalkWithOfflineCopy(inner => loadSharedWalk(shareToken, inner), offlineRef, signal);
        }
        const offlineNotice = result.offline ? `Офлайн-копия от ${new Date(result.savedAt).toLocaleDateString("ru-RU")}. Последняя редакция может быть новее.` : "";
        if (!signal.aborted) setLoaded({ key: queryKey, view: result.view, error: "", offlineNotice, offlineRef });
      } catch (caught) {
        if (!controller.signal.aborted) setLoaded({ key: queryKey, view: null, error: toUserMessage(caught, "Не удалось открыть прогулку."), offlineNotice: "", offlineRef: null });
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
  // Local guest walks exist only in this browser, so the server cannot accept reviews for them.
  const reviewTarget: ReviewTarget | null = selectedKind === "catalog" ? { kind: "catalog", id: catalogId }
    : selectedKind === "share" ? { kind: "share", token: shareToken }
    : selectedKind === "id" ? { kind: "account", id: accountId } : null;
  if (current?.error) return <WalkError message={current.error} />;
  if (!current?.view) return <main className="walk-screen"><p role="status">Открываем прогулку…</p></main>;
  // Only walks saved on this device or in the viewer's account lead back to the builder.
  const own: OwnWalk | null = selectedKind === "local" ? { editHref: ownWalkEditHref("local", localId), notes: ownWalkNotes(current.view) }
    : selectedKind === "id" ? { editHref: ownWalkEditHref("id", accountId), notes: ownWalkNotes(current.view) } : null;
  return <>{current.offlineNotice ? <p className="walk-offline-notice walk-offline-notice--map" data-region="notices" role="status">{current.offlineNotice}</p> : null}<TourExperience key={queryKey} walk={current.view} offline={current.offlineRef} reviewTarget={reviewTarget} launchTarget={launchesPath(reviewTarget) ? reviewTarget : null} own={own} /></>;
}

function WalkError({ message }: { message: string }) {
  return <main className="walk-screen"><p className="walk-warning" role="alert">{message}</p><a href="/history">Вернуться к прогулкам</a></main>;
}

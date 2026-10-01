"use client";

import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import { watchForSafeUpdate } from "@/lib/offline/auto-update";

const SHELL_UNAVAILABLE = "Офлайн-режим недоступен в этом браузере.";
const subscribeNever = () => () => {};

/**
 * Registers the Service Worker that keeps the app shell available offline and
 * reports whether a newer version is waiting. A waiting version is applied on
 * its own once `canApplyUpdate` allows it and the reload goes unnoticed; until
 * then `updateAvailable` offers it manually. `shellStatus` is empty while the
 * offline shell works.
 */
export function useOfflineShell(canApplyUpdate: () => boolean = () => true): { shellStatus: string; updateAvailable: boolean } {
  const [offlineStatus, setOfflineStatus] = useState("");
  const [updateAvailable, setUpdateAvailable] = useState(false);
  // The static HTML assumes support; the client snapshot reveals browsers without Service Worker.
  const serviceWorkerMissing = useSyncExternalStore(subscribeNever, () => process.env.NODE_ENV === "production" && !("serviceWorker" in navigator), () => false);
  const canApply = useEffectEvent(canApplyUpdate);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;

    let cancelled = false;
    const cleanups: Array<() => void> = [];
    void navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    }).then(async (registration) => {
      if (cancelled) return;
      const autoUpdate = watchForSafeUpdate({
        registration, serviceWorker: navigator.serviceWorker, document, window,
        canApply: () => canApply(), reload: () => window.location.reload(),
      });
      cleanups.push(autoUpdate.dispose);
      const checkUpdate = () => {
        if (cancelled) return;
        setUpdateAvailable(Boolean(registration.waiting));
        autoUpdate.check();
      };
      const watchInstalling = () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", checkUpdate);
        cleanups.push(() => worker.removeEventListener("statechange", checkUpdate));
      };
      const checkOnReturn = () => {
        if (document.visibilityState === "visible") void registration.update().catch(() => {});
      };
      registration.addEventListener("updatefound", watchInstalling);
      document.addEventListener("visibilitychange", checkOnReturn);
      window.addEventListener("online", checkOnReturn);
      cleanups.push(() => {
        registration.removeEventListener("updatefound", watchInstalling);
        document.removeEventListener("visibilitychange", checkOnReturn);
        window.removeEventListener("online", checkOnReturn);
      });
      watchInstalling();
      checkUpdate();
      if (!registration.active) {
        const worker = registration.installing ?? registration.waiting;
        if (!worker) throw new Error("Service Worker did not start");
        await new Promise<void>((resolve, reject) => {
          const check = () => {
            if (worker.state === "activated" || worker.state === "redundant") {
              worker.removeEventListener("statechange", check);
              if (worker.state === "activated") resolve();
              else reject(new Error("Offline installation failed"));
            }
          };
          worker.addEventListener("statechange", check);
          cleanups.push(() => worker.removeEventListener("statechange", check));
          check();
        });
      }
      if (!cancelled) setOfflineStatus("");
    }).catch(() => {
      if (!cancelled) setOfflineStatus(SHELL_UNAVAILABLE);
    });
    return () => {
      cancelled = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  return { shellStatus: serviceWorkerMissing ? SHELL_UNAVAILABLE : offlineStatus, updateAvailable };
}

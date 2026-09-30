import { useEffect, useState } from "react";
import { loadPublishedCatalog, type CatalogProgress } from "./published-catalog";

export function usePublishedCatalog() {
  const [progress, setProgress] = useState<CatalogProgress>({ places: [], total: 0 });
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void loadPublishedCatalog(controller.signal, setProgress).then(() => {
      if (!controller.signal.aborted) setStatus("ready");
    }).catch(() => {
      if (!controller.signal.aborted) setStatus("error");
    });
    return () => controller.abort();
  }, [attempt]);
  const retry = () => { setStatus("loading"); setAttempt(value => value + 1); };
  return { ...progress, status, retry };
}

import { useCallback, useEffect, useRef } from "react";
import { csrfHeaders } from "../auth/client";
import { resolveReviewer } from "../reviews/api";
import { getReviewKey } from "../reviews/device";
import type { ReviewTarget } from "../reviews/model";
import { loadJson } from "./walk-loader";

/** Launches are counted for catalog and link walks only; own and local walks never are. */
export function launchesPath(target: ReviewTarget | null) {
  if (target?.kind === "catalog") return `/api/story-walks/${encodeURIComponent(target.id)}/launches`;
  if (target?.kind === "share") return `/api/story-walks/shared/${encodeURIComponent(target.token)}/launches`;
  return null;
}

function validateLaunch(value: unknown) {
  if (!value || typeof value !== "object" || typeof (value as { counted?: unknown }).counted !== "boolean") throw new TypeError("Неверный ответ.");
  return (value as { counted: boolean }).counted;
}

/**
 * Reports one press of «Начать прогулку». The server deduplicates a viewer per walk per day,
 * so the bounded retries of loadJson are safe. Resolves false when nothing was sent.
 */
export async function reportWalkLaunch(target: ReviewTarget | null, signal: AbortSignal): Promise<boolean> {
  const path = launchesPath(target);
  if (!path) return false;
  const reviewer = await resolveReviewer();
  let headers: Record<string, string>;
  if (reviewer.kind === "user") headers = csrfHeaders();
  else {
    const key = getReviewKey({ create: true });
    if (!key) return false;
    headers = { "X-Review-Key": key };
  }
  if (signal.aborted) return false;
  return loadJson(path, signal, validateLaunch, 3, {}, { headers });
}

/**
 * Returns a callback that reports the launch at most once per mounted walk, so resuming or
 * restarting in the same page session is not counted again. Counting never breaks the walk:
 * every failure is swallowed, and the request is aborted on unmount.
 */
export function useLaunchReport(target: ReviewTarget | null) {
  const sent = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  return useCallback(() => {
    if (sent.current || !launchesPath(target)) return;
    sent.current = true;
    const current = new AbortController();
    controller.current = current;
    reportWalkLaunch(target, current.signal).catch(() => {});
  }, [target]);
}

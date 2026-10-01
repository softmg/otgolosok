import { csrfHeaders, getSession } from "../auth/client";
import { loadJson } from "../walks/walk-loader";
import { getReviewKey } from "./device";
import { reviewsPath, validateReviewPage, validateReviewWrite, type ReviewInput, type ReviewTarget } from "./model";

export type Reviewer = { kind: "user"; name: string } | { kind: "guest" };

export class ReviewKeyUnavailableError extends Error {
  constructor() {
    super("Браузер не даёт сохранить ключ отзыва. Войдите, чтобы оставить отзыв.");
    this.name = "ReviewKeyUnavailableError";
  }
}

/** Also refreshes the CSRF token; a failed session check falls back to a guest. */
export async function resolveReviewer(): Promise<Reviewer> {
  try {
    const user = await getSession();
    return user ? { kind: "user", name: user.name } : { kind: "guest" };
  } catch {
    return { kind: "guest" };
  }
}

function identityHeaders(reviewer: Reviewer, write: boolean): Record<string, string> {
  if (reviewer.kind === "user") return write ? csrfHeaders() : {};
  const key = getReviewKey({ create: write });
  if (!key && write) throw new ReviewKeyUnavailableError();
  return key ? { "X-Review-Key": key } : {};
}

export function loadReviews(target: ReviewTarget, reviewer: Reviewer, cursor: string | null, signal: AbortSignal) {
  const url = reviewsPath(target) + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
  return loadJson(url, signal, validateReviewPage, 3, undefined, { headers: identityHeaders(reviewer, false) });
}

// PUT is an upsert and DELETE is idempotent, so both share the bounded retries of loadJson.
export function saveReview(target: ReviewTarget, reviewer: Reviewer, input: ReviewInput, signal: AbortSignal) {
  return loadJson(`${reviewsPath(target)}/mine`, signal, validateReviewWrite, 3, input, { method: "PUT", headers: identityHeaders(reviewer, true) });
}

export function deleteReview(target: ReviewTarget, reviewer: Reviewer, signal: AbortSignal) {
  return loadJson(`${reviewsPath(target)}/mine`, signal, validateReviewWrite, 3, undefined, { method: "DELETE", headers: identityHeaders(reviewer, true) });
}

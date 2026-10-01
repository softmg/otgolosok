import { targetKey, type ReviewInput, type ReviewTarget } from "./model";

// Storage may be missing or throw (private mode, quota, blocked site data):
// every helper degrades to "nothing stored" instead of breaking the walk screen.
const KEY = "otgolosok:review-key:v1";
const DRAFT = "otgolosok:walk-reviews:draft:v1:";

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The guest's device key: 32 random bytes; null when the browser cannot keep it. */
export function getReviewKey({ create }: { create: boolean }): string | null {
  const store = storage();
  if (!store) return null;
  try {
    const existing = store.getItem(KEY);
    if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
    if (!create) return null;
    const key = base64url(crypto.getRandomValues(new Uint8Array(32)));
    store.setItem(KEY, key);
    return store.getItem(KEY) === key ? key : null;
  } catch {
    return null;
  }
}

export function saveReviewDraft(target: ReviewTarget, draft: ReviewInput) {
  try { storage()?.setItem(DRAFT + targetKey(target), JSON.stringify(draft)); } catch { /* The draft is a convenience only. */ }
}

export function loadReviewDraft(target: ReviewTarget): ReviewInput | null {
  try {
    const value = JSON.parse(storage()?.getItem(DRAFT + targetKey(target)) ?? "null") as Partial<ReviewInput> | null;
    if (!value || typeof value.text !== "string" || !Number.isInteger(value.rating) || value.rating! < 0 || value.rating! > 5) return null;
    return { rating: value.rating!, text: value.text };
  } catch {
    return null;
  }
}

export function clearReviewDraft(target: ReviewTarget) {
  try { storage()?.removeItem(DRAFT + targetKey(target)); } catch { /* Nothing to clear. */ }
}

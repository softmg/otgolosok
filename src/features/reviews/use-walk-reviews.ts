"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toUserMessage } from "@/lib/errors/user-message";
import { deleteReview, loadReviews, resolveReviewer, saveReview, type Reviewer } from "./api";
import { clearReviewDraft, saveReviewDraft } from "./device";
import { targetKey, type MyReview, type PublicReview, type ReviewInput, type ReviewStatus, type ReviewSummary, type ReviewTarget } from "./model";

export type ReviewsState = "idle" | "loading" | "ready" | "unavailable";
export type ReviewActionResult = { ok: true; status: ReviewStatus | null } | { ok: false; message: string };

export type WalkReviewsModel = {
  target: ReviewTarget | null;
  state: ReviewsState;
  reviewer: Reviewer | null;
  summary: ReviewSummary | null;
  reviews: PublicReview[];
  nextCursor: string | null;
  mine: MyReview | null;
  loadingMore: boolean;
  reload: () => void;
  loadMore: () => Promise<void>;
  save: (input: ReviewInput) => Promise<ReviewActionResult>;
  remove: () => Promise<ReviewActionResult>;
};

type Data = { key: string; state: ReviewsState; reviewer: Reviewer | null; summary: ReviewSummary | null; reviews: PublicReview[]; nextCursor: string | null; mine: MyReview | null };
const empty = (key: string, state: ReviewsState): Data => ({ key, state, reviewer: null, summary: null, reviews: [], nextCursor: null, mine: null });

/** Reviews never break the walk: any load failure, network or schema, ends in "unavailable". */
export function useWalkReviews(target: ReviewTarget | null): WalkReviewsModel {
  const key = target ? targetKey(target) : "";
  // The target object may be recreated on every render; only its key restarts loading.
  const targetRef = useRef(target);
  useEffect(() => { targetRef.current = target; });
  const [data, setData] = useState<Data>(() => empty(key, target ? "loading" : "idle"));
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const mounted = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    mounted.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const current = targetRef.current;
    if (!current) { setData(empty("", "idle")); return; }
    const controller = new AbortController();
    setData(previous => ({ ...(previous.key === key ? previous : empty(key, "loading")), state: "loading" }));
    void (async () => {
      const reviewer = await resolveReviewer();
      if (controller.signal.aborted) return;
      try {
        const page = await loadReviews(current, reviewer, null, controller.signal);
        setData({ key, state: "ready", reviewer, ...page });
      } catch {
        if (!controller.signal.aborted) setData({ ...empty(key, "unavailable"), reviewer });
      }
    })();
    return () => controller.abort();
  }, [key, attempt]);

  const current = data.key === key ? data : empty(key, target ? "loading" : "idle");

  const loadMore = useCallback(async () => {
    const active = targetRef.current;
    if (!active || !data.reviewer || !data.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await loadReviews(active, data.reviewer, data.nextCursor, mounted.current.signal);
      setData(previous => previous.key !== key ? previous : { ...previous, summary: page.summary, reviews: [...previous.reviews, ...page.reviews], nextCursor: page.nextCursor });
    } catch {
      // The button stays, so the user can try again; the loaded part of the list is kept.
    } finally {
      if (!mounted.current.signal.aborted) setLoadingMore(false);
    }
  }, [data.nextCursor, data.reviewer, key, loadingMore]);

  const write = useCallback(async (input: ReviewInput | null): Promise<ReviewActionResult> => {
    const active = targetRef.current;
    if (!active) return { ok: false, message: "Отзывы к этой прогулке недоступны." };
    const reviewer = data.reviewer ?? await resolveReviewer();
    if (input) saveReviewDraft(active, input);
    try {
      const result = input
        ? await saveReview(active, reviewer, input, mounted.current.signal)
        : await deleteReview(active, reviewer, mounted.current.signal);
      clearReviewDraft(active);
      setData(previous => previous.key !== key ? previous : { ...previous, reviewer, summary: result.summary, mine: result.mine });
      return { ok: true, status: result.mine?.status ?? null };
    } catch (error) {
      return { ok: false, message: toUserMessage(error, input ? "Не удалось отправить отзыв. Повторите попытку." : "Не удалось удалить отзыв. Повторите попытку.") };
    }
  }, [data.reviewer, key]);

  return {
    target, state: current.state, reviewer: current.reviewer, summary: current.summary, reviews: current.reviews, nextCursor: current.nextCursor, mine: current.mine,
    loadingMore,
    reload: useCallback(() => setAttempt(value => value + 1), []),
    loadMore,
    save: useCallback((input: ReviewInput) => write(input), [write]),
    remove: useCallback(() => write(null), [write]),
  };
}

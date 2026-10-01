"use client";

import { useState } from "react";
import { formatRatingSummary } from "./model";
import { ReviewForm } from "./review-form";
import type { WalkReviewsModel } from "./use-walk-reviews";
import styles from "./walk-reviews.module.css";

export type ReviewIntent = "read" | "rate";

function Stars({ rating }: { rating: number }) {
  return <span className={styles.ratingStars} role="img" aria-label={`Оценка ${rating} из 5`}>{"★".repeat(rating)}{"☆".repeat(5 - rating)}</span>;
}

function currentWalkHref() {
  return typeof location === "undefined" ? "/walk" : `${location.pathname}${location.search}`;
}

/** Summary, published texts and, on request, the author's own form. */
export function WalkReviews({ reviews, intent }: { reviews: WalkReviewsModel; intent: ReviewIntent }) {
  const [formOpen, setFormOpen] = useState(intent === "rate");
  const { target, state, summary, mine, reviewer } = reviews;
  if (!target) return null;
  if (state === "unavailable") {
    return <div className={styles.root}>
      <p className={styles.message} role="status">Отзывы сейчас недоступны.</p>
      <button type="button" className={styles.secondary} onClick={reviews.reload}>Повторить</button>
    </div>;
  }
  if (state !== "ready") return <div className={styles.root}><p className={styles.message} role="status">Загружаем отзывы…</p></div>;
  return <div className={styles.root}>
    <p className={styles.summary}>{formatRatingSummary(summary) || "Оценок пока нет"}</p>
    {formOpen ? <ReviewForm target={target} reviewer={reviewer} mine={mine} save={reviews.save} remove={reviews.remove}
      loginHref={`/login?returnTo=${encodeURIComponent(currentWalkHref())}`} />
      : <button type="button" className={styles.secondary} onClick={() => setFormOpen(true)}>{mine ? "Изменить отзыв" : "Оставить отзыв"}</button>}
    {reviews.reviews.length ? <ul className={styles.list} aria-label="Отзывы">
      {reviews.reviews.map(review => <li key={review.id} className={styles.item}>
        <p className={styles.itemHead}><strong>{review.author}</strong><Stars rating={review.rating} />
          <time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleDateString("ru-RU")}</time></p>
        <p className={styles.itemText}>{review.text}</p>
      </li>)}
    </ul> : null}
    {reviews.nextCursor ? <button type="button" className={styles.secondary} disabled={reviews.loadingMore} onClick={() => void reviews.loadMore()}>
      {reviews.loadingMore ? "Загружаем…" : "Показать ещё"}</button> : null}
  </div>;
}

"use client";

import { formatRatingSummary } from "./model";
import type { WalkReviewsModel } from "./use-walk-reviews";
import styles from "./walk-reviews.module.css";

function Stars({ rating }: { rating: number }) {
  return <span className={styles.ratingStars} role="img" aria-label={`Оценка ${rating} из 5`}>{"★".repeat(rating)}{"☆".repeat(5 - rating)}</span>;
}

/** Summary and published texts; the author's own form opens in ReviewDialog. */
export function WalkReviews({ reviews, onRate }: { reviews: WalkReviewsModel; onRate: () => void }) {
  const { target, state, summary, mine } = reviews;
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
    <button type="button" className={styles.secondary} aria-haspopup="dialog" onClick={onRate}>{mine ? "Изменить отзыв" : "Оставить отзыв"}</button>
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

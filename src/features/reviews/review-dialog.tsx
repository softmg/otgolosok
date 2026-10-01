"use client";

import { useEffect, useId, useRef } from "react";
import { ExploreIcon } from "../explore/icons";
import { ReviewForm } from "./review-form";
import type { WalkReviewsModel } from "./use-walk-reviews";
import styles from "./walk-reviews.module.css";

function currentWalkHref() {
  return typeof location === "undefined" ? "/walk" : `${location.pathname}${location.search}`;
}

/** The rating form in its own modal window over the walk screen. */
export function ReviewDialog({ reviews, open, onClose, walkTitle }: { reviews: WalkReviewsModel; open: boolean; onClose: () => void; walkTitle: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { target, state, mine, reviewer } = reviews;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      // Browsers without modal dialogs still show the form, just without the backdrop.
      try { element.showModal(); } catch { element.setAttribute("open", ""); }
    } else if (!open && element.open) element.close();
  }, [open]);

  if (!target) return null;
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onClose={onClose}
    onClick={event => {
      // A click on the backdrop lands on the dialog element itself, outside its box.
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header className={styles.dialogHeader}>
      <div>
        <h2 id={titleId}>{mine ? "Ваш отзыв" : "Оцените прогулку"}</h2>
        <p>{walkTitle}</p>
      </div>
      <button type="button" className={styles.close} aria-label="Закрыть" onClick={onClose}><ExploreIcon name="close" /></button>
    </header>
    {!open ? null : state === "unavailable" ? <div className={styles.root}>
      <p className={styles.message} role="status">Отзывы сейчас недоступны.</p>
      <button type="button" className={styles.secondary} onClick={reviews.reload}>Повторить</button>
    </div> : state !== "ready" ? <p className={styles.message} role="status">Загружаем отзывы…</p>
      : <ReviewForm target={target} reviewer={reviewer} mine={mine} save={reviews.save} remove={reviews.remove}
        loginHref={`/login?returnTo=${encodeURIComponent(currentWalkHref())}`} labelledBy={titleId} onDone={onClose} />}
  </dialog>;
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ExploreIcon } from "../explore/icons";
import { ReviewForm } from "./review-form";
import type { WalkReviewsModel } from "./use-walk-reviews";
import styles from "./walk-reviews.module.css";

/** How long the thank-you message stays before the window closes itself. */
export const REVIEW_SENT_CLOSE_MS = 3000;

function currentWalkHref() {
  return typeof location === "undefined" ? "/walk" : `${location.pathname}${location.search}`;
}

/**
 * The rating form in its own modal window over the walk screen. It only sends:
 * after a successful send it thanks the author and closes itself.
 */
export function ReviewDialog({ reviews, open, onClose, walkTitle }: { reviews: WalkReviewsModel; open: boolean; onClose: () => void; walkTitle: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { target, state, mine, reviewer } = reviews;
  const [sent, setSent] = useState<string | null>(null);
  // Fixed when the window opens, so a successful send does not retitle it under the thank-you message.
  const [title, setTitle] = useState("Оцените прогулку");
  const [openedWith, setOpenedWith] = useState(false);
  if (openedWith !== open) {
    setOpenedWith(open);
    if (open) { setSent(null); setTitle(mine ? "Ваш отзыв" : "Оцените прогулку"); }
  }
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      // Browsers without modal dialogs still show the form, just without the backdrop.
      try { element.showModal(); } catch { element.setAttribute("open", ""); }
    } else if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (!open || sent === null) return;
    const timer = setTimeout(() => closeRef.current(), REVIEW_SENT_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [open, sent]);

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
        <h2 id={titleId}>{title}</h2>
        <p>{walkTitle}</p>
      </div>
      <button type="button" className={styles.close} aria-label="Закрыть" onClick={onClose}><ExploreIcon name="close" /></button>
    </header>
    {!open ? null : sent !== null ? <p className={styles.sent} role="status">{sent || "Спасибо!"}</p>
      : state === "unavailable" ? <div className={styles.root}>
        <p className={styles.message} role="status">Отзывы сейчас недоступны.</p>
        <button type="button" className={styles.secondary} onClick={reviews.reload}>Повторить</button>
      </div> : state !== "ready" ? <p className={styles.message} role="status">Загружаем отзывы…</p>
      : <ReviewForm target={target} reviewer={reviewer} mine={mine} save={reviews.save} remove={reviews.remove}
        loginHref={`/login?returnTo=${encodeURIComponent(currentWalkHref())}`} labelledBy={titleId} onSent={setSent} />}
  </dialog>;
}

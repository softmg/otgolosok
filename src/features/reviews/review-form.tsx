"use client";

import { useId, useState, type FormEvent } from "react";
import { getReviewKey, loadReviewDraft } from "./device";
import { REVIEW_TEXT_MAX, type MyReview, type ReviewStatus, type ReviewTarget } from "./model";
import type { ReviewActionResult } from "./use-walk-reviews";
import type { Reviewer } from "./api";
import styles from "./walk-reviews.module.css";

const starLabels = ["1 звезда из 5", "2 звезды из 5", "3 звезды из 5", "4 звезды из 5", "5 звёзд из 5"];
const statusMessages: Record<ReviewStatus, string> = {
  published: "Спасибо! Оценка учтена.",
  pending: "Спасибо! Отзыв появится после проверки редакцией.",
  hidden: "Отзыв скрыт редакцией.",
};

export const codePoints = (text: string) => [...text].length;

export type ReviewFormProps = {
  target: ReviewTarget;
  reviewer: Reviewer | null;
  mine: MyReview | null;
  save: (input: { rating: number; text: string }) => Promise<ReviewActionResult>;
  remove: () => Promise<ReviewActionResult>;
  loginHref: string;
  /** The id of an outer heading (the dialog title); the form then renders no title of its own. */
  labelledBy?: string;
  /** Shown as «Готово» after a successful save or delete. */
  onDone?: () => void;
};

export function ReviewForm({ target, reviewer, mine, save, remove, loginHref, labelledBy, onDone }: ReviewFormProps) {
  const id = useId();
  // A draft left by a failed send wins over the stored review: it holds the user's latest intent.
  const [initial] = useState(() => loadReviewDraft(target) ?? (mine ? { rating: mine.rating, text: mine.text } : { rating: 0, text: "" }));
  const [rating, setRating] = useState(initial.rating);
  const [text, setText] = useState(initial.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [confirming, setConfirming] = useState(false);
  const guest = reviewer?.kind !== "user";
  const [keyMissing] = useState(() => guest && !getReviewKey({ create: true }));

  if (keyMissing) {
    return <div className={styles.form}>
      <p className={styles.message} role="status">Браузер не даёт сохранить ключ отзыва. Войдите, чтобы оставить отзыв.</p>
      <a className={styles.secondary} href={loginHref}>Войти</a>
    </div>;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!rating || busy) return;
    setBusy(true); setError(""); setStatus("");
    const result = await save({ rating, text: text.trim() });
    setBusy(false);
    if (result.ok) setStatus(result.status ? statusMessages[result.status] : "");
    else setError(result.message);
  }

  async function confirmDelete() {
    setBusy(true); setError(""); setStatus("");
    const result = await remove();
    setBusy(false); setConfirming(false);
    if (result.ok) { setRating(0); setText(""); setStatus("Отзыв удалён."); }
    else setError(result.message);
  }

  return <form className={styles.form} onSubmit={event => void submit(event)} aria-labelledby={labelledBy ?? `${id}-title`}>
    {labelledBy ? null : <h2 id={`${id}-title`} className={styles.formTitle}>{mine ? "Ваш отзыв" : "Оцените прогулку"}</h2>}
    {mine?.status === "pending" ? <p className={styles.badge}>На модерации</p> : null}
    {mine?.status === "hidden" ? <p className={styles.badge}>Скрыт редакцией</p> : null}
    <fieldset className={styles.stars}>
      <legend>Оценка</legend>
      <div className={styles.starRow}>
        {starLabels.map((label, index) => {
          const value = index + 1;
          return <label key={value} className={styles.star} data-filled={value <= rating ? "true" : undefined} data-checked={value === rating ? "true" : undefined}>
            <input type="radio" name={`${id}-rating`} value={value} checked={value === rating} onChange={() => setRating(value)} aria-label={label} />
            <span aria-hidden="true">{value <= rating ? "★" : "☆"}</span>
          </label>;
        })}
      </div>
    </fieldset>
    <label className={styles.textLabel} htmlFor={`${id}-text`}>Отзыв (необязательно)</label>
    <textarea id={`${id}-text`} className={styles.textarea} value={text} maxLength={REVIEW_TEXT_MAX} rows={3}
      onChange={event => setText(event.target.value)} aria-describedby={`${id}-counter ${id}-disclosure`} />
    <p id={`${id}-counter`} className={styles.counter} aria-live="polite">{codePoints(text)} / {REVIEW_TEXT_MAX}</p>
    <p id={`${id}-disclosure`} className={styles.hint}>{reviewer?.kind === "user"
      ? `Отзыв будет опубликован с именем «${reviewer.name}».`
      : "Отзыв будет опубликован от имени «Гость». Изменить его можно только в этом браузере."}</p>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {status ? <p className={styles.message} role="status">{status}</p> : null}
    {status && onDone ? <button type="button" className={styles.primary} onClick={onDone}>Готово</button> : null}
    <button type="submit" className={status && onDone ? styles.secondary : styles.primary} disabled={!rating || busy}>{busy ? "Отправляем…" : error ? "Повторить" : mine ? "Сохранить изменения" : "Отправить отзыв"}</button>
    {mine ? confirming ? <div className={styles.confirm} role="group" aria-label="Подтверждение удаления">
      <span>Удалить отзыв?</span>
      <button type="button" className={styles.danger} disabled={busy} onClick={() => void confirmDelete()}>Удалить</button>
      <button type="button" className={styles.secondary} disabled={busy} onClick={() => setConfirming(false)}>Отмена</button>
    </div> : <button type="button" className={styles.secondary} disabled={busy} onClick={() => setConfirming(true)}>Удалить отзыв</button> : null}
  </form>;
}

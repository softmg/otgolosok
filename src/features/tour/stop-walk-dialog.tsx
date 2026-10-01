"use client";

import { useEffect, useId, useRef } from "react";
import styles from "./stop-walk-dialog.module.css";

/**
 * «Прервать прогулку?»: a native modal that confirms stopping a running walk.
 * Escape, a click on the backdrop and «Продолжить» keep walking; only «Прервать» calls `onConfirm`.
 */
export function StopWalkDialog({ open, onCancel, onConfirm }: { open: boolean; onCancel: () => void; onConfirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const textId = useId();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      // Browsers without modal dialogs still show the question, just without the backdrop.
      try { element.showModal(); } catch { element.setAttribute("open", ""); }
    } else if (!open && element.open) element.close();
  }, [open]);

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} aria-describedby={textId} onClose={onCancel}
    onClick={event => {
      // A click on the backdrop lands on the dialog element itself, outside its box.
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onCancel();
    }}>
    <h2 id={titleId}>Прервать прогулку?</h2>
    <p id={textId}>Звук остановится, и вы вернётесь к описанию маршрута. Начать заново можно в любой момент.</p>
    <div className={styles.actions}>
      {/* The safe answer comes first and takes the initial focus. */}
      <button type="button" className={styles.secondary} autoFocus onClick={onCancel}>Продолжить</button>
      <button type="button" className={styles.danger} onClick={onConfirm}>Прервать</button>
    </div>
  </dialog>;
}

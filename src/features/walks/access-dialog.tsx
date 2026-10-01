"use client";

import { useEffect, useId, useRef, useState } from "react";
import { accountApi } from "../auth/client";
import { ExploreIcon } from "../explore/icons";
import { toUserMessage } from "@/lib/errors/user-message";
import type { WalkCard } from "./walk-loader";
import styles from "./access-dialog.module.css";

export type WalkVisibility = NonNullable<WalkCard["visibility"]>;
export type AccessCard = Pick<WalkCard, "id" | "title" | "revision" | "visibility" | "listingStatus"> & { draft?: boolean };

const OPTIONS: Array<{ value: WalkVisibility; label: string; hint: string }> = [
  { value: "private", label: "Только я", hint: "Прогулку видите только вы." },
  { value: "shared", label: "По ссылке", hint: "Открыть сможет любой, у кого есть ссылка." },
  { value: "public", label: "Доступно всем", hint: "По ссылке и в «Топе прогулок» после проверки редакцией." },
];

/** Access line of an account card, in words: the state is never shown by colour alone. */
export function accessLabel(card: Pick<WalkCard, "visibility" | "listingStatus">) {
  if (card.visibility === "shared") return "По ссылке";
  if (card.visibility !== "public") return "Только я";
  if (card.listingStatus === "approved") return "Всем · в топе";
  if (card.listingStatus === "hidden") return "Всем · скрыта редакцией из топа";
  return "Всем · на проверке";
}

/**
 * «Доступ к прогулке»: a native modal with the three access levels of an account walk.
 * `onSaved` receives the updated walk from the server.
 */
export function AccessDialog({ card, onClose, onSaved }: { card: AccessCard | null; onClose: () => void; onSaved: (walk: WalkCard) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const hintId = useId();
  const [choice, setChoice] = useState<WalkVisibility>("private");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openedFor, setOpenedFor] = useState<AccessCard | null>(null);
  if (openedFor !== card) {
    setOpenedFor(card);
    if (card) { setChoice(card.visibility ?? "private"); setError(""); setBusy(false); }
  }

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (card && !element.open) {
      try { element.showModal(); } catch { element.setAttribute("open", ""); }
    } else if (!card && element.open) element.close();
  }, [card]);

  async function save() {
    if (!card || busy) return;
    if (choice === card.visibility) { onClose(); return; }
    setBusy(true); setError("");
    try {
      const data = await accountApi(`/api/me/walks/${encodeURIComponent(card.id)}/sharing`, { method: "PUT", body: JSON.stringify({ revision: card.revision, visibility: choice }) });
      onSaved(data.walk as WalkCard);
    } catch (caught) {
      const status = (caught as { status?: number }).status, code = (caught as { code?: string | null }).code;
      setError(status === 409 && code !== "WALK_NOT_READY"
        ? "Прогулка изменилась на другом устройстве. Обновите страницу и повторите."
        : toUserMessage(caught, "Не удалось изменить доступ."));
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onClose={onClose}
    onClick={event => {
      // A click on the backdrop lands on the dialog element itself, outside its box.
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    <header className={styles.header}>
      <div>
        <h2 id={titleId}>Доступ к прогулке</h2>
        {card && <p>{card.title}</p>}
      </div>
      <button type="button" className={styles.close} aria-label="Закрыть" onClick={onClose}><ExploreIcon name="close" /></button>
    </header>
    {card && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset className={styles.options} disabled={busy}>
        <legend className={styles.legend}>Кто может открыть прогулку</legend>
        {OPTIONS.map(option => {
          const blocked = option.value === "public" && card.draft;
          return <label key={option.value} className={styles.option}>
            <input type="radio" name="visibility" value={option.value} checked={choice === option.value} disabled={blocked}
              aria-describedby={blocked ? hintId : undefined} onChange={() => setChoice(option.value)} />
            <span><strong>{option.label}</strong><span>{option.hint}</span>
              {blocked && <span id={hintId} className={styles.blocked}>Сначала постройте маршрут.</span>}</span>
          </label>;
        })}
      </fieldset>
      {card.visibility === "public" && card.listingStatus === "hidden" && <p className={styles.note}>Редакция скрыла прогулку из топа. Ссылка продолжает работать.</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={onClose}>Отмена</button>
        <button type="submit" className={styles.primary} disabled={busy}>{busy ? "Сохраняем…" : "Сохранить"}</button>
      </div>
    </form>}
  </dialog>;
}

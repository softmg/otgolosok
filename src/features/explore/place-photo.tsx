"use client";

import Image from "next/image";
import { useId, useRef, useState, type CSSProperties } from "react";
import { ExploreIcon } from "./icons";
import type { PlacePhoto } from "./place-story";
import styles from "./place-photo.module.css";

export type { PlacePhoto };

/** The tallest width-to-height ratio of the photo in the expanded story card: a little taller than a square. */
export const TALLEST_RATIO = 4 / 5;

/**
 * The wide photo on top of a place card, as in map apps; a tap opens the full image with its credit.
 * The caller keys it by place so loading failures cannot leak into the next card. `pending` holds an
 * empty banner while the photo of a place known to have one is loading, so the card never jumps.
 * Renders nothing without a photo or after the banner image fails.
 * With `onPreview` the banner is only a picture: a tap calls it (the story card expands) instead of opening the
 * viewer, and it is no separate control, since keyboard users have the card's own handle.
 */
export function PlacePhotoBanner({ photo, pending = false, title, onPreview }: { photo?: PlacePhoto; pending?: boolean; title: string; onPreview?: () => void }) {
  const [bannerFailed, setBannerFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [openFailed, setOpenFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialogTitle = useId();

  // Static on purpose: no shimmer, so it is safe with reduced motion.
  if (!photo && pending) return <span aria-hidden="true" className={styles.placeholder} data-photo-placeholder />;
  if (!photo || bannerFailed) return null;
  const image = <Image unoptimized src={photo.src} width={photo.width} height={photo.height} alt={photo.alt}
    loading="eager" onError={() => setBannerFailed(true)} />;
  // The expanded story shows the photo whole, but a tall one no taller than 4:5: the text must stay in sight.
  const ratio = { "--photo-ratio": Math.max(photo.width / photo.height, TALLEST_RATIO) } as CSSProperties;
  if (onPreview) return <span className={`${styles.banner} ${styles.preview}`} style={ratio} onClick={onPreview} data-photo-banner>{image}</span>;

  function showPhoto() {
    try {
      dialog.current?.showModal();
      setOpen(true);
      setImageFailed(false);
      setOpenFailed(false);
      closeButton.current?.focus();
    } catch {
      setOpenFailed(true);
    }
  }

  return <>
    <button ref={trigger} type="button" className={styles.banner} style={ratio} onClick={showPhoto} data-photo-banner
      aria-label={`Открыть фото: ${title}`} aria-haspopup="dialog">
      {/* The full copy: the 250 px preview would be blurry stretched across the card, and the viewer then opens from cache. */}
      {image}
    </button>
    {openFailed ? <p className={styles.status} role="status">Не удалось открыть фотографию. Попробуйте ещё раз.</p> : null}
    <dialog ref={dialog} className={styles.viewer} aria-labelledby={dialogTitle}
      onClose={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.current?.close();
      }}>
      <header className={styles.viewerHeader}>
        <h3 id={dialogTitle}>{title}</h3>
        <button ref={closeButton} type="button" className={styles.close} aria-label="Закрыть фото" onClick={() => dialog.current?.close()}><ExploreIcon name="close" /></button>
      </header>
      {open ? imageFailed ? <div className={styles.error} role="status">
        <p>Фотография не загрузилась. Проверьте подключение и попробуйте ещё раз.</p>
        <button type="button" onClick={() => { setAttempt(value => value + 1); setImageFailed(false); }}>Повторить</button>
      </div> : <Image key={attempt} unoptimized src={photo.src} width={photo.width} height={photo.height}
        loading="eager" alt={photo.alt} className={styles.full} onError={() => setImageFailed(true)} /> : null}
      <p className={styles.credit}>Фото: {photo.author ? `${photo.author}. ` : null}<a href={photo.sourceUrl} target="_blank" rel="noopener noreferrer">Wikimedia Commons</a> · <a href={photo.licenseUrl} target="_blank" rel="noopener noreferrer">{photo.license}</a></p>
    </dialog>
  </>;
}

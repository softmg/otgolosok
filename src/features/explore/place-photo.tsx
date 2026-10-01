"use client";

import Image from "next/image";
import { useId, useRef, useState } from "react";
import { ExploreIcon } from "./icons";
import type { PlacePhoto } from "./place-story";
import styles from "./place-photo.module.css";

export type { PlacePhoto };

/**
 * The caller keys this heading by place so loading failures cannot leak into the next card.
 * `pending` keeps an empty preview slot while the photo of a place known to have one is loading, so the title never reflows.
 */
export function PlacePhotoHeading({ photo, pending = false, title, address, titleClassName, addressClassName }: {
  photo?: PlacePhoto;
  pending?: boolean;
  title: string;
  address: string;
  titleClassName?: string;
  addressClassName?: string;
}) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [openFailed, setOpenFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialogTitle = useId();
  const heading = <><h2 id="selected-place-title" className={titleClassName}>{title}</h2>{title !== address ? <p className={addressClassName}>{address}</p> : null}</>;

  if (!photo && pending) return <div className={styles.heading} data-photo-heading>
    <div className={styles.headingText}>{heading}</div>
    <span aria-hidden="true" className={styles.placeholder} data-photo-placeholder />
  </div>;
  if (!photo || thumbnailFailed) return heading;

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
    <div className={styles.heading} data-photo-heading>
      <div className={styles.headingText}>{heading}</div>
      <button ref={trigger} type="button" className={styles.preview} onClick={showPhoto}
        aria-label={`Открыть фото: ${title}`} aria-haspopup="dialog">
        <Image unoptimized src={photo.thumbnail} width={240} height={240} alt={photo.alt}
          onError={() => setThumbnailFailed(true)} />
      </button>
    </div>
    {openFailed ? <p role="status">Не удалось открыть фотографию. Попробуйте ещё раз.</p> : null}
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

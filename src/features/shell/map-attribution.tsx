"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import styles from "./map-attribution.module.css";

/** OSMF allows collapsing the credit after five seconds or on map interaction, if it can be opened again. */
export const ATTRIBUTION_COLLAPSE_MS = 5_000;

/**
 * The data credit the basemap owes (VersaTiles serves OpenStreetMap data, see map-style.ts).
 * It shows first as a link and then folds into an «i» button that opens it again.
 * `surface` is the map: touching, scrolling or using the keyboard on it folds the credit at once.
 */
export function MapAttribution({ surface }: { surface?: RefObject<HTMLElement | null> }) {
  const [open, setOpen] = useState(true);
  const link = useRef<HTMLAnchorElement>(null);
  const focusLink = useRef(false);

  useEffect(() => {
    if (!open) return;
    // A credit being read from the keyboard stays until the map is used.
    const timer = setTimeout(() => { if (document.activeElement !== link.current) setOpen(false); }, ATTRIBUTION_COLLAPSE_MS);
    const map = surface?.current;
    const collapse = () => setOpen(false);
    const events = ["pointerdown", "wheel", "keydown"] as const;
    for (const event of events) map?.addEventListener(event, collapse, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const event of events) map?.removeEventListener(event, collapse);
    };
  }, [open, surface]);

  useEffect(() => {
    if (open && focusLink.current) { focusLink.current = false; link.current?.focus(); }
  }, [open]);

  return <p className={styles.attribution} data-region="attribution">
    {open
      ? <a ref={link} href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>
      : <button type="button" aria-label="Источник данных карты" onClick={() => { focusLink.current = true; setOpen(true); }}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" /><path d="M8 7.25v4M8 4.75v.01" /></svg>
      </button>}
  </p>;
}

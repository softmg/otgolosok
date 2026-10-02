"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../ui/cx";
import styles from "./map-controls.module.css";

export type ZoomControl = { zoomIn(): void; zoomOut(): void; canZoomIn: boolean; canZoomOut: boolean };

/** A round map button with the shared island look; never smaller than a finger. */
export function MapControlButton({ className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={cx(styles.button, className)} {...props} />;
}

/** Screen buttons (e.g. «Моё местоположение») followed by the zoom pair. */
export function MapControls({ zoom, children }: { zoom: ZoomControl; children?: ReactNode }) {
  return <div className={styles.controls} data-region="controls">
    {children}
    <div className={styles.zoom} role="group" aria-label="Масштаб карты">
      <button type="button" className={styles.zoomButton} aria-label="Отдалить" disabled={!zoom.canZoomOut} onClick={zoom.zoomOut}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" /></svg>
      </button>
      <button type="button" className={styles.zoomButton} aria-label="Приблизить" disabled={!zoom.canZoomIn} onClick={zoom.zoomIn}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12" /></svg>
      </button>
    </div>
  </div>;
}

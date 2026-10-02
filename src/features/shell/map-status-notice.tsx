import type { ReactNode } from "react";
import styles from "./map-status-notice.module.css";

export type MapStatus = { phase: "loading" | "ready" | "failed"; tilesOffline: boolean };

export function mapStatusText(status: MapStatus): string | null {
  if (status.phase === "loading") return "Загружаем карту…";
  if (status.phase === "failed") return "Карта не загрузилась. Откройте список историй.";
  return status.tilesOffline ? "Карта требует интернета. Сохранённые истории доступны в разделе «Сохранено»." : null;
}

/** A short message in the notices above the sheet of a map screen. */
export function MapNotice({ children }: { children: ReactNode }) {
  return <p className={styles.notice} role="status">{children}</p>;
}

/** What the map itself has to say: loading, failure, or basemap tiles unreachable. */
export function MapStatusNotice({ status }: { status: MapStatus }) {
  const text = mapStatusText(status);
  return text ? <MapNotice>{text}</MapNotice> : null;
}

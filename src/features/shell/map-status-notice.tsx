import styles from "./map-status-notice.module.css";

export type MapStatus = { phase: "loading" | "ready" | "failed"; tilesOffline: boolean };

export function mapStatusText(status: MapStatus): string | null {
  if (status.phase === "loading") return "Загружаем карту…";
  if (status.phase === "failed") return "Карта не загрузилась. Откройте список историй.";
  return status.tilesOffline ? "Карта требует интернета. Сохранённые истории доступны в разделе «Сохранено»." : null;
}

/** What the map itself has to say: loading, failure, or basemap tiles unreachable. */
export function MapStatusNotice({ status }: { status: MapStatus }) {
  const text = mapStatusText(status);
  return text ? <p className={styles.notice} role="status">{text}</p> : null;
}

"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ExploreMap, type MapHandle, type ZoomLimits } from "../explore/explore-map";
import { MapAttribution } from "../shell/map-attribution";
import { MapControls } from "../shell/map-controls";
import { MapStatusNotice, type MapStatus } from "../shell/map-status-notice";
import type { Coordinates, WalkPlan } from "./types";
import type { WalkChapter } from "./walk-plan";
import styles from "./walk-map.module.css";

const noop = () => {};

function distanceLabel(meters: number | null) {
  if (meters === null || !Number.isFinite(meters)) return null;
  return meters < 1000 ? `${Math.max(10, Math.round(meters / 10) * 10)} м` : `${(meters / 1000).toFixed(1).replace(".", ",")} км`;
}

export function WalkMap({ chapters, index, path, user, distanceToNextM, onSelect }: {
  chapters: WalkChapter[];
  index: number;
  path: WalkPlan["path"] | undefined;
  user: (Coordinates & { accuracyM: number }) | null;
  distanceToNextM: number | null;
  onSelect: (index: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const handle = useRef<MapHandle>(null);
  const [status, setStatus] = useState<MapStatus>({ phase: "loading", tilesOffline: false });
  const [limits, setLimits] = useState<ZoomLimits>({ canZoomIn: true, canZoomOut: true });
  const zoomIn = useCallback(() => handle.current?.zoomIn(), []);
  const zoomOut = useCallback(() => handle.current?.zoomOut(), []);
  // Route geometry is stored in GeoJSON order, longitude first.
  const geometry = useMemo(
    () => (path?.coordinates ?? []).flatMap(([lon, lat]) => Number.isFinite(lat) && Number.isFinite(lon) ? [{ lat, lon }] : []),
    [path],
  );
  const items = useMemo(
    () => chapters.map((chapter, position) => ({
      id: chapter.id,
      title: `Часть ${position + 1}: ${chapter.title}. ${chapter.place}`,
      location: chapter.trigger_location ?? chapter.location,
      number: position + 1,
    })),
    [chapters],
  );
  if (!chapters.length) return null;
  const next = chapters[index + 1];
  const distance = distanceLabel(distanceToNextM);

  return <section className="walk-map" aria-labelledby="walk-map-title">
    <div className="walk-map-head">
      <h2 id="walk-map-title">Где вы</h2>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "Скрыть карту" : "Показать карту"}
      </button>
    </div>
    {open ? <div className={`walk-map-canvas ${styles.canvas}`}>
      <ExploreMap ref={handle} onStatus={setStatus} onZoomLimits={setLimits} items={items} selectedId={chapters[index]?.id} focus={null} user={user}
        geometry={geometry.length > 1 ? geometry : undefined} onSelect={(id) => {
          const position = chapters.findIndex((chapter) => chapter.id === id);
          if (position >= 0) onSelect(position);
        }} onPoint={noop}
        mapLabel="Карта прогулки: линия пути, отметки частей по порядку и ваше положение. Нажмите отметку, чтобы слушать эту часть." />
      <div className={styles.overlay}>
        <MapStatusNotice status={status} />
        <div className={styles.row}>
          <MapAttribution />
          <MapControls zoom={{ zoomIn, zoomOut, ...limits }} />
        </div>
      </div>
    </div> : null}
    <p className="walk-map-next" role="status">
      {next
        ? <>Дальше: {index + 2}. {next.title}{distance ? <> · {distance} по прямой</> : null}</>
        : <>Финиш: {chapters[index]?.place}</>}
    </p>
  </section>;
}

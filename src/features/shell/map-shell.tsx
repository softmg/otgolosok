"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { ExploreMap, type ExploreMapProps, type MapHandle, type ZoomLimits } from "../explore/explore-map";
import { MapAttribution } from "./map-attribution";
import { MapControls } from "./map-controls";
import { mapStatusText, MapStatusNotice, type MapStatus } from "./map-status-notice";
import { useMapInsets } from "./use-map-insets";
import styles from "./map-shell.module.css";

export type ShellMapProps = Omit<ExploreMapProps, "insets" | "ref" | "onStatus" | "onZoomLimits" | "legacyChrome">;

type Props = {
  map: ShellMapProps;
  /** Contents of the header island: brand, search, closing the screen. */
  header: ReactNode;
  /** Screen buttons placed before the zoom pair, e.g. «Моё местоположение». */
  controls?: ReactNode;
  /** Short messages above the sheet. */
  notices?: ReactNode;
  /** At most one Sheet. */
  sheet?: ReactNode;
};

/**
 * The frame of every full-screen map: the map fills the screen and islands take their rows in one
 * grid — header, controls, free map, dock with notices and the sheet. Nothing is positioned by hand,
 * so an island that grows takes room from the free map instead of covering another island.
 * The map keeps its focus and route inside the free cell, measured from this layout.
 */
export function MapShell({ map, header, controls, notices, sheet }: Props) {
  const mapCell = useRef<HTMLDivElement>(null);
  const free = useRef<HTMLDivElement>(null);
  const handle = useRef<MapHandle>(null);
  const insets = useMapInsets(mapCell, free);
  const [status, setStatus] = useState<MapStatus>({ phase: "loading", tilesOffline: false });
  const [limits, setLimits] = useState<ZoomLimits>({ canZoomIn: true, canZoomOut: true });
  const zoomIn = useCallback(() => handle.current?.zoomIn(), []);
  const zoomOut = useCallback(() => handle.current?.zoomOut(), []);
  const hasNotices = Boolean(notices) || mapStatusText(status) !== null;
  const hasDock = hasNotices || Boolean(sheet);

  return <div className={styles.shell}>
    <div ref={mapCell} className={styles.map}>
      <ExploreMap {...map} ref={handle} insets={insets} onStatus={setStatus} onZoomLimits={setLimits} />
    </div>
    <div className={styles.frame} data-dock={hasDock ? undefined : "none"}>
      <header className={styles.header} data-region="header">{header}</header>
      <div className={styles.attribution}><MapAttribution surface={mapCell} /></div>
      <div className={styles.controls}>
        <MapControls zoom={{ zoomIn, zoomOut, ...limits }}>{controls}</MapControls>
      </div>
      <div ref={free} className={styles.free} aria-hidden="true" />
      {hasDock ? <div className={styles.dock}>
        {hasNotices ? <div className={styles.notices} data-region="notices">
          <MapStatusNotice status={status} />
          {notices}
        </div> : null}
        {sheet}
      </div> : null}
    </div>
  </div>;
}

"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { ExploreMap, type ExploreMapProps, type MapHandle, type ZoomLimits } from "../explore/explore-map";
import { MapAttribution } from "./map-attribution";
import { MapBrand } from "./map-brand";
import { MapControls } from "./map-controls";
import { mapStatusText, MapStatusNotice, type MapStatus } from "./map-status-notice";
import { useMapInsets } from "./use-map-insets";
import styles from "./map-shell.module.css";

export type ShellMapProps = Omit<ExploreMapProps, "insets" | "ref" | "onStatus" | "onZoomLimits">;

type Props = {
  map: ShellMapProps;
  /** Called when the brand in the header is followed, e.g. to stop a running walk. */
  onBrand?: () => void;
  /** Whether the bottom navigation is on screen; a running walk hides it and the dock goes down to the edge. */
  navigation?: boolean;
  /** Screen buttons placed before the zoom pair, e.g. «Моё местоположение». */
  controls?: ReactNode;
  /** Short messages above the sheet. */
  notices?: ReactNode;
  /** At most one Sheet. */
  sheet?: ReactNode;
  /** The sheet is expanded for reading: it takes the screen (or its column) and the rest is inert. */
  sheetExpanded?: boolean;
  /** A tap on the dimmed map beside an expanded sheet. */
  onCollapseSheet?: () => void;
};

/**
 * The frame of every full-screen map and its only header: the map fills the screen and islands take their rows in one
 * grid — the top row (header with the map controls beside it), free map, dock with notices and the sheet. Nothing is positioned by hand,
 * so an island that grows takes room from the free map instead of covering another island.
 * The map keeps its focus and route inside the free cell, measured from this layout.
 */
export function MapShell({ map, onBrand, navigation = true, controls, notices, sheet, sheetExpanded = false, onCollapseSheet }: Props) {
  const mapCell = useRef<HTMLDivElement>(null);
  const free = useRef<HTMLDivElement>(null);
  const handle = useRef<MapHandle>(null);
  // The free cell vanishes under an expanded sheet; the map keeps the view it had beside the peek.
  const insets = useMapInsets(mapCell, free, sheetExpanded);
  const [status, setStatus] = useState<MapStatus>({ phase: "loading", tilesOffline: false });
  const [limits, setLimits] = useState<ZoomLimits>({ canZoomIn: true, canZoomOut: true });
  const zoomIn = useCallback(() => handle.current?.zoomIn(), []);
  const zoomOut = useCallback(() => handle.current?.zoomOut(), []);
  const hasNotices = Boolean(notices) || mapStatusText(status) !== null;
  const hasDock = hasNotices || Boolean(sheet);

  return <div className={styles.shell}>
    <div ref={mapCell} className={styles.map} inert={sheetExpanded}>
      <ExploreMap {...map} ref={handle} insets={insets} onStatus={setStatus} onZoomLimits={setLimits} />
    </div>
    {/* Mouse users get a way back beside a column; keyboard and screen readers use the handle, Escape or Back. */}
    {sheetExpanded ? <div className={styles.scrim} aria-hidden="true" data-scrim onClick={onCollapseSheet} /> : null}
    <div className={styles.frame} data-dock={hasDock ? undefined : "none"} data-nav={navigation ? undefined : "none"} data-sheet-mode={sheetExpanded ? "expanded" : undefined}>
      <div className={styles.top} inert={sheetExpanded}>
        <header className={styles.header} data-region="header"><MapBrand onClick={onBrand} /></header>
        <MapControls zoom={{ zoomIn, zoomOut, ...limits }}>{controls}</MapControls>
      </div>
      <div className={styles.attribution}><MapAttribution surface={mapCell} /></div>
      <div ref={free} className={styles.free} aria-hidden="true" />
      {hasDock ? <div className={styles.dock}>
        {hasNotices ? <div className={styles.notices} data-region="notices" inert={sheetExpanded}>
          <MapStatusNotice status={status} />
          {notices}
        </div> : null}
        {sheet}
      </div> : null}
    </div>
  </div>;
}

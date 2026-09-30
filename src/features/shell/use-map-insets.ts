"use client";

import { useEffect, useState, type RefObject } from "react";
import { insetsFromRects, NO_INSETS, sameInsets, type MapInsets } from "./map-insets";

/**
 * The part of the map left free by the shell's islands, measured from the layout itself.
 * No breakpoints or CSS values are copied into JS: whatever the CSS lays out is what the map avoids.
 */
export function useMapInsets(map: RefObject<HTMLElement | null>, free: RefObject<HTMLElement | null>): MapInsets {
  const [insets, setInsets] = useState<MapInsets>(NO_INSETS);
  useEffect(() => {
    const mapElement = map.current, freeElement = free.current;
    if (!mapElement || !freeElement) return;
    const measure = () => {
      const next = insetsFromRects(mapElement.getBoundingClientRect(), freeElement.getBoundingClientRect());
      setInsets(current => sameInsets(current, next) ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(mapElement);
    observer.observe(freeElement);
    // Turning the phone can move the free cell without resizing it.
    addEventListener("resize", measure);
    return () => { observer.disconnect(); removeEventListener("resize", measure); };
  }, [map, free]);
  return insets;
}

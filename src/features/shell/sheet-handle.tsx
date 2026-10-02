"use client";

import { useRef, type PointerEvent } from "react";
import { readSwipe, TAP_SLOP_PX } from "./sheet-swipe";
import styles from "./sheet-handle.module.css";

type Props = {
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  /** Id of the sheet this handle expands. */
  controls: string;
  expandLabel: string;
  collapseLabel: string;
};

/**
 * The grip at the top of an expandable sheet: a tap (or Enter/Space) toggles it, a vertical swipe
 * up expands and down collapses. The finger is not followed; the sheet switches between two states.
 */
export function SheetHandle({ expanded, onExpand, onCollapse, controls, expandLabel, collapseLabel }: Props) {
  const start = useRef<{ x: number; y: number; t: number; id: number } | null>(null);
  // A drag ends with a click on the same button; it must not toggle the sheet a second time.
  const suppressClick = useRef(false);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    start.current = { x: event.clientX, y: event.clientY, t: event.timeStamp, id: event.pointerId };
    suppressClick.current = false;
    // Capture can fail for a pointer that is already gone; the gesture still ends on this button or is cancelled.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* the swipe is read from pointerup anyway */ }
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const from = start.current;
    start.current = null;
    if (!from || from.id !== event.pointerId) return;
    const dx = event.clientX - from.x, dy = event.clientY - from.y;
    if (Math.hypot(dx, dy) <= TAP_SLOP_PX) return;
    suppressClick.current = true;
    const swipe = readSwipe({ dx, dy, ms: event.timeStamp - from.t });
    if (swipe === "up" && !expanded) onExpand();
    else if (swipe === "down" && expanded) onCollapse();
  };

  const onClick = () => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    if (expanded) onCollapse(); else onExpand();
  };

  return <button type="button" className={styles.handle} aria-expanded={expanded} aria-controls={controls}
    aria-label={expanded ? collapseLabel : expandLabel}
    onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { start.current = null; }} onClick={onClick} />;
}

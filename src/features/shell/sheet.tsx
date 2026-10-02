"use client";

import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { cx } from "../ui/cx";
import styles from "./sheet.module.css";

type Props = {
  /** Accessible name of the sheet; use `labelledBy` when a visible heading names it. */
  label?: string;
  labelledBy?: string;
  /**
   * Edge-to-edge media above the header, such as a place photo. It never scrolls away and yields height first
   * when the sheet is short, so the body keeps room for its text; an empty slot takes no room.
   */
  media?: ReactNode;
  /** One control pinned to the top right corner over the media or the body, such as close. It takes no room. */
  corner?: ReactNode;
  /**
   * The grip that expands the sheet to a full-height reading view (see SheetHandle). A sheet with a handle
   * never scrolls its body while collapsed: the text is a teaser that yields first, then the media.
   */
  handle?: ReactNode;
  /** Expanded: the whole sheet scrolls like a page, the footer stays pinned at its bottom. */
  expanded?: boolean;
  /** Target of the handle's `aria-controls`. */
  id?: string;
  header?: ReactNode;
  /** One row of actions. It never scrolls away. */
  footer?: ReactNode;
  children?: ReactNode;
  /** Names the body as a region, so long text can be found and scrolled from the keyboard. */
  bodyLabel?: string;
  className?: string;
  sheetRef?: Ref<HTMLElement>;
  /** Stable hooks for tests and styles: which sheet this is and its current step. */
  name?: string;
  state?: string;
};

/**
 * A panel of a map screen: fixed header, one scrolling body, fixed footer. It takes at most the
 * height its container gives it, so a long body scrolls inside instead of pushing anything away.
 * With a `handle` it is expandable instead: a non-scrolling peek, or the whole sheet scrolling as a page.
 */
export function Sheet({ id, label, labelledBy, media, corner, handle, expanded = false, header, footer, children, bodyLabel, className, sheetRef, name, state }: Props) {
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  const hasBody = Boolean(children);
  useEffect(() => {
    const element = body.current, inner = content.current;
    if (!element || !inner) return;
    const measure = () => setScrollable(element.scrollHeight > element.clientHeight + 1);
    measure();
    // The capped body keeps its size while its content grows, so both are watched.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [hasBody]);

  return <section ref={sheetRef} id={id} className={cx(styles.sheet, className)} data-region="sheet" data-sheet={name} data-state={state}
    data-expandable={handle ? "" : undefined} data-expanded={handle && expanded ? "" : undefined}
    aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy}>
    {/* Controls that float over the sheet and stay at its top while an expanded sheet scrolls. */}
    {corner || handle ? <div className={styles.chrome} data-sheet-part="chrome">
      {handle ? <div className={styles.handle} data-sheet-part="handle">{handle}</div> : null}
      {corner ? <div className={styles.corner} data-sheet-part="corner">{corner}</div> : null}
    </div> : null}
    {media ? <div className={styles.media} data-sheet-part="media">{media}</div> : null}
    {header ? <div className={styles.header} data-sheet-part="header">{header}</div> : null}
    {children ? <div ref={body} className={styles.body} data-sheet-part="body"
      role={bodyLabel ? "region" : undefined} aria-label={bodyLabel}
      // Only a body that actually scrolls is worth a stop in the tab order; an expandable one never does.
      tabIndex={scrollable && !handle ? 0 : undefined}><div ref={content} className={styles.content}>{children}</div></div> : null}
    {footer ? <div className={styles.footer} data-sheet-part="footer">{footer}</div> : null}
  </section>;
}

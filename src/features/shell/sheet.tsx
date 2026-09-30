"use client";

import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { cx } from "../ui/cx";
import styles from "./sheet.module.css";

type Props = {
  /** Accessible name of the sheet; use `labelledBy` when a visible heading names it. */
  label?: string;
  labelledBy?: string;
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
 */
export function Sheet({ label, labelledBy, header, footer, children, bodyLabel, className, sheetRef, name, state }: Props) {
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

  return <section ref={sheetRef} className={cx(styles.sheet, className)} data-region="sheet" data-sheet={name} data-state={state} aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy}>
    {header ? <div className={styles.header} data-sheet-part="header">{header}</div> : null}
    {children ? <div ref={body} className={styles.body} data-sheet-part="body"
      role={bodyLabel ? "region" : undefined} aria-label={bodyLabel}
      // Only a body that actually scrolls is worth a stop in the tab order.
      tabIndex={scrollable ? 0 : undefined}><div ref={content} className={styles.content}>{children}</div></div> : null}
    {footer ? <div className={styles.footer} data-sheet-part="footer">{footer}</div> : null}
  </section>;
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

/**
 * The history-state key of an expanded sheet. The entry keeps the URL: Back collapses the sheet instead of leaving
 * the page. Next's patched pushState copies its own `__NA` marker into a fresh state object; without it Next's
 * popstate handler reloads the page, so states here are always new objects that Next completes.
 */
const HISTORY_KEY = "otgolosokSheet";

export type ExpandableSheet = {
  expanded: boolean;
  /** Animated; adds a history entry. */
  expand: () => void;
  /** Animated; consumes the entry `expand` added, if it is the current one. */
  collapse: () => void;
  /**
   * Instant, for a sheet about to close. With `keepHistoryEntry` only the local state resets: used right before an
   * in-app link pushes its own entry, which a `history.back()` would race with.
   */
  dismiss: (options?: { keepHistoryEntry?: boolean }) => void;
};

function stateKey(state: unknown): unknown {
  return state && typeof state === "object" ? (state as Record<string, unknown>)[HISTORY_KEY] : undefined;
}

/** Slides the sheet between its states where the browser can; otherwise, or with reduced motion, switches at once. */
function withTransition(update: () => void) {
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof document.startViewTransition !== "function" || reduced) { update(); return; }
  let transition: ViewTransition;
  try {
    transition = document.startViewTransition(() => flushSync(update));
  } catch {
    // A hidden document refuses transitions (InvalidStateError); the state still has to change.
    update();
    return;
  }
  // A transition skipped by a newer one or by a hidden tab rejects these; the update has run regardless.
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
}

/**
 * Collapsed/expanded state of the one expandable sheet on a screen, tied to browser history.
 * `key` identifies the expandable content; a new key (or none) starts collapsed. A fresh screen never starts
 * expanded, even when reloaded on an expanded entry.
 */
export function useExpandableSheet(key: string | undefined): ExpandableSheet {
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined);
  // Other content, or none, forgets the expansion: coming back to the same story starts from the peek. Unless it
  // appears on its own expanded entry, such as the story after Back from the walk builder: then it reopens expanded.
  // A reloaded entry has lost its key by then (the mount effect below), so a fresh screen still starts collapsed.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setExpandedKey(key !== undefined && stateKey(history.state) === key ? key : undefined);
  }
  const expanded = key !== undefined && expandedKey === key;

  useEffect(() => {
    const state = history.state as unknown;
    if (stateKey(state) === undefined) return;
    const rest = { ...(state as Record<string, unknown>) };
    delete rest[HISTORY_KEY];
    history.replaceState(rest, "");
  }, []);

  useEffect(() => {
    if (key === undefined) return;
    // Back collapses, Forward re-expands.
    const onPopState = (event: PopStateEvent) => {
      const next = stateKey(event.state) === key ? key : undefined;
      withTransition(() => setExpandedKey(next));
    };
    addEventListener("popstate", onPopState);
    return () => removeEventListener("popstate", onPopState);
  }, [key]);

  const expand = useCallback(() => {
    if (key === undefined || expanded) return;
    history.pushState({ [HISTORY_KEY]: key }, "");
    withTransition(() => setExpandedKey(key));
  }, [key, expanded]);

  const collapse = useCallback(() => {
    if (!expanded) return;
    if (stateKey(history.state) === key) history.back();
    else withTransition(() => setExpandedKey(undefined));
  }, [key, expanded]);

  const dismiss = useCallback(({ keepHistoryEntry = false }: { keepHistoryEntry?: boolean } = {}) => {
    if (!expanded) return;
    setExpandedKey(undefined);
    if (!keepHistoryEntry && stateKey(history.state) === key) history.back();
  }, [key, expanded]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // The photo viewer is a modal dialog with its own Escape.
      if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
      collapse();
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [expanded, collapse]);

  return { expanded, expand, collapse, dismiss };
}

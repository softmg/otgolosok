import { useLayoutEffect, useSyncExternalStore } from "react";

// A screen that needs the whole display — a running walk — hides the bottom navigation while it asks to.
// The navigation lives in the root layout, outside that screen, so the request goes through this module.
// A counter, not a flag: when two screens hide it at once, the first to let go must not bring it back.
let requests = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function change(delta: number) {
  requests += delta;
  for (const listener of listeners) listener();
}

const isHidden = () => requests > 0;
// The server renders the navigation: no screen has asked yet.
const serverHidden = () => false;

/** Whether some screen has hidden the bottom navigation. */
export function useNavigationHidden() {
  return useSyncExternalStore(subscribe, isHidden, serverHidden);
}

/** Hides the bottom navigation while `hidden` is true and the caller is mounted. */
export function useHideNavigation(hidden: boolean) {
  // A layout effect: the navigation goes in the same frame as the screen changes, without flashing over it.
  useLayoutEffect(() => {
    if (!hidden) return;
    change(1);
    return () => change(-1);
  }, [hidden]);
}

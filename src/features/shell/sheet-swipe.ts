/** Vertical intent of a finished gesture on a sheet handle: negative `dy` is up. */
export type Swipe = "up" | "down" | null;

/** Movement beyond this in any direction is a gesture, never a tap. */
export const TAP_SLOP_PX = 10;
/** Shorter vertical moves are jitter, whatever their speed. */
const MIN_SWIPE_PX = 12;
/** A move this long is a swipe at any speed. */
const LONG_SWIPE_PX = 32;
/** A short move counts when it is at least this fast (px/ms): a flick. */
const FLICK_SPEED = 0.4;

export function readSwipe({ dx, dy, ms }: { dx: number; dy: number; ms: number }): Swipe {
  const distance = Math.abs(dy);
  if (Math.abs(dx) > distance || distance < MIN_SWIPE_PX) return null;
  if (distance < LONG_SWIPE_PX && distance / Math.max(ms, 1) < FLICK_SPEED) return null;
  return dy < 0 ? "up" : "down";
}

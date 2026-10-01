// Applies a downloaded app version without a button, but only at a moment when
// replacing the page loses nothing: no walk, no playing audio, no unfinished
// work. Before the visitor touches the page it happens right away; afterwards it
// waits until the page goes to the background, so the reload is never seen.

/** How long the waiting worker gets to take control before the attempt is dropped. */
export const ACTIVATION_TIMEOUT_MS = 10_000;

const INTERACTIONS = ["pointerdown", "keydown", "wheel"] as const;

type Registration = Pick<ServiceWorkerRegistration, "waiting">;
type Container = Pick<ServiceWorkerContainer, "controller" | "addEventListener" | "removeEventListener">;
type PageDocument = Pick<Document, "visibilityState" | "querySelectorAll" | "addEventListener" | "removeEventListener">;
type PageWindow = Pick<Window, "addEventListener" | "removeEventListener">;

export type SafeUpdateOptions = {
  registration: Registration;
  serviceWorker: Container;
  document: PageDocument;
  window: PageWindow;
  /** False while the page holds state a reload would lose (walk, walk builder, offline download). */
  canApply: () => boolean;
  reload: () => void;
  timeoutMs?: number;
};

/** Audio or video that is playing or about to play: a reload would cut it off. */
export function mediaPlaying(document: Pick<Document, "querySelectorAll">): boolean {
  return Array.from(document.querySelectorAll<HTMLMediaElement>("audio, video")).some(media => !media.paused && !media.ended);
}

/**
 * Asks the waiting worker to take over and resolves true once it controls the
 * page. False on timeout: an older waiting build may ignore the message, and
 * the manual /update.html flow stays available.
 */
export function activateWaitingWorker(serviceWorker: Container, worker: ServiceWorker, timeoutMs = ACTIVATION_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    const done = (value: boolean) => {
      clearTimeout(timer);
      serviceWorker.removeEventListener("controllerchange", check);
      resolve(value);
    };
    const check = () => { if (serviceWorker.controller === worker) done(true); };
    const timer = setTimeout(() => done(false), timeoutMs);
    serviceWorker.addEventListener("controllerchange", check);
    worker.postMessage({ type: "ACTIVATE_UPDATE" });
    check();
  });
}

/** Watches for a safe moment to apply a waiting version; `check` re-evaluates after the waiting worker changes. */
export function watchForSafeUpdate(options: SafeUpdateOptions): { check: () => void; dispose: () => void } {
  const { registration, serviceWorker, document, window, canApply, reload, timeoutMs } = options;
  let interacted = false;
  let applying = false;
  let disposed = false;

  const markInteracted = () => { interacted = true; };
  const check = () => {
    const worker = registration.waiting;
    if (disposed || applying || !worker) return;
    if (document.visibilityState === "visible" && interacted) return;
    if (!canApply() || mediaPlaying(document)) return;
    applying = true;
    void activateWaitingWorker(serviceWorker, worker, timeoutMs).then(activated => {
      applying = false;
      // After unmount the visitor is elsewhere in the app: the next load picks the version up.
      if (activated && !disposed) reload();
    });
  };

  for (const name of INTERACTIONS) window.addEventListener(name, markInteracted, { capture: true, passive: true });
  document.addEventListener("visibilitychange", check);
  return {
    check,
    dispose: () => {
      disposed = true;
      for (const name of INTERACTIONS) window.removeEventListener(name, markInteracted, { capture: true });
      document.removeEventListener("visibilitychange", check);
    },
  };
}

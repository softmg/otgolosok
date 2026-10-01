import { afterEach, describe, expect, it, vi } from "vitest";
import { activateWaitingWorker, mediaPlaying, watchForSafeUpdate } from "./auto-update";

type Media = { paused: boolean; ended: boolean };

function page({ visibility = "visible" as DocumentVisibilityState, media = [] as Media[] } = {}) {
  const document = Object.assign(new EventTarget(), {
    visibilityState: visibility,
    querySelectorAll: () => media,
  });
  return { document, window: new EventTarget() };
}

function setup({ visibility = "visible" as DocumentVisibilityState, media = [] as Media[], canApply = (): boolean => true } = {}) {
  const serviceWorker = Object.assign(new EventTarget(), { controller: null as unknown });
  // The real waiting worker takes control asynchronously after the message.
  const worker = {
    postMessage: vi.fn(() => setTimeout(() => {
      serviceWorker.controller = worker;
      serviceWorker.dispatchEvent(new Event("controllerchange"));
    }, 0)),
  } as unknown as ServiceWorker & { postMessage: ReturnType<typeof vi.fn> };
  const registration = { waiting: worker as ServiceWorker | null };
  const { document, window } = page({ visibility, media });
  const reload = vi.fn();
  const watcher = watchForSafeUpdate({
    registration, serviceWorker: serviceWorker as unknown as ServiceWorkerContainer,
    document: document as unknown as Document, window: window as unknown as Window,
    canApply, reload, timeoutMs: 1000,
  });
  const hide = () => { document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange")); };
  return { watcher, worker, registration, document, window, reload, hide };
}

afterEach(() => vi.useRealTimers());

describe("safe automatic update", () => {
  it("reloads into the new version before the visitor touches the page", async () => {
    vi.useFakeTimers();
    const { watcher, worker, reload } = setup();
    watcher.check();
    expect(worker.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "ACTIVATE_UPDATE" });
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("waits for the background once the visitor has used the page", async () => {
    vi.useFakeTimers();
    const { watcher, worker, window, reload, hide } = setup();
    window.dispatchEvent(new Event("pointerdown"));
    watcher.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.postMessage).not.toHaveBeenCalled();
    hide();
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each([
    ["a walk or the walk builder holds the page", { canApply: () => false }],
    ["audio is playing", { media: [{ paused: false, ended: false }] }],
  ])("keeps the old version while %s", async (_, options) => {
    vi.useFakeTimers();
    const { watcher, worker, reload, hide } = setup({ visibility: "hidden", ...options });
    watcher.check();
    hide();
    await vi.advanceTimersByTimeAsync(2000);
    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does nothing without a waiting version or after unmount", async () => {
    vi.useFakeTimers();
    const idle = setup({ visibility: "hidden" });
    idle.registration.waiting = null;
    idle.watcher.check();
    const gone = setup({ visibility: "hidden" });
    gone.watcher.check();
    gone.watcher.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(idle.reload).not.toHaveBeenCalled();
    // Activated, but the visitor has already left this screen: the next load picks it up.
    expect(gone.worker.postMessage).toHaveBeenCalledOnce();
    expect(gone.reload).not.toHaveBeenCalled();
  });

  it("sends a single activation request while one is pending", () => {
    vi.useFakeTimers();
    const { watcher, worker, hide } = setup({ visibility: "hidden" });
    watcher.check();
    hide();
    watcher.check();
    expect(worker.postMessage).toHaveBeenCalledOnce();
  });
});

describe("activating the waiting worker", () => {
  it("gives up after the timeout when an older worker ignores the message", async () => {
    vi.useFakeTimers();
    const serviceWorker = Object.assign(new EventTarget(), { controller: null });
    const worker = { postMessage: vi.fn() } as unknown as ServiceWorker;
    const result = activateWaitingWorker(serviceWorker as unknown as ServiceWorkerContainer, worker, 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a control change to another worker", async () => {
    vi.useFakeTimers();
    const serviceWorker = Object.assign(new EventTarget(), { controller: {} as unknown });
    const worker = { postMessage: vi.fn() } as unknown as ServiceWorker;
    const result = activateWaitingWorker(serviceWorker as unknown as ServiceWorkerContainer, worker, 1000);
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toBe(false);
  });
});

describe("playing media", () => {
  it.each([
    [[], false],
    [[{ paused: true, ended: false }], false],
    [[{ paused: false, ended: true }], false],
    [[{ paused: true, ended: false }, { paused: false, ended: false }], true],
  ])("%j → %s", (media, expected) => {
    expect(mediaPlaying({ querySelectorAll: () => media } as unknown as Document)).toBe(expected);
  });
});

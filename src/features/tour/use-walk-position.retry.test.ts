// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { positionFailed, useWalkPosition } from "./use-walk-position";

afterEach(() => vi.unstubAllGlobals());

it("retry снова запрашивает положение у браузера и останавливает прежнее слежение", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const watchers: Array<{ success: PositionCallback; error: PositionErrorCallback }> = [];
  const clearWatch = vi.fn();
  const geolocation = {
    watchPosition: (success: PositionCallback, error: PositionErrorCallback) => watchers.push({ success, error }),
    clearWatch,
  };
  vi.stubGlobal("navigator", { ...navigator, geolocation });
  let hook!: ReturnType<typeof useWalkPosition>;
  const Probe = () => { hook = useWalkPosition(); return null; };
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(Probe)));

  // retry до старта прогулки ничего не запускает.
  act(() => hook.retry());
  expect(watchers).toHaveLength(0);

  const options = { replayMode: null, speed: 1, path: null, live: () => ({ target: { lat: 0, lon: 0 }, config: {} as never }), busy: () => false, onEntered: () => {} };
  act(() => hook.start(options));
  act(() => watchers[0].error({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: "" } as GeolocationPositionError));
  expect(hook.diagnostics.sourceStatus).toBe("permission-denied");
  expect(positionFailed(hook.diagnostics)).toBe(true);

  act(() => hook.retry());
  expect(watchers).toHaveLength(2);
  expect(clearWatch).toHaveBeenCalledWith(1);
  expect(positionFailed(hook.diagnostics)).toBe(false);

  // Ответ прежнего слежения больше не влияет на состояние.
  act(() => watchers[0].error({ code: 2, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: "" } as GeolocationPositionError));
  expect(positionFailed(hook.diagnostics)).toBe(false);
  act(() => watchers[1].success({ coords: { latitude: 55.75, longitude: 37.6, accuracy: 12 }, timestamp: 1 } as GeolocationPosition));
  expect(hook.diagnostics.sourceStatus).toBe("active");
  expect(hook.diagnostics.lastFix).toMatchObject({ lat: 55.75, lon: 37.6, accuracyM: 12 });
  await act(async () => root.unmount());
});

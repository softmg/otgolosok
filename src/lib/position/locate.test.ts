import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locateOnce, type LocateUpdate } from "./locate";

type Channel = { success?: PositionCallback; error?: PositionErrorCallback };

function createGeolocationMock() {
  const coarse: Channel = {};
  const precise: Channel = {};
  const clearWatch = vi.fn();
  const geolocation = {
    getCurrentPosition: (success: PositionCallback, error?: PositionErrorCallback | null) => {
      coarse.success = success;
      coarse.error = error ?? undefined;
    },
    watchPosition: (success: PositionCallback, error?: PositionErrorCallback | null) => {
      precise.success = success;
      precise.error = error ?? undefined;
      return 7;
    },
    clearWatch,
  } as unknown as Geolocation;
  return { coarse, precise, clearWatch, geolocation };
}

function position(accuracy: number, latitude = 55.75): GeolocationPosition {
  return {
    coords: { accuracy, latitude, longitude: 37.6, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) },
    timestamp: 1_000,
    toJSON: () => ({}),
  };
}

function failure(code: 1 | 2 | 3): GeolocationPositionError {
  return { code, message: "", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
}

function permissionsMock(initial: PermissionState) {
  const listeners = new Set<() => void>();
  const status = {
    state: initial,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  return {
    permissions: { query: async () => status as unknown as PermissionStatus },
    change(state: PermissionState) {
      status.state = state;
      listeners.forEach((listener) => listener());
    },
  };
}

function start(overrides: Parameters<typeof locateOnce>[1] = {}) {
  const mock = createGeolocationMock();
  const updates: LocateUpdate[] = [];
  const cancel = locateOnce((update) => updates.push(update), { geolocation: mock.geolocation, permissions: null, ...overrides });
  const summary = () => updates.map((update) => update.type === "fix" ? `${update.final ? "final" : "fix"}:${update.fix.accuracyM}` : `error:${update.code}`);
  return { ...mock, updates, summary, cancel };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("locateOnce", () => {
  it("reports a missing geolocation API", () => {
    const updates: LocateUpdate[] = [];
    locateOnce((update) => updates.push(update), { geolocation: null, permissions: null });
    expect(updates).toEqual([{ type: "error", code: "unsupported" }]);
  });

  it("shows a coarse fix first and finishes on a precise one", () => {
    const run = start();
    run.coarse.success?.(position(400));
    run.precise.success?.(position(12, 55.751));

    expect(run.summary()).toEqual(["fix:400", "final:12"]);
    expect(run.updates.at(-1)).toMatchObject({ fix: { lat: 55.751, lon: 37.6 } });
    expect(run.clearWatch).toHaveBeenCalledWith(7);
  });

  it("finishes at once when the first fix is already accurate", () => {
    const run = start();
    run.coarse.success?.(position(30));
    run.precise.success?.(position(5));
    expect(run.summary()).toEqual(["final:30"]);
  });

  it("ignores fixes that are not more accurate than the best one", () => {
    const run = start();
    run.coarse.success?.(position(150));
    run.precise.success?.(position(150));
    run.precise.success?.(position(900));
    run.precise.success?.(position(80));
    expect(run.summary()).toEqual(["fix:150", "fix:80"]);
  });

  it("settles on the best coarse fix when refinement does not improve in time", () => {
    const run = start({ refineMs: 6_000 });
    run.coarse.success?.(position(250));
    vi.advanceTimersByTime(5_999);
    expect(run.summary()).toEqual(["fix:250"]);
    vi.advanceTimersByTime(1);
    expect(run.summary()).toEqual(["fix:250", "final:250"]);
  });

  it("keeps the coarse fix when GPS refinement fails", () => {
    const run = start();
    run.coarse.success?.(position(250));
    run.precise.error?.(failure(3));
    expect(run.summary()).toEqual(["fix:250", "final:250"]);
  });

  it("waits for the coarse request when GPS fails first", () => {
    const run = start();
    run.precise.error?.(failure(3));
    expect(run.summary()).toEqual([]);
    run.coarse.success?.(position(250));
    expect(run.summary()).toEqual(["fix:250", "final:250"]);
  });

  it("treats a position without a usable accuracy as the least accurate", () => {
    const run = start();
    run.coarse.success?.(position(Number.NaN));
    run.precise.success?.(position(500));
    expect(run.summary()).toEqual(["fix:Infinity", "fix:500"]);
  });

  it.each([
    ["coarse", 1, "precise", 3, "permission-denied"],
    ["precise", 1, "coarse", 2, "permission-denied"],
    ["coarse", 2, "precise", 3, "position-unavailable"],
    ["coarse", 3, "precise", 2, "position-unavailable"],
    ["coarse", 3, "precise", 3, "timeout"],
  ] as const)("reports %s error %i then %s error %i as %s", (firstChannel, firstCode, secondChannel, secondCode, expected) => {
    const run = start();
    const channel = (name: "coarse" | "precise") => name === "coarse" ? run.coarse : run.precise;
    channel(firstChannel).error?.(failure(firstCode));
    channel(secondChannel).error?.(failure(secondCode));
    expect(run.summary()).toEqual([`error:${expected}`]);
  });

  it("does not count time spent on the permission prompt", async () => {
    const permission = permissionsMock("prompt");
    const run = start({ permissions: permission.permissions, deadlineMs: 20_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.summary()).toEqual([]);

    permission.change("granted");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(run.summary()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.summary()).toEqual(["error:timeout"]);
  });

  it.each(["granted", "denied"] as const)("starts the deadline right away when permission is %s", async (state) => {
    const run = start({ permissions: permissionsMock(state).permissions, deadlineMs: 20_000 });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(run.summary()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.summary()).toEqual(["error:timeout"]);
  });

  it("falls back to a longer deadline when permission state is unknown", async () => {
    const run = start({ permissions: null, unknownPermissionDeadlineMs: 45_000 });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(run.summary()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.summary()).toEqual(["error:timeout"]);
  });

  it("settles on the best fix when the deadline passes during refinement", async () => {
    const run = start({ permissions: permissionsMock("granted").permissions, deadlineMs: 3_000, refineMs: 10_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    run.coarse.success?.(position(250));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run.summary()).toEqual(["fix:250", "final:250"]);
  });

  it("stays silent after cancellation", async () => {
    const run = start();
    run.cancel();
    run.coarse.success?.(position(10));
    run.precise.error?.(failure(1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.updates).toEqual([]);
    expect(run.clearWatch).toHaveBeenCalledWith(7);
  });

  it("reports a browser that throws on request", () => {
    const updates: LocateUpdate[] = [];
    const geolocation = { getCurrentPosition: () => { throw new Error("blocked"); } } as unknown as Geolocation;
    locateOnce((update) => updates.push(update), { geolocation, permissions: null });
    expect(updates).toEqual([{ type: "error", code: "position-unavailable" }]);
  });
});

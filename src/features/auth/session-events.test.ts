import { describe, expect, it } from "vitest";
import { AUTH_EVENT_KEY, isSignOutChannelEvent, isSignOutStorageEvent } from "./session-events";

describe("session events", () => {
  it("accepts only the explicit sign-out storage key", () => {
    expect(isSignOutStorageEvent({ key: AUTH_EVENT_KEY })).toBe(true);
    expect(isSignOutStorageEvent({ key: "otgolosok:walk:v1" })).toBe(false);
    expect(isSignOutStorageEvent({ key: null })).toBe(false);
  });
  it("accepts only the sign-out channel message", () => {
    expect(isSignOutChannelEvent({ data: "signed-out" })).toBe(true);
    expect(isSignOutChannelEvent({ data: "signed-in" })).toBe(false);
  });
});

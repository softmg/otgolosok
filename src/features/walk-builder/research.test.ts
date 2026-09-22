import { afterEach, describe, expect, it, vi } from "vitest";
import { applyResearch, editDraft, emptyDraft, parseDraft, readResearchJob, researchKey, researchLookup, researchMatches, saveDraft, type Draft, type ResearchJob, type ResearchRequest } from "./model";
import { request, RejectedRequest, RequestError, shouldOfferResearch } from "./request";

const start = { address: "Москва, Первая улица, 1", location: { lat: 55.75, lon: 37.6 } };
const stop = { address: "Москва, Вторая улица, 2", location: { lat: 55.752, lon: 37.602 } };
const snapshot: ResearchRequest = { start, mode: "loop", minutes: 30 };
const id = "12345678-1234-1234-1234-123456789abc";
const recoveryToken = "12345678-1234-4234-8234-123456789def";
const job: ResearchJob = { id, request: { ...snapshot, start: { ...start, address: "Начало прогулки" } }, stage: "ready", revision: 12, phase: "complete", progress: { checked: 1, total: 1, accepted: 1 }, route: { stops: [stop], geometry: [start.location, stop.location], distanceM: 600, walkingMinutes: 10, attribution: "OpenStreetMap" }, stories: [{ place: stop, id, stage: "ready" }], error: null, canRetry: false };
const draft: Draft = { ...emptyDraft(), start, research: { request: snapshot, stops: [], id, recoveryToken } };

afterEach(() => vi.unstubAllGlobals());
describe("research persistence and application", () => {
  it("uses exactly rounded-six coordinates, mode and duration, never the address", () => {
    const renamed = { ...snapshot, start: { address: "Другое название", location: { lat: 55.7500004, lon: 37.6000004 } } };
    expect(researchKey(renamed)).toBe(researchKey(snapshot));
    expect(researchLookup(renamed, recoveryToken)).toBe(`/api/walk-research-jobs?lat=55.75&lon=37.6&mode=loop&minutes=30&recoveryToken=${recoveryToken}`);
    expect(researchKey({ ...snapshot, minutes: 60 })).not.toBe(researchKey(snapshot));
    expect(researchKey({ ...snapshot, mode: "open" })).not.toBe(researchKey(snapshot));
  });
  it("keeps old v1 drafts and both uncertain intent and durable IDs", () => {
    expect(parseDraft(JSON.stringify(emptyDraft()))).toEqual(emptyDraft());
    expect(parseDraft(JSON.stringify(draft))).toEqual(draft);
    const uncertain = { ...draft, research: { ...draft.research!, id: null } };
    expect(parseDraft(JSON.stringify(uncertain))).toEqual(uncertain);
    expect(() => parseDraft(JSON.stringify({ ...draft, research: { id: "bad" } }))).toThrow();
    for (const token of [undefined, null, "", "not-a-token"]) {
      expect(() => parseDraft(JSON.stringify({ ...draft, research: { ...draft.research, recoveryToken: token } }))).toThrow();
    }
  });
  it("preserves references on edits but rejects stale route and story application", () => {
    for (const change of [{ start: stop }, { stops: [stop] }, { mode: "open" as const }, { minutes: 60 as const }]) {
      const next = editDraft(draft, change);
      expect(next.research).toEqual(draft.research);
      expect(researchMatches(next, draft.research!)).toBe(false);
      expect(() => applyResearch(next, job)).toThrow();
    }
    expect(() => applyResearch(draft, { ...job, request: { ...snapshot, minutes: 90 } })).toThrow();
    expect(() => applyResearch(draft, { ...job, stories: [] })).toThrow();
    expect(() => applyResearch(draft, { ...job, stage: "voicing" })).toThrow();
  });
  it("applies the exact route and existing story references without any network request", () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const next = applyResearch(draft, readResearchJob(job));
    expect(next.route).toBe(job.route);
    expect(next.jobs).toEqual(job.stories);
    expect(next.researchApplied).toBe(true);
    expect(next.start?.address).toBe(start.address);
    expect(next.research?.request.start.address).toBe(start.address);
    expect(next.research?.recoveryToken).toBe(recoveryToken);
    expect(parseDraft(JSON.stringify(next))).toEqual(next);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects stale tabs and storage failures without overwriting the original", () => {
    const setItem = vi.fn();
    expect(() => saveDraft({ getItem: () => "other tab", setItem }, draft, null)).toThrow();
    expect(setItem).not.toHaveBeenCalled();
    expect(() => saveDraft({ getItem: () => null, setItem: () => { throw new Error("full"); } }, draft, null)).toThrow("full");
    expect(draft.research?.id).toBe(id);
  });
  it("validates public unwrapped progress and route data", () => {
    expect(readResearchJob(job)).toEqual(job);
    for (const value of [{ job }, { ...job, revision: -1 }, { ...job, progress: { checked: 4, total: 3, accepted: 2 } }, { ...job, route: { ...job.route, walkingMinutes: 60 } }]) expect(() => readResearchJob(value)).toThrow();
  });
  it("rejects a different poll ID or request even when that response is terminal", () => {
    expect(readResearchJob(job, draft.research)).toBe(job);
    expect(() => readResearchJob({ ...job, id: recoveryToken }, draft.research)).toThrow("другое исследование");
    expect(() => readResearchJob({ ...job, request: { ...job.request, mode: "open" } }, draft.research)).toThrow("другое исследование");
    expect(readResearchJob(job, { ...draft.research!, id: null })).toBe(job);
  });
});
describe("walk requests", () => {
  it("offers research for automatic stop shortages and unroutable automatic candidates", () => {
    const shortage = new RejectedRequest("Insufficient ready stops", "WALK_STOPS_NOT_FOUND", 422);
    const unroutable = new RejectedRequest("No route through automatic candidates", "WALK_NOT_FOUND", 404);
    expect(shouldOfferResearch("auto", shortage)).toBe(true);
    expect(shouldOfferResearch("auto", unroutable)).toBe(true);
    expect(shouldOfferResearch("manual", shortage)).toBe(false);
    expect(shouldOfferResearch("manual", unroutable)).toBe(false);
    for (const error of [new Error("WALK_STOPS_NOT_FOUND"), new RequestError("Unavailable", "SERVICE_UNAVAILABLE", 503)]) expect(shouldOfferResearch("auto", error)).toBe(false);
  });
  it("preserves error codes for CTA gating, missing recovery and unavailable providers", async () => {
    for (const [status, code] of [[422, "WALK_STOPS_NOT_FOUND"], [404, "NOT_FOUND"], [503, "RESEARCH_UNAVAILABLE"]] as const) {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { code, message: "Unavailable" } }), { status }))));
      const result = request("/api/walk-plan", new AbortController().signal);
      await expect(result).rejects.toMatchObject({ code, status });
      await expect(result).rejects.toBeInstanceOf(status < 500 ? RejectedRequest : RequestError);
    }
  });
  it("lookup and polling are GET-only; only explicit create and retry send bodies", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(job))));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const restored = parseDraft(JSON.stringify({ ...draft, research: { ...draft.research!, id: null } })).research!;
    await request(researchLookup(restored.request, restored.recoveryToken), signal);
    await request(`/api/walk-research-jobs/${id}`, signal);
    await request("/api/walk-research-jobs", signal, { ...snapshot, consent: true, recoveryToken: restored.recoveryToken });
    await request(`/api/walk-research-jobs/${id}/retry`, signal, { revision: 12 });
    expect(fetch.mock.calls[0][1].method).toBeUndefined();
    expect(fetch.mock.calls[1][1].body).toBeUndefined();
    expect(JSON.parse(fetch.mock.calls[2][1].body).consent).toBe(true);
    expect(JSON.parse(fetch.mock.calls[2][1].body).recoveryToken).toBe(recoveryToken);
    expect(new URL(fetch.mock.calls[0][0], "https://example.test").searchParams.get("recoveryToken")).toBe(recoveryToken);
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({ revision: 12 });
  });
});

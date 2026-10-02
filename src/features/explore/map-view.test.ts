import { describe, expect, it, vi } from "vitest";
import { createMapView } from "./map-view";

/** A map 390×844 that records the view calls and fires Leaflet's start events like the real one. */
function fakeMap() {
  const listeners = new Set<() => void>();
  let zoom = 14;
  const fire = () => listeners.forEach(listener => listener());
  const map = {
    getSize: () => ({ x: 390, y: 844 }),
    getZoom: () => zoom,
    /** Leaflet с zoomSnap 0.25 возвращает четверти уровня. */
    getBoundsZoom: vi.fn(() => 15.75),
    setView: vi.fn((_: unknown, value: number) => { zoom = value; fire(); return map; }),
    panBy: vi.fn(() => { fire(); return map; }),
    fitBounds: vi.fn(() => { fire(); return map; }),
    on: vi.fn((_: string, listener: () => void) => { listeners.add(listener); return map; }),
    off: vi.fn((_: string, listener: () => void) => { listeners.delete(listener); return map; }),
    /** A drag, a wheel or a zoom button: Leaflet fires movestart/zoomstart outside our calls. */
    userGesture: fire,
  };
  return map;
}

const route: [number, number][] = [[55.75, 37.6], [55.76, 37.61]];
const panels = { top: 130, right: 12, bottom: 344, left: 12 };

describe("вид карты", () => {
  it("вписывает маршрут в свободную область с запасом на метку", () => {
    const map = fakeMap();
    const view = createMapView(map as never);
    view.setInsets(panels);
    view.fit(route);
    expect(map.getBoundsZoom).toHaveBeenLastCalledWith(route, false, { x: 72, y: 522 });
    expect(map.fitBounds).toHaveBeenLastCalledWith(route, { paddingTopLeft: [36, 154], paddingBottomRight: [36, 368], maxZoom: 15, animate: false });
  });

  it.each([
    ["дробный масштаб округляется вниз до целого", 15.75, 15],
    ["целый масштаб не меняется", 16, 16],
    ["короткий маршрут ограничен максимальным масштабом", 18.5, 17],
  ])("%s", (_name, boundsZoom, zoom) => {
    const map = fakeMap();
    map.getBoundsZoom.mockReturnValue(boundsZoom);
    createMapView(map as never).fit(route);
    expect(map.fitBounds).toHaveBeenLastCalledWith(route, expect.objectContaining({ maxZoom: zoom }));
  });

  it("переписывает маршрут, пока пользователь не трогал карту", () => {
    const map = fakeMap();
    const view = createMapView(map as never);
    view.fit(route);
    view.setInsets(panels);
    expect(map.fitBounds).toHaveBeenCalledTimes(2);
    view.resized();
    expect(map.fitBounds).toHaveBeenCalledTimes(3);
  });

  it("не сбрасывает масштаб пользователя, когда меняются панели", () => {
    const map = fakeMap();
    const view = createMapView(map as never);
    view.fit(route);
    map.userGesture();
    view.setInsets(panels);
    view.resized();
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it("новый маршрут или новая точка снова управляют видом", () => {
    const map = fakeMap();
    const view = createMapView(map as never);
    view.fit(route);
    map.userGesture();
    view.focus({ lat: 55.7, lon: 37.5 });
    view.setInsets(panels);
    expect(map.setView).toHaveBeenCalledTimes(2);
    map.userGesture();
    view.fit(route);
    view.setInsets({ ...panels, bottom: 200 });
    expect(map.fitBounds).toHaveBeenCalledTimes(3);
  });

  it("ставит выбранную точку в центр свободной области", () => {
    const map = fakeMap();
    const view = createMapView(map as never);
    view.setInsets(panels);
    view.focus({ lat: 55.7, lon: 37.5 });
    expect(map.setView).toHaveBeenLastCalledWith([55.7, 37.5], 16, { animate: false });
    // The free box is centred 107 px above the middle of the map: the view moves down by that.
    expect(map.panBy).toHaveBeenLastCalledWith([0, 107], { animate: false });
  });

  it("без панелей точка остаётся в центре и сохраняет заданный масштаб", () => {
    const map = fakeMap();
    const view = createMapView(map as never);
    view.focus({ lat: 55.7, lon: 37.5, zoom: 12 });
    expect(map.setView).toHaveBeenLastCalledWith([55.7, 37.5], 12, { animate: false });
    expect(map.panBy).not.toHaveBeenCalled();
  });

  it("убранный маршрут не возвращается при смене панелей", () => {
    const map = fakeMap();
    const view = createMapView(map as never);
    view.fit(route);
    view.clearFit();
    view.setInsets(panels);
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { StoryAudioPlayer } from "./story-audio-player";

let container: HTMLDivElement;
let root: Root;
let play: MockInstance<HTMLMediaElement["play"]>;
let pause: MockInstance<HTMLMediaElement["pause"]>;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  });
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
    this.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root.render(createElement(StoryAudioPlayer, { src: "/api/story-audio/a.mp3" })));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

const audio = () => container.querySelector("audio")!;
const button = () => container.querySelector<HTMLButtonElement>("section[aria-label='Плеер истории'] button")!;
const timeline = () => container.querySelector<HTMLInputElement>("input[type='range']")!;
const setDuration = async (value: number) => {
  Object.defineProperty(audio(), "duration", { configurable: true, value });
  await act(async () => audio().dispatchEvent(new Event("loadedmetadata")));
};

describe("плеер истории вне прогулки", () => {
  it("показывает тот же плеер, что и прогулка, а не стандартный плеер браузера", () => {
    expect(audio().controls).toBe(false);
    expect(button().getAttribute("aria-label")).toBe("Слушать историю");
    // Until the length is known the timeline cannot jump.
    expect(timeline().disabled).toBe(true);
  });

  it("запускает и ставит на паузу запись одной кнопкой", async () => {
    await act(async () => button().click());
    expect(play).toHaveBeenCalledTimes(1);
    expect(button().getAttribute("aria-label")).toBe("Пауза");
    await act(async () => button().click());
    expect(pause).toHaveBeenCalledTimes(1);
    expect(button().getAttribute("aria-label")).toBe("Продолжить");
  });

  it.each([
    { case: "внутри записи", target: 30, expected: 30 },
    { case: "до начала", target: -15, expected: 0 },
    { case: "после конца", target: 500, expected: 120 },
  ])("перематывает по шкале $case", async ({ target, expected }) => {
    await setDuration(120);
    expect(timeline().disabled).toBe(false);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(timeline(), String(target));
      timeline().dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(audio().currentTime).toBe(expected);
  });

  it("не даёт перематывать запись неизвестной длины", async () => {
    await setDuration(Infinity);
    expect(timeline().disabled).toBe(true);
  });

  it("сообщает об ошибке запуска и даёт повторить", async () => {
    play.mockImplementationOnce(() => Promise.reject(new DOMException("blocked", "NotAllowedError")));
    await act(async () => button().click());
    expect(container.querySelector("[role='alert']")?.textContent).toContain("Не удалось включить запись");
    expect(button().getAttribute("aria-label")).toBe("Повторить запуск звука");
    await act(async () => button().click());
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
    expect(button().getAttribute("aria-label")).toBe("Пауза");
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("не пугает ошибкой предзагрузки, пока запись не пытались включить, и перезагружает её по нажатию", async () => {
    await act(async () => audio().dispatchEvent(new Event("error")));
    expect(container.querySelector("[role='alert']")).toBeNull();
    expect(button().getAttribute("aria-label")).toBe("Слушать историю");
    await act(async () => button().click());
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
    expect(button().getAttribute("aria-label")).toBe("Пауза");
  });

  it("сообщает, если запись оборвалась во время прослушивания", async () => {
    await act(async () => button().click());
    await act(async () => audio().dispatchEvent(new Event("error")));
    expect(container.querySelector("[role='alert']")).not.toBeNull();
    expect(button().getAttribute("aria-label")).toBe("Повторить запуск звука");
  });

  it("останавливает звук, когда карточку закрывают", async () => {
    await act(async () => button().click());
    await act(async () => root.unmount());
    expect(pause).toHaveBeenCalled();
    root = createRoot(container);
  });
});

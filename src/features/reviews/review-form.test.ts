// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewForm, type ReviewFormProps } from "./review-form";
import { saveReviewDraft } from "./device";

const target = { kind: "catalog" as const, id: "arbat" };
let root: Root, container: HTMLDivElement;

async function mount(props: Partial<ReviewFormProps> = {}) {
  const full: ReviewFormProps = {
    target, reviewer: { kind: "guest" }, mine: null, loginHref: "/login?returnTo=%2Fwalk",
    save: vi.fn().mockResolvedValue({ ok: true, status: "published" }), remove: vi.fn().mockResolvedValue({ ok: true, status: null }),
    ...props,
  };
  await act(async () => root.render(createElement(ReviewForm, full)));
  return full;
}
const button = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent === text);
const radio = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
async function type(value: string) {
  const textarea = container.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(textarea, value); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function submit() {
  await act(async () => container.querySelector("form")!.requestSubmit());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("offers five native radios and keeps submit disabled until a rating is chosen", async () => {
  const props = await mount();
  const radios = container.querySelectorAll<HTMLInputElement>("input[type=radio]");
  expect([...radios].map(item => item.getAttribute("aria-label"))).toEqual(["1 звезда из 5", "2 звезды из 5", "3 звезды из 5", "4 звезды из 5", "5 звёзд из 5"]);
  expect(new Set([...radios].map(item => item.name)).size).toBe(1);
  expect(button("Отправить отзыв")!.disabled).toBe(true);
  await act(async () => radio("4 звезды из 5").click());
  expect(radio("4 звезды из 5").checked).toBe(true);
  expect(radio("4 звезды из 5").closest("label")!.dataset.checked).toBe("true");
  await type("Отличный маршрут 😀");
  expect(container.textContent).toContain("18 / 1000");
  expect(container.querySelector("textarea")!.maxLength).toBe(1000);
  await submit();
  expect(props.save).toHaveBeenCalledWith({ rating: 4, text: "Отличный маршрут 😀" });
});

it.each([
  ["published", "Спасибо! Оценка учтена."],
  ["pending", "Спасибо! Отзыв появится после проверки редакцией."],
  ["hidden", "Отзыв скрыт редакцией."],
] as const)("shows the result for status %s", async (status, message) => {
  await mount({ save: vi.fn().mockResolvedValue({ ok: true, status }) });
  await act(async () => radio("5 звёзд из 5").click());
  await submit();
  expect(container.querySelector("[role=status]")!.textContent).toBe(message);
});

it("keeps the draft after a failed save and offers a retry", async () => {
  saveReviewDraft(target, { rating: 2, text: "черновик" });
  const save = vi.fn().mockResolvedValueOnce({ ok: false, message: "Нет связи с сервером." }).mockResolvedValueOnce({ ok: true, status: "pending" });
  await mount({ save, mine: { rating: 5, text: "старый", status: "published", updatedAt: "" } });
  expect(container.querySelector("textarea")!.value).toBe("черновик");
  expect(radio("2 звезды из 5").checked).toBe(true);
  await submit();
  expect(container.querySelector("[role=alert]")!.textContent).toBe("Нет связи с сервером.");
  expect(container.querySelector("textarea")!.value).toBe("черновик");
  await act(async () => button("Повторить")!.click());
  expect(save).toHaveBeenCalledTimes(2);
  expect(container.querySelector("[role=alert]")).toBeNull();
});

it("confirms deletion inline", async () => {
  const props = await mount({ mine: { rating: 3, text: "текст", status: "pending", updatedAt: "" } });
  expect(container.textContent).toContain("На модерации");
  expect(button("Сохранить изменения")).toBeTruthy();
  await act(async () => button("Удалить отзыв")!.click());
  expect(container.textContent).toContain("Удалить отзыв?");
  await act(async () => button("Отмена")!.click());
  expect(props.remove).not.toHaveBeenCalled();
  await act(async () => button("Удалить отзыв")!.click());
  await act(async () => button("Удалить")!.click());
  expect(props.remove).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[role=status]")!.textContent).toBe("Отзыв удалён.");
});

it("asks a guest without storage to sign in", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
  await mount();
  expect(container.textContent).toContain("Браузер не даёт сохранить ключ отзыва. Войдите, чтобы оставить отзыв.");
  expect(container.querySelector("a")!.getAttribute("href")).toBe("/login?returnTo=%2Fwalk");
  expect(container.querySelector("form")).toBeNull();
});

it("discloses the public author name", async () => {
  await mount({ reviewer: { kind: "user", name: "Анна" } });
  expect(container.textContent).toContain("Отзыв будет опубликован с именем «Анна».");
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount();
  expect(container.textContent).toContain("Отзыв будет опубликован от имени «Гость». Изменить его можно только в этом браузере.");
});

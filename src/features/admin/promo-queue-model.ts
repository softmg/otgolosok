// Promo queue shared by the admin list of user walks and the queue tab.

export type PromoStatus = "queued" | "building" | "ready" | "published" | "failed" | "cancelled";
export type PromoState = { status: PromoStatus; slotAt: string | null; youtubeUrl: string | null };
export type PromoItem = {
  id: string; walkId: string; title: string; shareToken: string | null; visibility: string | null;
  position: number; status: PromoStatus; slotAt: string | null; runId: string | null;
  youtubeUrl: string | null; telegramUrl: string | null; error: string | null; revision: number;
  createdAt: string; updatedAt: string;
};
export type PromoQueue = { items: PromoItem[]; history: PromoItem[] };

export const promoStatusLabels: Record<PromoStatus, string> = {
  queued: "в очереди", building: "собирается", ready: "готов к выходу",
  published: "опубликован", failed: "ошибка", cancelled: "отменён",
};

/** Slot time in Moscow, the time zone of the schedule, whatever the browser's zone is. */
export function slotLabel(slotAt: string | null) {
  if (!slotAt) return "время не назначено";
  return new Date(slotAt).toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow", weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  }) + " МСК";
}

/** The admin column in words: status and the planned or past slot. */
export function promoText(promo: PromoState | null) {
  if (!promo) return "Без промо";
  if (promo.status === "published") return "Опубликован";
  return `${promoStatusLabels[promo.status]} · ${slotLabel(promo.slotAt)}`;
}

/** A walk can be queued when nothing for it is waiting; a published walk may be promoted again. */
export const canEnqueue = (promo: PromoState | null) => !promo || promo.status === "published";

/** Link-only walks become public through YouTube and Telegram: the editor confirms it. */
export const PROMO_LINK_ONLY_WARNING =
  "Прогулка доступна только по ссылке. В промо ссылка станет публичной в YouTube и Telegram. Поставить в очередь?";

"use client";

import { useEffect, useRef, useState } from "react";
import { pageCount, pageRange, type AdminApi, type AdminRun } from "./model";
import { skeletonRows } from "./table-skeleton";
import styles from "./reviews-admin.module.css";

type ReviewStatus = "pending" | "published" | "hidden";
type AdminReview = {
  id: string; rating: number; text: string; status: ReviewStatus;
  createdAt: string; updatedAt: string; moderatedAt: string | null;
  walk: { kind: "catalog" | "account"; id: string; title: string; url: string | null };
  author: { kind: "user"; id: string; name: string; email: string } | { kind: "guest" };
};
type ReviewPage = { reviews: AdminReview[]; total: number; offset: number; hasMore: boolean; pending: number };
type Filters = { status: ReviewStatus | "all"; rating: string; q: string };
const EMPTY_FILTERS: Filters = { status: "pending", rating: "", q: "" };
const PAGE_SIZE = 25;
const statusLabels: Record<ReviewStatus, string> = { pending: "На модерации", published: "Опубликован", hidden: "Скрыт" };
const dateLabel = (value: string) => new Date(value).toLocaleString("ru-RU");

export function ReviewsAdmin({ api, run, busy }: { api: AdminApi; run: AdminRun; busy: string }) {
  const loaded = useRef(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState<ReviewPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function load(next: Filters, offset: number, signal: AbortSignal) {
    setLoading(true); setFailed(false);
    try {
      const params = new URLSearchParams({ status: next.status, ...(next.rating ? { rating: next.rating } : {}), ...(next.q ? { q: next.q } : {}), limit: String(PAGE_SIZE), offset: String(offset) });
      const result = await api<ReviewPage>(`/reviews?${params}`, signal);
      setPage(result); setApplied(next);
    } catch (error) { setFailed(true); throw error; }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (busy || loaded.current) return;
    void run("Загрузка отзывов…", async signal => {
      loaded.current = true;
      await load(EMPTY_FILTERS, 0, signal);
    });
    // The initial request runs once after the parent releases its authentication request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, busy, run]);

  function act(review: AdminReview, label: string, path: string, body: unknown, done: string) {
    setNotice(""); setConfirmDelete(null);
    void run(label, async signal => {
      await api(`/reviews/${review.id}/${path}`, signal, body);
      setNotice(done);
      await load(applied, page?.offset ?? 0, signal);
    });
  }

  const disabled = Boolean(busy) || loading;
  const hasFilters = applied.status !== "pending" || Boolean(applied.rating || applied.q);
  return <section className="walk-admin" aria-busy={loading} aria-labelledby="reviews-admin-title">
    <div className="walk-admin__head">
      <div><h2 id="reviews-admin-title">Отзывы</h2><p>{page ? `На модерации: ${page.pending}` : "Отзывы к прогулкам. Текст публикуется только после проверки."}</p></div>
      <button type="button" disabled={disabled} onClick={() => void run("Обновление отзывов…", signal => load(applied, page?.offset ?? 0, signal))}>Обновить список</button>
    </div>
    <form className={styles.filters} onSubmit={event => {
      event.preventDefault();
      setNotice("");
      void run("Поиск отзывов…", signal => load({ ...filters, q: filters.q.trim() }, 0, signal));
    }}>
      <label>Статус<select value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value as Filters["status"] })}>
        <option value="pending">На модерации</option><option value="published">Опубликованные</option><option value="hidden">Скрытые</option><option value="all">Все</option>
      </select></label>
      <label>Оценка<select value={filters.rating} onChange={event => setFilters({ ...filters, rating: event.target.value })}>
        <option value="">Любая</option>{[1, 2, 3, 4, 5].map(value => <option key={value} value={String(value)}>{value}</option>)}
      </select></label>
      <label>Название прогулки<input type="search" maxLength={120} value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} /></label>
      <button type="submit" className="admin-primary" disabled={disabled}>Найти</button>
      <button type="button" disabled={disabled || (!hasFilters && filters.status === "pending" && !filters.rating && !filters.q)} onClick={() => {
        setFilters(EMPTY_FILTERS); setNotice("");
        void run("Сброс фильтров…", signal => load(EMPTY_FILTERS, 0, signal));
      }}>Сбросить</button>
    </form>
    {notice && <p className="walk-admin__message" role="status">{notice}</p>}
    {failed && <p className="walk-admin__message walk-admin__message--error" role="alert">Не удалось загрузить отзывы. {page ? "Показаны ранее загруженные данные. " : ""}<button type="button" disabled={disabled} onClick={() => void run("Повторная загрузка…", signal => load(applied, page?.offset ?? 0, signal))}>Повторить</button></p>}
    <p className="admin-meta" role="status">{loading ? "Загружаем отзывы…" : page ? `Показано ${pageRange(page.offset, page.reviews.length, page.total)} отзывов.` : ""}</p>
    <div className="walk-admin__table-wrap" role="region" aria-label="Список отзывов" tabIndex={0}>
      <table className={`walk-admin__table ${styles.table}`}>
        <caption className="admin-sr-only">Отзывы к прогулкам и их статус</caption>
        <thead><tr><th scope="col">Отзыв</th><th scope="col">Прогулка</th><th scope="col">Автор</th><th scope="col">Даты</th><th scope="col">Действия</th></tr></thead>
        <tbody>{loading ? skeletonRows(5, page?.reviews.length ?? 0) : page?.reviews.map(review => <tr key={review.id}>
          <th scope="row">
            <span className={styles.rating} role="img" aria-label={`Оценка ${review.rating} из 5`}>{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</span>
            <span className={styles.status} data-status={review.status}>{statusLabels[review.status]}</span>
            {review.text ? <p className={styles.text}>{review.text}</p> : <span className={styles.meta}>Без текста</span>}
          </th>
          <td>{review.walk.url ? <a href={review.walk.url} target="_blank" rel="noopener noreferrer">{review.walk.title}</a> : review.walk.title}
            {review.walk.url ? null : <span className={styles.meta}>Прогулка удалена или закрыта</span>}</td>
          <td>{review.author.kind === "user" ? <><strong>{review.author.name || "Без имени"}</strong><span className={styles.meta}>{review.author.email}</span></> : "Гость"}</td>
          <td><time dateTime={review.updatedAt}>{dateLabel(review.updatedAt)}</time><span className={styles.meta}>Создан {dateLabel(review.createdAt)}</span></td>
          <td><div className={styles.actions}>
            {review.status !== "published" ? <button type="button" disabled={disabled} onClick={() => act(review, "Публикация отзыва…", "moderate", { action: "publish" }, "Отзыв опубликован.")}>Опубликовать</button> : null}
            {review.status !== "hidden" ? <button type="button" disabled={disabled} onClick={() => act(review, "Скрытие отзыва…", "moderate", { action: "hide" }, "Отзыв скрыт.")}>Скрыть</button> : null}
            {confirmDelete === review.id ? <span className={styles.confirm} role="group" aria-label="Подтверждение удаления">Удалить отзыв?
              <button type="button" className={styles.danger} disabled={disabled} onClick={() => act(review, "Удаление отзыва…", "delete", {}, "Отзыв удалён.")}>Удалить</button>
              <button type="button" disabled={disabled} onClick={() => setConfirmDelete(null)}>Отмена</button>
            </span> : <button type="button" disabled={disabled} onClick={() => setConfirmDelete(review.id)}>Удалить</button>}
          </div></td>
        </tr>)}</tbody>
      </table>
      {page && !page.total && !loading && !failed && <p className="walk-admin__empty">{hasFilters ? "По этим фильтрам отзывов нет. Измените условия или сбросьте фильтры." : "Новых отзывов на модерации нет."}</p>}
    </div>
    {page && <nav className="admin-pagination" aria-label="Страницы отзывов">
      <button type="button" disabled={disabled || page.offset === 0} onClick={() => void run("Загрузка отзывов…", signal => load(applied, Math.max(0, page.offset - PAGE_SIZE), signal))}>Назад</button>
      <span className="admin-meta">Страница {Math.floor(page.offset / PAGE_SIZE) + 1} из {pageCount(page.total, PAGE_SIZE)}</span>
      <button type="button" disabled={disabled || !page.hasMore} onClick={() => void run("Загрузка отзывов…", signal => load(applied, page.offset + PAGE_SIZE, signal))}>Далее</button>
    </nav>}
  </section>;
}

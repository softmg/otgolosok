"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { WalkAdmin } from "./walk-admin";
import { pageCount, pageRange, type AdminApi, type AdminRun } from "./model";
import { skeletonRows } from "./table-skeleton";
import { canEnqueue, PROMO_LINK_ONLY_WARNING, promoText, type PromoState } from "./promo-queue-model";
import { PromoQueueAdmin } from "./promo-queue-admin";
import styles from "./shared-walk-admin.module.css";

type Visibility = "shared" | "public";
type ListingStatus = "pending" | "approved" | "hidden";
type SharedWalk = {
  id: string; title: string; shareToken: string; revision: number; createdAt: string; updatedAt: string;
  visibility: Visibility; listingStatus: ListingStatus | null;
  author: { id: string; name: string; email: string } | null;
  mode: "open" | "loop" | null; stopCount: number | null;
  walkingMinutes: number | null; distanceM: number | null; snapshotError: string | null;
  launches: number; promo: PromoState | null;
};
type WalkPage = { walks: SharedWalk[]; total: number; offset: number; hasMore: boolean; pending: number };
type Filters = { q: string; author: string; mode: string; access: string; listing: string; promo: string };
const EMPTY_FILTERS: Filters = { q: "", author: "", mode: "all", access: "all", listing: "all", promo: "all" };
const STALE_MESSAGE = "Прогулка изменилась — обновите список.";
const PAGE_SIZE = 25;
const modeLabels = { open: "В одну сторону", loop: "Кольцевой" };
const listingLabels: Record<ListingStatus, string> = { pending: "на проверке", approved: "в топе", hidden: "скрыта из топа" };
/** Access and top state in words, so the table never relies on colour. */
export const accessText = (walk: Pick<SharedWalk, "visibility" | "listingStatus">) =>
  walk.visibility === "public" ? `Всем · ${listingLabels[walk.listingStatus ?? "pending"]}` : "По ссылке";
const dateLabel = (value: string) => new Date(value).toLocaleString("ru-RU");

export function SharedWalkAdmin({ api, run, busy, onPending }: { api: AdminApi; run: AdminRun; busy: string; onPending?: (count: number) => void }) {
  const loaded = useRef(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState<WalkPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState("");
  const [manualLink, setManualLink] = useState("");
  const [copying, setCopying] = useState(false);

  async function loadPage(next: Filters, offset: number, signal: AbortSignal) {
    setLoading(true); setFailed(false); setNotice(""); setManualLink("");
    try {
      const params = new URLSearchParams({ ...next, limit: String(PAGE_SIZE), offset: String(offset) });
      const result = await api<WalkPage>(`/walks/shared?${params}`, signal);
      setPage(result); setApplied(next); setFilters(next); onPending?.(result.pending);
      return result;
    } catch (error) { setFailed(true); throw error; }
    finally { setLoading(false); }
  }
  async function load(next: Filters, offset: number, signal: AbortSignal) { await loadPage(next, offset, signal); }

  useEffect(() => {
    if (busy || loaded.current) return;
    void run("Загрузка пользовательских прогулок…", async signal => {
      loaded.current = true;
      const first = await loadPage(EMPTY_FILTERS, 0, signal);
      // The moderation queue opens first while public walks await review.
      if (first.pending > 0) await load({ ...EMPTY_FILTERS, listing: "pending" }, 0, signal);
    });
    // The initial request runs once after the parent releases its authentication request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, busy, run]);

  async function copyLink(walk: SharedWalk) {
    const url = new URL(`/walk?share=${encodeURIComponent(walk.shareToken)}`, window.location.origin).href;
    setCopying(true); setNotice(""); setManualLink("");
    try { await navigator.clipboard.writeText(url); setNotice(`Ссылка на «${walk.title}» скопирована.`); }
    catch { setNotice("Браузер не разрешил копирование. Выделите и скопируйте ссылку ниже."); setManualLink(url); }
    finally { setCopying(false); }
  }

  function moderate(walk: SharedWalk, action: "approve" | "hide") {
    setNotice(""); setManualLink("");
    void run(action === "approve" ? "Одобрение прогулки…" : "Скрытие прогулки…", async signal => {
      try {
        await api(`/walks/shared/${encodeURIComponent(walk.id)}/listing`, signal, { action, revision: walk.revision });
      } catch (error) {
        if ((error as { status?: number }).status !== 409) throw error;
        await load(applied, page?.offset ?? 0, signal);
        setNotice(STALE_MESSAGE);
        return;
      }
      await load(applied, page?.offset ?? 0, signal);
      setNotice(action === "approve" ? `«${walk.title}» в топе.` : `«${walk.title}» скрыта из топа. Ссылка продолжает работать.`);
    });
  }

  function enqueue(walk: SharedWalk) {
    if (walk.visibility !== "public" && !window.confirm(PROMO_LINK_ONLY_WARNING)) return;
    setNotice(""); setManualLink("");
    void run("Постановка в очередь промо…", async signal => {
      try {
        await api("/promo-queue", signal, { walkId: walk.id });
      } catch (error) {
        if ((error as { status?: number }).status !== 409) throw error;
        await load(applied, page?.offset ?? 0, signal);
        setNotice("Прогулка уже в очереди промо или больше не открыта по ссылке — список обновлён.");
        return;
      }
      await load(applied, page?.offset ?? 0, signal);
      setNotice(`«${walk.title}» в очереди промо. Дата выхода — во вкладке «Очередь промо».`);
    });
  }

  const disabled = Boolean(busy) || loading;
  const hasFilters = Boolean(applied.q || applied.author || applied.mode !== "all" || applied.access !== "all" || applied.listing !== "all" || applied.promo !== "all");
  return <section className="walk-admin" aria-busy={loading} aria-labelledby="shared-walks-title">
    <div className="walk-admin__head">
      <div><h2 id="shared-walks-title">Пользовательские прогулки</h2><p>Прогулки, открытые по ссылке или всем, включая созданные сервисом. Открытые всем попадают в «Топ прогулок» после одобрения. Сначала недавно обновлённые. Запуски — сколько раз прогулку начали по ссылке: один зритель в сутки, без запусков автора.{page ? ` На проверке: ${page.pending}.` : ""}</p></div>
      <button type="button" disabled={disabled} onClick={() => void run("Обновление прогулок…", signal => load(applied, page?.offset ?? 0, signal))}>Обновить список</button>
    </div>
    <form className={styles.filters} onSubmit={event => {
      event.preventDefault();
      void run("Поиск прогулок…", signal => load({ ...filters, q: filters.q.trim(), author: filters.author.trim() }, 0, signal));
    }}>
      <label>Название прогулки<input type="search" maxLength={120} value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} /></label>
      <label>Автор<input type="search" maxLength={120} placeholder="Имя или почта" value={filters.author} onChange={event => setFilters({ ...filters, author: event.target.value })} /></label>
      <label>Тип маршрута<select value={filters.mode} onChange={event => setFilters({ ...filters, mode: event.target.value })}><option value="all">Все типы</option><option value="open">В одну сторону</option><option value="loop">Кольцевой</option></select></label>
      <label>Доступ<select value={filters.access} onChange={event => setFilters({ ...filters, access: event.target.value })}><option value="all">Все</option><option value="shared">По ссылке</option><option value="public">Всем</option></select></label>
      <label>Топ<select value={filters.listing} onChange={event => setFilters({ ...filters, listing: event.target.value })}><option value="all">Все</option><option value="pending">На проверке</option><option value="approved">В топе</option><option value="hidden">Скрытые</option></select></label>
      <label>Промо<select value={filters.promo} onChange={event => setFilters({ ...filters, promo: event.target.value })}><option value="all">Все</option><option value="none">Без промо</option><option value="active">В очереди</option><option value="published">Опубликованы</option></select></label>
      <button type="submit" className="admin-primary" disabled={disabled}>Найти</button>
      <button type="button" disabled={disabled || (!hasFilters && !filters.q && !filters.author && filters.mode === "all" && filters.access === "all" && filters.listing === "all" && filters.promo === "all")} onClick={() => {
        setFilters(EMPTY_FILTERS);
        void run("Сброс фильтров…", signal => load(EMPTY_FILTERS, 0, signal));
      }}>Сбросить</button>
    </form>
    {notice && <p className="walk-admin__message" role="status">{notice}</p>}
    {manualLink && <label className={styles.manual}>Ссылка для копирования<input readOnly value={manualLink} onFocus={event => event.target.select()} /></label>}
    {failed && <p className="walk-admin__message walk-admin__message--error" role="alert">Не удалось загрузить список. {page ? "Показаны ранее загруженные данные. " : ""}<button type="button" disabled={disabled} onClick={() => void run("Повторная загрузка…", signal => load(filters, 0, signal))}>Повторить</button></p>}
    <p className="admin-meta" role="status">{loading ? "Загружаем прогулки…" : page ? `Показано ${pageRange(page.offset, page.walks.length, page.total)} прогулок.` : ""}</p>
    <div className="walk-admin__table-wrap" role="region" aria-label="Список пользовательских прогулок" tabIndex={0}>
      <table className={`walk-admin__table ${styles.table}`}>
        <caption className="admin-sr-only">Пользовательские прогулки, их авторы и доступ</caption>
        <thead><tr><th scope="col">Прогулка</th><th scope="col">Автор</th><th scope="col">Маршрут</th><th scope="col">Даты</th><th scope="col">Доступ</th><th scope="col">Запуски</th><th scope="col">Промо</th><th scope="col">Действия</th></tr></thead>
        <tbody>{loading ? skeletonRows(8, page?.walks.length ?? 0) : page?.walks.map(walk => <tr key={walk.id}>
          <th scope="row"><a href={`/walk?share=${encodeURIComponent(walk.shareToken)}`} target="_blank" rel="noopener noreferrer">{walk.title}</a>{walk.snapshotError && <span className={styles.warning}>Снимок повреждён</span>}</th>
          <td>{walk.author ? <><strong>{walk.author.name || "Без имени"}</strong><span className={styles.meta}>{walk.author.email}</span></> : "Автор неизвестен"}</td>
          <td>{walk.mode ? modeLabels[walk.mode] : "Нет данных"}<span className={styles.meta}>{walk.stopCount !== null ? `Точек: ${walk.stopCount}` : ""}{walk.distanceM !== null ? ` · ${(walk.distanceM / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км` : ""}{walk.walkingMinutes !== null ? ` · ${Math.round(walk.walkingMinutes)} мин пешком` : ""}</span></td>
          <td><time dateTime={walk.updatedAt}>{dateLabel(walk.updatedAt)}</time><span className={styles.meta}>Создана {dateLabel(walk.createdAt)}</span></td>
          <td>{accessText(walk)}</td>
          <td>{walk.launches.toLocaleString("ru-RU")}</td>
          <td>{promoText(walk.promo)}{walk.promo?.youtubeUrl && <a className={styles.meta} href={walk.promo.youtubeUrl} target="_blank" rel="noopener noreferrer">Ролик на YouTube</a>}</td>
          <td className={styles.actions}><button type="button" disabled={disabled || copying} onClick={() => void copyLink(walk)} aria-label={`Скопировать ссылку: ${walk.title}`}>Скопировать ссылку</button>
            {walk.visibility === "public" && walk.listingStatus !== "approved" && <button type="button" disabled={disabled} onClick={() => moderate(walk, "approve")} aria-label={`Одобрить для топа: ${walk.title}`}>Одобрить для топа</button>}
            {walk.visibility === "public" && walk.listingStatus !== "hidden" && <button type="button" disabled={disabled} onClick={() => moderate(walk, "hide")} aria-label={`Скрыть из топа: ${walk.title}`}>Скрыть из топа</button>}
            {canEnqueue(walk.promo) && !walk.snapshotError && <button type="button" disabled={disabled} onClick={() => enqueue(walk)} aria-label={`В очередь промо: ${walk.title}`}>В очередь промо</button>}</td>
        </tr>)}</tbody>
      </table>
      {page && !page.total && !loading && !failed && <p className="walk-admin__empty">{hasFilters ? "По этим фильтрам прогулок нет. Измените условия или сбросьте фильтры." : "Пока никто не открыл доступ к прогулке."}</p>}
    </div>
    {page && <nav className="admin-pagination" aria-label="Страницы пользовательских прогулок">
      <button type="button" disabled={disabled || page.offset === 0} onClick={() => void run("Загрузка прогулок…", signal => load(applied, Math.max(0, page.offset - PAGE_SIZE), signal))}>Назад</button>
      <span className="admin-meta">Страница {Math.floor(page.offset / PAGE_SIZE) + 1} из {pageCount(page.total, PAGE_SIZE)}</span>
      <button type="button" disabled={disabled || !page.hasMore} onClick={() => void run("Загрузка прогулок…", signal => load(applied, page.offset + PAGE_SIZE, signal))}>Далее</button>
    </nav>}
  </section>;
}

export function WalkAdminSection(props: ComponentProps<typeof WalkAdmin>) {
  const [tab, setTab] = useState("shared");
  const [pending, setPending] = useState(0);
  const dirty = useRef(false);
  const { onDirtyChange } = props;
  const trackDirty = useCallback((value: boolean) => { dirty.current = value; onDirtyChange(value); }, [onDirtyChange]);
  return <>
    <nav className="admin-tabs" aria-label="Каталоги прогулок">
      {[{ id: "shared", title: pending > 0 ? `Пользовательские · ${pending}` : "Пользовательские" }, { id: "promo", title: "Очередь промо" }, { id: "editorial", title: "Редактор глав" }].map(item => <button key={item.id} disabled={Boolean(props.busy)} aria-current={tab === item.id ? "page" : undefined} onClick={() => {
        if (tab === item.id || (dirty.current && !window.confirm("Есть несохранённые правки главы. Отбросить их и продолжить?"))) return;
        setTab(item.id);
      }}>{item.title}</button>)}
    </nav>
    {tab === "shared" ? <SharedWalkAdmin api={props.api} busy={props.busy} run={props.run} onPending={setPending} />
      : tab === "promo" ? <PromoQueueAdmin api={props.api} busy={props.busy} run={props.run} />
      : <WalkAdmin {...props} onDirtyChange={trackDirty} />}
  </>;
}

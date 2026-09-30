"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { WalkAdmin } from "./walk-admin";
import { pageCount, pageRange, type AdminApi, type AdminRun } from "./model";
import { skeletonRows } from "./table-skeleton";
import styles from "./shared-walk-admin.module.css";

type SharedWalk = {
  id: string; title: string; shareToken: string; createdAt: string; updatedAt: string;
  author: { id: string; name: string; email: string } | null;
  mode: "open" | "loop" | null; stopCount: number | null;
  walkingMinutes: number | null; distanceM: number | null; snapshotError: string | null;
};
type WalkPage = { walks: SharedWalk[]; total: number; offset: number; hasMore: boolean };
type Filters = { q: string; author: string; mode: string };
const EMPTY_FILTERS: Filters = { q: "", author: "", mode: "all" };
const PAGE_SIZE = 25;
const modeLabels = { open: "В одну сторону", loop: "Кольцевой" };
const dateLabel = (value: string) => new Date(value).toLocaleString("ru-RU");

export function SharedWalkAdmin({ api, run, busy }: { api: AdminApi; run: AdminRun; busy: string }) {
  const loaded = useRef(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState<WalkPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState("");
  const [manualLink, setManualLink] = useState("");
  const [copying, setCopying] = useState(false);

  async function load(next: Filters, offset: number, signal: AbortSignal) {
    setLoading(true); setFailed(false); setNotice(""); setManualLink("");
    try {
      const params = new URLSearchParams({ ...next, limit: String(PAGE_SIZE), offset: String(offset) });
      const result = await api<WalkPage>(`/walks/shared?${params}`, signal);
      setPage(result); setApplied(next);
    } catch (error) { setFailed(true); throw error; }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (busy || loaded.current) return;
    void run("Загрузка общедоступных прогулок…", async signal => {
      loaded.current = true;
      await load(EMPTY_FILTERS, 0, signal);
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

  const disabled = Boolean(busy) || loading;
  const hasFilters = Boolean(applied.q || applied.author || applied.mode !== "all");
  return <section className="walk-admin" aria-busy={loading} aria-labelledby="shared-walks-title">
    <div className="walk-admin__head">
      <div><h2 id="shared-walks-title">Прогулки по ссылке</h2><p>Все прогулки с открытым доступом по ссылке, включая созданные сервисом. Сначала недавно обновлённые.</p></div>
      <button type="button" disabled={disabled} onClick={() => void run("Обновление прогулок…", signal => load(applied, page?.offset ?? 0, signal))}>Обновить список</button>
    </div>
    <form className={styles.filters} onSubmit={event => {
      event.preventDefault();
      void run("Поиск прогулок…", signal => load({ ...filters, q: filters.q.trim(), author: filters.author.trim() }, 0, signal));
    }}>
      <label>Название прогулки<input type="search" maxLength={120} value={filters.q} onChange={event => setFilters({ ...filters, q: event.target.value })} /></label>
      <label>Автор<input type="search" maxLength={120} placeholder="Имя или почта" value={filters.author} onChange={event => setFilters({ ...filters, author: event.target.value })} /></label>
      <label>Тип маршрута<select value={filters.mode} onChange={event => setFilters({ ...filters, mode: event.target.value })}><option value="all">Все типы</option><option value="open">В одну сторону</option><option value="loop">Кольцевой</option></select></label>
      <button type="submit" className="admin-primary" disabled={disabled}>Найти</button>
      <button type="button" disabled={disabled || (!hasFilters && !filters.q && !filters.author && filters.mode === "all")} onClick={() => {
        setFilters(EMPTY_FILTERS);
        void run("Сброс фильтров…", signal => load(EMPTY_FILTERS, 0, signal));
      }}>Сбросить</button>
    </form>
    {notice && <p className="walk-admin__message" role="status">{notice}</p>}
    {manualLink && <label className={styles.manual}>Ссылка для копирования<input readOnly value={manualLink} onFocus={event => event.target.select()} /></label>}
    {failed && <p className="walk-admin__message walk-admin__message--error" role="alert">Не удалось загрузить список. {page ? "Показаны ранее загруженные данные. " : ""}<button type="button" disabled={disabled} onClick={() => void run("Повторная загрузка…", signal => load(filters, 0, signal))}>Повторить</button></p>}
    <p className="admin-meta" role="status">{loading ? "Загружаем прогулки…" : page ? `Показано ${pageRange(page.offset, page.walks.length, page.total)} прогулок.` : ""}</p>
    <div className="walk-admin__table-wrap" role="region" aria-label="Список прогулок по ссылке" tabIndex={0}>
      <table className={`walk-admin__table ${styles.table}`}>
        <caption className="admin-sr-only">Расшаренные прогулки и их авторы</caption>
        <thead><tr><th scope="col">Прогулка</th><th scope="col">Автор</th><th scope="col">Маршрут</th><th scope="col">Даты</th><th scope="col">Ссылка</th></tr></thead>
        <tbody>{loading ? skeletonRows(5, page?.walks.length ?? 0) : page?.walks.map(walk => <tr key={walk.id}>
          <th scope="row"><a href={`/walk?share=${encodeURIComponent(walk.shareToken)}`} target="_blank" rel="noopener noreferrer">{walk.title}</a>{walk.snapshotError && <span className={styles.warning}>Снимок повреждён</span>}</th>
          <td>{walk.author ? <><strong>{walk.author.name || "Без имени"}</strong><span className={styles.meta}>{walk.author.email}</span></> : "Автор неизвестен"}</td>
          <td>{walk.mode ? modeLabels[walk.mode] : "Нет данных"}<span className={styles.meta}>{walk.stopCount !== null ? `Точек: ${walk.stopCount}` : ""}{walk.distanceM !== null ? ` · ${(walk.distanceM / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км` : ""}{walk.walkingMinutes !== null ? ` · ${Math.round(walk.walkingMinutes)} мин пешком` : ""}</span></td>
          <td><time dateTime={walk.updatedAt}>{dateLabel(walk.updatedAt)}</time><span className={styles.meta}>Создана {dateLabel(walk.createdAt)}</span></td>
          <td><button type="button" disabled={disabled || copying} onClick={() => void copyLink(walk)} aria-label={`Скопировать ссылку: ${walk.title}`}>Скопировать ссылку</button></td>
        </tr>)}</tbody>
      </table>
      {page && !page.total && !loading && !failed && <p className="walk-admin__empty">{hasFilters ? "По этим фильтрам прогулок нет. Измените условия или сбросьте фильтры." : "Пока никто не открыл доступ к прогулке по ссылке."}</p>}
    </div>
    {page && <nav className="admin-pagination" aria-label="Страницы общедоступных прогулок">
      <button type="button" disabled={disabled || page.offset === 0} onClick={() => void run("Загрузка прогулок…", signal => load(applied, Math.max(0, page.offset - PAGE_SIZE), signal))}>Назад</button>
      <span className="admin-meta">Страница {Math.floor(page.offset / PAGE_SIZE) + 1} из {pageCount(page.total, PAGE_SIZE)}</span>
      <button type="button" disabled={disabled || !page.hasMore} onClick={() => void run("Загрузка прогулок…", signal => load(applied, page.offset + PAGE_SIZE, signal))}>Далее</button>
    </nav>}
  </section>;
}

export function WalkAdminSection(props: ComponentProps<typeof WalkAdmin>) {
  const [tab, setTab] = useState("shared");
  const dirty = useRef(false);
  const { onDirtyChange } = props;
  const trackDirty = useCallback((value: boolean) => { dirty.current = value; onDirtyChange(value); }, [onDirtyChange]);
  return <>
    <nav className="admin-tabs" aria-label="Каталоги прогулок">
      {[{ id: "shared", title: "По ссылке" }, { id: "editorial", title: "Редактор глав" }].map(item => <button key={item.id} disabled={Boolean(props.busy)} aria-current={tab === item.id ? "page" : undefined} onClick={() => {
        if (tab === item.id || (dirty.current && !window.confirm("Есть несохранённые правки главы. Отбросить их и продолжить?"))) return;
        setTab(item.id);
      }}>{item.title}</button>)}
    </nav>
    {tab === "shared" ? <SharedWalkAdmin api={props.api} busy={props.busy} run={props.run} /> : <WalkAdmin {...props} onDirtyChange={trackDirty} />}
  </>;
}

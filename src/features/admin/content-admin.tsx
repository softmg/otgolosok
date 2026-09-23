"use client";

import { useEffect, useRef, useState } from "react";
import {
  batchItemStates, batchStates, contentErrorOptions, contentStatusOptions, pageCount, pageRange,
  placeStatusOptions, placeTextStatuses, retryableItemStates,
  type AdminApi, type AdminRun, type ContentAudioJob, type ContentBatch, type ContentBatchItemPage,
  type ContentErrorFilter, type ContentHeartbeat, type ContentPlace, type ContentPlaceStatusFilter,
  type ContentPlaceSummary, type ContentStatusFilter, type ContentWorker, type Draft,
} from "./model";
import { skeletonRows } from "./table-skeleton";
import { IdentityCandidates } from "./identity-candidates";
import "./content-admin.css";

type ContentAdminProps = { api: AdminApi; busy: string; run: AdminRun; onDirtyChange: (dirty: boolean) => void };
type Stats = {
  places: number; texts: number; audio: number;
  jobs?: Record<string, number>; external?: Record<string, number>;
  textUsageTokens?: number; oldestTextQueuedAt?: string | null;
  audioQueue?: { oldestQueuedAt: string | null; averageAttemptSec: number | null; artifactBytes: number; artifacts: number };
};
type PlacePage = { places: ContentPlaceSummary[]; total: number; hasMore: boolean };

const PLACE_PAGE = 50;
const ITEM_PAGE = 50;
const BATCH_PAGE = 20;
const HEARTBEAT_WINDOW_MS = 120_000;
const numbers = new Intl.NumberFormat("ru-RU");

function moment(value: string | null | undefined) {
  if (!value) return "нет";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString("ru-RU");
}

/** Item states are grouped into four buckets; each count opens the job list filtered to that bucket. */
function progressSegments(counts: ContentBatch["counts"]): { key: Exclude<ContentStatusFilter, "all">; label: string; value: number }[] {
  return [
    { key: "ready", label: "готово", value: counts.ready },
    { key: "working", label: "в работе", value: counts.working },
    { key: "waiting", label: "ждут", value: counts.queued },
    { key: "stopped", label: "остановлено", value: counts.failed },
  ];
}

export function ContentAdmin({ api, busy, run, onDirtyChange }: ContentAdminProps) {
  const loaded = useRef(false);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const catalogHeading = useRef<HTMLHeadingElement>(null);
  const placeOpener = useRef<HTMLButtonElement | null>(null);
  const pendingNavigation = useRef<"editor" | "catalog" | null>(null);
  const [notice, setNotice] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  // Each table watches its own request: `/content/batches` + workers + audio arrive together, places and items separately.
  const [loading, setLoading] = useState({ overview: false, places: false, items: false });

  const [batches, setBatches] = useState<ContentBatch[]>([]);
  const [batchPage, setBatchPage] = useState(0);
  const [batchLimit, setBatchLimit] = useState(50);
  const [batchMode, setBatchMode] = useState<"text-and-audio" | "text-only">("text-and-audio");

  const [batch, setBatch] = useState<ContentBatch | null>(null);
  const [itemPage, setItemPage] = useState<ContentBatchItemPage | null>(null);
  const [itemStatus, setItemStatus] = useState<ContentStatusFilter>("all");
  const [itemError, setItemError] = useState<ContentErrorFilter>("all");
  const [itemOffset, setItemOffset] = useState(0);

  const [placePage, setPlacePage] = useState<PlacePage>({ places: [], total: 0, hasMore: false });
  const [placeOffset, setPlaceOffset] = useState(0);
  const [placeQueryInput, setPlaceQueryInput] = useState("");
  const [placeQuery, setPlaceQuery] = useState("");
  const [placeStatus, setPlaceStatus] = useState<ContentPlaceStatusFilter>("all");

  const [place, setPlace] = useState<ContentPlace | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState("");

  const [workers, setWorkers] = useState<ContentWorker[]>([]);
  const [heartbeats, setHeartbeats] = useState<ContentHeartbeat[]>([]);
  const [audioJobs, setAudioJobs] = useState<ContentAudioJob[]>([]);
  const [workerToken, setWorkerToken] = useState("");
  const [ttsTransport, setTtsTransport] = useState<"worker" | "http">("worker");
  // Freshness is read off the clock when the list arrives: during render `Date.now()` would be impure and the
  // callout would silently go stale anyway, because nothing re-renders the component as the window expires.
  const [workerOnline, setWorkerOnline] = useState(false);

  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline);
  const disabled = Boolean(busy);
  const batchPages = pageCount(batches.length, BATCH_PAGE);
  const batchRows = batches.slice(batchPage * BATCH_PAGE, batchPage * BATCH_PAGE + BATCH_PAGE);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    if (busy || !pendingNavigation.current) return;
    const target = pendingNavigation.current === "editor"
      ? editorHeading.current
      : placeOpener.current?.isConnected ? placeOpener.current : catalogHeading.current;
    if (!target) return;
    const block = pendingNavigation.current === "editor" ? "start" : "center";
    pendingNavigation.current = null;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block, behavior: "instant" });
  }, [busy, place]);

  /** Raises the table's flag for the whole request, including the retry that walks back a page that fell off the end. */
  async function tracked<T>(key: keyof typeof loading, action: () => Promise<T>) {
    setLoading(state => ({ ...state, [key]: true }));
    try { return await action(); }
    finally { setLoading(state => ({ ...state, [key]: false })); }
  }

  function loadOverview(signal: AbortSignal) {
    return tracked("overview", async () => {
      const [batchList, nextStats, workerList, audio] = await Promise.all([
        api<{ batches: ContentBatch[] }>("/content/batches", signal),
        api<Stats>("/content/stats", signal),
        api<{ transport: "worker" | "http"; workers: ContentWorker[]; heartbeats: ContentHeartbeat[] }>("/content/workers", signal),
        api<{ audioJobs: ContentAudioJob[] }>("/content/audio", signal),
      ]);
      setBatches(batchList.batches); setStats(nextStats);
      setWorkers(workerList.workers); setHeartbeats(workerList.heartbeats); setAudioJobs(audio.audioJobs);
      setTtsTransport(workerList.transport);
      setWorkerOnline(workerList.workers.some(worker => !worker.revokedAt && worker.lastSeenAt
        && Date.now() - new Date(worker.lastSeenAt).valueOf() < HEARTBEAT_WINDOW_MS));
    });
  }

  function loadPlaces(offset: number, signal: AbortSignal, next?: { q?: string; status?: ContentPlaceStatusFilter }) {
    return tracked("places", () => fetchPlaces(offset, signal, next));
  }

  async function fetchPlaces(offset: number, signal: AbortSignal, next?: { q?: string; status?: ContentPlaceStatusFilter }) {
    const q = next?.q ?? placeQuery;
    const status = next?.status ?? placeStatus;
    const params = new URLSearchParams({ limit: String(PLACE_PAGE), offset: String(offset), status });
    if (q) params.set("q", q);
    const result = await api<PlacePage>(`/content/places?${params}`, signal);
    // A page can fall off the end when places are archived between requests.
    if (!result.places.length && offset > 0) { await fetchPlaces(Math.max(0, offset - PLACE_PAGE), signal, next); return; }
    setPlacePage(result); setPlaceOffset(offset);
  }

  function loadItems(id: string, offset: number, signal: AbortSignal, next?: { status?: ContentStatusFilter; error?: ContentErrorFilter }) {
    return tracked("items", () => fetchItems(id, offset, signal, next));
  }

  async function fetchItems(id: string, offset: number, signal: AbortSignal, next?: { status?: ContentStatusFilter; error?: ContentErrorFilter }) {
    const params = new URLSearchParams({
      limit: String(ITEM_PAGE), offset: String(offset),
      status: next?.status ?? itemStatus, error: next?.error ?? itemError,
    });
    const result = await api<ContentBatchItemPage>(`/content/batches/${id}/items?${params}`, signal);
    if (!result.items.length && offset > 0) { await fetchItems(id, Math.max(0, offset - ITEM_PAGE), signal, next); return; }
    setItemPage(result); setItemOffset(offset);
  }

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void run("Загрузка OSM-каталога…", async signal => { await Promise.all([loadOverview(signal), loadPlaces(0, signal)]); });
  // The ref keeps this a one-time mount load; later refreshes go through explicit buttons.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function refresh() {
    void run("Обновление данных…", async signal => {
      await loadOverview(signal);
      await loadPlaces(placeOffset, signal);
      if (batch) await loadItems(batch.id, itemOffset, signal);
      setNotice("");
    });
  }

  function consentToLoseDraft() {
    return !dirty || window.confirm("Есть несохранённые правки текста места. Отбросить их и продолжить?");
  }

  function openBatch(next: ContentBatch, status: ContentStatusFilter = "all") {
    void run("Загрузка заданий партии…", async signal => {
      setBatch(next); setItemStatus(status); setItemError("all");
      await loadItems(next.id, 0, signal, { status, error: "all" });
    });
  }

  function batchAction(id: string, action: "pause" | "resume" | "cancel", label: string) {
    void run(label, async signal => {
      await api(`/content/batches/${id}/${action}`, signal, {});
      await loadOverview(signal);
      if (batch?.id === id) await loadItems(id, itemOffset, signal);
      setNotice(action === "pause" ? "Партия поставлена на паузу." : action === "resume" ? "Партия продолжена." : "Партия отменена, ожидающие задания сняты.");
    });
  }

  function openPlace(id: string, opener: HTMLButtonElement) {
    if (!consentToLoseDraft()) return;
    void run("Загрузка места…", async signal => {
      const value = (await api<{ place: ContentPlace }>(`/content/places/${id}`, signal)).place;
      const next = value.text?.draft ?? null;
      placeOpener.current = opener;
      pendingNavigation.current = "editor";
      setPlace(value); setDraft(next); setBaseline(JSON.stringify(next)); setNotice("");
    });
  }

  function closePlace() {
    if (!consentToLoseDraft()) return;
    pendingNavigation.current = "catalog";
    setPlace(null); setDraft(null); setBaseline("");
  }

  const draftValid = Boolean(draft?.title.trim() && draft.paragraphs.length && draft.paragraphs.every(item => item.text.trim()));

  return (
    <section className="admin-addresses content-admin" aria-labelledby="admin-content-title">
      <div className="admin-section-head">
        <div>
          <h2 id="admin-content-title">OSM-партии</h2>
          <p className="admin-meta">Массовая подготовка текстов и очередь локального Silero/F5-TTS.</p>
        </div>
        <button disabled={disabled} onClick={refresh}>Обновить</button>
      </div>
      {notice && <p className="admin-meta" role="status">{notice}</p>}

      {stats ? <dl className="content-stats">
        <div><dt>Мест в каталоге</dt><dd>{numbers.format(stats.places)}</dd></div>
        <div><dt>Текстов</dt><dd>{numbers.format(stats.texts)}</dd></div>
        <div><dt>Аудио</dt><dd>{numbers.format(stats.audio)}</dd></div>
        <div><dt>Очередь текстов</dt><dd>{numbers.format(stats.jobs?.queued ?? 0)}</dd><span>в работе {numbers.format(stats.jobs?.working ?? 0)}</span></div>
        <div><dt>Очередь аудио</dt><dd>{numbers.format(stats.external?.queued ?? 0)}</dd><span>у воркеров {numbers.format(stats.external?.leased ?? 0)}</span></div>
        <div><dt>Средняя попытка TTS</dt><dd>{stats.audioQueue?.averageAttemptSec == null ? "—" : <>{stats.audioQueue.averageAttemptSec.toFixed(1)}<small> с</small></>}</dd></div>
        <div><dt>Токенов текста</dt><dd>{numbers.format(stats.textUsageTokens ?? 0)}</dd></div>
        <div><dt>Аудиофайлов</dt><dd>{numbers.format(stats.audioQueue?.artifacts ?? 0)}</dd><span>{numbers.format(Math.round((stats.audioQueue?.artifactBytes ?? 0) / 1048576))} МиБ</span></div>
        <div><dt>Старейший текст в очереди</dt><dd className="content-stats-date">{moment(stats.oldestTextQueuedAt)}</dd></div>
        <div><dt>Старейшее аудио в очереди</dt><dd className="content-stats-date">{moment(stats.audioQueue?.oldestQueuedAt)}</dd></div>
      </dl> : <div className="content-stats-loading" role="status" aria-live="polite"><span className="content-loading-spinner" aria-hidden="true" />Загружаем статистику каталога…</div>}

      <section className="admin-review content-audio-backfill" aria-labelledby="content-audio-backfill-title">
        <div className="admin-section-head"><div>
          <h3 id="content-audio-backfill-title">Массовая озвучка</h3>
          <p className="admin-meta">Поставляет в очередь утверждённые тексты без готового аудио. Повторный запуск не создаёт дубликаты.</p>
        </div>
          <button className="admin-primary" disabled={disabled || ttsTransport === "worker" && !workerOnline} onClick={() => void run("Постановка озвучки…", async signal => {
            const result = await api<{ queued: number; retried: number; alreadyQueued: number; failed: number; inspected: number; hasMore: boolean }>("/content/audio/bulk", signal, { limit: 500 });
            await loadOverview(signal);
            setNotice(`В очередь поставлено: ${result.queued}. Повторено: ${result.retried}. Проверено: ${result.inspected}${result.hasMore ? " — нажмите ещё раз для продолжения" : ""}.`);
          })}>Озвучить тексты без аудио</button>
        </div>
        {ttsTransport === "worker" && !workerOnline && <p className="admin-callout">Нет online-воркера TTS. Сначала подключите воркер.</p>}
      </section>

      <section className="admin-review" aria-labelledby="content-new-batch-title">
        <h3 id="content-new-batch-title">Новая партия</h3>
        <p className="admin-meta">Берёт указанное число мест из каталога по алфавиту и ставит их в очередь подготовки.</p>
        <form className="admin-filters content-batch-form" onSubmit={event => {
          event.preventDefault();
          void run("Создание партии…", async signal => {
            await api("/content/batches", signal, {
              requestKey: crypto.randomUUID(), name: `OSM · ${new Date().toLocaleString("ru-RU")}`,
              limit: batchLimit, textProfile: "story-v1", mode: batchMode,
            });
            await loadOverview(signal);
            setBatchPage(0);
            setNotice("Партия создана и поставлена в очередь.");
          });
        }}>
          <label><span>Количество объектов</span><input type="number" min={1} max={5000} value={batchLimit} disabled={disabled}
            onChange={event => setBatchLimit(Math.max(1, Math.min(5000, Number(event.target.value) || 1)))} /></label>
          <label><span>Что готовить</span><select value={batchMode} disabled={disabled}
            onChange={event => setBatchMode(event.target.value as typeof batchMode)}>
            <option value="text-and-audio">Текст и озвучку</option>
            <option value="text-only">Только текст</option>
          </select></label>
          <button className="admin-primary" disabled={disabled}>Создать партию</button>
        </form>
      </section>

      <IdentityCandidates api={api} busy={busy} run={run} onPilotCreated={async (_created, signal) => { await loadOverview(signal); setBatchPage(0); }} />

      <section className="admin-review" aria-labelledby="content-batches-title">
        <div className="admin-section-head">
          <div>
            <h3 id="content-batches-title">Партии</h3>
            <p className="admin-meta">Всего партий {batches.length}. Нажмите число в колонке «Прогресс заданий», чтобы открыть эти здания списком.</p>
          </div>
        </div>
        <div className="admin-table-wrap" aria-busy={loading.overview}><table className="admin-table">
          <caption className="admin-sr-only">Партии OSM</caption>
          <thead><tr><th scope="col">Партия</th><th scope="col">Состояние</th><th scope="col">Прогресс заданий</th><th scope="col">Действия</th></tr></thead>
          <tbody>{loading.overview ? skeletonRows(4, batchRows.length) : batchRows.map(item => {
            const segments = progressSegments(item.counts);
            return <tr key={item.id} data-current={batch?.id === item.id || undefined}>
              <th scope="row">{item.name}<span className="admin-row-id">{item.id.slice(0, 8)} · {item.mode === "text-only" ? "только текст" : "текст и озвучка"}{item.identityPolicy === "weak_identity" ? " · слабая идентификация, публикация после утверждения" : ""} · создана {moment(item.createdAt)}</span></th>
              <td><span className={`admin-stage content-batch-state-${item.state}`}>{batchStates[item.state] ?? item.state}</span></td>
              <td>
                <div className="content-progress" aria-hidden="true">{segments.map(segment => segment.value
                  ? <span key={segment.key} data-segment={segment.key} style={{ flexGrow: segment.value }} /> : null)}</div>
                <div className="content-counts">{segments.map(segment => <button key={segment.key} type="button" data-segment={segment.key}
                  disabled={disabled || !segment.value} aria-label={`Показать здания партии «${item.name}» со статусом «${segment.label}»: ${segment.value}`}
                  onClick={() => openBatch(item, segment.key)}><b>{segment.value}</b> {segment.label}</button>)}
                  <span className="admin-row-id">всего {item.counts.total}</span></div>
              </td>
              <td><div className="admin-row-actions">
                <button disabled={disabled} onClick={() => openBatch(item)}>Все задания</button>
                {item.state === "running" && <button disabled={disabled} onClick={() => batchAction(item.id, "pause", "Пауза…")}>Пауза</button>}
                {item.state === "paused" && <button disabled={disabled} onClick={() => batchAction(item.id, "resume", "Продолжение…")}>Продолжить</button>}
                {item.state !== "cancelled" && <button disabled={disabled} onClick={() => {
                  if (window.confirm(`Отменить партию «${item.name}»? Ожидающие задания и их аудио будут сняты с очереди.`)) batchAction(item.id, "cancel", "Отмена…");
                }}>Отменить</button>}
              </div></td>
            </tr>;
          })}</tbody>
        </table></div>
        {!loading.overview && !batches.length && <p className="admin-empty-row" role="status">Партий пока нет.</p>}
        {batchPages > 1 && <nav className="admin-pagination" aria-label="Страницы партий">
          <button disabled={disabled || batchPage === 0} onClick={() => setBatchPage(page => Math.max(0, page - 1))}>Назад</button>
          <span className="admin-meta">Страница {batchPage + 1} из {batchPages}</span>
          <button disabled={disabled || batchPage + 1 >= batchPages} onClick={() => setBatchPage(page => Math.min(batchPages - 1, page + 1))}>Далее</button>
        </nav>}
      </section>

      {batch && <section className="admin-review" aria-labelledby="content-items-title">
        <div className="admin-section-head">
          <div><h3 id="content-items-title">Состав партии «{batch.name}»</h3>
            <p className="admin-meta">Всего заданий {batch.counts.total}. Фильтры ниже меняют только этот список и не влияют на таблицу партий.</p></div>
          <button disabled={disabled} onClick={() => { setBatch(null); setItemPage(null); setItemOffset(0); setItemError("all"); }}>Закрыть</button>
        </div>
        <div className="content-toolbar">
          <label htmlFor="content-item-status">Статус задания</label>
          <select id="content-item-status" value={itemStatus} disabled={disabled} onChange={event => {
            // Error codes are counted per status bucket, so a status change starts over with every code in view.
            const next = event.target.value as ContentStatusFilter; setItemStatus(next); setItemError("all");
            void run("Фильтрация заданий…", signal => loadItems(batch.id, 0, signal, { status: next, error: "all" }));
          }}>{contentStatusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          <label htmlFor="content-item-error">Ошибка</label>
          <select id="content-item-error" value={itemError} disabled={disabled} onChange={event => {
            const next = event.target.value; setItemError(next);
            void run("Фильтрация заданий…", signal => loadItems(batch.id, 0, signal, { error: next }));
          }}>{contentErrorOptions(itemPage?.errors ?? [], itemError).map(option =>
            <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          <p className="admin-meta" role="status">{loading.items
            ? "Загружаем задания…"
            : `Показано ${pageRange(itemOffset, itemPage?.items.length ?? 0, itemPage?.total ?? 0)}`}</p>
        </div>
        <div className="admin-table-wrap" aria-busy={loading.items}><table className="admin-table">
          <caption className="admin-sr-only">Задания партии</caption>
          <thead><tr><th scope="col">Место</th><th scope="col">Состояние</th><th scope="col">Ошибка</th><th scope="col">Действие</th></tr></thead>
          <tbody>{loading.items ? skeletonRows(4, itemPage?.items.length ?? 0) : (itemPage?.items ?? []).map(item => <tr key={item.placeId}>
            <th scope="row">{item.name}<span className="admin-row-id">{item.address ?? item.placeId}</span></th>
            <td><span className={`admin-stage admin-stage-${item.state}`}>{batchItemStates[item.state] ?? item.state}</span></td>
            {/* Older failures stored the code in `message`; then the code alone is shown instead of repeating it twice. */}
            <td>{item.error
              ? <>{item.error.message && item.error.message !== item.error.code ? item.error.message : null}
                {item.error.code && <span className="admin-row-id">{item.error.code}</span>}</>
              : "—"}</td>
            <td>{retryableItemStates.includes(item.state) && <button disabled={disabled} onClick={() => void run("Повтор задания…", async signal => {
              await api(`/content/batches/${batch.id}/items/${item.placeId}/retry`, signal, {});
              await loadItems(batch.id, itemOffset, signal);
              await loadOverview(signal);
              setNotice(`Задание «${item.name}» снова поставлено в очередь.`);
            })}>Повторить</button>}</td>
          </tr>)}</tbody>
        </table></div>
        {!loading.items && !itemPage?.items.length && <p className="admin-empty-row" role="status">Заданий с выбранными фильтрами в партии нет.</p>}
        <nav className="admin-pagination" aria-label="Страницы заданий партии">
          <button disabled={disabled || itemOffset === 0} onClick={() => void run("Загрузка заданий…", signal => loadItems(batch.id, Math.max(0, itemOffset - ITEM_PAGE), signal))}>Назад</button>
          <span className="admin-meta">Страница {Math.floor(itemOffset / ITEM_PAGE) + 1} из {pageCount(itemPage?.total ?? 0, ITEM_PAGE)}</span>
          <button disabled={disabled || !itemPage?.hasMore} onClick={() => void run("Загрузка заданий…", signal => loadItems(batch.id, itemOffset + ITEM_PAGE, signal))}>Далее</button>
        </nav>
      </section>}

      {/* The block only exists while something is stuck, so its skeleton shows on refresh rather than flashing an empty section on first load. */}
      {audioJobs.length > 0 && <section className="admin-review" aria-labelledby="content-audio-title">
        <div className="admin-section-head"><div>
          <h3 id="content-audio-title">Остановленные аудиозадания</h3>
          <p className="admin-meta">Показано {audioJobs.length}. Повтор запускает новую ограниченную серию попыток с тем же утверждённым текстом.</p>
        </div></div>
        <div className="admin-table-wrap" aria-busy={loading.overview}><table className="admin-table">
          <caption className="admin-sr-only">Остановленные аудиозадания</caption>
          <thead><tr><th scope="col">Место</th><th scope="col">Профиль</th><th scope="col">Попытки</th><th scope="col">Ошибка</th><th scope="col">Действие</th></tr></thead>
          <tbody>{loading.overview ? skeletonRows(5, audioJobs.length) : audioJobs.map(audio => <tr key={audio.id}>
            <th scope="row">{audio.placeName ?? audio.placeId ?? audio.id}<span className="admin-row-id">{audio.id.slice(0, 8)} · {batchItemStates[audio.state] ?? audio.state}</span></th>
            <td>{audio.profileId}</td>
            <td>{audio.attempts} из {audio.maxAttempts}</td>
            <td>{audio.error?.message ?? audio.error?.code ?? "—"}</td>
            <td><button disabled={disabled} onClick={() => void run("Повтор озвучивания…", async signal => {
              await api(`/content/audio/${audio.id}/retry`, signal, {});
              await loadOverview(signal);
              setNotice("Аудиозадание снова поставлено в очередь.");
            })}>Повторить</button></td>
          </tr>)}</tbody>
        </table></div>
      </section>}

      <section className="admin-review" aria-labelledby="content-catalog-title">
        <div className="admin-section-head"><div>
          <h3 id="content-catalog-title" ref={catalogHeading} tabIndex={-1}>Каталог и редактура</h3>
          <p className="admin-meta">Автоматический текст появляется публично и уходит в TTS только после утверждения.</p>
        </div></div>
        <form className="admin-filters" role="search" onSubmit={event => {
          event.preventDefault();
          const q = placeQueryInput.trim(); setPlaceQuery(q);
          void run("Поиск мест…", signal => loadPlaces(0, signal, { q }));
        }}>
          <label className="admin-search"><span>Название или адрес</span>
            <input type="search" value={placeQueryInput} placeholder="Например, Пятницкая" disabled={disabled}
              onChange={event => setPlaceQueryInput(event.target.value)} /></label>
          <label><span>Состояние текста</span><select value={placeStatus} disabled={disabled} onChange={event => {
            const next = event.target.value as ContentPlaceStatusFilter; setPlaceStatus(next);
            void run("Фильтрация мест…", signal => loadPlaces(0, signal, { status: next }));
          }}>{placeStatusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <button className="admin-filter-submit" type="submit" disabled={disabled}>Найти</button>
        </form>
        <p className="admin-meta" role="status">{loading.places
          ? "Загружаем места…"
          : `Показано ${pageRange(placeOffset, placePage.places.length, placePage.total)} мест.`}</p>
        <div className="admin-table-wrap" aria-busy={loading.places}><table className="admin-table">
          <caption className="admin-sr-only">Каталог мест OSM</caption>
          <thead><tr><th scope="col">Место</th><th scope="col">Текст</th><th scope="col">Аудио</th><th scope="col">Действие</th></tr></thead>
          <tbody>{loading.places ? skeletonRows(4, placePage.places.length) : placePage.places.map(item => <tr key={item.id} data-current={place?.id === item.id || undefined}>
            <th scope="row">{item.name}<span className="admin-row-id">{item.address ?? item.id}</span></th>
            <td><span className={`admin-stage content-text-${item.textStatus}`}>{placeTextStatuses[item.textStatus]}</span></td>
            <td>{item.audio ? "Готово" : "Нет"}</td>
            <td><button disabled={disabled} onClick={event => openPlace(item.id, event.currentTarget)}>Открыть</button></td>
          </tr>)}</tbody>
        </table></div>
        {!loading.places && !placePage.places.length && <p className="admin-empty-row" role="status">По этим условиям мест не найдено.</p>}
        <nav className="admin-pagination" aria-label="Страницы каталога мест">
          <button disabled={disabled || placeOffset === 0} onClick={() => void run("Загрузка мест…", signal => loadPlaces(Math.max(0, placeOffset - PLACE_PAGE), signal))}>Назад</button>
          <span className="admin-meta">Страница {Math.floor(placeOffset / PLACE_PAGE) + 1} из {pageCount(placePage.total, PLACE_PAGE)}</span>
          <button disabled={disabled || !placePage.hasMore} onClick={() => void run("Загрузка мест…", signal => loadPlaces(placeOffset + PLACE_PAGE, signal))}>Далее</button>
        </nav>

        {place && <article className="admin-document" aria-labelledby="content-place-title">
          <div className="admin-document-head">
            <div><p className="admin-context">{place.id}</p><h3 id="content-place-title" ref={editorHeading} tabIndex={-1}>{place.name}</h3>
              <p className="admin-meta">{place.address ?? "Адрес не указан"}{dirty ? " · есть несохранённые правки" : ""}</p></div>
            <button disabled={disabled} onClick={closePlace}>Закрыть</button>
          </div>
          {draft ? <>
            <label htmlFor="content-title">Заголовок</label>
            <input id="content-title" value={draft.title} disabled={disabled}
              onChange={event => setDraft({ ...draft, title: event.target.value })} />
            {draft.paragraphs.map((paragraph, index) => <div className="admin-paragraph" key={index}>
              <label htmlFor={`content-paragraph-${index}`}>Абзац {index + 1}</label>
              <textarea id={`content-paragraph-${index}`} rows={6} value={paragraph.text} disabled={disabled}
                onChange={event => setDraft({ ...draft, paragraphs: draft.paragraphs.map((value, i) => i === index ? { ...value, text: event.target.value } : value) })} />
            </div>)}
            <div className="admin-actions">
              <button className="admin-primary" disabled={disabled || !draftValid} onClick={() => void run("Утверждение текста…", async signal => {
                const value = (await api<{ place: ContentPlace }>(`/content/places/${place.id}/approve`, signal, { story: draft })).place;
                await loadOverview(signal); await loadPlaces(placeOffset, signal);
                setPlacePage(current => ({
                  ...current,
                  places: current.places.map(item => item.id === value.id ? { ...item, textStatus: "approved" } : item),
                }));
                pendingNavigation.current = "catalog";
                setPlace(null); setDraft(null); setBaseline("");
                setNotice("Текст утверждён; нужная озвучка поставлена в очередь.");
              })}>Утвердить текст</button>
              {place.text?.verification === "editorial" && <button disabled={disabled || dirty} onClick={() => void run("Постановка аудио…", async signal => {
                await api(`/content/places/${place.id}/audio`, signal, {});
                await loadOverview(signal);
                setNotice("Озвучка поставлена в очередь.");
              })}>Озвучить заново</button>}
            </div>
            {ttsTransport === "worker" && !workerOnline && <p className="admin-callout">Сейчас нет online-воркера TTS. Поставленная озвучка останется в очереди до его подключения.</p>}
          </> : <p className="admin-empty">Для этого места текст ещё не создан. Включите его в новую партию, чтобы запустить подготовку.</p>}
        </article>}
      </section>

      {ttsTransport === "worker" ? <section className="admin-review" aria-labelledby="content-workers-title">
        <div className="admin-section-head">
          <div><h3 id="content-workers-title">Локальные TTS-воркеры</h3>
            <p className="admin-meta">Активным считается воркер, обращавшийся к API за последние две минуты.</p></div>
          <button disabled={disabled} onClick={() => void run("Создание ключа…", async signal => {
            const result = await api<{ worker: ContentWorker & { token: string } }>("/content/workers", signal,
              { name: `Локальный воркер ${new Date().toLocaleDateString("ru-RU")}`, profiles: ["silero-ru-v1", "f5-ru-v1"] });
            setWorkerToken(result.worker.token);
            await loadOverview(signal);
          })}>Выпустить ключ</button>
        </div>
        {workerToken && <div className="admin-callout"><strong>Скопируйте токен сейчас — второй раз он не показывается:</strong>
          <pre>{workerToken}</pre>
          <div className="admin-actions">
            <button onClick={() => void navigator.clipboard.writeText(workerToken)}>Копировать</button>
            <button onClick={() => setWorkerToken("")}>Скрыть</button>
          </div></div>}
        {!workerOnline && <p className="admin-callout">Сейчас нет подходящего online-воркера. Аудиозадания останутся в очереди.</p>}
        <div className="admin-table-wrap" aria-busy={loading.overview}><table className="admin-table">
          <caption className="admin-sr-only">Ключи и состояние локальных TTS-воркеров</caption>
          <thead><tr><th scope="col">Воркер</th><th scope="col">Профили</th><th scope="col">Последний heartbeat</th><th scope="col">Текущая работа</th><th scope="col">Действие</th></tr></thead>
          <tbody>{loading.overview ? skeletonRows(5, workers.length) : workers.map(worker => {
            const heartbeat = heartbeats.find(item => item.credentialId === worker.id);
            return <tr key={worker.id}>
              <th scope="row">{worker.name}{heartbeat && <span className="admin-row-id">{heartbeat.workerName} · {heartbeat.version ?? "версия неизвестна"}</span>}</th>
              <td>{worker.profiles.join(", ")}</td>
              <td>{worker.revokedAt ? "отозван" : worker.lastSeenAt ? moment(worker.lastSeenAt) : "ещё не подключался"}</td>
              <td>{heartbeat?.currentJobId ? `${heartbeat.progress?.stage ?? "работает"}${heartbeat.progress?.percent === undefined ? "" : ` · ${heartbeat.progress.percent}%`}` : "—"}</td>
              <td>{!worker.revokedAt && <button disabled={disabled} onClick={() => {
                if (!window.confirm(`Отозвать ключ воркера «${worker.name}»? Он немедленно потеряет доступ к очереди.`)) return;
                void run("Отзыв ключа…", async signal => { await api(`/content/workers/${worker.id}/revoke`, signal, {}); await loadOverview(signal); });
              }}>Отозвать</button>}</td>
            </tr>;
          })}</tbody>
        </table></div>
        {!loading.overview && !workers.length && <p className="admin-empty-row" role="status">Ключи воркеров ещё не выпускались.</p>}
      </section> : <section className="admin-review" aria-labelledby="content-workers-title">
        <h3 id="content-workers-title">Сервер TTS</h3>
        <p className="admin-meta">Озвучка обрабатывается сервером TTS через закрытое HTTP-подключение. Ключи внешних воркеров в этом режиме не используются.</p>
      </section>}
    </section>
  );
}

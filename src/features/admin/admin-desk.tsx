"use client";

import { useEffect, useRef, useState } from "react";
import { BrandMark } from "../brand/brand-mark";
import { WalkAdmin } from "./walk-admin";
import { ContentAdmin } from "./content-admin";
import { draftCheck, initialDraft, safeSourceLink, stages, type AdminApi, type Draft, type Job, type Summary, type TtsProvider } from "./model";
import { skeletonRows } from "./table-skeleton";
import { csrfHeaders, getSession, signOut } from "../auth/client";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PAGE_SIZE = 50;
type AdminSection = "addresses" | "walks" | "content";
type RelevanceFilter = "active" | "irrelevant" | "all";

class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function formattedDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString("ru-RU");
}

function voiceLabel(item: Summary) {
  const voice = item.audio?.voice ?? item.ttsVoice;
  if (!voice) return "Не выбрана";
  const provider = item.audio?.provider ?? item.ttsProvider;
  return provider ? `${provider === "yandex" ? "Яндекс" : "OpenAI"} · ${voice}` : voice;
}

export function AdminDesk() {
  const request = useRef<AbortController | null>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const queueHeading = useRef<HTMLHeadingElement>(null);
  const pendingNavigation = useRef<"editor" | "queue" | null>(null);
  const sessionRestored = useRef(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [accessState, setAccessState] = useState<"checking" | "forbidden" | "editor">("checking");
  const [section, setSection] = useState<AdminSection>("addresses");
  const [walkDirty, setWalkDirty] = useState(false);
  const [jobs, setJobs] = useState<Summary[]>([]);
  // The queue table swaps to placeholder rows while its own request runs, instead of holding stale rows.
  const [queueLoading, setQueueLoading] = useState(false);
  const [contentDirty, setContentDirty] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [relevanceFilter, setRelevanceFilter] = useState<RelevanceFilter>("active");
  const [job, setJob] = useState<Job | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("openai");
  const [ttsVoice, setTtsVoice] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const dirty = draft !== null && JSON.stringify(draft) !== baseline;
  const hasUnsavedWork = dirty || walkDirty || contentDirty;

  useEffect(() => {
    if (!authenticated || busy || section !== "addresses" || !pendingNavigation.current) return;
    const heading = pendingNavigation.current === "editor" ? editorHeading.current : queueHeading.current;
    if (!heading) return;
    pendingNavigation.current = null;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "start", behavior: "instant" });
  }, [authenticated, busy, job, section]);

  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  useEffect(() => {
    if (!hasUnsavedWork && !busy) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [hasUnsavedWork, busy]);

  function clearAccess() {
    pendingNavigation.current = null;
    setAuthenticated(false); setAccessState("checking"); setSection("addresses"); setWalkDirty(false); setContentDirty(false);
    setJobs([]); setOffset(0); setHasMore(false); setJob(null); setDraft(null); setBaseline("");
    setConfirmed(false); setConflict(false); setNotice(""); setTtsProvider("openai"); setTtsVoice("");
  }

  // One operation owns the controller, including login + deep-link loading.
  async function run(label: string, action: (signal: AbortSignal) => Promise<void>) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(label); setError(""); setNotice("");
    const timer = window.setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), 20000);
    try { await action(controller.signal); }
    catch (cause) {
      if (request.current !== controller) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        clearAccess();
        setError("Доступ закрыт. Войдите аккаунтом редактора.");
      } else if (cause instanceof ApiError && cause.status === 409) {
        if (section === "addresses") { setConflict(true); setConfirmed(false); }
        setError(section === "walks"
          ? "Версия главы изменилась. Загрузите актуальную прогулку перед повторной отправкой."
          : "Версия задания изменилась. Локальные правки сохранены в редакторе. Скопируйте их перед загрузкой новой версии.");
      } else {
        setError(controller.signal.aborted
          ? "Время ожидания истекло. Результат операции неизвестен. Обновите запись перед повторной отправкой; локальный текст пока сохранён."
          : cause instanceof ApiError ? cause.message : "Не удалось связаться с сервером. Проверьте соединение и повторите попытку.");
        if (controller.signal.aborted && job && section === "addresses") { setConflict(true); setConfirmed(false); }
      }
    } finally {
      window.clearTimeout(timer);
      if (request.current === controller) { request.current = null; setBusy(""); }
    }
  }

  const api: AdminApi = async <T,>(path: string, signal: AbortSignal, body?: unknown): Promise<T> => {
    const endpoint = path.startsWith("/walks") ? `/api/story-admin${path}` : path.startsWith("/content/") ? `/api/story-admin${path}` : `/api/story-admin/jobs${path}`;
    const response = await fetch(endpoint, {
      method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin",
      redirect: "error", signal,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json", ...csrfHeaders() }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: "Сервер отклонил данные. Проверьте заполненные поля и повторите попытку.",
        404: "Запись не найдена. Обновите список и выберите её снова.",
        429: "Лимит запросов или очередь заполнены. Подождите минуту и повторите попытку.",
        503: "Сервис озвучивания недоступен. Выбранный текст можно озвучить позже.",
      };
      throw new ApiError(response.status, messages[response.status] ?? `Ошибка сервера (${response.status}). Повторите попытку позже.`);
    }
    const result = await response.json() as T;
    signal.throwIfAborted();
    return result;
  };

  function accept(value: Job, preserveTts = false) {
    const next = initialDraft(value);
    setJob(value); setDraft(next); setBaseline(JSON.stringify(next)); setConfirmed(false); setConflict(false);
    if (!preserveTts) {
      setTtsProvider(value.data.ttsProvider);
      setTtsVoice(value.data.ttsVoice ?? value.ttsProviders.find(option => option.id === value.data.ttsProvider)?.defaultVoice ?? "");
    }
    setJobs(current => current.map(item => item.id === value.id ? value : item)
      .filter(item => relevanceFilter === "all" || (relevanceFilter === "irrelevant" ? item.irrelevant : !item.irrelevant)));
    window.history.replaceState(window.history.state, "", `/admin?job=${value.id}`);
  }

  function consent() {
    return !hasUnsavedWork || window.confirm("Есть несохранённые правки. Отбросить их и продолжить?");
  }

  /** Keeps the flag up for the whole request, including the retry that walks back a page that fell off the end. */
  async function loadQueue(nextOffset: number, signal: AbortSignal, nextFilters?: { q?: string; stage?: string; relevance?: RelevanceFilter }) {
    setQueueLoading(true);
    try { await fetchQueue(nextOffset, signal, nextFilters); }
    finally { setQueueLoading(false); }
  }

  async function fetchQueue(nextOffset: number, signal: AbortSignal, nextFilters?: { q?: string; stage?: string; relevance?: RelevanceFilter }) {
    const nextQuery = nextFilters?.q ?? query;
    const nextStage = nextFilters?.stage ?? stageFilter;
    const nextRelevance = nextFilters?.relevance ?? relevanceFilter;
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(nextOffset), relevance: nextRelevance });
    if (nextQuery) params.set("q", nextQuery);
    if (nextStage !== "all") params.set("stage", nextStage);
    const result = await api<{ jobs: Summary[]; hasMore: boolean }>(`?${params}`, signal);
    if (!result.jobs.length && nextOffset > 0) {
      await fetchQueue(Math.max(0, nextOffset - PAGE_SIZE), signal, nextFilters);
      return;
    }
    setJobs(result.jobs); setHasMore(result.hasMore); setOffset(nextOffset);
  }

  useEffect(() => {
    if (sessionRestored.current) return;
    sessionRestored.current = true;
    void run("Восстановление сессии…", async signal => {
      const user = await getSession();
      if (!user) {
        window.location.replace(`/login?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
        return;
      }
      if (user.role !== "editor") {
        setAccessState("forbidden");
        setError("У этого аккаунта нет доступа к редакционному кабинету.");
        return;
      }
      setAccessState("editor");
      setAuthenticated(true);
      await loadQueue(0, signal);
      const params = new URLSearchParams(window.location.search);
      const id = params.get("job");
      if (id && UUID.test(id)) {
        accept((await api<{ job: Job }>(`/${id}`, signal)).job);
        pendingNavigation.current = "editor";
      } else if (id) setError("В ссылке указан неверный идентификатор задания. Выберите задание из списка.");
      else if (["walks","content"].includes(params.get("section") ?? "")) setSection(params.get("section") as AdminSection);
    });
  // `sessionRestored` makes this effect a one-time client-side restore.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accept, api, loadQueue]);

  function openJob(id: string, reload = false) {
    if (request.current || !consent()) return;
    if (reload && conflict && !dirty && !window.confirm("Загрузить текущую версию задания с сервера?")) return;
    void run("Загрузка задания…", async signal => {
      accept((await api<{ job: Job }>(`/${id}`, signal)).job);
      if (!reload) pendingNavigation.current = "editor";
      setSection("addresses"); setWalkDirty(false);
    });
  }

  function closeJob() {
    if (request.current || !consent()) return;
    pendingNavigation.current = "queue";
    setJob(null); setDraft(null); setBaseline(""); setConfirmed(false); setConflict(false); setError("");
    window.history.replaceState(window.history.state, "", "/admin");
  }

  function changeSection(next: AdminSection) {
    if (next === section || request.current) return;
    if (section === "walks" && walkDirty && !window.confirm("Есть несохранённые правки главы. Отбросить их и открыть другой раздел?")) return;
    if (section === "content" && contentDirty && !window.confirm("Есть несохранённые правки текста места. Отбросить их и открыть другой раздел?")) return;
    setSection(next); setWalkDirty(false); setContentDirty(false); setError(""); setNotice("");
    window.history.replaceState(window.history.state, "", next === "addresses" ? (job ? `/admin?job=${job.id}` : "/admin") : `/admin?section=${next}`);
  }

  function toggleRelevance(item: Summary) {
    if (request.current || (item.id === job?.id && !consent())) return;
    const irrelevant = !item.irrelevant;
    void run("Сохранение отметки…", async signal => {
      const updated = (await api<{ job: Job }>(`/${item.id}/relevance`, signal, { revision: item.revision, irrelevant })).job;
      if (item.id === job?.id) accept(updated, true);
      setNotice(irrelevant ? "Адрес отмечен как нерелевантный и скрыт из активной очереди." : "Адрес возвращён в активную очередь.");
      await loadQueue(offset, signal);
    });
  }

  function change(next: Draft) { setDraft(next); setConfirmed(false); }

  const facts = job?.data.evidence?.facts ?? [];
  const check = draft ? draftCheck(draft, facts) : null;
  const editable = job?.stage === "review_required" && !job.irrelevant && Boolean(facts.length);
  const savedUnchanged = Boolean(job?.data.editorDraft && draft && JSON.stringify(draft) === JSON.stringify(job.data.editorDraft));
  const selectedTts = job?.ttsProviders.find(option => option.id === ttsProvider);
  const selectedVoice = selectedTts?.voices.find(voice => voice.id === ttsVoice);
  const narrationEligible = Boolean(job && !job.irrelevant && (job.canApprove || job.canRegenerate || job.canRevoice || job.canRetry));
  const voiceReady = Boolean(narrationEligible && selectedTts?.available && selectedVoice && !conflict);
  const approvalAllowed = Boolean(job?.canApprove && voiceReady && savedUnchanged && !dirty && confirmed);
  const currentAudio = job?.data.audio ?? null;
  const narrationMode = job?.canApprove ? "approve" : job?.canRegenerate ? "regenerate" : job?.canRevoice ? "revoice" : job?.canRetry ? "retry" : null;

  function submitNarration() {
    if (!job || !narrationMode || request.current) return;
    if (narrationMode === "approve" && !approvalAllowed) return;
    if (narrationMode !== "approve" && !voiceReady) return;
    const action = narrationMode === "approve" ? "Утвердить текст и запустить озвучивание"
      : narrationMode === "regenerate" ? "Перегенерировать историю по текущим правилам"
        : narrationMode === "revoice" ? "Переозвучить историю" : "Продолжить подготовку истории";
    if (!window.confirm(`${action} через ${selectedTts?.label}, голос «${selectedVoice?.label}»?`)) return;
    const endpoint = narrationMode === "approve" ? "approve" : narrationMode === "regenerate" ? "regenerate" : narrationMode === "revoice" ? "revoice" : "retry";
    const label = narrationMode === "regenerate" ? "Перегенерация истории…" : narrationMode === "retry" ? "Возобновление подготовки…" : "Отправка на озвучивание…";
    void run(label, async signal => {
      accept((await api<{ job: Job }>(`/${job.id}/${endpoint}`, signal, { revision: job.revision, ttsProvider, ttsVoice })).job);
      setNotice(narrationMode === "regenerate"
        ? "История поставлена в очередь на полную перегенерацию по текущим правилам."
        : narrationMode === "retry" ? "Подготовка истории продолжена с выбранным голосом."
        : "Озвучивание поставлено в очередь. Обновите задание, чтобы проверить готовность.");
    });
  }

  return (
    <main className="admin-desk">
      <header className="admin-masthead">
        {/* A document navigation invokes beforeunload and destroys the in-memory session. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a className="admin-wordmark" href="/" aria-disabled={Boolean(busy)} onClick={event => { if (request.current) event.preventDefault(); }}><BrandMark /></a>
        <span className="admin-context">Редакционный кабинет</span>
        {authenticated && <button disabled={Boolean(busy)} onClick={() => {
          if (!request.current && consent()) { void signOut().finally(()=>{clearAccess();setError("");window.history.replaceState(window.history.state,"","/admin");}); }
        }}>Выйти</button>}
      </header>
      <div className="admin-heading"><h1>Редакция</h1><p>Проверяйте адресные истории и управляйте озвучкой готовых прогулок.</p></div>
      <div role="status" aria-live="polite" className="admin-status">{busy || notice}</div>
      {error && <div role="alert" className="admin-error">{error}</div>}
      {accessState === "forbidden" ? (
        <div className="admin-login">
          <p className="admin-context">Доступ для редактора</p><h2>Нет доступа к редакции</h2>
          <p>Вы вошли в аккаунт без роли редактора. Обратитесь к администратору, чтобы получить доступ.</p>
        </div>
      ) : !authenticated ? (
        <div className="admin-login">
          <p className="admin-context">Доступ для редактора</p><h2>Войти в редакцию</h2>
          <p id="admin-token-note">Войдите по email аккаунтом с ролью редактора.</p>
          <a className="admin-primary" href="/login?returnTo=/admin" aria-describedby="admin-token-note">Войти</a>
        </div>
      ) : (
        <div className="admin-workspace" aria-busy={Boolean(busy)}>
          <nav className="admin-tabs" aria-label="Разделы кабинета">
            <button disabled={Boolean(busy)} aria-current={section === "addresses" ? "page" : undefined} onClick={() => changeSection("addresses")}>Адреса</button>
            <button disabled={Boolean(busy)} aria-current={section === "walks" ? "page" : undefined} onClick={() => changeSection("walks")}>Прогулки</button>
            <button disabled={Boolean(busy)} aria-current={section === "content" ? "page" : undefined} onClick={() => changeSection("content")}>OSM-партии</button>
          </nav>

          {section === "walks" ? (
            <WalkAdmin api={api} busy={busy} run={run} openJob={openJob} onDirtyChange={setWalkDirty} />
          ) : section === "content" ? (
            <ContentAdmin api={api} busy={busy} run={run} onDirtyChange={setContentDirty} />
          ) : (
            <section className="admin-addresses" aria-labelledby="admin-addresses-title">
              <div className="admin-section-head">
                <div><h2 id="admin-addresses-title" ref={queueHeading} tabIndex={-1}>Адресные истории</h2><p className="admin-meta">{queueLoading ? "Загружаем адреса…" : jobs.length ? `${offset + 1}–${offset + jobs.length}` : "По этим условиям ничего не найдено"}</p></div>
                <button disabled={Boolean(busy)} onClick={() => void run("Обновление списка…", signal => loadQueue(offset, signal))}>Обновить</button>
              </div>
              <form className="admin-filters" role="search" onSubmit={event => {
                event.preventDefault(); const next = queryInput.trim(); setQuery(next);
                void run("Поиск адресов…", signal => loadQueue(0, signal, { q: next }));
              }}>
                <label className="admin-search"><span>Адрес или ID</span><input type="search" value={queryInput} placeholder="Например, Пятницкая" disabled={Boolean(busy)} onChange={event => setQueryInput(event.target.value)} /></label>
                <label><span>Состояние</span><select value={stageFilter} disabled={Boolean(busy)} onChange={event => {
                  const next = event.target.value; setStageFilter(next);
                  void run("Фильтрация адресов…", signal => loadQueue(0, signal, { stage: next }));
                }}><option value="all">Все состояния</option>{Object.entries(stages).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>Релевантность</span><select value={relevanceFilter} disabled={Boolean(busy)} onChange={event => {
                  const next = event.target.value as RelevanceFilter; setRelevanceFilter(next);
                  void run("Фильтрация адресов…", signal => loadQueue(0, signal, { relevance: next }));
                }}><option value="active">Активные</option><option value="irrelevant">Нерелевантные</option><option value="all">Все</option></select></label>
                <button className="admin-filter-submit" type="submit" disabled={Boolean(busy)}>Найти</button>
              </form>

              <div className="admin-table-wrap" aria-busy={queueLoading}><table className="admin-table">
                <caption className="admin-sr-only">Адресные истории и действия редактора</caption>
                <thead><tr><th scope="col">Адрес</th><th scope="col">Состояние</th><th scope="col">Выбранный голос</th><th scope="col">Обновлено</th><th scope="col">Действия</th></tr></thead>
                <tbody>{queueLoading ? skeletonRows(5, jobs.length) : jobs.map(item => <tr key={item.id} data-current={job?.id === item.id || undefined}>
                  <th scope="row"><button className="admin-address-link" disabled={Boolean(busy)} onClick={() => openJob(item.id)}>{item.address}</button><span className="admin-row-id">{item.id.slice(0, 8)} · версия {item.revision}</span></th>
                  <td><span className={`admin-stage admin-stage-${item.stage}`}>{item.irrelevant ? "Нерелевантный" : stages[item.stage] ?? item.stage}</span>{item.error && <span className="admin-row-error">{item.error.message}</span>}</td>
                  <td>{voiceLabel(item)}</td><td><time dateTime={item.updatedAt}>{formattedDate(item.updatedAt)}</time></td>
                  <td><div className="admin-row-actions"><button disabled={Boolean(busy)} onClick={() => openJob(item.id)}>Открыть</button><button disabled={Boolean(busy)} onClick={() => toggleRelevance(item)}>{item.irrelevant ? "Вернуть" : "Скрыть"}</button></div></td>
                </tr>)}</tbody>
              </table></div>
              <nav className="admin-pagination" aria-label="Страницы адресов">
                <button disabled={Boolean(busy) || offset === 0} onClick={() => void run("Загрузка адресов…", signal => loadQueue(Math.max(0, offset - PAGE_SIZE), signal))}>Назад</button>
                <span className="admin-meta">Страница {Math.floor(offset / PAGE_SIZE) + 1}</span>
                <button disabled={Boolean(busy) || !hasMore} onClick={() => void run("Загрузка адресов…", signal => loadQueue(offset + PAGE_SIZE, signal))}>Далее</button>
              </nav>

              {!job || !draft ? <section className="admin-empty"><h2>Выберите адрес</h2><p>Откройте строку, чтобы проверить текст, источники и озвучивание.</p></section> : (
                <article className="admin-document">
                  <header className="admin-document-head">
                    <div><p className="admin-context">{stages[job.stage] ?? job.stage} · версия {job.revision}</p><h2 id="admin-document-title" ref={editorHeading} tabIndex={-1}>{job.address}</h2><p className="admin-meta">{job.id} · обновлено {formattedDate(job.updatedAt)}</p></div>
                    <div className="admin-actions"><a className="admin-jump-link" href="#admin-narration-title">К озвучиванию</a><button disabled={Boolean(busy)} onClick={() => openJob(job.id, true)}>{conflict ? "Загрузить новую версию" : "Обновить"}</button><button disabled={Boolean(busy) || conflict} onClick={() => toggleRelevance(job)}>{job.irrelevant ? "Вернуть в очередь" : "Отметить нерелевантным"}</button><button disabled={Boolean(busy)} onClick={closeJob}>К списку адресов</button></div>
                  </header>
                  {job.irrelevant && <p className="admin-callout">Адрес скрыт из активной очереди. Верните его, чтобы продолжить редактуру или озвучивание.</p>}
                  {job.error && <p className="admin-callout">{job.error.message}</p>}
                  <section className="admin-review" aria-labelledby="admin-review-title"><h3 id="admin-review-title">Последняя проверка</h3>
                    {job.data.review ? <><p>{job.data.review.approved ? "Автоматическая проверка пройдена." : "Автоматическая проверка не пройдена."}</p>{job.data.review.issues.length ? <ul>{job.data.review.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : <p>Замечаний к тексту нет.</p>}</> : <p>Результата проверки текста пока нет.</p>}
                    {job.data.factReview && <div className="admin-identity"><h4>Идентификация места</h4><p>{job.data.factReview.placeName} · {job.data.factReview.resolvedAddress}</p><p>{job.data.factReview.addressConfirmed ? "Адрес подтверждён проверкой." : "Адрес не подтверждён проверкой."}</p><p>{job.data.factReview.identityNote || "Комментарий к идентификации отсутствует."}</p></div>}
                  </section>
                  {!facts.length && <div className="admin-callout"><h3>Нет проверенной доказательной базы</h3><p>Без подтверждённых фактов и источников нельзя сохранить редакторский текст. Доступный набросок показан только для чтения.</p></div>}
                  <div className="admin-editor-grid">
                    <section className="admin-editor" aria-labelledby="admin-draft-title"><h3 id="admin-draft-title">Редакторский текст</h3>
                      <p className="admin-meta">{dirty ? "Есть несохранённые правки" : job.data.editorDraft ? "Сохранённая редакторская версия" : job.data.story ? "Утверждённый текст" : "Исходный набросок: сохраните перед утверждением"}</p>
                      <fieldset disabled={Boolean(busy) || !editable}><legend className="admin-sr-only">Редактирование истории</legend>
                        <label htmlFor="admin-title">Заголовок</label><input id="admin-title" maxLength={140} value={draft.title} onChange={event => change({ ...draft, title: event.target.value })} />
                        {draft.paragraphs.map((paragraph, index) => <div className="admin-paragraph" key={index}>
                          <label htmlFor={`admin-paragraph-${index}`}>Абзац {index + 1}</label><textarea id={`admin-paragraph-${index}`} rows={7} maxLength={2000} value={paragraph.text} onChange={event => change({ ...draft, paragraphs: draft.paragraphs.map((p, i) => i === index ? { ...p, text: event.target.value } : p) })} />
                          <fieldset className="admin-fact-picks"><legend>Факты, подтверждающие абзац {index + 1}</legend>{facts.map(fact => <label key={fact.id}><input type="checkbox" checked={paragraph.factIds.includes(fact.id)} onChange={event => change({ ...draft, paragraphs: draft.paragraphs.map((p, i) => i === index ? { ...p, factIds: event.target.checked ? [...p.factIds, fact.id] : p.factIds.filter(id => id !== fact.id) } : p) })} /><span><b>{fact.id}</b> {fact.claim}</span></label>)}</fieldset>
                          <button disabled={draft.paragraphs.length <= 2} onClick={() => change({ ...draft, paragraphs: draft.paragraphs.filter((_, i) => i !== index) })}>Удалить абзац {index + 1}</button>
                        </div>)}
                        <button disabled={draft.paragraphs.length >= 6} onClick={() => change({ ...draft, paragraphs: [...draft.paragraphs, { text: "", factIds: [] }] })}>Добавить абзац</button>
                      </fieldset>
                    </section>
                    <aside className="admin-evidence" aria-labelledby="admin-evidence-title"><h3 id="admin-evidence-title">Источники и факты</h3>
                      {job.data.evidence && <p className="admin-meta">{job.data.evidence.placeName}<br />{job.data.evidence.resolvedAddress}</p>}
                      {facts.map(fact => <section className="admin-fact" key={fact.id}><h4>{fact.id} / {fact.claim}</h4>{fact.evidence.map((proof, index) => {
                        const source = job.data.evidence?.sources.find(s => s.id === proof.sourceId); const href = safeSourceLink(source?.url ?? null);
                        return <div key={index}><blockquote>{proof.quote}</blockquote><p className="admin-meta">{source?.publisher && `${source.publisher} · `}{href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{source?.title || proof.sourceId} (новая вкладка)</a> : `${source?.title || proof.sourceId}: ссылка недоступна`}</p></div>;
                      })}</section>)}
                      {!facts.length && <p>Подтверждённых фактов нет.</p>}
                    </aside>
                  </div>
                  <section className="admin-publish" aria-labelledby="admin-publish-title"><h3 id="admin-publish-title">Решение редактора</h3><p>{check?.words} слов из 100–250 · {check?.facts} из минимум 5 фактов · {draft.paragraphs.length} абзацев из 2–6.</p><p className="admin-meta">У каждого абзаца должен быть текст и хотя бы один подтверждающий факт. Сохранение не запускает озвучивание.</p>
                    <button disabled={Boolean(busy) || !editable || !check?.valid || conflict || (!dirty && Boolean(job.data.editorDraft))} onClick={() => void run("Сохранение текста…", async signal => {
                      accept((await api<{ job: Job }>(`/${job.id}/edit`, signal, { revision: job.revision, draft })).job, true); setNotice("Редакторский текст сохранён. Проверьте его и подтвердите решение перед озвучиванием.");
                    })}>Сохранить текст</button>
                  </section>
                  <section className="admin-narration" aria-labelledby="admin-narration-title">
                    <div className="admin-narration-head"><div><h3 id="admin-narration-title">Озвучивание</h3><p className="admin-meta">Выберите сервис и голос для следующего запуска.</p></div>{currentAudio && <div className="admin-current-voice"><span>Сейчас</span><strong>{currentAudio.voice ?? "Голос не указан"}</strong><small>{currentAudio.provider === "yandex" ? "Яндекс" : "OpenAI"}{currentAudio.model ? ` · ${currentAudio.model}` : ""}</small></div>}</div>
                    {currentAudio && <div className="admin-audio"><audio controls preload="metadata" src={currentAudio.url}>Ваш браузер не поддерживает воспроизведение аудио.</audio>{currentAudio.durationSec > 0 && <span className="admin-meta">{Math.round(currentAudio.durationSec)} сек.</span>}</div>}
                    <div className="admin-tts">
                      <label htmlFor="admin-tts-provider">Сервис</label><select id="admin-tts-provider" value={ttsProvider} disabled={Boolean(busy) || !narrationEligible || conflict} aria-describedby="admin-tts-note" onChange={event => {
                        const next = event.target.value as TtsProvider; setTtsProvider(next); setTtsVoice(job.ttsProviders.find(option => option.id === next)?.defaultVoice ?? ""); setConfirmed(false);
                      }}>{job.ttsProviders.map(option => <option key={option.id} value={option.id} disabled={!option.available}>{option.label}{option.available ? "" : " — недоступен"}</option>)}</select>
                      <label htmlFor="admin-tts-voice">Голос</label><select id="admin-tts-voice" value={ttsVoice} disabled={Boolean(busy) || !narrationEligible || conflict || !selectedTts?.available} onChange={event => { setTtsVoice(event.target.value); setConfirmed(false); }}>
                        {ttsVoice && !selectedVoice ? <option value={ttsVoice} disabled>{ttsVoice} — недоступен</option> : null}{selectedTts?.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.label}{voice.id === selectedTts.defaultVoice ? " (по умолчанию)" : ""}</option>)}</select>
                      <p id="admin-tts-note" className="admin-meta">{narrationEligible ? "Новый файл заменит текущую озвучку после успешной генерации." : "Для текущего состояния запуск озвучивания недоступен."}</p>
                    </div>
                    {job.canApprove && <label className="admin-confirm"><input type="checkbox" checked={confirmed} disabled={Boolean(busy) || !savedUnchanged || dirty || conflict} onChange={event => setConfirmed(event.target.checked)} /><span>Я сверил сохранённый текст с цитатами, проверил адрес и подтверждаю версию для публикации.</span></label>}
                    {job.canRegenerate && <p className="admin-callout">Перегенерация удалит текущие исследовательские материалы и начнёт подготовку заново по актуальным правилам.</p>}
                    {job.stage === "failed" && !job.data.story && <p className="admin-callout">У задания ещё нет утверждённого текста, поэтому переозвучить его нельзя. Продолжите подготовку: сервис вернётся к незавершённому этапу и использует выбранный голос.</p>}
                    <button className="admin-primary" disabled={Boolean(busy) || (narrationMode === "approve" ? !approvalAllowed : !voiceReady)} onClick={submitNarration}>{narrationMode === "approve" ? "Утвердить и озвучить" : narrationMode === "regenerate" ? "Перегенерировать историю" : narrationMode === "revoice" ? "Переозвучить" : narrationMode === "retry" ? "Продолжить подготовку" : "Озвучивание недоступно"}</button>
                    {!job.canApprove && editable && <p className="admin-meta">Сохраните корректный текст, чтобы сервер разрешил утверждение.</p>}
                    {(job.stage === "ready" || (job.data.editorDraft && job.stage !== "review_required")) && <p className="admin-result"><a href={`/create?job=${job.id}`} target="_blank" rel="noopener noreferrer">{job.stage === "ready" ? "Открыть готовую историю" : "Открыть публичную страницу задания"} (новая вкладка)</a></p>}
                  </section>
                </article>
              )}
            </section>
          )}
        </div>
      )}
    </main>
  );
}

"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { DRAFT_RESEARCH_LIMIT, draftClipboardText, draftResearchOptions, draftResearchStatuses, pageCount, pageRange, type AdminApi, type AdminRun, type ContentDraft, type ContentDraftPage, type ContentDraftResearchFilter, type ContentPlace, type Draft, type DraftResearchResult } from "./model";
import { PlaceTextFields, placeTextValid } from "./place-text-fields";
import { skeletonRows } from "./table-skeleton";
import "./content-admin.css";

const DRAFT_PAGE = 50;
const numbers = new Intl.NumberFormat("ru-RU");

function moment(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString("ru-RU");
}

type DraftsAdminProps = { api: AdminApi; busy: string; run: AdminRun; onDirtyChange: (dirty: boolean) => void };

/** Generated texts no editor has approved yet, newest first: each can be copied as plain text or opened for editing and approval. */
export function DraftsAdmin({ api, busy, run, onDirtyChange }: DraftsAdminProps) {
  const [page, setPage] = useState<ContentDraftPage>({ total: 0, hasMore: false, items: [] });
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [place, setPlace] = useState<ContentPlace | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [researchCount, setResearchCount] = useState(20);
  const [researchFilter, setResearchFilter] = useState<ContentDraftResearchFilter>("all");
  const loaded = useRef(false);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const placeOpener = useRef<HTMLButtonElement | null>(null);
  const pendingNavigation = useRef<"editor" | "list" | null>(null);
  const disabled = Boolean(busy);
  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // Focus moves once the request settles: to the editor after opening, back to the row's button after closing.
  useEffect(() => {
    if (busy || !pendingNavigation.current) return;
    const target = pendingNavigation.current === "editor" ? editorHeading.current : placeOpener.current?.isConnected ? placeOpener.current : null;
    const block = pendingNavigation.current === "editor" ? "start" : "center";
    pendingNavigation.current = null;
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block, behavior: "instant" });
  }, [busy, place]);

  async function load(next: number, signal: AbortSignal, research: ContentDraftResearchFilter = researchFilter) {
    setLoading(true);
    try {
      const result = await api<ContentDraftPage>(`/content/drafts?limit=${DRAFT_PAGE}&offset=${next}&research=${research}`, signal);
      // A page can fall off the end when drafts are approved between requests.
      if (!result.items.length && next > 0) { await load(Math.max(0, next - DRAFT_PAGE), signal, research); return; }
      setPage(result); setOffset(next);
    } finally { setLoading(false); }
  }

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void run("Загрузка черновиков…", signal => load(0, signal));
  // The ref keeps this a one-time mount load; later refreshes go through explicit buttons.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copy(draft: ContentDraft) {
    try {
      await navigator.clipboard.writeText(draftClipboardText(draft));
      setNotice(`Скопировано: ${draft.name}.`);
    } catch {
      setNotice("Не удалось скопировать: браузер не дал доступ к буферу обмена.");
    }
  }

  function consentToLoseDraft() {
    return !dirty || window.confirm("Есть несохранённые правки текста места. Отбросить их и продолжить?");
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
    pendingNavigation.current = "list";
    setPlace(null); setDraft(null); setBaseline("");
  }

  /** Queues drafts for a Perplexity search round; a successful run replaces the draft, a failed one leaves it as is. */
  function research(target: { placeIds: string[]; name: string } | { limit: number }, mode: "search" | "deep" = "search") {
    if (!consentToLoseDraft()) return;
    void run("Постановка черновиков в очередь…", async signal => {
      const result = await api<DraftResearchResult>("/content/drafts/research", signal, { requestKey: crypto.randomUUID(), ...(mode === "deep" ? { mode } : {}), ...("limit" in target ? { limit: target.limit } : { placeIds: target.placeIds }) });
      setPlace(null); setDraft(null); setBaseline("");
      await load(offset, signal);
      setNotice("limit" in target
        ? `Поставлено в очередь на переисследование: ${numbers.format(result.count)}. Партия «${result.batch.name}».`
        : `Черновик «${target.name}» поставлен в очередь на ${mode === "deep" ? "глубокое исследование" : "переисследование"}.`);
    });
  }

  const countValid = Number.isInteger(researchCount) && researchCount >= 1 && researchCount <= DRAFT_RESEARCH_LIMIT;

  function approve(current: ContentPlace, story: Draft) {
    void run("Утверждение текста…", async signal => {
      await api(`/content/places/${current.id}/approve`, signal, { story });
      setPlace(null); setDraft(null); setBaseline("");
      await load(offset, signal);
      setNotice(`Текст утверждён: ${current.name}.`);
    });
  }

  return <section className="admin-addresses content-admin" aria-labelledby="admin-drafts-title">
    <div className="admin-section-head">
      <div>
        <h2 id="admin-drafts-title">Черновики</h2>
        <p className="admin-meta">Сгенерированные тексты, которые ещё не утверждены. Откройте черновик, чтобы поправить абзацы и утвердить текст.</p>
      </div>
      <button disabled={disabled} onClick={() => void run("Загрузка черновиков…", signal => load(offset, signal))}>Обновить</button>
    </div>
    {page.researchAvailable
      ? <form className="admin-row-actions drafts-research" onSubmit={event => { event.preventDefault(); if (countValid) research({ limit: researchCount }); }}>
        <label>Сколько черновиков <input type="number" min={1} max={DRAFT_RESEARCH_LIMIT} step={1} value={Number.isNaN(researchCount) ? "" : researchCount}
          disabled={disabled} onChange={event => setResearchCount(event.currentTarget.valueAsNumber)} /></label>
        <button type="submit" disabled={disabled || !countValid || !page.unresearched}>Переисследовать через Perplexity</button>
        <span className="admin-meta">Ещё не проверено через Perplexity: {numbers.format(page.unresearched ?? 0)}. Сначала берутся самые старые черновики; удачный прогон заменяет текст черновика.</span>
      </form>
      : !loading && <p className="admin-meta">Переисследование через Perplexity недоступно: на сервере не задана модель поиска.</p>}
    {page.deepResearchAvailable && <p className="admin-meta">Глубокое исследование запускается для одного черновика и расходует квоту Perplexity Deep Research. Поиск может занять до 10 минут; удачный прогон заменит черновик.</p>}
    <div className="content-toolbar">
      <label htmlFor="draft-research-filter">Статус исследования</label>
      <select id="draft-research-filter" value={researchFilter} disabled={disabled} onChange={event => {
        const next = event.target.value as ContentDraftResearchFilter; setResearchFilter(next);
        void run("Фильтрация черновиков…", signal => load(0, signal, next));
      }}>{draftResearchOptions(page.counts).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      <p className="admin-meta" role="status">{notice || (loading ? "Загружаем черновики…" : `Показано ${pageRange(offset, page.items.length, page.total)} черновиков.`)}</p>
    </div>
    <div className="admin-table-wrap" aria-busy={loading}><table className="admin-table">
      <caption className="admin-sr-only">Черновики текстов</caption>
      <thead><tr><th scope="col">Место</th><th scope="col">Заголовок</th><th scope="col">Исследование</th><th scope="col">Абзацев</th><th scope="col">Создан</th><th scope="col">Действие</th></tr></thead>
      <tbody>{loading ? skeletonRows(6, page.items.length) : page.items.map(item => <Fragment key={item.placeId}><tr data-current={place?.id === item.placeId || undefined}>
        <th scope="row">{item.name}<span className="admin-row-id">{item.address ? `${item.address} · ` : ""}{item.location.lat}, {item.location.lon}</span></th>
        <td>{item.text.title || "—"}</td>
        <td><span className="admin-meta">{draftResearchStatuses[item.research]}</span></td>
        <td>{numbers.format(item.text.paragraphs.length)}</td>
        <td>{moment(item.text.createdAt)}</td>
        <td><div className="admin-row-actions">
          <button disabled={disabled} aria-label={`Копировать черновик: ${item.name}`} onClick={() => void copy(item)}>Копировать</button>
          <button disabled={disabled} aria-label={`Открыть черновик: ${item.name}`} onClick={event => openPlace(item.placeId, event.currentTarget)}>Открыть</button>
          {page.researchAvailable && <button disabled={disabled} aria-label={`Переисследовать черновик: ${item.name}`} onClick={() => research({ placeIds: [item.placeId], name: item.name })}>Переисследовать</button>}
          {page.deepResearchAvailable && <button disabled={disabled || item.research === "queued"} aria-label={`Глубокое исследование: ${item.name}`} onClick={() => research({ placeIds: [item.placeId], name: item.name }, "deep")}>Глубокое исследование</button>}
        </div></td>
      </tr>
      {place?.id === item.placeId && <tr className="drafts-editor-row"><td colSpan={6}>
        <article className="admin-document" aria-labelledby="draft-place-title">
          <div className="admin-document-head">
            <div><p className="admin-context">{place.id}</p><h3 id="draft-place-title" ref={editorHeading} tabIndex={-1}>{place.name}</h3>
              <p className="admin-meta">{place.address ?? "Адрес не указан"}{dirty ? " · есть несохранённые правки" : ""}</p></div>
            <button disabled={disabled} onClick={closePlace}>Закрыть</button>
          </div>
          {draft ? <>
            <PlaceTextFields draft={draft} disabled={disabled} onChange={setDraft} />
            <div className="admin-actions">
              <button className="admin-primary" disabled={disabled || !placeTextValid(draft)} onClick={() => approve(place, draft)}>Утвердить текст</button>
            </div>
          </> : <p className="admin-empty">У этого места больше нет текста. Обновите список черновиков.</p>}
        </article>
      </td></tr>}
      </Fragment>)}</tbody>
    </table></div>
    {!loading && !page.items.length && <p className="admin-empty-row" role="status">{researchFilter === "all" ? "Черновиков нет." : "Черновиков с этим статусом нет."}</p>}
    <nav className="admin-pagination" aria-label="Страницы черновиков">
      <button disabled={disabled || offset === 0} onClick={() => void run("Загрузка черновиков…", signal => load(Math.max(0, offset - DRAFT_PAGE), signal))}>Назад</button>
      <span className="admin-meta">Страница {Math.floor(offset / DRAFT_PAGE) + 1} из {pageCount(page.total, DRAFT_PAGE)}</span>
      <button disabled={disabled || !page.hasMore} onClick={() => void run("Загрузка черновиков…", signal => load(offset + DRAFT_PAGE, signal))}>Далее</button>
    </nav>
  </section>;
}

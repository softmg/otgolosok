"use client";

import { useEffect, useRef, useState } from "react";
import type { AdminApi, AdminRun, OpenAdminJob, TtsProvider } from "./model";
import { pageCount, pageRange, safeSourceLink } from "./model";
import { skeletonRows } from "./table-skeleton";
import "./walk-admin.css";

type WalkSummary = {
  id: string;
  title: string;
  subtitle: string;
  status: string;
  chapterCount: number;
  publishedCount: number;
  pendingCount: number;
  failedCount: number;
  updatedAt: string | null;
};

type WalkDraft = {
  title: string;
  transition: string;
  paragraphs: { id: string; text: string; fact_ids: string[] }[];
  nextHint: string;
};

type WalkSource = {
  id: string;
  title: string;
  url: string | null;
  publisher: string;
  kind?: string;
  checked_at?: string;
};

type WalkFact = {
  id: string;
  claim: string;
  confidence?: string;
  evidence: { source_id: string; locator?: string; summary?: string }[];
};

type WalkAudio = {
  url: string;
  durationSec: number;
  provider?: TtsProvider;
  model: string;
  voice: string;
  generatedAt?: string;
};

type TtsOption = {
  id: TtsProvider;
  label: string;
  available: boolean;
  defaultVoice: string;
  voices: { id: string; label: string }[];
};

type WalkChapter = {
  id: string;
  contentId: string;
  title: string;
  place: string;
  revision: number;
  status: string;
  updatedAt: string;
  draft: WalkDraft;
  published: { draft: WalkDraft; audio: WalkAudio } | null;
  source: { sources: WalkSource[]; facts: WalkFact[] };
  latestJob: {
    id: string;
    stage: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    error: { code?: string; message: string } | null;
    ttsProvider: TtsProvider | null;
    ttsVoice: string | null;
  } | null;
};

type WalkDetail = {
  id: string;
  title: string;
  subtitle: string;
  status: string;
  ttsProviders: TtsOption[];
  chapters: WalkChapter[];
};

type WalkAdminProps = {
  api: AdminApi;
  busy: string;
  run: AdminRun;
  openJob: OpenAdminJob;
  onDirtyChange: (dirty: boolean) => void;
};

const stageLabels: Record<string, string> = {
  draft: "Нужна редактура",
  conflict: "Нужна сверка",
  pending: "В работе",
  queued: "В очереди",
  researching: "Подготовка",
  verifying: "Проверка",
  writing: "Сборка текста",
  voicing: "Озвучивание",
  ready: "Готово",
  failed: "Ошибка",
};
const confidenceLabels: Record<string, string> = {
  verified: "Подтверждён",
  legend: "Городская легенда",
  unverified: "Не подтверждён",
};
const workingStages = new Set(["queued", "researching", "verifying", "writing", "voicing"]);
const WALK_PAGE = 50;

function copyDraft(draft: WalkDraft): WalkDraft {
  return {
    ...draft,
    paragraphs: draft.paragraphs.map((paragraph) => ({
      ...paragraph,
      fact_ids: [...paragraph.fact_ids],
    })),
  };
}

function safeAudioUrl(value: string | undefined) {
  if (!value) return null;
  return /^\/audio\/walk\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.mp3$/.test(value)
    || /^\/api\/story-audio\/[a-f0-9]{64}\.mp3$/.test(value) ? value : null;
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "нет данных";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "нет данных" : date.toLocaleString("ru-RU");
}

function stageLabel(stage: string) {
  return stageLabels[stage] ?? stage;
}

export function WalkAdmin({ api, busy, run, onDirtyChange }: WalkAdminProps) {
  const loaded = useRef(false);
  const [walks, setWalks] = useState<WalkSummary[]>([]);
  const [walkOffset, setWalkOffset] = useState(0);
  const [walkTotal, setWalkTotal] = useState(0);
  const [walksHaveMore, setWalksHaveMore] = useState(false);
  const [walk, setWalk] = useState<WalkDetail | null>(null);
  const [chapterId, setChapterId] = useState("");
  const [draft, setDraft] = useState<WalkDraft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [ttsProvider, setTtsProvider] = useState<TtsProvider>("openai");
  const [ttsVoice, setTtsVoice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  // Each table watches its own request: the catalogue list and the chapters of the opened walk reload separately.
  const [walksLoading, setWalksLoading] = useState(false);
  const [walkLoading, setWalkLoading] = useState(false);

  const chapter = walk?.chapters.find((item) => item.id === chapterId) ?? null;
  const catalogConflict = chapter?.status === "conflict";
  const blocked = conflict || catalogConflict;
  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline);
  const selectedProvider = walk?.ttsProviders.find((option) => option.id === ttsProvider);
  const selectedVoice = selectedProvider?.voices.find((voice) => voice.id === ttsVoice);
  const chapterBusy = Boolean(chapter && workingStages.has(chapter.status));
  const walkBusy = Boolean(walk?.chapters.some((item) => workingStages.has(item.status)));
  const walkBlocked = Boolean(walk?.chapters.some((item) => item.status === "conflict"));
  const draftValid = Boolean(draft?.title.trim() && draft.paragraphs.length
    && draft.paragraphs.every((paragraph) => paragraph.text.trim()));

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (busy || loaded.current) return;
    void run("Загрузка прогулок…", async (signal) => {
      loaded.current = true;
      setWalksLoading(true);
      try {
        const params = new URLSearchParams({ limit: String(WALK_PAGE), offset: "0" });
        const result = await api<{ walks: WalkSummary[]; total: number; hasMore: boolean }>(`/walks?${params}`, signal);
        setWalks(result.walks);
        setWalkOffset(0);
        setWalkTotal(result.total);
        setWalksHaveMore(result.hasMore);
      } finally { setWalksLoading(false); }
    });
  }, [api, busy, run]);

  const sourceById = new Map((chapter?.source.sources ?? []).map((source) => [source.id, source]));

  function chooseVoice(detail: WalkDetail, selected: WalkChapter) {
    const latest = selected.latestJob;
    const preferred = detail.ttsProviders.find((option) => option.id === latest?.ttsProvider)
      ?? detail.ttsProviders.find((option) => option.available)
      ?? detail.ttsProviders[0];
    setTtsProvider(preferred?.id ?? "openai");
    const latestVoice = preferred?.voices.some((voice) => voice.id === latest?.ttsVoice)
      ? latest?.ttsVoice ?? "" : "";
    setTtsVoice(latestVoice || preferred?.defaultVoice || preferred?.voices[0]?.id || "");
  }

  function acceptWalk(detail: WalkDetail, preferredChapter?: string) {
    const selected = detail.chapters.find((item) => item.id === preferredChapter)
      ?? detail.chapters[0] ?? null;
    setWalk(detail);
    setChapterId(selected?.id ?? "");
    const nextDraft = selected ? copyDraft(selected.draft) : null;
    setDraft(nextDraft);
    setBaseline(nextDraft ? JSON.stringify(nextDraft) : "");
    setConflict(false);
    if (selected) chooseVoice(detail, selected);
  }

  function consentDiscard() {
    return !dirty || window.confirm("Есть несохранённые правки главы. Отбросить их и продолжить?");
  }

  function openWalk(id: string, force = false) {
    if (busy || (!force && walk?.id === id) || !consentDiscard()) return;
    setNotice("");
    void run("Загрузка прогулки…", (signal) => loadWalk(async () => {
      const result = await api<{ walk: WalkDetail }>(`/walks/${id}`, signal);
      acceptWalk(result.walk, force ? chapterId : undefined);
    }));
  }

  function openChapter(id: string) {
    if (!walk || id === chapterId || busy || !consentDiscard()) return;
    const selected = walk.chapters.find((item) => item.id === id);
    if (!selected) return;
    setChapterId(id);
    const nextDraft = copyDraft(selected.draft);
    setDraft(nextDraft);
    setBaseline(JSON.stringify(nextDraft));
    setConflict(false);
    setNotice("");
    chooseVoice(walk, selected);
  }

  async function fetchWalks(offset: number, signal: AbortSignal): Promise<void> {
    const params = new URLSearchParams({ limit: String(WALK_PAGE), offset: String(offset) });
    const result = await api<{ walks: WalkSummary[]; total: number; hasMore: boolean }>(`/walks?${params}`, signal);
    if (!result.walks.length && offset > 0) {
      await fetchWalks(Math.max(0, offset - WALK_PAGE), signal);
      return;
    }
    setWalks(result.walks);
    setWalkOffset(offset);
    setWalkTotal(result.total);
    setWalksHaveMore(result.hasMore);
  }

  async function updateWalks(signal: AbortSignal) {
    setWalksLoading(true);
    try {
      await fetchWalks(walkOffset, signal);
    } finally { setWalksLoading(false); }
  }

  /** Every request that ends in `acceptWalk` replaces the chapter table, so it holds that table's flag. */
  async function loadWalk(action: () => Promise<void>) {
    setWalkLoading(true);
    try { await action(); }
    finally { setWalkLoading(false); }
  }

  async function withConflictGuard(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      if (errorStatus(error) === 409) {
        setConflict(true);
        setNotice("");
      }
      throw error;
    }
  }

  return (
    <section className="walk-admin" aria-busy={Boolean(busy)}>
      <div className="walk-admin__head">
        <div>
          <h2>Прогулки</h2>
          <p>Редактируйте главы и запускайте новую озвучку по одной. Опубликованная запись останется доступна, пока новая не будет готова.</p>
          <p className="admin-meta">{walksLoading ? "Загружаем прогулки…" : `Показано ${pageRange(walkOffset, walks.length, walkTotal)} прогулок.`}</p>
        </div>
        <button type="button" disabled={Boolean(busy) || dirty} onClick={() => {
          setNotice("");
          void run("Обновление прогулок…", async (signal) => {
            await updateWalks(signal);
            if (walk) await loadWalk(async () => {
              acceptWalk((await api<{ walk: WalkDetail }>(`/walks/${walk.id}`, signal)).walk, chapterId);
            });
          });
        }}>Обновить список</button>
      </div>

      {dirty && <p className="walk-admin__message walk-admin__message--dirty" role="status">Есть несохранённые правки в выбранной главе.</p>}
      {conflict && <div className="walk-admin__message walk-admin__message--error" role="alert">
        <strong>Глава изменилась на сервере.</strong>
        <span>Сохранение и переозвучка заблокированы. Загрузите актуальную версию и внесите правки заново.</span>
        <button type="button" disabled={Boolean(busy)} onClick={() => walk && openWalk(walk.id, true)}>Загрузить с сервера</button>
      </div>}
      {notice && <p className="walk-admin__message" role="status">{notice}</p>}

      <div className="walk-admin__table-wrap" aria-busy={walksLoading}>
        <table className="walk-admin__table">
          <caption className="admin-sr-only">Прогулки и состояние их глав</caption>
          <thead><tr><th scope="col">Прогулка</th><th scope="col">Главы</th><th scope="col">Готово</th><th scope="col">В работе</th><th scope="col">Ошибки</th><th scope="col">Обновлено</th></tr></thead>
          <tbody>{walksLoading ? skeletonRows(6, walks.length) : walks.map((item) => <tr key={item.id} data-selected={walk?.id === item.id || undefined}>
            <th scope="row"><button type="button" className="walk-admin__walk-link" disabled={Boolean(busy)} aria-current={walk?.id === item.id ? "true" : undefined} onClick={() => openWalk(item.id)}><strong>{item.title}</strong><span>{stageLabel(item.status)}</span></button></th>
            <td>{item.chapterCount}</td><td>{item.publishedCount}</td><td>{item.pendingCount}</td><td data-error={item.failedCount > 0 || undefined}>{item.failedCount}</td><td>{formatDate(item.updatedAt)}</td>
          </tr>)}</tbody>
        </table>
        {!walks.length && !walksLoading && !busy && <p className="walk-admin__empty">В каталоге пока нет прогулок с редактируемыми главами.</p>}
      </div>
      <nav className="admin-pagination" aria-label="Страницы прогулок">
        <button disabled={Boolean(busy) || walkOffset === 0} onClick={() => void run("Загрузка прогулок…", async signal => {
          setWalksLoading(true);
          try { await fetchWalks(Math.max(0, walkOffset - WALK_PAGE), signal); }
          finally { setWalksLoading(false); }
        })}>Назад</button>
        <span className="admin-meta">Страница {Math.floor(walkOffset / WALK_PAGE) + 1} из {pageCount(walkTotal, WALK_PAGE)}</span>
        <button disabled={Boolean(busy) || !walksHaveMore} onClick={() => void run("Загрузка прогулок…", async signal => {
          setWalksLoading(true);
          try { await fetchWalks(walkOffset + WALK_PAGE, signal); }
          finally { setWalksLoading(false); }
        })}>Далее</button>
      </nav>

      {walk && <article className="walk-admin__detail">
        <header className="walk-admin__route-head">
          <div><p className="walk-admin__state" data-state={walk.status}>{stageLabel(walk.status)}</p><h3>{walk.title}</h3><p>{walk.subtitle}</p></div>
          <button type="button" disabled={Boolean(busy)} onClick={() => openWalk(walk.id, true)}>{conflict ? "Загрузить актуальную версию" : "Обновить прогулку"}</button>
        </header>

        <section className="walk-admin__regenerate" aria-labelledby="walk-regenerate-title">
          <div><h4 id="walk-regenerate-title">Перегенерировать прогулку</h4><p>Все главы будут заново озвучены выбранным голосом. Опубликованные записи останутся доступны, пока каждая новая запись не будет готова.</p></div>
          <button type="button" className="admin-primary" disabled={Boolean(busy) || dirty || walkBusy || walkBlocked || !selectedProvider?.available || !selectedVoice} onClick={() => {
            if (!window.confirm(`Перегенерировать озвучку всех глав прогулки «${walk.title}» голосом «${selectedVoice?.label}»?`)) return;
            void run("Перегенерация прогулки…", async (signal) => {
              await loadWalk(async () => {
                const result = await api<{ walk: WalkDetail }>(`/walks/${walk.id}/regenerate`, signal, { ttsProvider, ttsVoice });
                acceptWalk(result.walk, chapterId);
              });
              await updateWalks(signal);
              setNotice("Все главы прогулки поставлены в очередь на перегенерацию озвучки.");
            });
          }}>Перегенерировать прогулку</button>
          {dirty && <p>Сначала сохраните или отбросьте правки выбранной главы.</p>}
          {walkBusy && <p>Дождитесь завершения текущей подготовки главы.</p>}
          {walkBlocked && <p>Сначала устраните конфликт структуры главы с каталогом.</p>}
        </section>

        <div className="walk-admin__chapters-wrap" aria-busy={walkLoading}>
          <table className="walk-admin__chapters">
            <caption>Главы по порядку маршрута</caption>
            <thead><tr><th scope="col">№</th><th scope="col">Глава</th><th scope="col">Место</th><th scope="col">Состояние</th><th scope="col">Версия</th></tr></thead>
            {/* The chapter title is the row header, so the placeholder puts its two-line bar in the second column. */}
            <tbody>{walkLoading ? skeletonRows(5, walk.chapters.length, 1) : walk.chapters.map((item, index) => <tr key={item.id} data-selected={chapterId === item.id || undefined}>
              <td>{index + 1}</td><th scope="row"><button type="button" className="walk-admin__chapter-link" disabled={Boolean(busy)} aria-current={chapterId === item.id ? "true" : undefined} onClick={() => openChapter(item.id)}>{item.title}</button></th><td>{item.place}</td><td><span className="walk-admin__state" data-state={item.status}>{stageLabel(item.status)}</span></td><td>{item.revision}</td>
            </tr>)}</tbody>
          </table>
        </div>

        {chapter && draft && <div className="walk-admin__editor-layout">
          <section className="walk-admin__editor" aria-labelledby="walk-chapter-editor-title">
            <div className="walk-admin__section-head"><div><h4 id="walk-chapter-editor-title">Текст главы</h4><p>{chapter.place} · версия {chapter.revision} · обновлено {formatDate(chapter.updatedAt)}</p></div><span className="walk-admin__state" data-state={chapter.status}>{stageLabel(chapter.status)}</span></div>
            {chapter.latestJob?.error && <p className="walk-admin__message walk-admin__message--error" role="alert"><strong>Ошибка озвучивания:</strong> {chapter.latestJob.error.message}</p>}
            {catalogConflict && <p className="walk-admin__message walk-admin__message--error" role="alert">Структура главы в каталоге изменилась. Сохранённые правки требуют сверки с новой версией; опубликованная прогулка использует актуальный каталог.</p>}
            {chapterBusy && <p className="walk-admin__message" role="status">Идёт озвучивание. Текст временно закрыт для изменений, чтобы в публикацию попала выбранная версия.</p>}
            <fieldset disabled={Boolean(busy) || blocked || chapterBusy}>
              <legend className="admin-sr-only">Редактирование главы прогулки</legend>
              <label htmlFor="walk-admin-title">Заголовок</label>
              <input id="walk-admin-title" maxLength={200} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              <label htmlFor="walk-admin-transition">Переход к главе</label>
              <textarea id="walk-admin-transition" rows={3} maxLength={1200} value={draft.transition} onChange={(event) => setDraft({ ...draft, transition: event.target.value })} />
              {draft.paragraphs.map((paragraph, index) => <div className="walk-admin__paragraph" key={paragraph.id}>
                <label htmlFor={`walk-admin-paragraph-${paragraph.id}`}>Абзац {index + 1}</label>
                <textarea id={`walk-admin-paragraph-${paragraph.id}`} rows={7} maxLength={4000} value={paragraph.text} onChange={(event) => setDraft({ ...draft, paragraphs: draft.paragraphs.map((item) => item.id === paragraph.id ? { ...item, text: event.target.value } : item) })} />
                <p className="walk-admin__fact-links"><span>Связанные факты:</span> {paragraph.fact_ids.map((id) => <a key={id} href={`#walk-fact-${chapter.id}-${id}`}>{id}</a>)}</p>
              </div>)}
              <label htmlFor="walk-admin-next-hint">Подсказка до следующей точки</label>
              <textarea id="walk-admin-next-hint" rows={3} maxLength={1200} value={draft.nextHint} onChange={(event) => setDraft({ ...draft, nextHint: event.target.value })} />
            </fieldset>
            <div className="walk-admin__save-row">
              <button type="button" className="admin-primary" disabled={Boolean(busy) || blocked || chapterBusy || !dirty || !draftValid} onClick={() => {
                void run("Сохранение главы…", (signal) => withConflictGuard(async () => {
                  await loadWalk(async () => {
                    const result = await api<{ walk: WalkDetail }>(`/walks/${walk.id}/chapters/${chapter.id}/edit`, signal, { revision: chapter.revision, draft });
                    acceptWalk(result.walk, chapter.id);
                  });
                  await updateWalks(signal);
                  setNotice("Текст главы сохранён. Озвучивание не запускалось.");
                }));
              }}>Сохранить текст</button>
              <span>{draftValid ? "Сохранение обновит только редакторский текст." : "Заполните заголовок и все абзацы."}</span>
            </div>
          </section>

          <aside className="walk-admin__reference" aria-label="Публикация, озвучивание и источники">
            <section className="walk-admin__audio">
              <h4>Текущая публикация</h4>
              {chapter.published?.audio && safeAudioUrl(chapter.published.audio.url) ? <>
                <audio controls preload="metadata" src={safeAudioUrl(chapter.published.audio.url) ?? undefined}>Ваш браузер не поддерживает воспроизведение аудио.</audio>
                <p>{chapter.published.audio.provider ? `${chapter.published.audio.provider} · ` : ""}{chapter.published.audio.voice} · {Math.round(chapter.published.audio.durationSec)} сек.</p>
              </> : <p>У этой главы пока нет доступной опубликованной записи.</p>}
            </section>

            <section className="walk-admin__revoice">
              <h4>Переозвучить главу</h4>
              <p>Сначала сохраните текст. Новая запись заменит текущую только после успешной генерации.</p>
              <label htmlFor="walk-admin-tts-provider">Сервис</label>
              <select id="walk-admin-tts-provider" value={ttsProvider} disabled={Boolean(busy) || blocked || dirty} onChange={(event) => {
                const next = event.target.value as TtsProvider;
                const option = walk.ttsProviders.find((item) => item.id === next);
                setTtsProvider(next);
                setTtsVoice(option?.defaultVoice || option?.voices[0]?.id || "");
              }}>{walk.ttsProviders.map((option) => <option key={option.id} value={option.id} disabled={!option.available}>{option.label}{option.available ? "" : " — недоступен"}</option>)}</select>
              <label htmlFor="walk-admin-tts-voice">Голос</label>
              <select id="walk-admin-tts-voice" value={ttsVoice} disabled={Boolean(busy) || blocked || dirty || !selectedProvider?.available} onChange={(event) => setTtsVoice(event.target.value)}>
                {ttsVoice && !selectedVoice && <option value={ttsVoice} disabled>{ttsVoice} — недоступен</option>}
                {selectedProvider?.voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}{voice.id === selectedProvider.defaultVoice ? " (по умолчанию)" : ""}</option>)}
              </select>
              <button type="button" className="admin-primary" disabled={Boolean(busy) || blocked || dirty || !selectedProvider?.available || !selectedVoice || chapterBusy} onClick={() => {
                if (!window.confirm(`Переозвучить главу «${draft.title}» голосом «${selectedVoice?.label}»?`)) return;
                void run("Переозвучивание главы…", (signal) => withConflictGuard(async () => {
                  await loadWalk(async () => {
                    const result = await api<{ walk: WalkDetail }>(`/walks/${walk.id}/chapters/${chapter.id}/revoice`, signal, { revision: chapter.revision, ttsProvider, ttsVoice });
                    acceptWalk(result.walk, chapter.id);
                  });
                  await updateWalks(signal);
                  setNotice("Глава поставлена в очередь на озвучивание. Текущая публикация остаётся доступна.");
                }));
              }}>Переозвучить главу</button>
              {chapter.latestJob && <p className="walk-admin__job">Последнее задание: {stageLabel(chapter.latestJob.stage)} · {formatDate(chapter.latestJob.updatedAt)}</p>}
            </section>

            <section className="walk-admin__sources">
              <h4>Факты и источники</h4>
              {chapter.source.facts.map((fact) => <article id={`walk-fact-${chapter.id}-${fact.id}`} key={fact.id}>
                <h5><span>{fact.id}</span>{fact.claim}</h5>
                {fact.confidence && <p className="walk-admin__confidence">{confidenceLabels[fact.confidence] ?? fact.confidence}</p>}
                {fact.evidence.map((evidence, index) => {
                  const source = sourceById.get(evidence.source_id);
                  const href = safeSourceLink(source?.url ?? null);
                  return <div key={`${evidence.source_id}-${index}`} className="walk-admin__evidence">
                    {evidence.summary && <p>{evidence.summary}</p>}
                    {evidence.locator && <p className="walk-admin__locator">{evidence.locator}</p>}
                    <p>{source?.publisher ? `${source.publisher} · ` : ""}{href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{source?.title || evidence.source_id}</a> : source?.title || evidence.source_id}</p>
                  </div>;
                })}
              </article>)}
              {!chapter.source.facts.length && <p>Для этой главы факты не указаны.</p>}
              {chapter.source.sources.length > 0 && <div className="walk-admin__sources-list">
                <h5>Все источники главы</h5>
                <ul>{chapter.source.sources.map((source) => {
                  const href = safeSourceLink(source.url);
                  return <li key={source.id}><strong>{source.id}</strong><span>{href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{source.title}</a> : source.title}</span><small>{source.publisher}{source.checked_at ? ` · проверено ${source.checked_at}` : ""}</small></li>;
                })}</ul>
              </div>}
            </section>
          </aside>
        </div>}
      </article>}
    </section>
  );
}

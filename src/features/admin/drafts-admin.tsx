"use client";

import { useEffect, useRef, useState } from "react";
import { draftClipboardText, pageCount, pageRange, type AdminApi, type AdminRun, type ContentDraft, type ContentDraftPage } from "./model";
import { skeletonRows } from "./table-skeleton";
import "./content-admin.css";

const DRAFT_PAGE = 50;
const numbers = new Intl.NumberFormat("ru-RU");

function moment(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString("ru-RU");
}

/** Generated texts no editor has approved yet, newest first, each copyable as plain text. */
export function DraftsAdmin({ api, busy, run }: { api: AdminApi; busy: string; run: AdminRun }) {
  const [page, setPage] = useState<ContentDraftPage>({ total: 0, hasMore: false, items: [] });
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const loaded = useRef(false);
  const disabled = Boolean(busy);

  async function load(next: number, signal: AbortSignal) {
    setLoading(true);
    try {
      const result = await api<ContentDraftPage>(`/content/drafts?limit=${DRAFT_PAGE}&offset=${next}`, signal);
      // A page can fall off the end when drafts are approved between requests.
      if (!result.items.length && next > 0) { await load(Math.max(0, next - DRAFT_PAGE), signal); return; }
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

  return <section className="admin-addresses content-admin" aria-labelledby="admin-drafts-title">
    <div className="admin-section-head">
      <div>
        <h2 id="admin-drafts-title">Черновики</h2>
        <p className="admin-meta">Сгенерированные тексты, которые ещё не утверждены. Утверждение — в разделе «OSM-партии», в карточке места.</p>
      </div>
      <button disabled={disabled} onClick={() => void run("Загрузка черновиков…", signal => load(offset, signal))}>Обновить</button>
    </div>
    <p className="admin-meta" role="status">{notice || (loading ? "Загружаем черновики…" : `Показано ${pageRange(offset, page.items.length, page.total)} черновиков.`)}</p>
    <div className="admin-table-wrap" aria-busy={loading}><table className="admin-table">
      <caption className="admin-sr-only">Черновики текстов</caption>
      <thead><tr><th scope="col">Место</th><th scope="col">Заголовок</th><th scope="col">Абзацев</th><th scope="col">Создан</th><th scope="col">Действие</th></tr></thead>
      <tbody>{loading ? skeletonRows(5, page.items.length) : page.items.map(item => <tr key={item.placeId}>
        <th scope="row">{item.name}<span className="admin-row-id">{item.address ? `${item.address} · ` : ""}{item.location.lat}, {item.location.lon}</span></th>
        <td>{item.text.title || "—"}</td>
        <td>{numbers.format(item.text.paragraphs.length)}</td>
        <td>{moment(item.text.createdAt)}</td>
        <td><button disabled={disabled} aria-label={`Копировать черновик: ${item.name}`} onClick={() => void copy(item)}>Копировать</button></td>
      </tr>)}</tbody>
    </table></div>
    {!loading && !page.items.length && <p className="admin-empty-row" role="status">Черновиков нет.</p>}
    <nav className="admin-pagination" aria-label="Страницы черновиков">
      <button disabled={disabled || offset === 0} onClick={() => void run("Загрузка черновиков…", signal => load(Math.max(0, offset - DRAFT_PAGE), signal))}>Назад</button>
      <span className="admin-meta">Страница {Math.floor(offset / DRAFT_PAGE) + 1} из {pageCount(page.total, DRAFT_PAGE)}</span>
      <button disabled={disabled || !page.hasMore} onClick={() => void run("Загрузка черновиков…", signal => load(offset + DRAFT_PAGE, signal))}>Далее</button>
    </nav>
  </section>;
}

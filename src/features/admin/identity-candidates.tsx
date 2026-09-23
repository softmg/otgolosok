"use client";

import { useState } from "react";
import {
  batchItemStates, identityQueueOptions, identityReasons, identitySignals, identityTiers, pageCount, pageRange,
  type AdminApi, type AdminRun, type ContentBatch, type IdentityCandidate, type IdentityCandidatePage,
  type IdentityLocation, type IdentityQueueFilter, type IdentityTier, type IdentityTierFilter,
} from "./model";
import { skeletonRows } from "./table-skeleton";

type Props = {
  api: AdminApi; busy: string; run: AdminRun;
  /** Refreshes the batch table so the new paused pilot shows up next to the other batches. */
  onPilotCreated: (batch: ContentBatch, signal: AbortSignal) => Promise<void>;
};
type Filters = { tier: IdentityTierFilter; category: string; queue: IdentityQueueFilter; q: string };

const PAGE = 50;
const tierOrder: IdentityTier[] = ["auto", "enrich", "manual"];
const numbers = new Intl.NumberFormat("ru-RU");

function locationSummary(location: IdentityLocation) {
  if (location.building) return `${location.building.relation === "point_in_building" ? "Точка OSM внутри здания" : "Точка OSM на контуре здания"}: ${location.building.address}`;
  if (location.nearestAddress) return `Ближайший адрес в ${numbers.format(location.nearestAddress.distanceMeters)} м: ${location.nearestAddress.address}`;
  const parts = [location.street?.name, location.district].filter(Boolean);
  return parts.length ? parts.join(", ") : "Адресных ориентиров нет";
}

function explanation(item: IdentityCandidate) {
  const reasons = item.reasons.map(code => identityReasons[code] ?? code);
  const signals = item.signals.map(code => identitySignals[code] ?? code);
  return { reasons, signals };
}

/** Places skipped by the regular filter with weak_identity. Nothing loads until the editor opens the block. */
export function IdentityCandidates({ api, busy, run, onPilotCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<IdentityCandidatePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Filters>({ tier: "auto", category: "all", queue: "all", q: "" });
  const [queryInput, setQueryInput] = useState("");
  const [pilotLimit, setPilotLimit] = useState(20);
  const [pilotMode, setPilotMode] = useState<"text-only" | "text-and-audio">("text-only");
  const [notice, setNotice] = useState("");
  const disabled = Boolean(busy);
  const maxPilot = page?.pilotLimit ?? 50;

  async function load(nextOffset: number, signal: AbortSignal, next: Partial<Filters> = {}) {
    const value = { ...filters, ...next };
    const params = new URLSearchParams({ tier: value.tier, category: value.category, queue: value.queue, limit: String(PAGE), offset: String(nextOffset) });
    if (value.q) params.set("q", value.q);
    setLoading(true);
    try {
      const result = await api<IdentityCandidatePage>(`/content/identity-candidates?${params}`, signal);
      if (!result.items.length && nextOffset > 0) { await load(Math.max(0, nextOffset - PAGE), signal, next); return; }
      setFilters(value); setPage(result); setOffset(nextOffset);
    } finally { setLoading(false); }
  }

  function filter(next: Partial<Filters>) {
    void run("Фильтрация кандидатов…", signal => load(0, signal, next));
  }

  function createPilot() {
    const limit = Math.max(1, Math.min(maxPilot, pilotLimit));
    if (!window.confirm(`Создать партию из ${limit} мест уровня «${identityTiers.auto.label}»? Партия появится на паузе; `
      + "тексты не будут опубликованы и озвучены без утверждения редактором.")) return;
    void run("Создание пилота…", async signal => {
      const result = await api<{ batch: ContentBatch; created: boolean }>("/content/identity-candidates/pilot", signal,
        { requestKey: crypto.randomUUID(), limit, mode: pilotMode });
      await onPilotCreated(result.batch, signal);
      await load(0, signal);
      setNotice(`Пилот «${result.batch.name}» создан на паузе: ${result.batch.counts.total} мест. Проверьте состав и нажмите «Продолжить» в таблице партий.`);
    });
  }

  const autoAvailable = page ? page.tiers.auto : 0;

  return (
    <section className="admin-review identity-candidates" aria-labelledby="identity-candidates-title">
      <div className="admin-section-head">
        <div>
          <h3 id="identity-candidates-title">Места со слабой идентификацией</h3>
          <p className="admin-meta">Места, которые обычный фильтр пропускает из-за отсутствия адреса и внешнего идентификатора.
            Оценка не меняет фильтр: она помогает выбрать ограниченный пилот и показывает, чего не хватает остальным.</p>
        </div>
        {!open && <button disabled={disabled} onClick={() => void run("Загрузка кандидатов…", async signal => { await load(0, signal); setOpen(true); })}>Показать кандидатов</button>}
        {open && <button disabled={disabled} onClick={() => { setOpen(false); setNotice(""); }}>Скрыть</button>}
      </div>

      {open && page && <>
        {notice && <p className="admin-meta" role="status">{notice}</p>}
        {!page.assessedAt ? <p className="admin-callout">Оценка ещё не выполнялась. Запустите на сервере
          {" "}<code>node scripts/assess-identity-candidates.mjs</code> — команда работает офлайн и не обращается к модели.</p> : <>
          <p className="admin-meta">Правила {page.rulesVersion}, оценка от {new Date(page.assessedAt).toLocaleString("ru-RU")}.</p>
          {page.stale > 0 && <p className="admin-callout">{numbers.format(page.stale)} оценок устарели после обновления каталога и скрыты. Повторите
            {" "}<code>node scripts/assess-identity-candidates.mjs</code>.</p>}
          <div className="content-counts identity-tiers" role="group" aria-label="Уровни уверенности">
            <button type="button" disabled={disabled} aria-pressed={filters.tier === "all"} onClick={() => filter({ tier: "all", category: "all" })}>
              <b>{numbers.format(tierOrder.reduce((sum, tier) => sum + page.tiers[tier], 0))}</b> все</button>
            {tierOrder.map(tier => <button key={tier} type="button" data-tier={tier} disabled={disabled} aria-pressed={filters.tier === tier}
              title={identityTiers[tier].hint} onClick={() => filter({ tier, category: "all" })}>
              <b>{numbers.format(page.tiers[tier])}</b> {identityTiers[tier].label.toLowerCase()}</button>)}
          </div>
          <p className="admin-meta">{filters.tier === "all" ? "Показаны все уровни." : identityTiers[filters.tier].hint}</p>

          <form className="admin-filters identity-filters" role="search" onSubmit={event => { event.preventDefault(); filter({ q: queryInput.trim() }); }}>
            <label className="admin-search"><span>Название</span>
              <input type="search" value={queryInput} placeholder="Например, музей" disabled={disabled} onChange={event => setQueryInput(event.target.value)} /></label>
            <label><span>Тип OSM</span><select value={filters.category} disabled={disabled} onChange={event => filter({ category: event.target.value })}>
              <option value="all">Все типы</option>
              {page.categories.map(item => <option key={item.category} value={item.category}>{item.category} · {numbers.format(item.count)}</option>)}
            </select></label>
            <label><span>Задание</span><select value={filters.queue} disabled={disabled} onChange={event => filter({ queue: event.target.value as IdentityQueueFilter })}>
              {identityQueueOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></label>
            <button className="admin-filter-submit" type="submit" disabled={disabled}>Найти</button>
          </form>

          <p className="admin-meta" role="status">{loading ? "Загружаем кандидатов…" : `Показано ${pageRange(offset, page.items.length, page.total)} мест.`}</p>
          <div className="admin-table-wrap" aria-busy={loading}><table className="admin-table">
            <caption className="admin-sr-only">Кандидаты со слабой идентификацией</caption>
            <thead><tr><th scope="col">Место</th><th scope="col">Уровень</th><th scope="col">Почему</th><th scope="col">Ориентир OSM</th><th scope="col">Задание</th></tr></thead>
            <tbody>{loading ? skeletonRows(5, page.items.length) : page.items.map(item => {
              const { reasons, signals } = explanation(item);
              return <tr key={item.placeId}>
                <th scope="row">{item.name}<span className="admin-row-id">{item.category} · {item.placeId}</span></th>
                <td><span className={`admin-stage identity-tier-${item.tier}`}>{identityTiers[item.tier].label}</span>
                  <span className="admin-row-id">оценка {item.score} из 100</span></td>
                <td>{reasons.length ? <span className="identity-reasons">{reasons.join("; ")}</span> : "Ограничений нет"}
                  <span className="admin-row-id">{signals.join(", ") || "Сигналов нет"}</span></td>
                <td>{locationSummary(item.location)}</td>
                <td>{item.job ? batchItemStates[item.job.state] ?? item.job.state : "—"}</td>
              </tr>;
            })}</tbody>
          </table></div>
          {!loading && !page.items.length && <p className="admin-empty-row" role="status">Кандидатов с выбранными фильтрами нет.</p>}
          <nav className="admin-pagination" aria-label="Страницы кандидатов">
            <button disabled={disabled || offset === 0} onClick={() => void run("Загрузка кандидатов…", signal => load(Math.max(0, offset - PAGE), signal))}>Назад</button>
            <span className="admin-meta">Страница {Math.floor(offset / PAGE) + 1} из {pageCount(page.total, PAGE)}</span>
            <button disabled={disabled || !page.hasMore} onClick={() => void run("Загрузка кандидатов…", signal => load(offset + PAGE, signal))}>Далее</button>
          </nav>

          <section className="identity-pilot" aria-labelledby="identity-pilot-title">
            <h4 id="identity-pilot-title">Пилотная партия</h4>
            <p className="admin-meta">Берёт до {maxPilot} мест уровня «{identityTiers.auto.label}» без заданий, чередуя типы объектов.
              Партия создаётся на паузе. Для этих мест в текст попадают только факты о самом объекте, источник должен называть его так же,
              как OSM, а публикация и озвучка возможны только после утверждения редактором.</p>
            <form className="admin-filters content-batch-form" onSubmit={event => { event.preventDefault(); createPilot(); }}>
              <label><span>Количество мест</span><input type="number" min={1} max={maxPilot} value={pilotLimit} disabled={disabled}
                onChange={event => setPilotLimit(Math.max(1, Math.min(maxPilot, Number(event.target.value) || 1)))} /></label>
              <label><span>Что готовить</span><select value={pilotMode} disabled={disabled} onChange={event => setPilotMode(event.target.value as typeof pilotMode)}>
                <option value="text-only">Только текст</option>
                <option value="text-and-audio">Текст, озвучка после утверждения</option>
              </select></label>
              <button className="admin-primary" disabled={disabled || !autoAvailable}>Создать пилот</button>
            </form>
          </section>
        </>}
      </>}
    </section>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import type { AdminApi, AdminRun } from "./model";
import { promoStatusLabels, slotLabel, type PromoItem, type PromoQueue } from "./promo-queue-model";
import { skeletonRows } from "./table-skeleton";
import styles from "./shared-walk-admin.module.css";

const STALE = "Очередь изменилась — список обновлён.";
type Action = "up" | "remove" | "requeue";
const actionLabels: Record<Action, { button: string; progress: string; done: (title: string) => string }> = {
  up: { button: "Выше", progress: "Перемещение в очереди…", done: title => `«${title}» поднята выше.` },
  remove: { button: "Убрать", progress: "Удаление из очереди…", done: title => `«${title}» убрана из очереди.` },
  requeue: { button: "Вернуть в очередь", progress: "Возврат в очередь…", done: title => `«${title}» снова в очереди.` },
};

function Links({ item }: { item: PromoItem }) {
  return <>
    {item.youtubeUrl && <a className={styles.meta} href={item.youtubeUrl} target="_blank" rel="noopener noreferrer">Ролик на YouTube</a>}
    {item.telegramUrl && <a className={styles.meta} href={item.telegramUrl} target="_blank" rel="noopener noreferrer">Пост в Telegram</a>}
  </>;
}

/** The promo queue: planned slots (Mon–Thu 19:00, Fri–Sun 21:00 MSK), order and finished issues. */
export function PromoQueueAdmin({ api, run, busy }: { api: AdminApi; run: AdminRun; busy: string }) {
  const loaded = useRef(false);
  const [queue, setQueue] = useState<PromoQueue | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState("");

  async function load(signal: AbortSignal) {
    setLoading(true); setFailed(false);
    try { setQueue(await api<PromoQueue>("/promo-queue", signal)); }
    catch (error) { setFailed(true); throw error; }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (busy || loaded.current) return;
    loaded.current = true;
    void run("Загрузка очереди промо…", load);
    // The first request runs once after the parent releases its authentication request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, busy, run]);

  function act(item: PromoItem, action: Action) {
    setNotice("");
    void run(actionLabels[action].progress, async signal => {
      try {
        await api(`/promo-queue/${encodeURIComponent(item.id)}/${action}`, signal, { revision: item.revision });
      } catch (error) {
        if ((error as { status?: number }).status !== 409 && (error as { status?: number }).status !== 404) throw error;
        await load(signal);
        setNotice(STALE);
        return;
      }
      await load(signal);
      setNotice(actionLabels[action].done(item.title));
    });
  }

  const disabled = Boolean(busy) || loading;
  const firstQueued = queue?.items.find(item => item.status === "queued")?.id;
  return <section className="walk-admin" aria-busy={loading} aria-labelledby="promo-queue-title">
    <div className="walk-admin__head">
      <div><h2 id="promo-queue-title">Очередь промо</h2><p>Один выпуск в день: пн–чт в 19:00, пт–вс в 21:00 по Москве. Ролик и пост собираются ночью, утром бот присылает превью с кнопками «Отменить» и «Перенести». Без ответа выпуск выходит по расписанию.</p></div>
      <button type="button" disabled={disabled} onClick={() => void run("Обновление очереди…", load)}>Обновить</button>
    </div>
    {notice && <p className="walk-admin__message" role="status">{notice}</p>}
    {failed && <p className="walk-admin__message walk-admin__message--error" role="alert">Не удалось загрузить очередь. <button type="button" disabled={disabled} onClick={() => void run("Повторная загрузка…", load)}>Повторить</button></p>}
    <div className="walk-admin__table-wrap" role="region" aria-label="Очередь промо" tabIndex={0}>
      <table className={`walk-admin__table ${styles.table}`}>
        <caption className="admin-sr-only">Выпуски в очереди промо и даты выхода</caption>
        <thead><tr><th scope="col">Выход</th><th scope="col">Прогулка</th><th scope="col">Статус</th><th scope="col">Действия</th></tr></thead>
        <tbody>{loading ? skeletonRows(4, queue?.items.length ?? 0) : queue?.items.map(item => <tr key={item.id}>
          <td>{slotLabel(item.slotAt)}</td>
          <th scope="row">{item.shareToken ? <a href={`/walk?share=${encodeURIComponent(item.shareToken)}`} target="_blank" rel="noopener noreferrer">{item.title}</a> : item.title}{item.visibility === "shared" && <span className={styles.meta}>По ссылке</span>}</th>
          <td>{promoStatusLabels[item.status]}</td>
          <td className={styles.actions}>{item.status === "queued" ? <>
            {item.id !== firstQueued && <button type="button" disabled={disabled} onClick={() => act(item, "up")} aria-label={`Выше: ${item.title}`}>Выше</button>}
            <button type="button" disabled={disabled} onClick={() => act(item, "remove")} aria-label={`Убрать из очереди: ${item.title}`}>Убрать</button>
          </> : <span className={styles.meta}>Отменить или перенести — кнопками в боте</span>}</td>
        </tr>)}</tbody>
      </table>
      {queue && !queue.items.length && !loading && <p className="walk-admin__empty">Очередь пуста. Поставьте прогулку в промо во вкладке «Пользовательские».</p>}
    </div>
    {queue && queue.history.length > 0 && <>
      <h3>Прошедшие выпуски</h3>
      <div className="walk-admin__table-wrap" role="region" aria-label="Прошедшие выпуски" tabIndex={0}>
        <table className={`walk-admin__table ${styles.table}`}>
          <caption className="admin-sr-only">Опубликованные, отменённые и неудачные выпуски</caption>
          <thead><tr><th scope="col">Прогулка</th><th scope="col">Итог</th><th scope="col">Действия</th></tr></thead>
          <tbody>{queue.history.map(item => <tr key={item.id}>
            <th scope="row">{item.title}</th>
            <td>{promoStatusLabels[item.status]}{item.slotAt && item.status === "published" ? ` · ${slotLabel(item.slotAt)}` : ""}{item.error && <span className={styles.warning}>{item.error}</span>}<Links item={item} /></td>
            <td className={styles.actions}>{item.status !== "published" && <>
              <button type="button" disabled={disabled} onClick={() => act(item, "requeue")} aria-label={`Вернуть в очередь: ${item.title}`}>Вернуть в очередь</button>
              <button type="button" disabled={disabled} onClick={() => act(item, "remove")} aria-label={`Удалить из истории: ${item.title}`}>Убрать</button>
            </>}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </>}
  </section>;
}

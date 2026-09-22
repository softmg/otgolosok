"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getSession, accountApi } from "../auth/client";
import { listLocalWalks, migrateLocalWalks } from "./local-store";
import { type WalkCard, loadCatalogCards } from "./walk-loader";
import { AppHeader } from "../navigation/app-header";
import { mergePage } from "../account/pagination";
import "./history.css";
type Card = WalkCard & { distanceM?: number; walkingMinutes?: number; draft?: boolean };
export function WalkLibrary() {
  const [local, setLocal] = useState<Card[]>([]);
  const [account, setAccount] = useState<Card[]>([]);
  const [catalog, setCatalog] = useState<Card[]>([]);
  const [guest, setGuest] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<"all" | "draft">("all");
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const fail = (key: string, caught: unknown) => { if (active) setErrors(current => ({ ...current, [key]: caught instanceof Error ? caught.message : "Не удалось открыть прогулки." })); };
    void (async () => {
      try {
        migrateLocalWalks(localStorage);
        setLocal(listLocalWalks(localStorage).map(item => ({ id: item.document.id, title: item.document.title, subtitle: item.document.description, revision: item.revision, kind: "local", updatedAt: item.updatedAt, draft: !item.document.route, distanceM: item.document.route?.distanceM, walkingMinutes: item.document.route?.walkingMinutes })));
      } catch (caught) { fail("local", caught); }
      await Promise.all([
        loadCatalogCards(controller.signal).then(cards => { if (active) setCatalog(cards); }).catch(caught => fail("catalog", caught)),
        (async () => {
          const user = await getSession(); if (!active) return; setGuest(!user);
          if (user) { const data = await accountApi("/api/me/walks"); if (!active) return; setAccount(data.walks.map((card: WalkCard) => ({ ...card, kind: "account" }))); setCursor(data.nextCursor ?? null); }
        })().catch(caught => fail("account", caught)),
      ]);
      if (active) setLoading(false);
    })();
    return () => { active = false; controller.abort(); };
  }, [attempt]);
  async function more() {
    if (!cursor || busy) return; setBusy("page");
    try {
      const data = await accountApi(`/api/me/walks?cursor=${encodeURIComponent(cursor)}`);
      setAccount(current => mergePage(current, data.walks.map((item: WalkCard) => ({ ...item, kind: "account" })), (item: Card) => item.id)); setCursor(data.nextCursor ?? null);
    } catch (caught) { setErrors(current => ({ ...current, page: caught instanceof Error ? caught.message : "Не удалось загрузить следующую страницу." })); }
    finally { setBusy(null); }
  }
  async function copy(token: string) {
    const url = `${location.origin}/walk?share=${encodeURIComponent(token)}`;
    try { await navigator.clipboard.writeText(url); setNotice("Ссылка скопирована."); } catch { setNotice(`Скопируйте ссылку: ${url}`); }
  }
  async function share(card: Card) {
    if (busy) return; setBusy(card.id); setNotice("");
    try {
      const data = await accountApi(`/api/me/walks/${encodeURIComponent(card.id)}/sharing`, { method: "PUT", body: JSON.stringify({ revision: card.revision, enabled: card.visibility !== "shared" }) });
      setAccount(current => current.map(item => item.id === card.id ? { ...item, ...data.walk } : item));
      if (data.walk.shareToken) await copy(data.walk.shareToken); else setNotice("Доступ по ссылке закрыт.");
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Не удалось изменить доступ."); } finally { setBusy(null); }
  }
  const cards = [...account, ...local].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const visible = cards.filter(card => filter === "all" || card.draft);
  return <main className="ui-page history-page"><AppHeader />
    <header className="history-heading"><div><p className="ui-eyebrow">Ваши маршруты</p><h1>История прогулок</h1><p className="ui-muted">Знакомые места. Новые открытия. Всё, к чему хочется вернуться.</p></div><Link href="/?walk=create" className="ui-button">Новая прогулка <span aria-hidden="true">＋</span></Link></header>
    <div className="history-filters"><button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>Все прогулки</button><button aria-pressed={filter === "draft"} onClick={() => setFilter("draft")}>Черновики</button></div>
    {Object.entries(errors).map(([key, message]) => <p key={key} role="alert" className="ui-notice">{message} <button className="history-retry" onClick={() => { setErrors({}); setLoading(true); setAttempt(value => value + 1); }}>Повторить</button></p>)}
    {loading ? <p role="status" className="ui-muted">Загружаем ваши прогулки…</p> : <>
      {visible.length ? <ul className="history-grid">{visible.map(card => <li key={`${card.kind}:${card.id}`}><article className="history-card"><div className="history-card-body"><span className="history-badge">{card.draft ? "Черновик" : card.kind === "local" ? "На устройстве" : "В аккаунте"}</span><Link className="history-card-title" href={`/walk?${card.kind === "local" ? "local" : "id"}=${encodeURIComponent(card.id)}`}><h2>{card.title}</h2></Link>{card.subtitle && <p>{card.subtitle}</p>}<p className="ui-muted">{[card.walkingMinutes ? `${card.walkingMinutes} мин пешком` : null, card.distanceM ? `${(card.distanceM / 1000).toFixed(1)} км` : null, card.updatedAt ? new Date(card.updatedAt).toLocaleDateString("ru-RU") : null].filter(Boolean).join(" · ")}</p><div className="history-actions"><Link href={`/?walk=create&${card.kind === "local" ? "local" : "id"}=${encodeURIComponent(card.id)}&edit=1`}>Редактировать</Link>{card.kind === "account" && <button disabled={busy !== null} onClick={() => void share(card)}>{card.visibility === "shared" ? "Закрыть доступ" : "Поделиться"}</button>}{card.shareToken && <button onClick={() => void copy(card.shareToken!)}>Скопировать ссылку</button>}</div></div></article></li>)}</ul> : <section className="history-empty"><span aria-hidden="true">↗</span><h2>{filter === "draft" ? "Нет незаконченных прогулок" : "Начните свою историю города"}</h2><p>Выберите дом на карте или задайте начало маршрута.<br />Сохранённые прогулки появятся здесь.</p><Link className="ui-button" href="/?walk=create">Создать прогулку</Link></section>}
      {cursor && <button className="ui-button secondary" disabled={busy !== null} onClick={() => void more()}>Показать ещё</button>}
      {notice && <p className="ui-notice" role="status">{notice}</p>}
      {guest && <aside className="history-signin"><div><h2>Ваши прогулки — с вами</h2><p>Войдите, чтобы открывать их на других устройствах и делиться ссылками.</p></div><Link className="ui-button quiet" href="/login?returnTo=/history">Войти</Link></aside>}
      {!cards.length && catalog.length > 0 && <section className="history-catalog"><p className="ui-eyebrow">Попробуйте готовый маршрут</p>{catalog.map(card => <Link key={card.id} href={`/walk?catalog=${encodeURIComponent(card.id)}`}><strong>{card.title}</strong><span>Открыть прогулку →</span></Link>)}</section>}
    </>}
  </main>;
}

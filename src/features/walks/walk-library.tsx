"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getSession, accountApi } from "../auth/client";
import { listLocalWalks, migrateLocalWalks } from "./local-store";
import type { WalkCard } from "./walk-loader";
import { AccessDialog, accessLabel } from "./access-dialog";
import { TopWalks } from "./top-walks";
import { AppHeader } from "../navigation/app-header";
import { mergePage } from "../account/pagination";
import "./history.css";
import styles from "./walk-library.module.css";
import { toUserMessage } from "@/lib/errors/user-message";
type Card = WalkCard & { distanceM?: number; walkingMinutes?: number; draft?: boolean };
type Tab = "mine" | "top";
const TABS: Array<{ id: Tab; title: string }> = [{ id: "mine", title: "Мои прогулки" }, { id: "top", title: "Топ прогулок" }];

/** `?tab=` wins; otherwise «Мои» once own walks have loaded, or «Топ» for a viewer with none. */
export function selectedTab(param: string | null, loading: boolean, ownCount: number): Tab | null {
  if (param === "top" || param === "mine") return param;
  if (loading) return null;
  return ownCount ? "mine" : "top";
}

export function WalkLibrary() {
  const params = useSearchParams();
  const [local, setLocal] = useState<Card[]>([]);
  const [account, setAccount] = useState<Card[]>([]);
  const [guest, setGuest] = useState(false);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<"all" | "draft">("all");
  const [accessCard, setAccessCard] = useState<Card | null>(null);
  const [topOpened, setTopOpened] = useState(false);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ mine: null, top: null });
  useEffect(() => {
    let active = true;
    const fail = (key: string, caught: unknown) => { if (active) setErrors(current => ({ ...current, [key]: toUserMessage(caught, "Не удалось открыть прогулки.") })); };
    void (async () => {
      try {
        migrateLocalWalks(localStorage);
        setLocal(listLocalWalks(localStorage).map(item => ({ id: item.document.id, title: item.document.title, subtitle: item.document.description, revision: item.revision, kind: "local", updatedAt: item.updatedAt, draft: !item.document.route, distanceM: item.document.route?.distanceM, walkingMinutes: item.document.route?.walkingMinutes })));
      } catch (caught) { fail("local", caught); }
      await (async () => {
        const user = await getSession(); if (!active) return; setGuest(!user);
        if (user) { const data = await accountApi("/api/me/walks"); if (!active) return; setAccount(data.walks.map((card: WalkCard) => ({ ...card, kind: "account" }))); setCursor(data.nextCursor ?? null); }
      })().catch(caught => fail("account", caught));
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [attempt]);
  async function more() {
    if (!cursor || busy) return; setBusy("page");
    try {
      const data = await accountApi(`/api/me/walks?cursor=${encodeURIComponent(cursor)}`);
      setAccount(current => mergePage(current, data.walks.map((item: WalkCard) => ({ ...item, kind: "account" })), (item: Card) => item.id)); setCursor(data.nextCursor ?? null);
    } catch (caught) { setErrors(current => ({ ...current, page: toUserMessage(caught, "Не удалось загрузить следующую страницу.") })); }
    finally { setBusy(null); }
  }
  async function copy(token: string, done = "Ссылка скопирована.") {
    const url = `${location.origin}/walk?share=${encodeURIComponent(token)}`;
    try { await navigator.clipboard.writeText(url); setNotice(done); } catch { setNotice(`Скопируйте ссылку: ${url}`); }
  }
  async function accessSaved(previous: Card, walk: WalkCard) {
    setAccessCard(null);
    setAccount(current => current.map(item => item.id === previous.id ? { ...item, ...walk, kind: "account" } : item));
    if (!walk.shareToken) { setNotice("Доступ закрыт: прогулку видите только вы."); return; }
    const awaitsReview = walk.visibility === "public" && walk.listingStatus === "pending" && !(previous.visibility === "public" && previous.listingStatus === "pending");
    await copy(walk.shareToken, awaitsReview ? "Ссылка скопирована. Прогулка появится в топе после проверки." : "Ссылка скопирована.");
  }
  const cards = [...account, ...local].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const visible = cards.filter(card => filter === "all" || card.draft);
  const tab = selectedTab(params.get("tab"), loading, cards.length);
  // The top loads lazily on its first open and stays mounted afterwards.
  if (tab === "top" && !topOpened) setTopOpened(true);
  function selectTab(next: Tab, focus = false) {
    // replaceState integrates with the Next.js router, so useSearchParams follows it without a navigation.
    const url = new URL(location.href);
    url.searchParams.set("tab", next);
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (focus) tabRefs.current[next]?.focus();
  }
  function tabKeys(event: KeyboardEvent<HTMLButtonElement>) {
    const index = Math.max(0, TABS.findIndex(item => item.id === tab));
    const next = event.key === "ArrowRight" ? TABS[(index + 1) % TABS.length] : event.key === "ArrowLeft" ? TABS[(index - 1 + TABS.length) % TABS.length]
      : event.key === "Home" ? TABS[0] : event.key === "End" ? TABS[TABS.length - 1] : null;
    if (!next) return;
    event.preventDefault();
    selectTab(next.id, true);
  }
  return <main className="ui-page history-page"><AppHeader />
    <header className="history-heading"><div><p className="ui-eyebrow">Ваши маршруты</p><h1>История прогулок</h1><p className="ui-muted">Знакомые места. Новые открытия. Всё, к чему хочется вернуться.</p></div></header>
    <div role="tablist" aria-label="Прогулки" className={styles.tabs}>
      {TABS.map(item => <button key={item.id} ref={element => { tabRefs.current[item.id] = element; }} type="button" role="tab" id={`history-tab-${item.id}`}
        aria-selected={tab === item.id} aria-controls={`history-panel-${item.id}`} tabIndex={tab === item.id || (tab === null && item.id === "mine") ? 0 : -1}
        className={styles.tab} onClick={() => selectTab(item.id)} onKeyDown={tabKeys}>{item.title}</button>)}
    </div>
    <section role="tabpanel" id="history-panel-mine" aria-labelledby="history-tab-mine" hidden={tab === "top"}>
      <div className={styles.toolbar}><div className="history-filters"><button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>Все прогулки</button><button aria-pressed={filter === "draft"} onClick={() => setFilter("draft")}>Черновики</button></div><Link href="/?walk=create" className="ui-button">Новая прогулка <span aria-hidden="true">＋</span></Link></div>
      {Object.entries(errors).map(([key, message]) => <p key={key} role="alert" className="ui-notice">{message} <button className="history-retry" onClick={() => { setErrors({}); setLoading(true); setAttempt(value => value + 1); }}>Повторить</button></p>)}
      {loading ? <p role="status" className="ui-muted">Загружаем ваши прогулки…</p> : <>
        {visible.length ? <ul className="history-grid">{visible.map(card => <li key={`${card.kind}:${card.id}`}><article className="history-card"><div className="history-card-body"><span className="history-badge">{card.draft ? "Черновик" : card.kind === "local" ? "На устройстве" : "В аккаунте"}</span><Link className="history-card-title" href={`/walk?${card.kind === "local" ? "local" : "id"}=${encodeURIComponent(card.id)}`}><h2>{card.title}</h2></Link>{card.subtitle && <p>{card.subtitle}</p>}<p className="ui-muted">{[card.walkingMinutes ? `${card.walkingMinutes} мин пешком` : null, card.distanceM ? `${(card.distanceM / 1000).toFixed(1)} км` : null, card.updatedAt ? new Date(card.updatedAt).toLocaleDateString("ru-RU") : null].filter(Boolean).join(" · ")}</p>{card.kind === "account" && <p className={styles.access}>Доступ: {accessLabel(card)}</p>}<div className="history-actions"><Link href={`/?walk=create&${card.kind === "local" ? "local" : "id"}=${encodeURIComponent(card.id)}&edit=1`}>Редактировать</Link>{card.kind === "account" && <button disabled={busy !== null} aria-haspopup="dialog" onClick={() => { setNotice(""); setAccessCard(card); }}>Доступ</button>}{card.shareToken && <button onClick={() => void copy(card.shareToken!)}>Скопировать ссылку</button>}</div></div></article></li>)}</ul> : <section className="history-empty"><span aria-hidden="true">↗</span><h2>{filter === "draft" ? "Нет незаконченных прогулок" : "Начните свою историю города"}</h2><p>Выберите дом на карте или задайте начало маршрута.{" "}<br />Сохранённые прогулки появятся здесь.</p><Link className="ui-button" href="/?walk=create">Создать прогулку</Link></section>}
        {cursor && <button className="ui-button secondary" disabled={busy !== null} onClick={() => void more()}>Показать ещё</button>}
        {notice && <p className="ui-notice" role="status">{notice}</p>}
        {guest && <aside className="history-signin"><div><h2>Ваши прогулки — с вами</h2><p>Войдите, чтобы открывать их на других устройствах и делиться ссылками.</p></div><Link className="ui-button quiet" href="/login?returnTo=/history">Войти</Link></aside>}
      </>}
    </section>
    <section role="tabpanel" id="history-panel-top" aria-labelledby="history-tab-top" hidden={tab !== "top"}>
      {topOpened && <TopWalks />}
    </section>
    <AccessDialog card={accessCard} onClose={() => setAccessCard(null)} onSaved={walk => { if (accessCard) void accessSaved(accessCard, walk); }} />
  </main>;
}

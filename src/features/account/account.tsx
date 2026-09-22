"use client";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { AppHeader } from "../navigation/app-header";
import { accountApi, type AuthUser, getSession, signOut, signOutEverywhere } from "../auth/client";
import { AUTH_CHANNEL, isSignOutChannelEvent, isSignOutStorageEvent } from "../auth/session-events";
import { savedStories } from "../generator/offline";
import type { GenerationJob } from "../generator/types";
import { clearOfflineScope } from "../walks/offline";
import { mergePage } from "./pagination";
import "./account.css";

type RequestItem = { jobId: string; operation: string; createdAt: string };
type Favorite = { type: string; id: string; createdAt: string; title?: string; href?: string | null };
type Section = "requests" | "favorites";
export function Account() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [requests, setRequests] = useState<RequestItem[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [offline, setOffline] = useState<GenerationJob[]>([]);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [cursors, setCursors] = useState<Record<Section, string | null>>({ requests: null, favorites: null });
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"logout" | "all" | "delete" | null>(null);
  const [password, setPassword] = useState("");

  useEffect(() => {
    let active = true;
    const signedOut = () => location.replace("/login?returnTo=/account");
    const onStorage = (event: StorageEvent) => { if (isSignOutStorageEvent(event)) signedOut(); };
    const onMessage = (event: MessageEvent) => { if (isSignOutChannelEvent(event)) signedOut(); };
    let channel: BroadcastChannel | undefined;
    try { channel = new BroadcastChannel(AUTH_CHANNEL); channel.addEventListener("message", onMessage); } catch { /* Storage fallback. */ }
    addEventListener("storage", onStorage);
    const fail = (key: string, caught: unknown) => { if (active) setErrors(current => ({ ...current, [key]: caught instanceof Error ? caught.message : "Не удалось загрузить раздел." })); };
    void (async () => {
      try {
        const current = await getSession();
        if (!active) return;
        if (!current) { signedOut(); return; }
        setUser(current); setName(current.name); setLoaded(true);
        await Promise.all([
          accountApi("/api/me/requests").then(data => { if (active) { setRequests(data.requests); setCursors(v => ({ ...v, requests: data.nextCursor ?? null })); } }).catch(e => fail("requests", e)),
          accountApi("/api/me/favorites").then(data => { if (active) { setFavorites(data.favorites); setCursors(v => ({ ...v, favorites: data.nextCursor ?? null })); } }).catch(e => fail("favorites", e)),
          savedStories().then(data => { if (active) setOffline(data); }).catch(e => fail("offline", e)),
        ]);
      } catch (caught) { fail("profile", caught); if (active) setLoaded(true); }
    })();
    return () => { active = false; channel?.close(); removeEventListener("storage", onStorage); };
  }, [attempt]);

  async function loadMore(kind: Section) {
    const cursor = cursors[kind]; if (!cursor || busy) return; setBusy(kind);
    try {
      const data = await accountApi(`/api/me/${kind}?cursor=${encodeURIComponent(cursor)}`);
      if (kind === "requests") setRequests(current => mergePage(current, data.requests, (item: RequestItem) => `${item.jobId}:${item.createdAt}`));
      else setFavorites(current => mergePage(current, data.favorites, (item: Favorite) => `${item.type}:${item.id}`));
      setCursors(current => ({ ...current, [kind]: data.nextCursor ?? null }));
    } catch (caught) { setErrors(current => ({ ...current, [kind]: caught instanceof Error ? caught.message : "Не удалось загрузить следующую страницу." })); }
    finally { setBusy(null); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy("profile"); setNotice("");
    try { const data = await accountApi("/api/me", { method: "PATCH", body: JSON.stringify({ name: name.trim() }) }); setUser(data.user); setName(data.user.name); setNotice("Имя сохранено."); setEditing(false); }
    catch (caught) { setErrors(current => ({ ...current, profile: caught instanceof Error ? caught.message : "Не удалось сохранить имя." })); }
    finally { setBusy(null); }
  }
  async function confirm(event: FormEvent) {
    event.preventDefault(); if (!confirmAction || busy) return; setBusy("settings");
    try {
      if (confirmAction === "delete") await accountApi("/api/me", { method: "DELETE", body: JSON.stringify({ password }) });
      else {
        if (user) await clearOfflineScope(user.id);
        await (confirmAction === "all" ? signOutEverywhere() : signOut());
      }
      if (user && confirmAction === "delete") await clearOfflineScope(user.id);
      setPassword(""); location.replace("/");
    } catch (caught) { setErrors(current => ({ ...current, settings: caught instanceof Error ? caught.message : "Не удалось выполнить действие." })); }
    finally { setBusy(null); setPassword(""); }
  }
  const more = (kind: Section) => cursors[kind] && <button className="ui-button secondary" disabled={busy !== null} onClick={() => void loadMore(kind)}>Показать ещё</button>;
  return <main className="ui-page profile-page"><AppHeader />
    {Object.entries(errors).map(([key, text]) => <p key={key} role="alert" className="ui-notice">{text} <button className="profile-link" onClick={() => { setErrors({}); setAttempt(v => v + 1); }}>Повторить загрузку</button></p>)}
    {!loaded && <p role="status">Открываем профиль…</p>}
    {user && <>
      <header className="profile-hero"><div className="profile-avatar" aria-hidden="true">{user.name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toLocaleUpperCase("ru")}</div><div className="profile-identity"><h1>{user.name}</h1><p>{user.email}</p></div><button type="button" className="profile-edit" aria-label="Редактировать профиль" aria-expanded={editing} aria-controls="profile-edit-form" disabled={busy !== null} onClick={() => { setName(user.name); setEditing(value => !value); setNotice(""); }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m16 3 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15z" /></svg></button></header>
      {editing && <form id="profile-edit-form" className="profile-edit-form" onSubmit={save}><label className="ui-field">Ваше имя<input autoFocus value={name} onChange={e => setName(e.target.value)} required maxLength={80} autoComplete="name" disabled={busy !== null} /></label><div className="ui-row"><button className="ui-button" disabled={busy !== null || !name.trim() || name.trim() === user.name}>Сохранить изменения</button><button type="button" className="ui-button quiet" disabled={busy !== null} onClick={() => { setEditing(false); setName(user.name); }}>Отменить</button></div></form>}
      {notice && <p className="ui-notice" role="status">{notice}</p>}
      <Link className="profile-history" href="/history"><span className="profile-icon" aria-hidden="true">↗</span><span><strong>Мои прогулки</strong><small>Сохранённые маршруты и черновики</small></span><span aria-hidden="true">→</span></Link>
      <div className="profile-columns">
      <section className="profile-section"><h2>Сохранённое</h2><details><summary>Избранное <span>{favorites.length || ""}</span></summary>{favorites.length ? <ul className="profile-list">{favorites.map(item => <li key={`${item.type}:${item.id}`}>{item.href && /^\/(?:walk|create)\?/.test(item.href) ? <Link href={item.href}>{item.title || "Сохранённый материал"}</Link> : <span>Материал недоступен</span>}</li>)}</ul> : <p className="ui-muted">Здесь появятся любимые истории и прогулки.</p>}{more("favorites")}</details><details><summary>Доступно без сети <span>{offline.length || ""}</span></summary>{offline.length ? <ul className="profile-list">{offline.map(item => <li key={item.id}><Link href={`/create?job=${item.id}`}>{item.story?.title || "Сохранённая история"}</Link><small>{item.address}</small></li>)}</ul> : <p className="ui-muted">Откройте прогулку и сохраните готовые записи для прослушивания без интернета.</p>}</details><details><summary>Подготовка историй</summary>{requests.length ? <ul className="profile-list">{requests.map(item => <li key={`${item.jobId}:${item.createdAt}`}><Link href={item.operation === "walk_research" ? "/?walk=create&resume=1" : `/create?job=${item.jobId}`}>{item.operation === "walk_research" ? "Исследование прогулки" : "История места"}</Link><small>{new Date(item.createdAt).toLocaleString("ru-RU")}</small></li>)}</ul> : <p className="ui-muted">Вы ещё не заказывали истории.</p>}{more("requests")}</details></section></div>
      <section className="profile-section profile-settings"><h2>Настройки аккаунта</h2><div className="ui-row"><button className="ui-button quiet" onClick={() => setConfirmAction("logout")}>Выйти</button><button className="ui-button quiet" onClick={() => setConfirmAction("all")}>Выйти на всех устройствах</button><button className="profile-link profile-danger" onClick={() => setConfirmAction("delete")}>Удалить аккаунт</button></div>
      {confirmAction && <form className="profile-confirm" onSubmit={confirm}><h3>{confirmAction === "delete" ? "Удалить аккаунт навсегда?" : "Подтвердите выход"}</h3><p>{confirmAction === "delete" ? "Прогулки в аккаунте и избранное будут удалены без возможности восстановления. Локальные черновики останутся." : "Приватные материалы для прослушивания без сети будут удалены с этого устройства. Прогулки в аккаунте сохранятся."}</p>{confirmAction === "delete" && <label className="ui-field">Текущий пароль<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required maxLength={128} /></label>}<div className="ui-row"><button className="ui-button danger" disabled={busy !== null}>{confirmAction === "delete" ? "Удалить навсегда" : "Подтвердить выход"}</button><button type="button" className="ui-button secondary" disabled={busy !== null} onClick={() => { setConfirmAction(null); setPassword(""); }}>Отмена</button></div></form>}
      </section>
    </>}
  </main>;
}

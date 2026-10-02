"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ExploreMap, type MapFocus } from "../explore/explore-map";
import { ExploreIcon } from "../explore/icons";
import { BrandMark } from "../brand/brand-mark";
import type { Coordinates, Route } from "./types";
import type { WalkChapter } from "./walk-plan";
import { StopWalkDialog } from "./stop-walk-dialog";
import "./walk-session.css";

const noop = () => {};

export function WalkSession({ route, chapters, index, active, completed, user, positionFailed, resume,
  titleRef, startRef, onStart, onSelect, onStop, player, story, settings, audioError, ratingLabel = "", hasReview = false, ratingCount = null, reviews = null, onRate = noop }: {
  route: Route; chapters: WalkChapter[]; index: number; active: boolean; completed: boolean;
  user: (Coordinates & { accuracyM: number }) | null; positionFailed: boolean; resume: boolean;
  titleRef: RefObject<HTMLHeadingElement | null>; startRef: RefObject<HTMLButtonElement | null>;
  onStart: () => void; onSelect: (index: number) => void; onStop: (completed?: boolean) => void;
  player: ReactNode; story: ReactNode; settings: ReactNode; audioError: string;
  /** «★ 4,6 · 12 оценок» for the reading-phase meta line; empty hides it. */
  ratingLabel?: string;
  /** The viewer already has a review of this walk, so the finish screen offers to edit it. */
  hasReview?: boolean;
  /** Published ratings; 0 turns «Отзывы» into a direct «Оставить отзыв», null while unknown. */
  ratingCount?: number | null;
  /** The published reviews list; null for walks that cannot be reviewed. */
  reviews?: ReactNode | null;
  /** Opens the rating form in its own window. */
  onRate?: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  // The panel covers the bottom of the map or, on a low landscape screen, a column on the right.
  // The header covers the top of the map; its bottom edge is measured from the top of the screen.
  const [cover, setCover] = useState<{ side: "bottom" | "right"; size: number; top: number }>({ side: "bottom", size: 250, top: 74 });
  // A walk opens on its first stop; a walk without stops shows the whole route.
  const [focus, setFocus] = useState<MapFocus | null>(() => {
    const first = chapters[0];
    return first ? { ...(first.trigger_location ?? first.location) } : null;
  });
  const [drawer, setDrawer] = useState<"stops" | "story" | "settings" | "reviews" | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const chapter = chapters[index];
  const geometry = useMemo(() => (route.walk?.path.coordinates ?? []).map(([lon, lat]) => ({ lat, lon })), [route.walk?.path]);
  const items = useMemo(() => [
    ...(route.walk ? [{ id: "walk-start", title: `Старт: ${route.walk.start.address}`, location: route.walk.start.location, endpoint: true }] : []),
    ...chapters.map((item, i) => ({ id: item.id, title: `Остановка ${i + 1}: ${item.title}`, location: item.trigger_location ?? item.location, number: i + 1 })),
    ...(route.walk ? [{ id: "walk-finish", title: `Финиш: ${route.walk.finish.address}`, location: route.walk.finish.location, endpoint: true }] : []),
  ], [chapters, route.walk]);
  // Beside the panel the route also keeps clear of the map buttons above the navigation.
  // Below the header it leaves room for a stop pin, which rises about 48 px above its point.
  const padding = useMemo(() => cover.side === "right"
    ? { top: cover.top + 48, right: cover.size + 24, bottom: 160, left: 45 }
    : { top: cover.top + 48, right: 45, bottom: cover.size + 125, left: 45 }, [cover]);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => {
      const box = panel.getBoundingClientRect();
      // walk-session.css docks the panel to the right on a low landscape screen.
      const side = getComputedStyle(panel).getPropertyValue("--walk-panel-dock").trim() === "right" ? "right" : "bottom";
      const size = Math.ceil(side === "right" ? (panel.parentElement?.getBoundingClientRect().right ?? innerWidth) - box.left : box.height);
      const top = Math.ceil(headerRef.current?.getBoundingClientRect().bottom ?? 0);
      setCover(current => current.side === side && current.size === size && current.top === top ? current : { side, size, top });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    if (headerRef.current) observer.observe(headerRef.current);
    // Turning the phone may keep the panel's size while its dock changes.
    addEventListener("resize", measure);
    return () => { observer.disconnect(); removeEventListener("resize", measure); };
  }, []);
  function select(position: number) { setDrawer(null); onSelect(position); }
  function toggleReviews() { setDrawer(drawer === "reviews" ? null : "reviews"); }
  function rate() { setDrawer(null); onRate(); }
  const distance = (route.walk?.distance_m ?? 0) / 1000;
  const hasText = Boolean(chapter?.content.story.paragraphs.length);
  const canStart = geometry.length > 1;

  return <>
    <div className="walk-session-map">
      <ExploreMap items={items} selectedId={active ? chapter?.id : undefined} focus={focus} user={user}
        geometry={geometry} fitGeometry={!focus} insets={padding} legacyChrome onPoint={noop} onSelect={id => {
          const position = chapters.findIndex(item => item.id === id);
          if (position >= 0) { if (active) select(position); else setDrawer("stops"); }
        }} mapLabel="Карта прогулки: пешеходный маршрут и остановки" />
    </div>
    <header ref={headerRef} className="walk-session-header" data-region="header">
      <Link href="/" prefetch={false} className="walk-session-brand" aria-label="Отголосок, на главную" onClick={() => onStop()}><BrandMark /></Link>
      <Link className="walk-session-search" href="/?search=1" prefetch={false} aria-label="Найти адрес" onClick={() => onStop()}><ExploreIcon name="search" /></Link>
      <Link className="walk-session-back" href="/" prefetch={false} aria-label="Закрыть прогулку" onClick={() => onStop()}><ExploreIcon name="close" /></Link>
    </header>
    {active && user ? <button type="button" className="walk-session-locate" data-region="controls" aria-label="Моё местоположение" onClick={() => setFocus({ lat: user.lat, lon: user.lon, zoom: 16 })}><ExploreIcon name="locate" /></button> : null}
    <section ref={panelRef} className="walk-session-panel" data-region="sheet" aria-labelledby="walk-session-title">
      <header className="walk-session-heading">
        <div>
          <p className="walk-session-meta">{active ? chapter ? `Остановка ${index + 1} из ${chapters.length}` : "До финиша" : `${route.duration_min} мин · ${distance.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`}{!active && !completed && ratingLabel ? <> · {reviews
            ? <button type="button" className="walk-session-rating" aria-expanded={drawer === "reviews"} onClick={toggleReviews}>{ratingLabel}</button>
            : ratingLabel}</> : null}</p>
          <h1 id="walk-session-title" ref={titleRef} tabIndex={-1}>{completed ? "Прогулка завершена" : active ? chapter?.title ?? route.walk?.finish.address ?? "Прогулка" : route.title.trim() || "Ваш маршрут"}</h1>
        </div>
        {!completed ? <div className="walk-session-heading-actions">
          <button type="button" className="walk-session-icon" aria-label="Настройки прогулки" aria-expanded={drawer === "settings"} onClick={() => setDrawer(drawer === "settings" ? null : "settings")}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="15" cy="17" r="3" fill="currentColor"/></svg>
          </button>
          {active ? <button type="button" className="walk-session-icon" aria-label="Прервать прогулку" aria-haspopup="dialog" onClick={() => setConfirmStop(true)}><ExploreIcon name="close" /></button> : null}
        </div> : null}
      </header>
      {!active && !completed ? <p className="walk-session-address">{route.walk?.start.address} → {route.walk?.finish.address}</p> : null}
      {active && chapter && chapter.title !== chapter.place ? <p className="walk-session-address">{chapter.place}</p> : null}
      {active && !drawer ? player : null}
      {active && audioError ? <p className="walk-session-notice" role="status">{audioError}</p> : null}
      {active && positionFailed ? <p className="walk-session-notice" role="status">Геопозиция недоступна. Остановки можно переключать вручную.</p> : null}
      {active && chapter && !chapter.audio && !hasText ? <p className="walk-session-muted">Без истории</p> : null}
      {!completed ? <div className="walk-session-tools">
        {chapters.length > 0 ? <button type="button" aria-expanded={drawer === "stops"} onClick={() => setDrawer(drawer === "stops" ? null : "stops")}><ExploreIcon name="list" />Остановки · {chapters.length}</button> : null}
        {active && hasText ? <button type="button" aria-expanded={drawer === "story"} onClick={() => setDrawer(drawer === "story" ? null : "story")}>Читать историю</button> : null}
        {!active && reviews ? ratingCount === 0
          ? <button type="button" aria-haspopup="dialog" onClick={rate}>{hasReview ? "Изменить отзыв" : "Оставить отзыв"}</button>
          : <button type="button" aria-expanded={drawer === "reviews"} onClick={toggleReviews}>Отзывы</button> : null}
      </div> : null}
      {drawer && !completed ? <div className="walk-session-drawer" data-sheet-part="body" key={`${drawer}-${index}`}>
        {drawer === "stops" ? <ol className="walk-session-stops">{chapters.map((item, position) => <li key={item.id}>
          {active ? <button type="button" aria-current={position === index ? "step" : undefined} onClick={() => select(position)}><span>{position + 1}</span>{item.title}</button> : <p><span>{position + 1}</span>{item.title}</p>}
        </li>)}</ol> : drawer === "story" ? story : drawer === "reviews" ? reviews : <>
          {settings}
          {reviews ? <button type="button" className="walk-session-rate" aria-haspopup="dialog" onClick={rate}>Оценить прогулку</button> : null}
        </>}
      </div> : null}
      <footer className={`walk-session-actions${completed && reviews ? " walk-session-actions--finish" : ""}`} data-sheet-part="footer">
        {completed ? reviews ? <>
          <button type="button" className="walk-session-primary" aria-haspopup="dialog" onClick={onRate}>{hasReview ? "Изменить отзыв" : "Оставить отзыв"}</button>
          <Link className="walk-session-secondary" href="/">На карту</Link>
        </> : <Link className="walk-session-primary" href="/">На карту</Link> : active ? <>
          {index > 0 ? <button type="button" className="walk-session-previous" aria-label="Предыдущая остановка" onClick={() => select(index - 1)}><ExploreIcon name="arrow" /></button> : null}
          <button type="button" className="walk-session-primary" onClick={() => { setDrawer(null); if (index + 1 < chapters.length) select(index + 1); else onStop(true); }}>{index + 1 < chapters.length ? "Дальше" : "Завершить"}<ExploreIcon name="arrow" /></button>
        </> : <button type="button" ref={startRef} disabled={!canStart} className="walk-session-primary" onClick={() => { setDrawer(null); onStart(); }}>{resume ? "Продолжить прогулку" : "Начать прогулку"}<ExploreIcon name="arrow" /></button>}
      </footer>
      {!canStart ? <p role="alert" className="walk-session-notice">В этой прогулке ещё нет маршрута. Постройте его в редакторе из истории.</p> : null}
    </section>
    <StopWalkDialog open={active && confirmStop} onCancel={() => setConfirmStop(false)} onConfirm={() => { setConfirmStop(false); setDrawer(null); onStop(); }} />
  </>;
}

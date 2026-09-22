"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ExploreMap, type MapFocus } from "../explore/explore-map";
import { ExploreIcon } from "../explore/icons";
import type { Coordinates, Route } from "./types";
import type { WalkChapter } from "./walk-plan";
import "../explore/explore.css";
import "./walk-session.css";

const noop = () => {};

export function WalkSession({ route, chapters, index, active, completed, user, positionFailed, resume,
  titleRef, startRef, onStart, onSelect, onStop, player, story, settings, audioError }: {
  route: Route; chapters: WalkChapter[]; index: number; active: boolean; completed: boolean;
  user: (Coordinates & { accuracyM: number }) | null; positionFailed: boolean; resume: boolean;
  titleRef: RefObject<HTMLHeadingElement | null>; startRef: RefObject<HTMLButtonElement | null>;
  onStart: () => void; onSelect: (index: number) => void; onStop: (completed?: boolean) => void;
  player: ReactNode; story: ReactNode; settings: ReactNode; audioError: string;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [panelHeight, setPanelHeight] = useState(250);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [drawer, setDrawer] = useState<"stops" | "story" | "settings" | null>(null);
  const chapter = chapters[index];
  const geometry = useMemo(() => (route.walk?.path.coordinates ?? []).map(([lon, lat]) => ({ lat, lon })), [route.walk?.path]);
  const items = useMemo(() => [
    ...(route.walk ? [{ id: "walk-start", title: `Старт: ${route.walk.start.address}`, location: route.walk.start.location, compact: true }] : []),
    ...chapters.map((item, i) => ({ id: item.id, title: `Остановка ${i + 1}: ${item.title}`, location: item.location, number: i + 1 })),
    ...(route.walk ? [{ id: "walk-finish", title: `Финиш: ${route.walk.finish.address}`, location: route.walk.finish.location, compact: true }] : []),
  ], [chapters, route.walk]);
  const padding = useMemo(() => ({ top: 70, right: 45, bottom: panelHeight + 125, left: 45 }), [panelHeight]);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(() => setPanelHeight(Math.ceil(panel.getBoundingClientRect().height)));
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  function select(position: number) { setDrawer(null); onSelect(position); }
  const distance = (route.walk?.distance_m ?? 0) / 1000;
  const hasText = Boolean(chapter?.content.story.paragraphs.length);
  const canStart = geometry.length > 1;

  return <>
    <div className="walk-session-map">
      <ExploreMap items={items} selectedId={active ? chapter?.id : undefined} focus={focus} user={user}
        geometry={geometry} routePadding={padding} onPoint={noop} onSelect={id => {
          const position = chapters.findIndex(item => item.id === id);
          if (position >= 0) { if (active) select(position); else setDrawer("stops"); }
        }} mapLabel="Карта прогулки: пешеходный маршрут и остановки" />
    </div>
    <Link className="walk-session-back" href="/" aria-label="Закрыть прогулку" onClick={() => onStop()}><ExploreIcon name="close" /></Link>
    {active && user ? <button type="button" className="walk-session-locate" aria-label="Моё местоположение" onClick={() => setFocus({ lat: user.lat, lon: user.lon, zoom: 16 })}><ExploreIcon name="locate" /></button> : null}
    <section ref={panelRef} className="walk-session-panel" aria-labelledby="walk-session-title">
      <header className="walk-session-heading">
        <div>
          <p className="walk-session-meta">{active ? chapter ? `Остановка ${index + 1} из ${chapters.length}` : "До финиша" : `${route.duration_min} мин · ${distance.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`}</p>
          <h1 id="walk-session-title" ref={titleRef} tabIndex={-1}>{completed ? "Прогулка завершена" : active ? chapter?.title ?? route.walk?.finish.address ?? "Прогулка" : "Ваш маршрут"}</h1>
        </div>
        {!completed ? <button type="button" className="walk-session-icon" aria-label="Настройки прогулки" aria-expanded={drawer === "settings"} onClick={() => setDrawer(drawer === "settings" ? null : "settings")}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="15" cy="17" r="3" fill="currentColor"/></svg>
        </button> : null}
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
      </div> : null}
      {drawer && !completed ? <div className="walk-session-drawer" key={`${drawer}-${index}`}>
        {drawer === "stops" ? <ol className="walk-session-stops">{chapters.map((item, position) => <li key={item.id}>
          {active ? <button type="button" aria-current={position === index ? "step" : undefined} onClick={() => select(position)}><span>{position + 1}</span>{item.title}</button> : <p><span>{position + 1}</span>{item.title}</p>}
        </li>)}</ol> : drawer === "story" ? story : settings}
      </div> : null}
      <footer className="walk-session-actions">
        {completed ? <Link className="walk-session-primary" href="/">На карту</Link> : active ? <>
          {index > 0 ? <button type="button" className="walk-session-previous" aria-label="Предыдущая остановка" onClick={() => select(index - 1)}><ExploreIcon name="arrow" /></button> : null}
          <button type="button" className="walk-session-primary" onClick={() => { setDrawer(null); if (index + 1 < chapters.length) select(index + 1); else onStop(true); }}>{index + 1 < chapters.length ? "Дальше" : "Завершить"}<ExploreIcon name="arrow" /></button>
        </> : <button type="button" ref={startRef} disabled={!canStart} className="walk-session-primary" onClick={() => { setDrawer(null); onStart(); }}>{resume ? "Продолжить прогулку" : "Начать прогулку"}<ExploreIcon name="arrow" /></button>}
      </footer>
      {!canStart ? <p role="alert" className="walk-session-notice">В этой прогулке ещё нет маршрута. Постройте его в редакторе из истории.</p> : null}
    </section>
  </>;
}

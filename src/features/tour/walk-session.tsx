"use client";

import Link from "next/link";
import { FoodList, type FoodAdding } from "../food/food-list";
import { useWalkFood } from "../food/use-walk-food";
import { distanceToRoute, matchedRoutePoint, routeVertexDistances } from "../food/route-proximity";
import type { RouteFoodPlace } from "../food/food-walk-model";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { MapFitTarget, MapFocus } from "../explore/explore-map";
import { ExploreIcon } from "../explore/icons";
import { PlacePhotoBanner } from "../explore/place-photo";
import { usePlaceStory } from "../explore/place-story";
import { GeoHelp } from "../explore/around-sheets";
import { nativePlatform } from "@/lib/native/platform";
import { useHideNavigation } from "../navigation/navigation-visibility";
import { MapShell } from "../shell/map-shell";
import { MapControlButton } from "../shell/map-controls";
import { MapNotice } from "../shell/map-status-notice";
import type { Coordinates, Route } from "./types";
import { highlightedLeg, type StopStage, type WalkChapter } from "./walk-plan";
import { legFitPoints, legRange, routeLegCuts } from "./route-legs";
import type { AdvanceMode } from "./walk-settings";
import { StopWalkDialog } from "./stop-walk-dialog";
import type { OwnWalk } from "../walks/own-walk";
import { historicalWalkPhotos } from "./historical-photos";
import historicalStyles from "./historical-photos.module.css";
import "./walk-session.css";
import foodStyles from "./walk-food.module.css";
import type { WalkDirection } from "./walk-direction";
import type { AddFood } from "./tour-experience";
import { toUserMessage } from "@/lib/errors/user-message";

const noop = () => {};

/** The photo of the catalog place a stop tells about, as on its map card; nothing while it loads or without one. */
function StopPhoto({ placeId, stopId, title }: { placeId?: string; stopId: string; title: string }) {
  const place = usePlaceStory(placeId);
  const photos = historicalWalkPhotos(stopId);
  return <>
    {placeId ? <PlacePhotoBanner photo={place.story?.photo} title={title} /> : null}
    {photos.length ? <section className={historicalStyles.gallery} aria-labelledby={`${stopId}-historical-title`}>
      <h3 id={`${stopId}-historical-title`} className={historicalStyles.heading}>Исторические снимки</h3>
      <ul className={historicalStyles.list}>{photos.map(photo => <li key={photo.cid} className={historicalStyles.item}>
        <a className={historicalStyles.link} href={`https://pastvu.com/p/${photo.cid}`} target="_blank" rel="noopener noreferrer">
          <img className={historicalStyles.image} src={photo.src} alt={`${photo.title}, ${photo.year} год`} loading="lazy" />
          <span className={historicalStyles.caption}>{photo.year} · {photo.title}</span>
          <span className={historicalStyles.source}>Открыть на PastVu</span>
        </a>
      </li>)}</ul>
    </section> : null}
  </>;
}

/**
 * On the way to a stop: that the story will start by itself on arrival. Only for `place`:
 * in `manual` the «Слушать историю» button already says what to do. It takes the meta line above
 * the title, unlike a line of its own, which pushed the primary action out of a small panel.
 */
export function approachHint(advance: AdvanceMode, hasAudio: boolean) {
  return hasAudio && advance === "place" ? "Начнётся, когда подойдёте" : "";
}

export function WalkSession({ notice = "", route, chapters, index, stage = "stop", advance = "manual", active, completed, finishLeg = false, user, positionFailed, resume, resumeIndex = -1,
  titleRef, startRef, onStart, onSelect, onStop, player, story, settings, offline = null, audioError, ratingLabel = "", hasReview = false, ratingCount = null, reviews = null, onRate = noop, onImprove = null, own = null,
  positionDenied = false, onRetryPosition = noop, direction = "forward", foodMode: documentFoodMode, onDirectionChange, onAddFood = null }: {
  direction?: WalkDirection;
  foodMode?: "open" | "loop";
  onDirectionChange?: (direction: WalkDirection) => void;
  /** A message for the map notices, e.g. that the walk opened from its offline copy. */
  notice?: string;
  route: Route; chapters: WalkChapter[]; index: number; active: boolean; completed: boolean;
  /** The finish lies past the last stop: index `chapters.length` is the way there, ended by «Завершить». */
  finishLeg?: boolean;
  /** On the way to stop `index` or arrived there (see StopStage). */
  stage?: StopStage;
  advance?: AdvanceMode;
  user: (Coordinates & { accuracyM: number }) | null; positionFailed: boolean; resume: boolean;
  /** The stop the saved walk stopped at, marked in «Остановки» before «Продолжить прогулку»; -1 when unknown. */
  resumeIndex?: number;
  titleRef: RefObject<HTMLHeadingElement | null>; startRef: RefObject<HTMLButtonElement | null>;
  /** Starts the walk: from the saved place, or from stop `index` when the walker picked one in «Остановки». */
  onStart: (index?: number) => void; onSelect: (index: number) => void; onStop: (completed?: boolean) => void;
  player: ReactNode; story: ReactNode; audioError: string;
  /** Playback settings, shown only during the walk: before the start they are noise on the card. */
  settings: ReactNode;
  /** The offline copy controls before the start, under the route in «Остановки»: the copy is saved before going out. */
  offline?: ReactNode;
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
  /** Opens «Что улучшить?»; null for walks the server cannot take requests for. */
  onImprove?: (() => void) | null;
  /** The viewer's own walk: before the start it leads back to the builder and shows the builder's notes. */
  own?: OwnWalk | null;
  /** The site has no access to geolocation: asking again will not show a prompt, the walker allows it in the browser. */
  positionDenied?: boolean;
  /** Asks the browser for the position again; called from a tap, so it may show the permission prompt. */
  onRetryPosition?: () => void;
  /** Adds a venue from «Поесть рядом» as a stop; null where the walk cannot take one. */
  onAddFood?: AddFood | null;
}) {
  // A running walk takes the whole screen: the bottom navigation goes and MapShell lowers the card to the edge.
  // The header still leads out of the walk, and the navigation returns once the walk is stopped or finished.
  useHideNavigation(active);
  // A walk opens on its first stop; a walk without stops shows the whole route.
  const [focus, setFocus] = useState<MapFocus | null>(() => {
    const first = chapters[0];
    return first ? { ...(first.trigger_location ?? first.location) } : null;
  });
  const [drawer, setDrawer] = useState<"stops" | "story" | "settings" | "reviews" | "position" | "food" | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [focusedDirection, setFocusedDirection] = useState(direction);
  if (focusedDirection !== direction) {
    setFocusedDirection(direction);
    const first = chapters[0];
    setFocus(first ? { ...(first.trigger_location ?? first.location) } : route.walk?.start.location ?? null);
  }
  const chapter = chapters[index];
  const geometry = useMemo(() => (route.walk?.path.coordinates ?? []).map(([lon, lat]) => ({ lat, lon })), [route.walk?.path]);
  const foodVisible = drawer === "food" && !completed;
  const foodMode = documentFoodMode ?? (route.walk && route.walk.start.location.lat === route.walk.finish.location.lat && route.walk.start.location.lon === route.walk.finish.location.lon ? "loop" : "open");
  const food = useWalkFood(geometry, foodMode, foodVisible);
  if (food.unavailable && drawer === "food") setDrawer(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const [selectedFood, setSelectedFood] = useState<RouteFoodPlace | null>(null);
  // One venue at a time: each one reroutes the walk the next one is matched against.
  const [foodPending, setFoodPending] = useState<string | null>(null);
  const [foodStatus, setFoodStatus] = useState("");
  const addController = useRef<AbortController | null>(null);
  useEffect(() => () => addController.current?.abort(), []);
  const foodButton = geometry.length > 1 && food.manifest && !food.unavailable ? <button type="button" className={foodStyles.button} aria-label="Поесть рядом" aria-expanded={foodVisible} onClick={() => { setSelectedFood(null); setFoodStatus(""); setDrawer(foodVisible ? null : "food"); }}><ExploreIcon name="cup" /></button> : null;
  const [foodFit, setFoodFit] = useState<MapFitTarget | null>(null);
  useLayoutEffect(() => { if (drawer === "food" && drawerRef.current) drawerRef.current.scrollTop = 0; }, [drawer, selectedFood?.id]);
  const foodManifestError = geometry.length > 1 && food.error && !food.manifest && !food.unavailable;
  const vertexDistances = useMemo(() => routeVertexDistances(geometry), [geometry]);
  const items = useMemo(() => [
    ...(route.walk ? [{ id: "walk-start", title: `Старт: ${route.walk.start.address}`, location: route.walk.start.location, endpoint: true }] : []),
    ...chapters.map((item, i) => ({ id: item.id, title: `Остановка ${i + 1}: ${item.title}`, location: item.trigger_location ?? item.location, number: i + 1 })),
    ...(route.walk ? [{ id: "walk-finish", title: `Финиш: ${route.walk.finish.address}`, location: route.walk.finish.location, endpoint: true }] : []),
  ], [chapters, route.walk]);
  // A venue that joined the walk is drawn once, as its stop.
  const mapItems = useMemo(() => foodVisible && !food.unavailable ? [...items, ...food.places
    .filter(p => !chapters.some(item => item.location.lat === p.lat && item.location.lon === p.lon))
    .map(p => ({ id: p.id, title: p.name, location: { lat: p.lat, lon: p.lon }, foodKind: p.kind }))] : items, [items, chapters, foodVisible, food.places, food.unavailable]);
  async function addFood(place: RouteFoodPlace) {
    if (!onAddFood || addController.current) return;
    const controller = new AbortController();
    addController.current = controller;
    setFoodPending(place.id);
    setFoodStatus("");
    try {
      const notice = await onAddFood(place, controller.signal);
      if (!controller.signal.aborted) setFoodStatus([`«${place.name}» добавлено в прогулку.`, notice].filter(Boolean).join(" "));
    } catch (caught) {
      if (!controller.signal.aborted) setFoodStatus(toUserMessage(caught, "Не удалось добавить заведение в прогулку."));
    } finally {
      if (addController.current === controller) { addController.current = null; setFoodPending(null); }
    }
  }
  const foodAdding: FoodAdding | null = onAddFood && !completed ? {
    isAdded: place => chapters.some(item => item.location.lat === place.lat && item.location.lon === place.lon),
    onAdd: place => void addFood(place), pending: foodPending, status: foodStatus,
  } : null;
  function openFood(place: RouteFoodPlace) {
    setSelectedFood(place);
    setDrawer("food");
    const nearest = matchedRoutePoint(place, geometry, vertexDistances);
    setFoodFit({ points: [{ lat: place.lat, lon: place.lon }, ...(nearest ? [nearest] : [])], keepUserView: false });
  }
  // During the walk the leg to walk now stands out; the map fits it whenever it changes.
  const stops = useMemo(() => chapters.map(item => item.trigger_location ?? item.location), [chapters]);
  const foodStops = useMemo(() => stops.map(stop => distanceToRoute(stop, geometry, { mode: foodMode })), [stops, geometry, foodMode]);
  const cuts = useMemo(() => routeLegCuts(geometry, stops), [geometry, stops]);
  const leg = highlightedLeg(index, stage, chapters.length);
  const foodFromM = vertexDistances[leg === 0 ? 0 : cuts[leg - 1] ?? 0] ?? 0;
  const legPath = active ? legRange(cuts, geometry.length, leg) : null;
  const legEnd = stops[leg] ?? route.walk?.finish.location ?? null;
  const legKey = active && legEnd ? `${leg}:${legPath?.join("-") ?? "point"}` : null;
  // Adjusted while rendering when the leg changes (not in an effect), so the fit lands with the highlight.
  // The walker's position joins the fit when it is known; the first fix after a fit without it
  // refines that fit once per walk, unless the walker has moved the map in the meantime.
  const [legFit, setLegFit] = useState<{ key: string | null; target: MapFitTarget | null; waiting: boolean; refined: boolean }>({ key: null, target: null, waiting: false, refined: false });
  if (legFit.key !== legKey) {
    const view = legKey && legEnd ? legFitPoints(geometry, legPath, legEnd, user) : null;
    setLegFit({ key: legKey, target: view ? { points: view.points, keepUserView: false } : null, waiting: Boolean(view && !view.withUser), refined: legKey ? legFit.refined : false });
  } else if (legFit.waiting && user && legEnd) {
    const view = legFitPoints(geometry, legPath, legEnd, user);
    setLegFit({ ...legFit, waiting: false, refined: true,
      target: view.withUser && !legFit.refined ? { points: view.points, keepUserView: true } : legFit.target });
  }
  // The position help closes by itself once a fix arrives after a retry.
  if (drawer === "position" && (user || !active)) setDrawer(null);
  function retryPosition() { setDrawer("position"); onRetryPosition(); }
  function select(position: number) { setDrawer(null); onSelect(position); }
  function startAt(position?: number) { setDrawer(null); onStart(position); }
  function toggleReviews() { setDrawer(drawer === "reviews" ? null : "reviews"); }
  function rate() { setDrawer(null); onRate(); }
  function improve() { setDrawer(null); onImprove?.(); }
  const distance = (route.walk?.distance_m ?? 0) / 1000;
  const hasText = Boolean(chapter?.content.story.paragraphs.length);
  const canStart = geometry.length > 1;
  // After the last stop comes the way to the finish, when it lies elsewhere.
  const next = index + 1 < chapters.length || (finishLeg && index + 1 === chapters.length);
  const meta = !active ? `${route.duration_min} мин · ${distance.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`
    : !chapter ? "До финиша" : stage === "approach" ? approachHint(advance, Boolean(chapter.audio)) : "";

  const panel = <section className={`walk-session-panel ${foodStyles.panel}`} data-region="sheet" aria-labelledby="walk-session-title">
      {/* Like the player, the photo yields its room to an open drawer. */}
      {active && chapter && !drawer ? <div className="walk-session-photo"><StopPhoto key={chapter.id} placeId={chapter.place_id} stopId={chapter.id} title={chapter.title} /></div> : null}
      <div className={`${foodStyles.body}${foodVisible || foodManifestError ? ` ${foodStyles.bodyScrollable}` : ""}`}>
      <header className="walk-session-heading">
        <div>
          {/* During the walk the stop number lives on the «Остановки» button; this line is left for the hint and the finish. */}
          {meta ? <p className="walk-session-meta">{meta}{!active && !completed && ratingLabel ? <> · {reviews
            ? <button type="button" className="walk-session-rating" aria-expanded={drawer === "reviews"} onClick={toggleReviews}>{ratingLabel}</button>
            : ratingLabel}</> : null}</p> : null}
          <h1 id="walk-session-title" ref={titleRef} tabIndex={-1}>{completed ? "Прогулка завершена" : active ? chapter?.title ?? route.walk?.finish.address ?? "Прогулка" : route.title.trim() || "Ваш маршрут"}</h1>
        </div>
        {!completed ? <div className="walk-session-heading-actions">
          {/* The cross belongs to the card: during the walk it interrupts it after a confirmation, before the start it leaves for the map. */}
          {active ? <button type="button" className="walk-session-icon" aria-label="Прервать прогулку" aria-haspopup="dialog" onClick={() => setConfirmStop(true)}><ExploreIcon name="close" /></button>
            : <Link className="walk-session-icon" href="/" prefetch={false} aria-label="Закрыть прогулку" onClick={() => onStop()}><ExploreIcon name="close" /></Link>}
        </div> : null}
      </header>
      {!active && !completed && !foodVisible ? own?.notes.map(note => <p key={note} className="walk-session-muted">{note}</p>) : null}
      {active && !drawer ? player : null}
      {active && audioError ? <p className="walk-session-notice" role="status">{audioError}</p> : null}
      {active && chapter && !chapter.audio && !hasText ? <p className="walk-session-muted">Без истории</p> : null}
      {!completed && !foodVisible ? <div className="walk-session-tools">
        {chapters.length > 0 ? <button type="button" aria-expanded={drawer === "stops"} onClick={() => setDrawer(drawer === "stops" ? null : "stops")}><ExploreIcon name="list" />{active && chapter ? `Остановка ${index + 1} из ${chapters.length}` : `Остановки · ${chapters.length}`}</button> : null}
        {active && (positionFailed || drawer === "position") ? <button type="button" className="walk-session-position" aria-expanded={drawer === "position"} onClick={retryPosition}><ExploreIcon name="locate" />Геопозиции нет</button> : null}
        {!active && canStart && onDirectionChange ? <button type="button" aria-label="Пройти прогулку с конца" aria-pressed={direction === "reverse"} onClick={() => { setDrawer(null); onDirectionChange(direction === "forward" ? "reverse" : "forward"); }}>{direction === "reverse" ? "Направление: с конца" : "Направление: с начала"}</button> : null}
        {active && hasText ? <button type="button" aria-expanded={drawer === "story"} onClick={() => setDrawer(drawer === "story" ? null : "story")}>Читать историю</button> : null}
        {/* Settings sit with the walk's other tools: in the heading a second button left a gap under a one-line title. */}
        {active ? <button type="button" aria-label="Настройки прогулки" aria-expanded={drawer === "settings"} onClick={() => setDrawer(drawer === "settings" ? null : "settings")}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="15" cy="17" r="3" fill="currentColor"/></svg>Настройки
        </button> : null}
        {!active && reviews ? ratingCount === 0
          ? <button type="button" aria-haspopup="dialog" onClick={rate}>{hasReview ? "Изменить отзыв" : "Оставить отзыв"}</button>
          : <button type="button" aria-expanded={drawer === "reviews"} onClick={toggleReviews}>Отзывы</button> : null}
      </div> : null}
      {drawer && !completed ? <div ref={drawerRef} className={`walk-session-drawer ${foodStyles.drawer}`} data-sheet-part="body" key={`${drawer}-${index}`}>
        {drawer === "food" && food.manifest ? <FoodList places={food.places} stops={foodStops} active={active} fromM={foodFromM}
          selected={selectedFood && food.places.find(p => p.id === selectedFood.id) || null} onSelect={openFood} onBack={() => setSelectedFood(null)}
          hours={food.hours} manifest={food.manifest} error={food.error} loading={food.loading} onRetry={food.retry} adding={foodAdding} /> : drawer === "stops" ? <>
          {/* Before the start the addresses live here, not on the card: the card keeps only the title and the action.
              During the walk the list is for jumping between stops, and on a small screen the lines would crowd the map.
              A walk already begun continues from any stop: the walker may have gone ahead or come back another day. */}
          {!active && route.walk ? <p className="walk-session-endpoint">{route.walk.start.address === route.walk.finish.address ? "Старт и финиш" : "Старт"}: {route.walk.start.address}</p> : null}
          <ol className="walk-session-stops">{chapters.map((item, position) => <li key={item.id}>
            {active ? <button type="button" aria-current={position === index ? "step" : undefined} onClick={() => select(position)}><span>{position + 1}</span>{item.title}</button>
              : resume && canStart ? <button type="button" aria-current={position === resumeIndex ? "step" : undefined} onClick={() => startAt(position)}><span>{position + 1}</span>{item.title}</button> : <p><span>{position + 1}</span>{item.title}</p>}
          </li>)}</ol>
          {!active && route.walk && route.walk.start.address !== route.walk.finish.address ? <p className="walk-session-endpoint">Финиш: {route.walk.finish.address}</p> : null}
          {!active ? offline : null}
        </> : drawer === "position" ? <div role="status">
          <p className="walk-session-muted">{!positionFailed ? "Определяем положение…" : positionDenied ? (nativePlatform() ? "Приложению запрещён доступ к геопозиции. Разрешите его в настройках телефона — до тех пор остановки переключаются вручную." : "Сайту запрещён доступ к геопозиции. Разрешите его в браузере — до тех пор остановки переключаются вручную.") : "Не удалось определить положение. Проверьте, включена ли геолокация на устройстве, — до тех пор остановки переключаются вручную."}</p>
          {positionFailed ? <GeoHelp open={positionDenied} onRetry={onRetryPosition} /> : null}
        </div> : drawer === "story" ? <>
          {/* The address belongs to the story: on the card it only pushes the player and the map down. */}
          {chapter && chapter.title !== chapter.place ? <p className="walk-session-address">{chapter.place}</p> : null}
          {story}
        </> : drawer === "reviews" ? reviews : <>
          {settings}
          {reviews ? <button type="button" className="walk-session-rate" aria-haspopup="dialog" onClick={rate}>Оценить прогулку</button> : null}
          {onImprove ? <button type="button" className="walk-session-rate" aria-haspopup="dialog" onClick={improve}>Что улучшить в прогулке?</button> : null}
        </>}
      </div> : null}
      {completed && onImprove ? <button type="button" className="walk-session-rate" aria-haspopup="dialog" onClick={improve}>Что улучшить в прогулке?</button> : null}
      {foodManifestError ? <p role="status" className="walk-session-notice">Не удалось загрузить заведения <button type="button" className={foodStyles.retry} onClick={food.retry}>Повторить</button></p> : null}
      </div>
      <footer className={`${foodStyles.actions} walk-session-actions${completed && reviews ? " walk-session-actions--finish" : ""}`} data-sheet-part="footer">
        {completed ? reviews ? <>
          <button type="button" className="walk-session-primary" aria-haspopup="dialog" onClick={onRate}>{hasReview ? "Изменить отзыв" : "Оставить отзыв"}</button>
          <Link className="walk-session-secondary" href="/">На карту</Link>
        </> : <Link className="walk-session-primary" href="/">На карту</Link> : active ? <>
          {index > 0 ? <button type="button" className="walk-session-previous" aria-label="Предыдущая остановка" onClick={() => select(index - 1)}><ExploreIcon name="arrow" /></button> : null}
          {foodButton}
          <button type="button" className="walk-session-primary" onClick={() => { setDrawer(null); if (next) select(index + 1); else onStop(true); }}>{index + 1 < chapters.length ? "Дальше" : next ? "К финишу" : "Завершить"}<ExploreIcon name="arrow" /></button>
        </> : <>
          {/* The way back to the builder sits where «Назад» sits during the walk: before the start the walk is still being made. */}
          {own ? <Link className="walk-session-previous" href={own.editHref} prefetch={false} aria-label="Изменить маршрут"><ExploreIcon name="arrow" /></Link> : null}
          {foodButton}
          <button type="button" ref={startRef} disabled={!canStart} className="walk-session-primary" onClick={() => startAt()}>{resume ? "Продолжить прогулку" : "Начать прогулку"}<ExploreIcon name="arrow" /></button>
        </>}
      </footer>
      {!canStart ? <p role="alert" className="walk-session-notice">В этой прогулке ещё нет маршрута. Постройте его в редакторе из истории.</p> : null}
    </section>;

  return <>
    <MapShell navigation={!active} onBrand={() => onStop()}
      map={{ items: mapItems, selectedId: foodVisible && selectedFood ? selectedFood.id : active ? chapter?.id : undefined, focus, user, geometry, fitGeometry: !focus, tunnels: route.walk?.path.tunnels,
        activeLeg: legPath, fitTarget: foodVisible && selectedFood ? foodFit : legFit.target, onPoint: noop, mapLabel: "Карта прогулки: пешеходный маршрут и остановки",
        onSelect: id => {
          const place = foodVisible ? food.places.find(p => p.id === id) : null;
          if (place) { openFood(place); return; }
          const position = chapters.findIndex(item => item.id === id);
          if (position >= 0) { if (active) select(position); else setDrawer("stops"); }
        } }}
      controls={active && user ? <MapControlButton aria-label="Моё местоположение" onClick={() => setFocus({ lat: user.lat, lon: user.lon, zoom: 16 })}><ExploreIcon name="locate" /></MapControlButton> : null}
      notices={notice ? <MapNotice>{notice}</MapNotice> : null}
      sheet={panel} />
    <StopWalkDialog open={active && confirmStop} onCancel={() => setConfirmStop(false)} onConfirm={() => { setConfirmStop(false); setDrawer(null); onStop(); }} />
  </>;
}

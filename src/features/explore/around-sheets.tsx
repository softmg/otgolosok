"use client";

import Link from "next/link";
import type { ReactNode, Ref } from "react";
import { Sheet } from "../shell/sheet";
import { ExploreIcon } from "./icons";
import { nearbyRadii, type NearbyRadius, type NearbyRecommendation } from "./nearby-stories";
import { PlacePhotoHeading } from "./place-photo";
import type { StoryPin } from "./story-pin";
import a from "./around.module.css";
import styles from "./around-sheets.module.css";

type GeoState = "idle" | "loading" | "ready" | "error" | "denied";

/** Asks for geolocation once: the one action is in the footer, closing it is remembered by the screen. */
export function LocationPromptSheet({ geo, onLocate, onDismiss }: { geo: GeoState; onLocate: () => void; onDismiss: () => void }) {
  return <Sheet name="location" labelledBy="location-title"
    header={<div className={a.headerRow}>
      <h2 id="location-title" className={a.title}>Смотрите истории рядом с вами</h2>
      <button type="button" className={a.iconButton} aria-label="Закрыть карточку" onClick={onDismiss}><ExploreIcon name="close" /></button>
    </div>}
    footer={<button type="button" className={a.primary} onClick={onLocate} disabled={geo === "loading"}>
      {geo === "loading" ? "Определяем положение…" : geo === "denied" || geo === "error" ? "Проверить снова" : "Включить геолокацию"}<ExploreIcon name="locate" />
    </button>} />;
}

/** A selected story: its label and close stay put, the text scrolls, the main action is always visible. */
export function StorySheet({ story, metadata, walkHref, startRef, onStart, onClose, onWalk }: {
  story: StoryPin; metadata: string; walkHref: string | null; startRef?: Ref<HTMLButtonElement>;
  onStart: (chapter?: number) => void; onClose: () => void; onWalk: () => void;
}) {
  const action = story.chapter !== undefined
    ? <button type="button" className={a.primary} ref={startRef} onClick={() => onStart(story.chapter)}>Слушать эту часть <ExploreIcon name="headphones" /></button>
    : story.jobId
      ? <Link className={a.primary} href={`/create?job=${story.jobId}`} prefetch={false}>{story.duration ? "Открыть и слушать" : "Открыть подготовку"}<ExploreIcon name={story.duration ? "headphones" : "arrow"} /></Link>
      : null;
  return <Sheet name="story" labelledBy="selected-place-title" bodyLabel={story.paragraphs?.length ? "Текст истории" : undefined}
    header={<div className={a.headerRow}>
      <span className={a.label}>{story.pending ? "Готовим для вас" : story.chapter !== undefined ? `По дороге · часть ${story.chapter + 1}` : "История места"}</span>
      <button type="button" className={a.iconButton} aria-label="Закрыть карточку" onClick={onClose}><ExploreIcon name="close" /></button>
    </div>}
    // The player stays with the action: scrolling the text never takes it away.
    footer={story.audioUrl || action ? <>{story.audioUrl ? <audio className={styles.audio} controls preload="metadata" src={story.audioUrl}>Ваш браузер не поддерживает аудио.</audio> : null}{action}</> : null}>
    <>
      <PlacePhotoHeading key={story.id} placeId={story.placeId} title={story.title} address={story.address}
        titleClassName={a.title} addressClassName={styles.address} />
      <small className={a.meta}>{metadata}</small>
      {story.paragraphs?.length ? <div className={styles.story}>{story.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div> : null}
      {story.attribution ? <p className={styles.source}>Источник: <a href={story.attribution.url} target="_blank" rel="noopener noreferrer">{story.attribution.label}</a></p> : null}
      {!action && story.placeId && !story.paragraphs?.length ? <p className={a.text}>Проверенный текст доступен в карточке места{story.audioUrl ? "; запись можно слушать здесь." : "; озвучивание ещё не готово."}</p> : null}
      {walkHref ? <WalkFromHere href={walkHref} onClick={onWalk} /> : null}
    </>
  </Sheet>;
}

/** A point the user tapped or searched: offer to prepare its story or to start a walk from it. */
export function PlaceSheet({ address, busy, error, createHref, walkHref, onClose, onWalk }: {
  address: string | null; busy: boolean; error: string; createHref: string; walkHref: string | null; onClose: () => void; onWalk: () => void;
}) {
  const note = error ? <p className={a.text} role="status">{error}</p>
    : busy ? <p className={a.text} role="status">Смотрим, какой дом находится рядом с выбранной точкой.</p>
    : !address ? <p className={a.text}>У этой точки нет точного номера дома. Введите адрес, чтобы мы искали историю нужного здания.</p>
    : null;
  return <Sheet name="place" labelledBy="new-place-title"
    header={<div className={a.headerRow}>
      <h2 id="new-place-title" className={a.title}>{busy ? "Определяем адрес…" : address ?? "О чём расскажет этот дом?"}</h2>
      <button type="button" className={a.iconButton} aria-label="Закрыть выбранное место" onClick={onClose}><ExploreIcon name="close" /></button>
    </div>}
    // Both actions stay in the footer: the card has no text to scroll past them.
    footer={busy ? null : <>
      <Link className={a.primary} href={createHref} prefetch={false}>{address ? "Подготовить историю этого дома" : "Ввести адрес вручную"}<ExploreIcon name="plus" /></Link>
      {walkHref ? <WalkFromHere href={walkHref} onClick={onWalk} footer /> : null}
    </>}>
    {note}
  </Sheet>;
}

/** Ready stories around a point, nearest first, with the radius to search in. */
export function NearbySheet({ status = "ready", radius, recommendations, onRadius, onSelect, onReset }: {
  status?: "loading" | "ready" | "error";
  radius: NearbyRadius; recommendations: NearbyRecommendation[];
  onRadius: (radius: NearbyRadius) => void; onSelect: (id: string) => void; onReset: () => void;
}) {
  const wider = nearbyRadii[nearbyRadii.indexOf(radius) + 1];
  return <Sheet name="nearby" labelledBy="nearby-title"
    header={<div>
      <span className={a.label}>Готовые истории рядом</span>
      <h2 id="nearby-title" className={a.title}>В радиусе {radius} м</h2>
    </div>}>
    <div className={styles.radius} role="group" aria-label="Радиус поиска">
      {nearbyRadii.map(value => <button key={value} type="button" aria-pressed={radius === value} onClick={() => onRadius(value)}>{value} м</button>)}
    </div>
    {status!=="ready"?<p role="status">{status==="loading"?"Ищем истории рядом…":"Не удалось загрузить все истории рядом. Повторите загрузку мест."}</p>:null}
    {recommendations.length ? <ol className={styles.list}>{recommendations.map((story, index) => <li key={story.id}>
      <div>
        <strong>{story.title}</strong>
        <span>{story.address} · {Math.round(story.distanceM)} м по прямой</span>
        {index === 0 ? <small>{story.reason}</small> : null}
      </div>
      <button type="button" className={index === 0 ? a.primary : a.secondary} onClick={() => onSelect(story.id)}>{index === 0 ? "Слушать" : "Альтернатива"}<ExploreIcon name={index === 0 ? "headphones" : "arrow"} /></button>
    </li>)}</ol> : status==="ready"?<>
      <p className={a.text}>В этом радиусе пока нет готовой проверенной истории.</p>
      {wider ? <button type="button" className={a.secondary} onClick={() => onRadius(wider)}>Искать в большем радиусе <ExploreIcon name="arrow" /></button>
        : <button type="button" className={a.secondary} onClick={onReset}>Выбрать другую точку <ExploreIcon name="map" /></button>}
    </>:null}
  </Sheet>;
}

function WalkFromHere({ href, onClick, footer = false }: { href: string; onClick: () => void; footer?: boolean }) {
  return <Link className={footer ? a.secondary : `${a.secondary} ${a.bodyAction}`} href={href} onClick={onClick} prefetch={false}>Создать прогулку отсюда <ExploreIcon name="walk" /></Link>;
}

/** The first-visit hint in the notices slot. */
export function MapHintNotice({ onClose }: { onClose: () => void }) {
  return <div className={a.notice}>
    <p><strong>Какой дом вам интересен?</strong>Нажмите на карту — найдём его историю.</p>
    <button className={a.iconButton} type="button" aria-label="Закрыть подсказку" onClick={onClose}><ExploreIcon name="close" /></button>
  </div>;
}

/** Result of locating the user; when access is denied it explains how to allow it. */
export function GeoNotice({ message, outside, denied, onMoscow, onRetry, onClose }: {
  message: string; outside: boolean; denied: boolean; onMoscow: () => void; onRetry: () => void; onClose: () => void;
}) {
  return <div className={a.notice}>
    <div>
      <p role="status">{message}{outside ? <> Пока доступны истории <span className={styles.nowrap}><button type="button" className={styles.inlineButton} onClick={onMoscow}>Москвы</button>.</span></> : null}</p>
      {denied ? <GeoHelp onRetry={onRetry} /> : null}
    </div>
    <button className={`${a.iconButton} ${styles.top}`} type="button" aria-label="Скрыть сообщение" onClick={onClose}><ExploreIcon name="close" /></button>
  </div>;
}

function GeoHelp({ onRetry }: { onRetry: () => void }): ReactNode {
  return <details className={styles.help}>
    <summary>Как разрешить геолокацию</summary>
    <p><strong>На iPhone и iPad</strong></p>
    <ol>
      <li>В Safari нажмите значок меню страницы слева от адреса, затем «Ещё» (…) → «Настройки сайта» → «Геопозиция» → «Разрешить».</li>
      <li>Если доступ всё ещё закрыт, откройте «Настройки» телефона → «Конфиденциальность и безопасность» → «Службы геолокации». Включите их и разрешите доступ для «Веб-сайты Safari» или вашего браузера при использовании.</li>
      <li>Вернитесь на сайт и повторите попытку.</li>
    </ol>
    <p>Если открыли сайт с экрана «Домой», проверьте его разрешение в «Службах геолокации». Если его нет в списке, откройте сайт в Safari.</p>
    <p>В другом браузере откройте настройки разрешений этого сайта и разрешите доступ к местоположению. Также проверьте геолокацию на устройстве.</p>
    <a href="https://support.apple.com/ru-ru/102515" target="_blank" rel="noopener noreferrer">Инструкция Apple ↗</a>
    <button className={styles.inlineButton} type="button" onClick={onRetry}>Проверить снова</button>
  </details>;
}

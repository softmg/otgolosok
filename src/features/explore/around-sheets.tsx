"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode, Ref } from "react";
import { Sheet } from "../shell/sheet";
import { SheetHandle } from "../shell/sheet-handle";
import { cx } from "../ui/cx";
import { ExploreIcon } from "./icons";
import { nearbyRadii, type NearbyRadius, type NearbyRecommendation } from "./nearby-stories";
import { StoryAudioPlayer } from "../tour/story-audio-player";
import { PlacePhotoBanner } from "./place-photo";
import { usePlaceStory } from "./place-story";
import { isExpandableStory, type StoryPin } from "./story-pin";
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

/**
 * A selected story. A catalog place or a story with text is expandable: collapsed it is a peek (photo, title, a
 * teaser, the player and the action) that never scrolls; expanded it is the whole story, read as a page. Other
 * stories (walk parts, stories being prepared) keep the plain card: label and close stay put, the text scrolls.
 * In both states the footer is the same element, so the player keeps playing.
 */
export function StorySheet({ story, walkHref, startRef, onStart, onClose, onWalk, retrying = false, retryError = "", onRetry, expanded = false, onExpand, onCollapse }: {
  story: StoryPin; walkHref: string | null; startRef?: Ref<HTMLButtonElement>;
  onStart: (chapter?: number) => void; onClose: () => void; onWalk: () => void;
  retrying?: boolean; retryError?: string; onRetry?: () => void;
  expanded?: boolean; onExpand?: () => void; onCollapse?: () => void;
}) {
  // A catalog point carries only its header; the text, sources and audio load when the sheet opens.
  const catalog = story.placeId !== undefined && story.chapter === undefined && story.jobId === undefined;
  const loaded = usePlaceStory(catalog ? story.placeId : undefined);
  const content: Pick<StoryPin, "paragraphs" | "attribution" | "audioUrl"> = catalog ? loaded.story ?? {} : story;
  const progress = story.progress;
  const expand = isExpandableStory(story) && onExpand && onCollapse ? { onExpand, onCollapse } : null;
  const peek = expand !== null && !expanded;
  const action = story.chapter !== undefined
    ? <button type="button" className={a.primary} ref={startRef} onClick={() => onStart(story.chapter)}>Слушать эту часть <ExploreIcon name="headphones" /></button>
    : progress?.canRetry && onRetry
      ? <button type="button" className={a.primary} disabled={retrying} onClick={onRetry}>{retrying ? "Запускаем…" : progress.retryLabel}<ExploreIcon name="arrow" /></button>
      : null;
  const pendingText = catalog && loaded.status !== "ready";
  const label = story.pending ? "Готовим для вас" : story.chapter !== undefined ? `По дороге · часть ${story.chapter + 1}` : progress ? progress.label : null;
  const labelText = label ? <span className={a.label}>{label}</span> : null;
  const title = <h2 id="selected-place-title" className={a.title}>{story.title}</h2>;
  // The peek names the place only; the address waits in the expanded card.
  const heading = peek ? title : <>{title}{story.title !== story.address ? <p className={styles.address}>{story.address}</p> : null}</>;
  const close = (className?: string) => <button type="button" className={cx(a.iconButton, className)} aria-label="Закрыть карточку" onClick={onClose}><ExploreIcon name="close" /></button>;
  // In the peek the title, the teaser and the photo open the story; controls inside them (retry) keep their own job.
  const expandOnClick = peek ? (event: MouseEvent) => { if (!(event.target as Element).closest("a, button, summary")) expand.onExpand(); } : undefined;
  // An expandable card keeps its close in the corner in both states. Walk parts and stories in progress keep their
  // label row with the close; a plain place card has no label, its close sits in the corner over the photo.
  const header = expand
    ? peek ? <div className={cx(styles.titleRow, styles.expandArea)} onClick={expandOnClick}>{labelText ? <div>{labelText}</div> : null}{heading}</div> : labelText
    : label ? <div className={a.headerRow}>{labelText}{close()}</div> : null;
  const paragraphs = content.paragraphs?.length ? peek ? content.paragraphs.slice(0, 1) : content.paragraphs : null;
  return <Sheet id="story-sheet" name="story" labelledBy="selected-place-title" bodyLabel={content.paragraphs?.length ? "Текст истории" : undefined}
    expanded={expand !== null && expanded}
    handle={expand ? <SheetHandle expanded={expanded} onExpand={expand.onExpand} onCollapse={expand.onCollapse} controls="story-sheet"
      expandLabel="Читать историю полностью" collapseLabel="Свернуть историю" /> : null}
    // Only catalog places have photos; the index flag holds the banner until the detail arrives.
    media={catalog ? <PlacePhotoBanner key={story.id} photo={loaded.story?.photo} pending={story.hasPhoto === true && loaded.status === "loading"} title={story.title}
      // In the peek the photo is part of the preview and expands the story like its title and text.
      onPreview={peek ? expand.onExpand : undefined} /> : null}
    header={header}
    corner={expand || !label ? close(styles.cornerClose) : null}
    // The player stays with the action: the text never takes it away. It is the walk's player too.
    footer={content.audioUrl || action ? <>{content.audioUrl ? <StoryAudioPlayer key={content.audioUrl} className={styles.audio} src={content.audioUrl} /> : null}{action}</> : null}>
    <>
      {peek ? null : <div className={cx(styles.heading, (expand || !label) && styles.titleRow)}>{heading}</div>}
      {pendingText && loaded.status === "loading" ? <p className={a.text} role="status">Загружаем рассказ…</p> : null}
      {pendingText && loaded.status === "error" ? <div role="alert"><p className={a.text}>Не удалось загрузить рассказ.</p><button type="button" className={a.secondary} onClick={loaded.retry}>Повторить</button></div> : null}
      {pendingText && loaded.status === "missing" ? <p className={a.text} role="status">Эта история больше недоступна.</p> : null}
      {progress?.pending ? <p className={a.text} role="status">{progress.label}. Можно закрыть карточку: подготовка продолжится, а история останется на карте.</p> : null}
      {progress?.error ? <p className={a.text} role="status">{progress.error}</p> : null}
      {retryError ? <p className={a.text} role="alert">{retryError}</p> : null}
      {progress?.note && !peek ? <p className={styles.source}>{progress.note}</p> : null}
      {paragraphs ? <div className={cx(styles.story, peek && styles.teaser, peek && styles.expandArea)} onClick={expandOnClick}>{paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div> : null}
      {peek ? null : <>
        {content.attribution ? <p className={styles.source}>Источник: <a href={content.attribution.url} target="_blank" rel="noopener noreferrer">{content.attribution.label}</a></p> : null}
        {story.sources?.length ? <details className={`${styles.help} ${styles.sources}`}><summary>Источники</summary>
          <ol>{story.sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a><span>{source.publisher}</span></li>)}</ol>
        </details> : null}
        {!action && story.placeId && !pendingText && !content.paragraphs?.length ? <p className={a.text}>Проверенный текст доступен в карточке места{content.audioUrl ? "; запись можно слушать здесь." : "; озвучивание ещё не готово."}</p> : null}
        {walkHref ? <WalkFromHere href={walkHref} onClick={onWalk} /> : null}
      </>}
    </>
  </Sheet>;
}

/** A point the user tapped or searched: offer to prepare its story or to start a walk from it. */
export function PlaceSheet({ address, busy, error, preparing = false, prepareError = "", walkHref, onPrepare, onClose, onWalk }: {
  address: string | null; busy: boolean; error: string; preparing?: boolean; prepareError?: string; walkHref: string | null;
  onPrepare: () => void; onClose: () => void; onWalk: () => void;
}) {
  // A point with no house nearby has no story to prepare; it can still be the start of a walk.
  const unknown = !busy && !error && !address && walkHref !== null;
  const note = error ? <p className={a.text} role="status">{error}</p>
    : busy ? <p className={a.text} role="status">Смотрим, какой дом находится рядом с выбранной точкой.</p>
    : prepareError ? <p className={a.text} role="alert">{prepareError}</p>
    : null;
  return <Sheet name="place" labelledBy="new-place-title"
    header={<div className={a.headerRow}>
      <h2 id="new-place-title" className={a.title}>{busy ? "Определяем адрес…" : address ?? (unknown ? "Не знаем, что здесь" : "О чём расскажет этот дом?")}</h2>
      <button type="button" className={a.iconButton} aria-label="Закрыть выбранное место" onClick={onClose}><ExploreIcon name="close" /></button>
    </div>}
    // Both actions stay in the footer: the card has no text to scroll past them.
    footer={busy || (!address && !walkHref) ? null : !address && walkHref ? <WalkFromHere href={walkHref} onClick={onWalk} primary /> : <>
      <button type="button" className={a.primary} disabled={preparing} onClick={onPrepare}>{preparing ? "Отправляем адрес…" : "История этого дома"}<ExploreIcon name="plus" /></button>
      {walkHref ? <WalkFromHere href={walkHref} onClick={onWalk} footer /> : null}
    </>}>
    {note}
  </Sheet>;
}

/** Ready stories around a point, nearest first, with the radius to search in. */
export function NearbySheet({ status = "ready", radius, recommendations, onRadius, onSelect, onClose }: {
  status?: "loading" | "ready" | "error";
  radius: NearbyRadius; recommendations: NearbyRecommendation[];
  onRadius: (radius: NearbyRadius) => void; onSelect: (id: string) => void; onClose: () => void;
}) {
  const wider = nearbyRadii[nearbyRadii.indexOf(radius) + 1];
  return <Sheet name="nearby" labelledBy="nearby-title"
    header={<div className={a.headerRow}>
      <div>
        <span className={a.label}>Готовые истории рядом</span>
        <h2 id="nearby-title" className={a.title}>В радиусе {radius} м</h2>
      </div>
      <button type="button" className={a.iconButton} aria-label="Закрыть истории рядом" onClick={onClose}><ExploreIcon name="close" /></button>
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
        : <button type="button" className={a.secondary} onClick={onClose}>Выбрать другую точку <ExploreIcon name="map" /></button>}
    </>:null}
  </Sheet>;
}

function WalkFromHere({ href, onClick, footer = false, primary = false }: { href: string; onClick: () => void; footer?: boolean; primary?: boolean }) {
  return <Link className={primary ? a.primary : footer ? a.secondary : `${a.secondary} ${a.bodyAction}`} href={href} onClick={onClick} prefetch={false}>Создать прогулку отсюда <ExploreIcon name="walk" /></Link>;
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

/** How to allow geolocation for the site; `open` shows the steps without the extra tap. */
export function GeoHelp({ onRetry, open = false }: { onRetry: () => void; open?: boolean }): ReactNode {
  return <details className={styles.help} open={open}>
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

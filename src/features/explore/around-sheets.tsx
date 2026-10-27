"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode, Ref } from "react";
import { CITIES, type City } from "../city/current-city";
import { Sheet } from "../shell/sheet";
import { SheetHandle } from "../shell/sheet-handle";
import { cx } from "../ui/cx";
import { nativePlatform } from "@/lib/native/platform";
import { ExploreIcon } from "./icons";
import { nearbyRadii, type NearbyRadius, type NearbyRecommendation } from "./nearby-stories";
import { StoryAudioPlayer } from "../tour/story-audio-player";
import { PlaceFeedback } from "../place-feedback/place-feedback";
import { canRatePlace } from "../place-feedback/model";
import { PlacePhotoBanner } from "./place-photo";
import { PlaceVideo } from "./place-video";
import { usePlaceStory } from "./place-story";
import { SharePlaceButton } from "./share-place-button";
import { isExpandableStory, isLinkablePlace, type StoryPin } from "./story-pin";
import a from "./around.module.css";
import styles from "./around-sheets.module.css";

import { FoodCard } from "../food/food-list";
import type { FoodManifest, FoodPlace } from "../food/food-cells";
import type { createFoodHoursCache } from "../food/food-walk-model";
import { useI18n } from "@/lib/i18n/provider";
import { ContentLanguageNote } from "@/lib/i18n/content-language-note";
import { toUserMessage } from "@/lib/errors/user-message";
import { htmlLanguage } from "@/lib/i18n/locale";

export function FoodSheet({ place, manifest, hours, distanceM, onClose }: {
  place: FoodPlace; manifest: FoodManifest; hours: ReturnType<typeof createFoodHoursCache>;
  distanceM?: number; onClose: () => void;
}) {
  const { t } = useI18n();
  return <Sheet name="food" labelledBy="food-place-title" header={<div className={a.headerRow}>
    <h2 id="food-place-title" className={a.title}>{place.name}</h2>
    <button type="button" className={a.iconButton} aria-label={t("Закрыть карточку")} onClick={onClose}><ExploreIcon name="close" /></button>
  </div>}><FoodCard place={place} manifest={manifest} hours={hours} heading={false} distanceLabel={distanceM === undefined ? undefined : t("≈ {distance} м от вас", { distance: Math.round(distanceM) })} /></Sheet>;
}

type GeoState = "idle" | "loading" | "ready" | "error" | "denied";

/** Asks for geolocation once: the one action is in the footer, closing it is remembered by the screen. */
export function LocationPromptSheet({ geo, onLocate, onDismiss }: { geo: GeoState; onLocate: () => void; onDismiss: () => void }) {
  const { t } = useI18n();
  return <Sheet name="location" labelledBy="location-title"
    header={<div className={a.headerRow}>
      <h2 id="location-title" className={a.title}>{t("Смотрите истории рядом с вами")}</h2>
      <button type="button" className={a.iconButton} aria-label={t("Закрыть карточку")} onClick={onDismiss}><ExploreIcon name="close" /></button>
    </div>}
    footer={<button type="button" className={a.primary} onClick={onLocate} disabled={geo === "loading"}>
      {t(geo === "loading" ? "Определяем положение…" : geo === "denied" || geo === "error" ? "Проверить снова" : "Включить геолокацию")}<ExploreIcon name="locate" />
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
  const { locale, t } = useI18n();
  // A catalog point carries only its header; the text, sources and audio load when the sheet opens.
  const catalog = story.placeId !== undefined && story.chapter === undefined && story.jobId === undefined;
  const loaded = usePlaceStory(catalog ? story.placeId : undefined, locale);
  const content: Pick<StoryPin, "paragraphs" | "attribution" | "audioUrl"> = catalog ? loaded.story ?? {} : story;
  const actualLocale = catalog ? loaded.story?.actualLocale ?? "ru" : "ru";
  const detailHeader = catalog ? loaded.story?.place : undefined;
  const displayTitle = detailHeader?.title ?? story.title;
  const displayAddress = detailHeader?.address ?? story.address;
  const progress = story.progress;
  const expand = isExpandableStory(story) && onExpand && onCollapse ? { onExpand, onCollapse } : null;
  const peek = expand !== null && !expanded;
  const action = story.chapter !== undefined
    ? <button type="button" className={a.primary} ref={startRef} onClick={() => onStart(story.chapter)}>{t("Слушать эту часть")} <ExploreIcon name="headphones" /></button>
    : progress?.canRetry && onRetry
      ? <button type="button" className={a.primary} disabled={retrying} onClick={onRetry}>{retrying ? t("Запускаем…") : progress.retryLabel}<ExploreIcon name="arrow" /></button>
      : null;
  const pendingText = catalog && loaded.status !== "ready";
  // The place is rated in the expanded story, after reading: in the peek the row would squeeze out the teaser.
  const rateable = catalog && !peek && loaded.status === "ready" && story.placeId !== undefined && canRatePlace(story.placeId);
  const label = story.pending ? t("Готовим для вас") : story.chapter !== undefined ? t("По дороге · часть {number}", { number: story.chapter + 1 }) : progress ? progress.label : null;
  const labelText = label ? <span className={a.label}>{label}</span> : null;
  const title = <h2 id="selected-place-title" className={a.title} lang={htmlLanguage[actualLocale]}>{displayTitle}</h2>;
  // The peek names the place only; the address waits in the expanded card.
  const heading = peek ? title : <>{title}{displayTitle !== displayAddress ? <p className={styles.address} lang="ru">{displayAddress}</p> : null}</>;
  const close = (className?: string) => <button type="button" className={cx(a.iconButton, className)} aria-label={t("Закрыть карточку")} onClick={onClose}><ExploreIcon name="close" /></button>;
  // In the peek the title, the teaser and the photo open the story; controls inside them (retry) keep their own job.
  const expandOnClick = peek ? (event: MouseEvent) => { if (!(event.target as Element).closest("a, button, summary")) expand.onExpand(); } : undefined;
  // An expandable card keeps its close in the corner in both states. Walk parts and stories in progress keep their
  // label row with the close; a plain place card has no label, its close sits in the corner over the photo.
  const header = expand
    ? peek ? <div className={cx(styles.titleRow, styles.expandArea)} onClick={expandOnClick}>{labelText ? <div>{labelText}</div> : null}{heading}</div> : labelText
    : label ? <div className={a.headerRow}>{labelText}{close()}</div> : null;
  const paragraphs = content.paragraphs?.length ? peek ? content.paragraphs.slice(0, 1) : content.paragraphs : null;
  return <Sheet id="story-sheet" name="story" labelledBy="selected-place-title" bodyLabel={content.paragraphs?.length ? t("Текст истории") : undefined}
    expanded={expand !== null && expanded}
    handle={expand ? <SheetHandle expanded={expanded} onExpand={expand.onExpand} onCollapse={expand.onCollapse} controls="story-sheet"
      expandLabel={t("Читать историю полностью")} collapseLabel={t("Свернуть историю")} /> : null}
    // Only catalog places have photos; the index flag holds the banner until the detail arrives.
    media={catalog ? <PlacePhotoBanner key={story.id} placeId={story.id} photo={loaded.story?.photo} pending={story.hasPhoto === true && loaded.status === "loading"} title={displayTitle}
      // In the peek the photo is part of the preview and expands the story like its title and text.
      onPreview={peek ? expand.onExpand : undefined} /> : null}
    header={header}
    corner={expand || !label ? close(styles.cornerClose) : null}
    // The player stays with the action: the text never takes it away. It is the walk's player too.
    footer={content.audioUrl || action || rateable ? <>
      {rateable && story.placeId ? <PlaceFeedback key={story.placeId} placeId={story.placeId} title={displayTitle} /> : null}
      {content.audioUrl ? <StoryAudioPlayer key={content.audioUrl} className={styles.audio} src={content.audioUrl} /> : null}{action}
    </> : null}>
    <>
      {peek ? null : <div className={cx(styles.heading, (expand || !label) && styles.titleRow)}>{heading}</div>}
      {(content.paragraphs?.length || content.audioUrl) ? <ContentLanguageNote contentLocale={actualLocale} audioAvailable={Boolean(content.audioUrl)} /> : null}
      {catalog && !peek ? <PlaceVideo key={story.id} placeId={story.placeId} title={displayTitle} /> : null}
      {pendingText && loaded.status === "loading" ? <p className={a.text} role="status">{t("Загружаем рассказ…")}</p> : null}
      {pendingText && loaded.status === "error" ? <div role="alert"><p className={a.text}>{t("Не удалось загрузить рассказ.")}</p><button type="button" className={a.secondary} onClick={loaded.retry}>{t("Повторить")}</button></div> : null}
      {pendingText && loaded.status === "missing" ? <p className={a.text} role="status">{t("Эта история больше недоступна.")}</p> : null}
      {progress?.pending ? <p className={a.text} role="status">{t("{status}. Можно закрыть карточку: подготовка продолжится, а история останется на карте.", { status: progress.label })}</p> : null}
      {progress?.error ? <p className={a.text} role="status">{toUserMessage(new Error(progress.error), "Подготовка прервалась.", locale)}</p> : null}
      {retryError ? <p className={a.text} role="alert">{retryError}</p> : null}
      {progress?.note && !peek ? <p className={styles.source}>{progress.note}</p> : null}
      {paragraphs ? <div className={cx(styles.story, peek && styles.teaser, peek && styles.expandArea)} lang={htmlLanguage[actualLocale]} onClick={expandOnClick}>{paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div> : null}
      {peek ? null : <>
        {content.attribution ? <p className={styles.source}>{t("Источник:")} <a href={content.attribution.url} target="_blank" rel="noopener noreferrer" lang={locale === "ru" ? undefined : "ru"}>{content.attribution.label}</a></p> : null}
        {story.sources?.length ? <details className={`${styles.help} ${styles.sources}`}><summary>{t("Источники")}</summary>
          <ol lang={locale === "ru" ? undefined : "ru"}>{story.sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a><span>{source.publisher}</span></li>)}</ol>
        </details> : null}
        {!action && story.placeId && !pendingText && !content.paragraphs?.length ? <p className={a.text}>{t(content.audioUrl ? "Проверенный текст доступен в карточке места; запись можно слушать здесь." : "Проверенный текст доступен в карточке места; озвучивание ещё не готово.")}</p> : null}
        {walkHref ? <WalkFromHere href={walkHref} onClick={onWalk} /> : null}
        {/* Only a published catalog place has a link to share, and only the reading view offers it. */}
        {expand && expanded && isLinkablePlace(story) && loaded.status === "ready" ? <SharePlaceButton key={story.id} placeId={story.id} title={displayTitle} /> : null}
      </>}
    </>
  </Sheet>;
}

/** A point the user tapped or searched: offer to prepare its story or to start a walk from it. */
export function PlaceSheet({ address, busy, error, preparing = false, prepareError = "", walkHref, onPrepare, onClose, onWalk }: {
  address: string | null; busy: boolean; error: string; preparing?: boolean; prepareError?: string; walkHref: string | null;
  onPrepare: () => void; onClose: () => void; onWalk: () => void;
}) {
  const { t } = useI18n();
  // A point with no house nearby has no story to prepare; it can still be the start of a walk.
  const unknown = !busy && !error && !address && walkHref !== null;
  const note = error ? <p className={a.text} role="status">{error}</p>
    : busy ? <p className={a.text} role="status">{t("Смотрим, какой дом находится рядом с выбранной точкой.")}</p>
    : prepareError ? <p className={a.text} role="alert">{prepareError}</p>
    : null;
  return <Sheet name="place" labelledBy="new-place-title"
    header={<div className={a.headerRow}>
      <h2 id="new-place-title" className={a.title}>{busy ? t("Определяем адрес…") : address ?? t(unknown ? "Не знаем, что здесь" : "О чём расскажет этот дом?")}</h2>
      <button type="button" className={a.iconButton} aria-label={t("Закрыть выбранное место")} onClick={onClose}><ExploreIcon name="close" /></button>
    </div>}
    // Both actions stay in the footer: the card has no text to scroll past them. The walk is the main action.
    footer={busy || (!address && !walkHref) ? null : <>
      {walkHref ? <WalkFromHere href={walkHref} onClick={onWalk} primary /> : null}
      {address ? <button type="button" className={walkHref ? a.secondary : a.primary} disabled={preparing} onClick={onPrepare}>{t(preparing ? "Отправляем адрес…" : "История этого дома")}<ExploreIcon name="plus" /></button> : null}
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
  const { locale, t } = useI18n();
  const wider = nearbyRadii[nearbyRadii.indexOf(radius) + 1];
  return <Sheet name="nearby" labelledBy="nearby-title"
    header={<div className={a.headerRow}>
      <div>
        <span className={a.label}>{t("Готовые истории рядом")}</span>
        <h2 id="nearby-title" className={a.title}>{t("В радиусе {radius} м", { radius })}</h2>
      </div>
      <button type="button" className={a.iconButton} aria-label={t("Закрыть истории рядом")} onClick={onClose}><ExploreIcon name="close" /></button>
    </div>}>
    <div className={styles.radius} role="group" aria-label={t("Радиус поиска")}>
      {nearbyRadii.map(value => <button key={value} type="button" aria-pressed={radius === value} onClick={() => onRadius(value)}>{t("{distance} м", { distance: value })}</button>)}
    </div>
    {status!=="ready"?<p role="status">{t(status==="loading"?"Ищем истории рядом…":"Не удалось загрузить все истории рядом. Повторите загрузку мест.")}</p>:null}
    {recommendations.length ? <ol className={styles.list}>{recommendations.map((story, index) => <li key={story.id}>
      <div>
        <strong lang={locale === "ru" ? undefined : "ru"}>{story.title}</strong>
        <span><span lang={locale === "ru" ? undefined : "ru"}>{story.address}</span> · {t("{distance} м по прямой", { distance: Math.round(story.distanceM) })}</span>
        {index === 0 ? <small>{story.reason}</small> : null}
      </div>
      <button type="button" className={index === 0 ? a.primary : a.secondary} onClick={() => onSelect(story.id)}>{t(index === 0 ? "Слушать" : "Альтернатива")}<ExploreIcon name={index === 0 ? "headphones" : "arrow"} /></button>
    </li>)}</ol> : status==="ready"?<>
      <p className={a.text}>{t("В этом радиусе пока нет готовой проверенной истории.")}</p>
      {wider ? <button type="button" className={a.secondary} onClick={() => onRadius(wider)}>{t("Искать в большем радиусе")} <ExploreIcon name="arrow" /></button>
        : <button type="button" className={a.secondary} onClick={onClose}>{t("Выбрать другую точку")} <ExploreIcon name="map" /></button>}
    </>:null}
  </Sheet>;
}

function WalkFromHere({ href, onClick, primary = false }: { href: string; onClick: () => void; primary?: boolean }) {
  const { path, t } = useI18n();
  return <Link className={primary ? a.primary : `${a.secondary} ${a.bodyAction}`} href={path(href)} onClick={onClick} prefetch={false}>{t("Создать прогулку отсюда")} <ExploreIcon name="walk" /></Link>;
}

/** The first-visit hint in the notices slot. */
export function MapHintNotice({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return <div className={a.notice}>
    <p><strong>{t("Откуда начнём прогулку?")}</strong>{t("Нажмите на карту — построим маршрут.")}</p>
    <button className={a.iconButton} type="button" aria-label={t("Закрыть подсказку")} onClick={onClose}><ExploreIcon name="close" /></button>
  </div>;
}

/** A story link being opened, or why it could not be: a damaged link, an unpublished story, a failed request. */
export function LinkNotice({ message, alert = false, onRetry, onClose }: { message: string; alert?: boolean; onRetry?: () => void; onClose: () => void }) {
  const { t } = useI18n();
  return <div className={a.notice}>
    <div>
      <p role={alert ? "alert" : "status"}>{message}</p>
      {onRetry ? <button type="button" className={`${a.secondary} ${a.bodyAction}`} onClick={onRetry}>{t("Повторить")}</button> : null}
    </div>
    <button className={`${a.iconButton} ${styles.top}`} type="button" aria-label={t("Скрыть сообщение")} onClick={onClose}><ExploreIcon name="close" /></button>
  </div>;
}

/** Result of locating the user; when access is denied it explains how to allow it. */
/** `failed`: the position is unknown, so a city is offered as the way to open the map without it. */
export function GeoNotice({ message, outside, failed, denied, onCity, onRetry, onClose }: {
  message: string; outside: boolean; failed: boolean; denied: boolean; onCity: (city: City) => void; onRetry: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  return <div className={a.notice}>
    <div>
      <p role="status">{message}{outside ? <> {t("Истории есть в городах:")}</> : null}</p>
      {/* Full touch targets: a city is the next step here, not a link inside a sentence. */}
      {outside || failed ? <div className={styles.cities} role="group" aria-label={t("Город")}>
        {CITIES.map(city => <button key={city.id} type="button" onClick={() => onCity(city)}>{t(city.name)}</button>)}
      </div> : null}
      {denied ? <GeoHelp onRetry={onRetry} /> : null}
    </div>
    <button className={`${a.iconButton} ${styles.top}`} type="button" aria-label={t("Скрыть сообщение")} onClick={onClose}><ExploreIcon name="close" /></button>
  </div>;
}

/** How to allow geolocation for the site; `open` shows the steps without the extra tap. */
export function GeoHelp({ onRetry, open = false }: { onRetry: () => void; open?: boolean }): ReactNode {
  const { t } = useI18n();
  const native = nativePlatform();
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const ios = native === "ios" || /iPhone|iPad|iPod/i.test(userAgent)
    || (typeof navigator !== "undefined" && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const androidWeb = native === null && /Android/i.test(userAgent);
  const windows = /Windows NT/i.test(userAgent);
  const mac = /Macintosh|Mac OS X/i.test(userAgent) && !ios;
  const desktop = windows || mac || /X11|Linux x86_64/i.test(userAgent);
  if (native === "android") return <details className={styles.help} open={open}>
    <summary>{t("Как разрешить геолокацию")}</summary>
    <ol>
      <li>{t("Откройте «Настройки» телефона → «Приложения» → «Отголосок» → «Разрешения» → «Местоположение».")}</li>
      <li>{t("Выберите «Разрешить только во время использования приложения» и включите «Точное местоположение».")}</li>
      <li>{t("Проверьте, что геолокация включена в быстрых настройках телефона, и вернитесь в приложение.")}</li>
    </ol>
    <button className={styles.inlineButton} type="button" onClick={onRetry}>{t("Проверить снова")}</button>
  </details>;
  return <details className={styles.help} open={open}>
    <summary>{t("Как разрешить геолокацию")}</summary>
    {ios ? <>
      <p><strong>{t("На iPhone и iPad")}</strong></p>
      <ol>
        <li>{t("В Safari нажмите значок меню страницы слева от адреса, затем «Ещё» (…) → «Настройки сайта» → «Геопозиция» → «Разрешить».")}</li>
        <li>{t("Если доступ всё ещё закрыт, откройте «Настройки» телефона → «Конфиденциальность и безопасность» → «Службы геолокации». Включите их и разрешите доступ для «Веб-сайты Safari» или вашего браузера при использовании.")}</li>
        <li>{t("Вернитесь на сайт и повторите попытку.")}</li>
      </ol>
      <p>{t("Если открыли сайт с экрана «Домой», проверьте его разрешение в «Службах геолокации». Если его нет в списке, откройте сайт в Safari.")}</p>
      <p>{t("В другом браузере откройте настройки разрешений этого сайта и разрешите доступ к местоположению. Также проверьте геолокацию на устройстве.")}</p>
      <a href="https://support.apple.com/ru-ru/102515" target="_blank" rel="noopener noreferrer">{t("Инструкция Apple ↗")}</a>
    </> : androidWeb ? <>
      <p><strong>{t("На телефоне Android")}</strong></p>
      <ol>
        <li>{t("Откройте настройки разрешений этого сайта в браузере и разрешите доступ к местоположению.")}</li>
        <li>{t("Проверьте, что геолокация включена в настройках телефона и разрешена для браузера.")}</li>
        <li>{t("Вернитесь на сайт и повторите попытку.")}</li>
      </ol>
    </> : <>
      <p><strong>{t(desktop ? "На компьютере" : "В браузере")}</strong></p>
      <ol>
        <li>{t("Откройте настройки этого сайта через значок слева от адреса в браузере.")}</li>
        <li>{t("Для местоположения выберите «Разрешить».")}</li>
        <li>{t("Вернитесь на сайт и повторите попытку.")}</li>
      </ol>
      {windows ? <p>{t("Если доступ всё ещё закрыт, откройте «Параметры Windows» → «Конфиденциальность и безопасность» → «Расположение» и включите службы геолокации и доступ для приложений.")}</p> : null}
      {mac ? <p>{t("Если доступ всё ещё закрыт, откройте «Системные настройки» → «Конфиденциальность и безопасность» → «Службы геолокации» и разрешите доступ браузеру.")}</p> : null}
    </>}
    <button className={styles.inlineButton} type="button" onClick={onRetry}>{t("Проверить снова")}</button>
  </details>;
}

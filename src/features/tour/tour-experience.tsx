"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TriggerConfig } from "@/lib/geo/types";
import {
  createWakeLockController,
  type WakeLockController,
  type WakeLockStatus,
} from "@/lib/wake-lock";
import type { Coordinates, Route } from "./types";
import type { WalkView } from "../walks/model";
import { walkViewToRoute } from "../walks/adapters";
import type { OfflineWalkRef } from "../walks/offline";
import { StorySources, StoryText } from "./story-content";
import { BrandMark } from "../brand/brand-mark";
import { chapterTriggerConfig, getWalkChapters, nextChapterTarget } from "./walk-plan";
import { advanceModeLabels, advanceModes, playbackRates, useWalkSettings, type AdvanceMode, type PlaybackRate } from "./walk-settings";
import { AudioPlayerControls } from "./audio-player-controls";
import { loadPublishedRoute } from "./published-route-cache";
import { usePlaybackProgress } from "./use-playback-progress";
import { WalkSession } from "./walk-session";
import { useOfflineShell } from "./use-offline-shell";
import { OfflineCopyControls, useOfflineCopy } from "./offline-copy";
import { positionFailed, useWalkPosition } from "./use-walk-position";
import { useWalkAudio } from "./use-walk-audio";
import { ClassicWalkView, type PlayerState } from "./classic-walk-view";
import { AroundScreen } from "../explore/around-screen";
import { isWalkCreation } from "../explore/panel-state";
import { markWalkStarted, wasWalkStarted } from "../reviews/device";
import { formatRatingSummary, type ReviewTarget } from "../reviews/model";
import { useWalkReviews } from "../reviews/use-walk-reviews";
import { WalkReviews } from "../reviews/walk-reviews";

type SessionPhase = "reading" | "walking";

export function TourExperience({ route, walk, offline = null, reviewTarget = null }: { route?: Route; walk?: WalkView; offline?: OfflineWalkRef | null; reviewTarget?: ReviewTarget | null }) {
  const resolvedRoute = walk ? walkViewToRoute(walk) : route;
  if (!resolvedRoute) return <main className="shell"><section className="hero-copy"><h1>Прогулка не найдена</h1><p className="dek">Откройте ссылку ещё раз или вернитесь к списку прогулок.</p></section></main>;
  return <AvailableTour route={resolvedRoute} universal={Boolean(walk)} view={walk} offlineRef={walk ? offline : null} reviewTarget={walk ? reviewTarget : null} />;
}

function AvailableTour({ route: initialRoute, universal = false, view, offlineRef, reviewTarget }: { route: Route; universal?: boolean; view?: WalkView; offlineRef: OfflineWalkRef | null; reviewTarget: ReviewTarget | null }) {
  const [route, setRoute] = useState(initialRoute);
  const firstPoi = route.pois[0];
  const [phase, setPhase] = useState<SessionPhase>("reading");
  const [completed, setCompleted] = useState(false);
  const [wakeStatus, setWakeStatus] = useState<WakeLockStatus>("idle");
  const [showSources, setShowSources] = useState(false);
  const [chapterIndex, setChapterIndex] = useState(0);
  // The chapter the last walk stopped at: the map reopens with its card.
  const [stoppedChapter, setStoppedChapter] = useState<number>();
  const [isReplay, setIsReplay] = useState(false);
  // Diagnostics are for field testing only: ?replay=… or ?debug=1.
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const offlineCopy = useOfflineCopy(view, offlineRef);
  const reviews = useWalkReviews(reviewTarget);
  // A UX filter against drive-by ratings, not a security control: the server does not check it.
  const [started, setStarted] = useState(() => reviewTarget ? wasWalkStarted(reviewTarget) : false);
  const canRate = Boolean(reviewTarget) && (started || Boolean(reviews.mine));
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const walkTitleRef = useRef<HTMLHeadingElement>(null);
  const sessionActiveRef = useRef(false);
  // A new version reloads the page by itself, but never during a walk, in the
  // walk builder or while a walk is being saved for offline use.
  const { shellStatus, updateAvailable } = useOfflineShell(() =>
    !sessionActiveRef.current && !offlineCopy.busy && !isWalkCreation(new URLSearchParams(window.location.search)));
  const restoreFocusRef = useRef(false);
  const wakeControllerRef = useRef<WakeLockController | null>(null);
  const sessionRef = useRef(0);
  const { settings, updateSettings } = useWalkSettings();
  // The position subscription outlives the render that created it, so chapter
  // state it depends on is read through refs rather than a stale closure.
  const liveRef = useRef({
    advance: settings.advance as AdvanceMode,
    index: 0,
    count: 0,
    target: firstPoi.location as Coordinates,
    config: {
      enterM: firstPoi.trigger.enter_m, exitM: firstPoi.trigger.exit_m,
      minFixes: firstPoi.trigger.min_fixes, windowSize: 5, maxAccuracyM: firstPoi.trigger.max_accuracy_m,
    } as TriggerConfig,
  });
  const selectChapterRef = useRef<(index: number) => void>(() => {});
  const controlsRef = useRef<{ toggle: () => void; seekBy: (offset: number) => void; seekTo: (position: number) => void }>({
    toggle: () => {}, seekBy: () => {}, seekTo: () => {},
  });
  useEffect(() => {
    if (universal) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    void loadPublishedRoute(initialRoute, controller.signal)
      .then(value => {
        // A listening session keeps its exact text, audio and resume offsets.
        if (!controller.signal.aborted) setRoute(current => sessionActiveRef.current ? current : value);
      })
      .catch(() => { /* The bundled walk remains available offline. */ })
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [initialRoute, universal]);
  // Stable between playback updates, so the map and plan do not rebuild on every tick.
  const chapters = useMemo(() => getWalkChapters(route, universal), [route, universal]);
  const chapter = chapters[chapterIndex];
  const walkContent = chapter?.content ?? firstPoi;
  const walkAudioUrl = chapter?.audio?.url ?? walkContent.story.audio_url;
  const walkUsesTestAudio = !universal && !walkAudioUrl;
  const { savedCheckpoint, saveCheckpoint, clearCheckpoint } = usePlaybackProgress(route.id,
    chapters.flatMap((item) => item.audio ? [{ id: item.id, audioUrl: item.audio.url, durationSec: item.audio.duration_sec }] : []));
  const savedChapterIndex = savedCheckpoint ? chapters.findIndex((item) => item.id === savedCheckpoint.chapterId) : -1;
  const finish = route.walk?.finish.location ?? firstPoi.viewpoint ?? firstPoi.location;
  const baseTriggerConfig: TriggerConfig = {
    enterM: firstPoi.trigger.enter_m,
    exitM: firstPoi.trigger.exit_m,
    minFixes: firstPoi.trigger.min_fixes,
    windowSize: 5,
    maxAccuracyM: firstPoi.trigger.max_accuracy_m,
  };
  // The walk listens for the stop whose chapter plays next, not for the finish.
  const target = chapters.length ? nextChapterTarget(chapters, chapterIndex, finish) : finish;
  const triggerConfig = chapters.length ? chapterTriggerConfig(chapters, chapterIndex, baseTriggerConfig) : baseTriggerConfig;
  const chapterTitle = chapter?.title ?? null;
  const chapterPlace = chapter?.place ?? null;

  const position = useWalkPosition();
  const { audioRef, handlers: audioHandlers, mediaRef, busyRef: audioBusyRef, status: audioStatus, playbackTime, mediaDuration, ...audio } = useWalkAudio({
    sessionRef, activeRef: sessionActiveRef, universal, routeId: route.id, chapters,
    source: walkAudioUrl, walking: phase === "walking", rate: settings.rate, saveCheckpoint, clearCheckpoint,
    onEnded: () => {
      const { advance, index, count } = liveRef.current;
      if (advance === "sequence" && index + 1 < count) selectChapterRef.current(index + 1);
    },
  });

  useEffect(() => () => {
    sessionRef.current += 1;
    sessionActiveRef.current = false;
    void wakeControllerRef.current?.dispose();
    wakeControllerRef.current = null;
  }, []);

  useEffect(() => {
    if (phase !== "reading") walkTitleRef.current?.focus();
    if (phase === "reading" && restoreFocusRef.current) {
      startButtonRef.current?.focus();
      restoreFocusRef.current = false;
    }
  }, [phase, chapterIndex]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media || phase !== "walking") return;
    media.setActions({
      play: () => controlsRef.current.toggle(),
      pause: () => controlsRef.current.toggle(),
      seekBy: (offset) => controlsRef.current.seekBy(offset),
      seekTo: (position) => controlsRef.current.seekTo(position),
      next: chapterIndex + 1 < chapters.length ? () => selectChapterRef.current(chapterIndex + 1) : undefined,
      previous: chapterIndex > 0 ? () => selectChapterRef.current(chapterIndex - 1) : undefined,
    });
    media.setTrack({
      title: chapterTitle ?? walkContent.story.opening,
      artist: chapterPlace ? `Часть ${chapterIndex + 1} из ${chapters.length} · ${chapterPlace}` : route.title,
      album: route.title,
      artwork: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
    });
  }, [mediaRef, phase, chapterIndex, chapters.length, chapterTitle, chapterPlace, walkContent.story.opening, route.title]);

  function startTour(resumeSaved = true, requestedIndex?: number) {
    if (phase !== "reading" || sessionActiveRef.current) return;
    setCompleted(false);
    sessionActiveRef.current = true;
    if (reviewTarget) { markWalkStarted(reviewTarget); setStarted(true); }

    const session = sessionRef.current + 1;
    sessionRef.current = session;
    const params = new URLSearchParams(window.location.search);
    const replayMode = params.get("replay");
    const initialIndex = requestedIndex !== undefined && requestedIndex >= 0 && requestedIndex < chapters.length ? requestedIndex : resumeSaved && savedChapterIndex >= 0 ? savedChapterIndex : 0;
    const initialPosition = requestedIndex === undefined && resumeSaved && savedCheckpoint ? savedCheckpoint.positionSec : 0;
    const startAudioUrl = chapters[initialIndex]?.audio?.url ?? chapters[initialIndex]?.content.story.audio_url ?? firstPoi.story.audio_url;

    // First, while the click still owns user activation (iOS).
    audio.begin(initialIndex, initialPosition, startAudioUrl);
    setPhase("walking");
    setChapterIndex(initialIndex);
    setShowSources(false);
    setIsReplay(replayMode === "clean" || replayMode === "walk");
    setShowDiagnostics(Boolean(replayMode) || params.get("debug") === "1");

    const wakeController = createWakeLockController({
      onChange: (snapshot) => {
        if (sessionRef.current === session) setWakeStatus(snapshot.status);
      },
    });
    wakeControllerRef.current = wakeController;
    setWakeStatus(wakeController.getSnapshot().status);
    void wakeController.request();

    position.start({
      replayMode,
      speed: Math.min(20, Math.max(1, Number(params.get("speed")) || 1)),
      path: route.walk?.path.coordinates ?? null,
      live: () => liveRef.current,
      busy: () => audioBusyRef.current,
      onEntered: () => {
        // Arriving at a stop starts its chapter only when the walker asked for it.
        // The trigger already withholds the arrival while a recording is playing.
        const live = liveRef.current;
        if (!route.walk) void audio.play();
        else if (live.advance === "place" && live.index + 1 < live.count) selectChapterRef.current(live.index + 1);
      },
    });
  }

  function stopTour(completed = false) {
    setCompleted(completed);
    audio.end(completed);
    sessionRef.current += 1;
    sessionActiveRef.current = false;
    position.stop();
    const wakeController = wakeControllerRef.current;
    wakeControllerRef.current = null;
    void wakeController?.dispose();
    setWakeStatus("idle");
    setIsReplay(false);
    setShowSources(false);
    setStoppedChapter(chapterIndex);
    restoreFocusRef.current = true;
    setPhase("reading");
  }

  function selectChapter(index: number) {
    if (!sessionActiveRef.current || index < 0 || index >= chapters.length) return;
    setShowSources(false);
    setChapterIndex(index);
    // The trigger now watches the stop after this one. Update the live values
    // here as well: a position update can arrive before the render that refreshes them.
    position.resetTrigger();
    liveRef.current = {
      ...liveRef.current, index,
      target: nextChapterTarget(chapters, index, finish),
      config: chapterTriggerConfig(chapters, index, baseTriggerConfig),
    };
    // Pass the destination explicitly: React state still holds the old chapter during this click.
    audio.switchTo(index, chapters[index].audio?.url ?? chapters[index].content.story.audio_url);
  }

  // Refreshed after every render so the long-lived position subscription and the
  // lock-screen handlers always act on the chapter that is playing now.
  useEffect(() => {
    liveRef.current = {
      advance: settings.advance, index: chapterIndex, count: chapters.length,
      target, config: triggerConfig,
    };
    selectChapterRef.current = selectChapter;
    controlsRef.current = {
      toggle: audio.toggle,
      seekBy: (offset) => audio.seek((audioRef.current?.currentTime ?? playbackTime) + offset),
      seekTo: (position) => audio.seek(position),
    };
  });

  const isWalking = phase !== "reading";
  const duration = mediaDuration || chapter?.audio?.duration_sec || walkContent.story.duration_sec;
  const canSeek = !walkUsesTestAudio && mediaDuration > 0 && !["loading", "unlocking", "locked"].includes(audioStatus);
  const audioButtonLabel = audioStatus === "loading" ? "Отменить запуск" : audioStatus === "playing" ? "Пауза" : audioStatus === "paused" ? "Продолжить" : audioStatus === "ended" ? "Слушать ещё раз" : audioStatus === "unlocking" ? "Включить звук" : audioStatus === "blocked" || audioStatus === "error" ? "Повторить запуск звука" : walkUsesTestAudio ? "Проверить звук" : walkAudioUrl ? "Слушать историю" : "Аудио ещё не готово";
  const player: PlayerState = { status: audioStatus, position: playbackTime, duration, canSeek, label: audioButtonLabel, source: walkAudioUrl, testTone: walkUsesTestAudio };
  const toggleSources = () => setShowSources((value) => !value);

  return (
    <main className={universal ? "walk-session" : isWalking ? "shell" : undefined} data-mode={isWalking ? "walk" : "reading"}>
      {!universal && isWalking ? <header className="masthead">
        <Link className="wordmark" href="/" aria-label="Отголосок, на главную">
          <BrandMark />
        </Link>
        <p className="privacy-note"><i aria-hidden="true" /> Координаты остаются на устройстве</p>
      </header> : null}

      {universal ? <WalkSession route={route} chapters={chapters} index={chapterIndex} active={isWalking} completed={completed}
        user={position.diagnostics.lastFix} positionFailed={positionFailed(position.diagnostics)} resume={Boolean(savedCheckpoint)} titleRef={walkTitleRef} startRef={startButtonRef}
        onStart={() => startTour()} onSelect={selectChapter} onStop={stopTour}
        ratingLabel={formatRatingSummary(reviews.summary)} canRate={canRate}
        reviews={reviewTarget ? intent => <WalkReviews reviews={reviews} intent={intent} canRate={canRate} /> : null}
        audioError={audioStatus === "blocked" || audioStatus === "error" ? "Не удалось включить аудио. Нажмите «Повторить запуск звука»." : ""}
        player={walkAudioUrl ? <AudioPlayerControls compact position={playbackTime} duration={duration} canSeek={canSeek} playing={audioStatus === "playing"}
          label={audioButtonLabel} rate={settings.rate} onToggle={audio.toggle} onSeek={audio.seek} onRate={rate => updateSettings({ rate })} /> : null}
        story={<><StoryText story={walkContent.story} />{walkContent.sources.length ? <StorySources content={walkContent} open={showSources} onToggle={toggleSources} /> : null}</>}
        settings={<div className="walk-session-settings">
          <label>Переключение остановок<select value={settings.advance} onChange={event => updateSettings({ advance: event.target.value as AdvanceMode })}>{advanceModes.map(mode => <option key={mode} value={mode}>{advanceModeLabels[mode]}</option>)}</select></label>
          <label>Скорость аудио<select value={settings.rate} onChange={event => updateSettings({ rate: Number(event.target.value) as PlaybackRate })}>{playbackRates.map(rate => <option key={rate} value={rate}>{String(rate).replace(".", ",")}×</option>)}</select></label>
          {offlineRef ? <OfflineCopyControls copy={offlineCopy} statusClassName="walk-session-muted" /> : null}
          {shellStatus ? <p className="walk-session-muted" role="status">{shellStatus}</p> : null}
          {isWalking ? <button type="button" onClick={() => stopTour()}>Остановить прогулку</button> : null}
        </div>} /> : isWalking ? (
        <ClassicWalkView route={route} chapters={chapters} chapterIndex={chapterIndex} titleRef={walkTitleRef}
          diagnostics={position.diagnostics} triggerConfig={triggerConfig} player={player} wakeStatus={wakeStatus}
          settings={settings} onSettings={updateSettings} showSources={showSources} onToggleSources={toggleSources}
          debug={{ show: showDiagnostics, replay: isReplay }}
          onToggle={audio.toggle} onSeek={audio.seek} onSelect={selectChapter} onStop={stopTour} />
      ) : (
        <AroundScreen route={route} openChapter={stoppedChapter} startRef={startButtonRef}
          onStart={(index) => startTour(false, index)} updateAvailable={updateAvailable} />
      )}

      <audio ref={audioRef} preload="auto" aria-label="Аудиогид" {...audioHandlers} />
    </main>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import {
  pauseAudioElement,
  playAudioSource,
  playTestTone,
  resumeAudioElement,
  seekAudioElement,
  stopAudioElement,
  unlockAudioElement,
} from "@/lib/audio";
import { createTriggerState, processFix } from "@/lib/geo/trigger";
import type {
  PositionFix,
  TriggerConfig,
  TriggerState,
} from "@/lib/geo/types";
import {
  CLEAN_REPLAY_TRACK,
  createBrowserPositionSource,
  createReplayPositionSource,
  createWalkReplayTrack,
  WALK_REPLAY_INTERVAL_MS,
} from "@/lib/position";
import type {
  PositionSourceKind,
  PositionSourceStatus,
  StopPositionSource,
} from "@/lib/position";
import {
  createWakeLockController,
  type WakeLockController,
  type WakeLockStatus,
} from "@/lib/wake-lock";
import {
  createMediaSessionController,
  type MediaSessionController,
} from "@/lib/audio/media-session";
import type { Coordinates, Route } from "./types";
import type { WalkView } from "../walks/model";
import { walkViewToRoute } from "../walks/adapters";
import { StorySources, StoryText } from "./story-content";
import { RouteNotes } from "./route-notes";
import { AroundScreen } from "../explore/around-screen";
import { RouteMap } from "./route-map";
import { BrandMark } from "../brand/brand-mark";
import { chapterTriggerConfig, getWalkChapters, nextChapterTarget, WalkPlanPreview } from "./walk-plan";
import { WalkMap } from "./walk-map";
import { advanceModeHints, advanceModeLabels, advanceModes, useWalkSettings, type AdvanceMode, type PlaybackRate } from "./walk-settings";
import { AudioPlayerControls } from "./audio-player-controls";
import { loadPublishedRoute } from "./published-route-cache";
import { usePlaybackProgress } from "./use-playback-progress";
import { formatPlaybackTime, type PlaybackCheckpoint } from "@/lib/audio/playback-progress";
import { getLastUserId, getSession } from "../auth/client";
import { saveWalkOffline } from "../walks/offline";
import { WalkSession } from "./walk-session";
import { playbackRates } from "./walk-settings";

type SessionPhase = "reading" | "walking";
type AudioStatus = "locked" | "unlocking" | "ready" | "loading" | "playing" | "paused" | "ended" | "blocked" | "error";

type Diagnostics = {
  source: PositionSourceKind | null;
  sourceStatus: PositionSourceStatus | "idle";
  lastFix: PositionFix | null;
  distanceM: number | null;
  trigger: TriggerState;
  sourceError: string | null;
};

const initialDiagnostics: Diagnostics = {
  source: null,
  sourceStatus: "idle",
  lastFix: null,
  distanceM: null,
  trigger: createTriggerState(),
  sourceError: null,
};

const sourceLabels: Record<PositionSourceStatus | "idle", string> = {
  idle: "ожидает",
  starting: "запрашиваем",
  active: "работает",
  stopped: "остановлен",
  complete: "трек завершён",
  "permission-denied": "доступ не дан",
  unavailable: "недоступна",
  error: "ошибка",
};

const wakeLabels: Record<WakeLockStatus, string> = {
  unsupported: "не поддерживается",
  idle: "ожидает",
  waiting: "ждёт активную вкладку",
  requesting: "запрашиваем",
  active: "экран активен",
  error: "не удалось включить",
  disposed: "выключен",
};

const audioLabels: Record<AudioStatus, string> = {
  locked: "не активирован",
  unlocking: "подготовка",
  ready: "готов",
  loading: "запускается",
  playing: "воспроизведение",
  paused: "пауза",
  ended: "запись закончилась",
  blocked: "нужно нажатие",
  error: "ошибка воспроизведения",
};

function applyPlaybackRate(audio: HTMLAudioElement, rate: number) {
  try { if (audio.playbackRate !== rate) audio.playbackRate = rate; }
  catch { /* Some engines reject a rate change while the source loads. */ }
}

export function TourExperience({ route, walk }: { route?: Route; walk?: WalkView }) {
  const resolvedRoute = walk ? walkViewToRoute(walk) : route;
  if (!resolvedRoute) return <main className="shell"><section className="hero-copy"><h1>Прогулка не найдена</h1><p className="dek">Откройте ссылку ещё раз или вернитесь к списку прогулок.</p></section></main>;
  return <AvailableTour route={resolvedRoute} universal={Boolean(walk)} view={walk} />;
}

function AvailableTour({ route: initialRoute, universal = false, view }: { route: Route; universal?: boolean; view?: WalkView }) {
  const [route, setRoute] = useState(initialRoute);
  const firstPoi = route.pois[0];
  const [phase, setPhase] = useState<SessionPhase>("reading");
  const [completed, setCompleted] = useState(false);
  const [audioStatus, setAudioStatus] = useState<AudioStatus>("locked");
  const [wakeStatus, setWakeStatus] = useState<WakeLockStatus>("idle");
  const [diagnostics, setDiagnostics] =
    useState<Diagnostics>(initialDiagnostics);
  const [showSources, setShowSources] = useState(false);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [isReplay, setIsReplay] = useState(false);
  const [offlineStatus, setOfflineStatus] = useState("Офлайн-копия ещё не сохранена");
  const [offlineBusy, setOfflineBusy] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const startButtonRef = useRef<HTMLButtonElement>(null);
  const walkTitleRef = useRef<HTMLHeadingElement>(null);
  const sessionActiveRef = useRef(false);
  const restoreFocusRef = useRef(false);
  const wakeControllerRef = useRef<WakeLockController | null>(null);
  const stopSourceRef = useRef<StopPositionSource | null>(null);
  const triggerStateRef = useRef<TriggerState>(createTriggerState());
  const audioBusyRef = useRef(false);
  const sessionRef = useRef(0);
  const playbackRef = useRef(0);
  const activeCheckpointRef = useRef<PlaybackCheckpoint | null>(null);
  const playbackSourceRef = useRef<string | null>(null);
  const restoringOffsetRef = useRef(false);
  const lastSavedTimeRef = useRef(0);
  const { settings, updateSettings } = useWalkSettings();
  const mediaRef = useRef<MediaSessionController | null>(null);
  // The position subscription outlives the render that created it, so chapter
  // state it depends on is read through refs rather than a stale closure.
  const liveRef = useRef({
    advance: settings.advance as AdvanceMode,
    rate: settings.rate as number,
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
  const usesTestAudio = !universal && !firstPoi.story.audio_url;
  const hasStoryText = firstPoi.story.text_status === "ready" && firstPoi.story.paragraphs.length > 0;
  const storyMinutes = Math.ceil(firstPoi.story.duration_sec / 60);
  const readyNotes = (route.notes ?? []).filter((note) => note.story.text_status === "ready" && note.story.paragraphs.length > 0);
  const chapters = getWalkChapters(route, universal);
  const chapter = chapters[chapterIndex];
  const walkContent = chapter?.content ?? firstPoi;
  const walkAudioUrl = chapter?.audio?.url ?? walkContent.story.audio_url;
  const walkUsesTestAudio = !universal && !walkAudioUrl;
  const hasWalkAudio = chapters.length > 0 && chapters.every((item) => item.audio?.url);
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
  const hasNextChapter = chapterIndex + 1 < chapters.length;
  const chapterTitle = chapter?.title ?? null;
  const chapterPlace = chapter?.place ?? null;

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) {
      return;
    }

    let cancelled = false;
    const cleanups: Array<() => void> = [];
    void navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    }).then(async (registration) => {
      if (cancelled) return;
      const checkUpdate = () => {
        if (!cancelled) setUpdateAvailable(Boolean(registration.waiting));
      };
      const watchInstalling = () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", checkUpdate);
        cleanups.push(() => worker.removeEventListener("statechange", checkUpdate));
      };
      const checkOnReturn = () => {
        if (document.visibilityState === "visible") void registration.update().catch(() => {});
      };
      registration.addEventListener("updatefound", watchInstalling);
      document.addEventListener("visibilitychange", checkOnReturn);
      window.addEventListener("online", checkOnReturn);
      cleanups.push(() => {
        registration.removeEventListener("updatefound", watchInstalling);
        document.removeEventListener("visibilitychange", checkOnReturn);
        window.removeEventListener("online", checkOnReturn);
      });
      watchInstalling();
      checkUpdate();
      if (!registration.active) {
        const worker = registration.installing ?? registration.waiting;
        if (!worker) throw new Error("Service Worker did not start");
        await new Promise<void>((resolve, reject) => {
          const check = () => {
            if (worker.state === "activated" || worker.state === "redundant") {
              worker.removeEventListener("statechange", check);
              if (worker.state === "activated") resolve();
              else reject(new Error("Offline installation failed"));
            }
          };
          worker.addEventListener("statechange", check);
          check();
        });
      }
      if (!cancelled) setOfflineStatus("Оболочка офлайн готова; сохраните прогулку для записей");
    }).catch(() => {
      if (!cancelled) setOfflineStatus("Оболочка офлайн готова; записи сохраняются отдельно");
    });
    return () => {
      cancelled = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, []);

  async function saveOffline() {
    if (!view || offlineBusy) return;
    setOfflineBusy(true);
    try {
      const user = await getSession().catch(() => null);
      const scope = user?.id ?? getLastUserId() ?? `public:${view.document.id}`;
      const result = await saveWalkOffline(view, scope);
      setOfflineStatus(`Офлайн-комплект сохранён · ${result.availableAudio} ${audioWord(result.availableAudio)}`);
    } catch (caught) {
      setOfflineStatus(caught instanceof Error ? caught.message : "Не удалось сохранить офлайн-комплект.");
    } finally {
      setOfflineBusy(false);
    }
  }

  useEffect(() => {
    const audioElement = audioRef.current;

    return () => {
      sessionRef.current += 1;
      sessionActiveRef.current = false;
      stopSourceRef.current?.();
      stopSourceRef.current = null;
      if (audioElement) stopAudioElement(audioElement);
      mediaRef.current?.release();
      mediaRef.current = null;
      void wakeControllerRef.current?.dispose();
      wakeControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (phase !== "reading") walkTitleRef.current?.focus();
    if (phase === "reading" && restoreFocusRef.current) {
      (startButtonRef.current ?? document.getElementById("around-title"))?.focus();
      restoreFocusRef.current = false;
    }
  }, [phase, chapterIndex]);

  useEffect(() => {
    const persist = () => {
      if (activeCheckpointRef.current) saveCheckpoint(activeCheckpointRef.current);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") persist();
    };
    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      persist();
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [saveCheckpoint]);

  useEffect(() => {
    if (audioRef.current) applyPlaybackRate(audioRef.current, settings.rate);
  }, [settings.rate, audioStatus]);

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
  }, [phase, chapterIndex, chapters.length, chapterTitle, chapterPlace, walkContent.story.opening, route.title]);

  useEffect(() => {
    mediaRef.current?.setPlaybackState(audioStatus === "playing" ? "playing" : phase === "walking" ? "paused" : "none");
  }, [audioStatus, phase]);

  function syncPlaybackProgress(persist = false) {
    const audio = audioRef.current;
    if (!audio || !sessionActiveRef.current || restoringOffsetRef.current) return;
    if (playbackSourceRef.current && audio.getAttribute("src") !== playbackSourceRef.current) return;
    if (audio.readyState < 1 || !Number.isFinite(audio.currentTime)) return;
    setPlaybackTime(audio.currentTime);
    if (Number.isFinite(audio.duration)) setMediaDuration(audio.duration);
    mediaRef.current?.setPosition({ durationSec: audio.duration, positionSec: audio.currentTime, playbackRate: audio.playbackRate });
    const checkpoint = activeCheckpointRef.current;
    if (!checkpoint) return;
    activeCheckpointRef.current = { ...checkpoint, positionSec: audio.currentTime };
    if (persist || Math.abs(audio.currentTime - lastSavedTimeRef.current) >= 2) {
      saveCheckpoint(activeCheckpointRef.current);
      lastSavedTimeRef.current = audio.currentTime;
    }
  }

  function setChapterCheckpoint(index: number, positionSec = 0) {
    const item = chapters[index];
    activeCheckpointRef.current = item?.audio ? {
      version: 1, routeId: route.id, chapterId: item.id,
      audioUrl: item.audio.url, positionSec,
    } : null;
    lastSavedTimeRef.current = positionSec;
    if (activeCheckpointRef.current) saveCheckpoint(activeCheckpointRef.current);
  }

  function finishAudio() {
    if (!sessionActiveRef.current) return;
    audioBusyRef.current = false;
    syncPlaybackProgress(true);
    const ended = Boolean(audioRef.current?.ended);
    if (ended) setAudioStatus("ended");
    else setAudioStatus((current) => current === "playing" ? "paused" : current);
    const { advance, index, count } = liveRef.current;
    if (ended && advance === "sequence" && index + 1 < count) selectChapterRef.current(index + 1);
  }

  async function playSignal(source: string | null = walkAudioUrl, positionSec = 0, resume = false) {
    const audio = audioRef.current;
    if (!audio || !sessionActiveRef.current) return;

    const session = sessionRef.current;
    const playback = playbackRef.current + 1;
    playbackRef.current = playback;
    audioBusyRef.current = true;
    const reuse = resume && source && !audio.error && audio.readyState >= 1 &&
      audio.getAttribute("src") === source && Math.abs(audio.currentTime - positionSec) < 0.5;
    playbackSourceRef.current = source;
    restoringOffsetRef.current = !reuse && positionSec > 0;
    setPlaybackTime(positionSec);
    if (!reuse) setMediaDuration(0);
    setAudioStatus("loading");
    if (!source && !universal) {
      const didPlay = reuse ? await resumeAudioElement(audio) : await playTestTone(audio);
      if (sessionRef.current !== session || playbackRef.current !== playback) return;
      audioBusyRef.current = false;
      setAudioStatus(didPlay ? "playing" : audio.error ? "error" : "blocked");
      return;
    }
    if (!source) {
      audioBusyRef.current = false;
      setAudioStatus("ready");
      return;
    }
    const didPlay = reuse ? await resumeAudioElement(audio) : await playAudioSource(audio, source, positionSec);
    if (sessionRef.current !== session || playbackRef.current !== playback) return;
    if (!didPlay) {
      audioBusyRef.current = false;
      setAudioStatus(audio.error ? "error" : "blocked");
    } else {
      restoringOffsetRef.current = false;
      syncPlaybackProgress(true);
      audioBusyRef.current = !audio.paused && !audio.ended;
      setAudioStatus(audio.ended ? "ended" : audio.paused ? "paused" : "playing");
    }
  }

  function toggleAudio() {
    if (phase !== "walking") return;
    if ((audioStatus === "playing" || audioStatus === "loading") && audioRef.current) {
      playbackRef.current += 1;
      syncPlaybackProgress(true);
      pauseAudioElement(audioRef.current);
      audioBusyRef.current = false;
      setAudioStatus("paused");
      return;
    }
    const position = audioStatus === "ended" ? 0 : activeCheckpointRef.current?.positionSec ?? playbackTime;
    void playSignal(walkAudioUrl, position, audioStatus === "paused");
  }

  function seekPlayback(position: number) {
    const audio = audioRef.current;
    if (!audio || !sessionActiveRef.current || audioStatus === "loading" || audioStatus === "unlocking") return;
    const sought = seekAudioElement(audio, position);
    if (sought === null) return;
    restoringOffsetRef.current = false;
    if (activeCheckpointRef.current) activeCheckpointRef.current.positionSec = sought;
    syncPlaybackProgress(true);
    if (audioStatus === "ended" && sought < audio.duration) setAudioStatus("paused");
  }

  function startTour(resumeSaved = true, requestedIndex?: number) {
    if (phase !== "reading" || sessionActiveRef.current) return;
    setCompleted(false);
    sessionActiveRef.current = true;

    const audio = audioRef.current;
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    playbackRef.current += 1;
    const playback = playbackRef.current;
    const params = new URLSearchParams(window.location.search);
    const replayMode = params.get("replay");
    const replay = replayMode === "clean" || replayMode === "walk";
    const initialIndex = requestedIndex !== undefined && requestedIndex >= 0 && requestedIndex < chapters.length ? requestedIndex : resumeSaved && savedChapterIndex >= 0 ? savedChapterIndex : 0;
    const initialPosition = requestedIndex === undefined && resumeSaved && savedCheckpoint ? savedCheckpoint.positionSec : 0;
    const startAudioUrl = chapters[initialIndex]?.audio?.url ?? chapters[initialIndex]?.content.story.audio_url ?? firstPoi.story.audio_url;

    // Keep this call before the first await: iOS grants playback to this exact
    // element only while the click still owns user activation.
    const unlockPromise = audio && !startAudioUrl && !universal
      ? unlockAudioElement(audio)
      : Promise.resolve(false);

    setPhase("walking");
    setChapterIndex(initialIndex);
    setChapterCheckpoint(initialIndex, initialPosition);
    setPlaybackTime(initialPosition);
    setAudioStatus(startAudioUrl ? "loading" : universal ? "ready" : "unlocking");
    audioBusyRef.current = universal ? Boolean(startAudioUrl) : true;
    setShowSources(false);
    setIsReplay(replay);
    triggerStateRef.current = createTriggerState();
    setDiagnostics({
      ...initialDiagnostics,
      source: replay ? "replay" : "browser",
      trigger: triggerStateRef.current,
    });

    // Audio readiness must never gate GPS or leave the walk controls disabled.
    if (startAudioUrl) {
      // Start the real clip within this click, retaining iOS user activation.
      void playSignal(startAudioUrl, initialPosition);
    } else if (!universal) {
      void unlockPromise.then((unlocked) => {
        if (sessionRef.current !== session || playbackRef.current !== playback) return;
        audioBusyRef.current = false;
        setAudioStatus(unlocked ? "ready" : "blocked");
      });
    }
    // Lock-screen controls are the point of the walk: the phone stays pocketed.
    mediaRef.current?.release();
    mediaRef.current = createMediaSessionController();
    const wakeController = createWakeLockController({
      onChange: (snapshot) => {
        if (sessionRef.current === session) setWakeStatus(snapshot.status);
      },
    });
    wakeControllerRef.current = wakeController;
    setWakeStatus(wakeController.getSnapshot().status);
    void wakeController.request();

    // `replay=walk` walks the routed line at an unhurried pace, so chapter
    // triggers can be checked at a desk; `speed` compresses that pace.
    const walkTrack = replayMode === "walk" && route.walk
      ? createWalkReplayTrack(route.walk.path.coordinates.map(([lon, lat]) => ({ lat, lon })))
      : [];
    const speed = Math.min(20, Math.max(1, Number(params.get("speed")) || 1));
    const source = walkTrack.length
      ? createReplayPositionSource({ fixes: walkTrack, intervalMs: Math.round(WALK_REPLAY_INTERVAL_MS / speed) })
      : replay
      ? createReplayPositionSource({ fixes: CLEAN_REPLAY_TRACK, intervalMs: 650 })
      : createBrowserPositionSource();

    stopSourceRef.current = source.subscribe((update) => {
      if (sessionRef.current !== session) return;

      if (update.type === "status") {
        setDiagnostics((current) => ({
          ...current,
          sourceStatus: update.status,
          sourceError: "error" in update ? update.error.message : null,
        }));
        return;
      }
      const live = liveRef.current;

      const result = processFix(
        triggerStateRef.current,
        update.fix,
        live.target,
        live.config,
        audioBusyRef.current,
      );
      triggerStateRef.current = result.state;
      setDiagnostics((current) => ({
        ...current,
        lastFix: update.fix,
        distanceM: result.distanceM,
        trigger: result.state,
      }));

      if (result.event?.type !== "entered") return;
      // Arriving at a stop starts its chapter only when the walker asked for it.
      // processFix already withholds the event while a recording is playing.
      if (!route.walk) void playSignal();
      else if (live.advance === "place" && live.index + 1 < live.count) selectChapterRef.current(live.index + 1);
    });
  }

  function stopTour(completed = false) {
    setCompleted(completed);
    syncPlaybackProgress(true);
    if (completed) clearCheckpoint();
    else if (activeCheckpointRef.current) saveCheckpoint(activeCheckpointRef.current);
    activeCheckpointRef.current = null;
    sessionRef.current += 1;
    sessionActiveRef.current = false;
    playbackRef.current += 1;
    stopSourceRef.current?.();
    stopSourceRef.current = null;
    triggerStateRef.current = createTriggerState();
    audioBusyRef.current = false;
    restoringOffsetRef.current = false;
    if (audioRef.current) stopAudioElement(audioRef.current);
    mediaRef.current?.release();
    mediaRef.current = null;
    const wakeController = wakeControllerRef.current;
    wakeControllerRef.current = null;
    void wakeController?.dispose();
    setWakeStatus("idle");
    setAudioStatus("locked");
    setDiagnostics(initialDiagnostics);
    setIsReplay(false);
    setShowSources(false);
    restoreFocusRef.current = true;
    setPhase("reading");
  }

  function selectChapter(index: number) {
    if (!sessionActiveRef.current || index < 0 || index >= chapters.length) return;
    playbackRef.current += 1;
    if (audioRef.current) stopAudioElement(audioRef.current);
    audioBusyRef.current = false;
    setAudioStatus("ready");
    setShowSources(false);
    setChapterIndex(index);
    setChapterCheckpoint(index);
    setPlaybackTime(0);
    setMediaDuration(0);
    restoringOffsetRef.current = false;
    // The trigger now watches the stop after this one, so earlier candidate fixes
    // no longer apply. Update the live values here as well: a position update can
    // arrive before the render that refreshes them.
    triggerStateRef.current = createTriggerState();
    liveRef.current = {
      ...liveRef.current, index,
      target: nextChapterTarget(chapters, index, finish),
      config: chapterTriggerConfig(chapters, index, baseTriggerConfig),
    };
    setDiagnostics((current) => ({ ...current, trigger: triggerStateRef.current, distanceM: null }));
    const source = chapters[index].audio?.url ?? chapters[index].content.story.audio_url;
    // Pass the destination explicitly: React state still holds the old chapter
    // during this click. Starting here also preserves mobile user activation.
    if (source) void playSignal(source);
    else setAudioStatus("ready");
  }

  // Refreshed after every render so the long-lived position subscription and the
  // lock-screen handlers always act on the chapter that is playing now.
  useEffect(() => {
    liveRef.current = {
      advance: settings.advance, rate: settings.rate, index: chapterIndex, count: chapters.length,
      target, config: triggerConfig,
    };
    selectChapterRef.current = selectChapter;
    controlsRef.current = {
      toggle: toggleAudio,
      seekBy: (offset) => seekPlayback((audioRef.current?.currentTime ?? playbackTime) + offset),
      seekTo: (position) => seekPlayback(position),
    };
  });

  const isWalking = phase !== "reading";
  const reliableFix =
    diagnostics.sourceStatus === "active" &&
    diagnostics.lastFix &&
    diagnostics.lastFix.accuracyM <= firstPoi.trigger.max_accuracy_m;
  const positionFailed = ["permission-denied", "unavailable", "error"].includes(diagnostics.sourceStatus);
  const signalTone = positionFailed ? "warning" : reliableFix ? "good" : diagnostics.lastFix ? "warning" : "neutral";
  const candidateCount = diagnostics.trigger.recentInside.filter(Boolean).length;
  const statusText = getStatusText(diagnostics, firstPoi.trigger.max_accuracy_m);
  const duration = mediaDuration || chapter?.audio?.duration_sec || walkContent.story.duration_sec;
  const canSeek = !walkUsesTestAudio && mediaDuration > 0 && !["loading", "unlocking", "locked"].includes(audioStatus);
  const audioButtonLabel = audioStatus === "loading" ? "Отменить запуск" : audioStatus === "playing" ? "Пауза" : audioStatus === "paused" ? "Продолжить" : audioStatus === "ended" ? "Слушать ещё раз" : audioStatus === "unlocking" ? "Включить звук" : audioStatus === "blocked" || audioStatus === "error" ? "Повторить запуск звука" : walkUsesTestAudio ? "Проверить звук" : walkAudioUrl ? "Слушать историю" : "Аудио ещё не готово";
  const chapterNarrative = chapter ? <>
    {chapter.transition ? <p className="walk-transition">{chapter.transition}</p> : null}
    {chapter.status && !["ready", "text_ready"].includes(chapter.status) ? <p className="walk-note" role="status">{walkStatusLabel(chapter.status)}</p> : null}
    {walkContent.story.paragraphs.length ? <StoryText story={walkContent.story} /> : null}
    <p className="walk-next-hint">{chapter.next_hint}</p>
  </> : null;

  return (
    <main className={universal ? "walk-session" : isWalking ? "shell" : "around-shell"} data-mode={isWalking ? "walk" : "reading"}>
      {!universal && isWalking ? <header className="masthead">
        <a className="wordmark" href="#top" aria-label="Отголосок, на главную">
          <BrandMark />
        </a>
        <p className="privacy-note"><i aria-hidden="true" /> Координаты остаются на устройстве</p>
      </header> : null}

      {universal ? <WalkSession route={route} chapters={chapters} index={chapterIndex} active={isWalking} completed={completed}
        user={diagnostics.lastFix} positionFailed={positionFailed} resume={Boolean(savedCheckpoint)} titleRef={walkTitleRef} startRef={startButtonRef}
        onStart={() => startTour()} onSelect={selectChapter} onStop={stopTour}
        audioError={audioStatus === "blocked" || audioStatus === "error" ? "Не удалось включить аудио. Нажмите «Повторить запуск звука»." : ""}
        player={walkAudioUrl ? <AudioPlayerControls compact position={playbackTime} duration={duration} canSeek={canSeek} playing={audioStatus === "playing"}
          label={audioButtonLabel} rate={settings.rate} onToggle={toggleAudio} onSeek={seekPlayback} onRate={rate => updateSettings({ rate })} /> : null}
        story={<><StoryText story={walkContent.story} />{walkContent.sources.length ? <StorySources content={walkContent} open={showSources} onToggle={() => setShowSources(value => !value)} /> : null}</>}
        settings={<div className="walk-session-settings">
          <label>Переключение остановок<select value={settings.advance} onChange={event => updateSettings({ advance: event.target.value as AdvanceMode })}>{advanceModes.map(mode => <option key={mode} value={mode}>{advanceModeLabels[mode]}</option>)}</select></label>
          <label>Скорость аудио<select value={settings.rate} onChange={event => updateSettings({ rate: Number(event.target.value) as PlaybackRate })}>{playbackRates.map(rate => <option key={rate} value={rate}>{String(rate).replace(".", ",")}×</option>)}</select></label>
          <button type="button" disabled={offlineBusy} onClick={() => void saveOffline()}>{offlineBusy ? "Сохраняем…" : "Скачать для прогулки без сети"}</button>
          <p className="walk-session-muted" role="status">{offlineStatus}</p>
          {isWalking ? <button type="button" onClick={() => stopTour()}>Остановить прогулку</button> : null}
        </div>} /> : isWalking ? (
        <section className="walk-view" id="top" aria-labelledby="walk-title">
          <div className="walk-status-row">
            <p className={`signal-status ${signalTone}`} role="status">
              <i aria-hidden="true" /> {statusText}
            </p>
            <p className="walk-counter">{chapter ? `Часть ${chapterIndex + 1} из ${chapters.length}` : hasStoryText || !usesTestAudio ? "История" : "Тестовая точка"}</p>
          </div>

          <div className="walk-story" data-sequence={chapter ? "true" : undefined}>
            <p className="walk-eyebrow">{chapter?.title ?? firstPoi.eyebrow}</p>
            <h1 id="walk-title" ref={walkTitleRef} tabIndex={-1}>{walkContent.story.opening}</h1>
            <p className="walk-place">{chapter?.place ?? firstPoi.name}</p>
            {chapter?.audio ? <details key={chapter.id} className="walk-transcript">
              <summary>Текст этой части</summary>
              {chapterNarrative}
            </details> : chapterNarrative}
            {walkUsesTestAudio ? <p className="walk-note">{chapter ? "Части переключаются вручную. Запись аудио готовится; кнопка проверки звука включает сигнал на 5 секунд." : hasStoryText ? "Историю можно прочитать ниже. Запись аудио готовится; у точки пока звучит тестовый сигнал на 5 секунд." : "Аудиоистория готовится. У точки прозвучит тестовый сигнал на 5 секунд."}</p> : null}
            {chapter?.audio ? <p className="walk-note">{Math.ceil(chapter.audio.duration_sec)} сек · Озвучка доступна. «Дальше» включает следующую часть.</p> : null}
            {!chapter ? <div className="trigger-meter" aria-label={`Подтверждений геопозиции: ${candidateCount} из ${triggerConfig.windowSize}`}>
              {Array.from({ length: triggerConfig.windowSize }, (_, index) => (
                <i key={index} className={index < candidateCount ? "filled" : ""} />
              ))}
            </div> : null}
          </div>

          {!walkUsesTestAudio && walkAudioUrl ? <AudioPlayerControls position={playbackTime} duration={duration}
            canSeek={canSeek} playing={audioStatus === "playing"} label={audioButtonLabel} rate={settings.rate}
            onToggle={toggleAudio} onSeek={seekPlayback} onRate={(rate: PlaybackRate) => updateSettings({ rate })} /> : <div className="walk-controls">
            {walkUsesTestAudio ? <button className="audio-button" type="button" onClick={toggleAudio}>{audioButtonLabel}</button> : <p className="walk-note" role="status">Для этой части пока нет аудиозаписи. Текст доступен ниже.</p>}
          </div>}

          {chapter ? <nav className="chapter-navigation" aria-label="Части прогулки">
            <button type="button" className="chapter-previous" disabled={chapterIndex === 0} onClick={() => selectChapter(chapterIndex - 1)}>Назад</button>
            <button type="button" className="chapter-next" onClick={() => chapterIndex + 1 < chapters.length ? selectChapter(chapterIndex + 1) : stopTour(true)}>
              {chapterIndex + 1 < chapters.length ? `Дальше: ${chapters[chapterIndex + 1].title}` : "Закончить маршрут"}
            </button>
          </nav> : null}

          {chapter ? <WalkMap chapters={chapters} index={chapterIndex} path={route.walk?.path}
            user={diagnostics.lastFix} distanceToNextM={hasNextChapter ? diagnostics.distanceM : null}
            onSelect={selectChapter} /> : null}

          {chapter ? <section className="walk-advance" aria-labelledby="walk-advance-title">
            <h2 id="walk-advance-title">Как включать следующую часть</h2>
            <div className="walk-advance-options" role="group" aria-labelledby="walk-advance-title">
              {advanceModes.map((mode: AdvanceMode) => <button key={mode} type="button"
                aria-pressed={settings.advance === mode}
                onClick={() => updateSettings({ advance: mode })}>{advanceModeLabels[mode]}</button>)}
            </div>
            <p>{advanceModeHints[settings.advance]}</p>
            {settings.advance === "place" && positionFailed
              ? <p className="walk-advance-warning" role="status">Геолокация недоступна, сама часть не включится. Пользуйтесь кнопкой «Дальше».</p>
              : null}
          </section> : null}

          {chapters.length > 1 ? <nav className="chapter-list" aria-labelledby="chapter-list-title">
            <h2 id="chapter-list-title">Части прогулки</h2>
            <p>Нажмите на часть, чтобы слушать с начала.</p>
            <ol>
              {chapters.map((item, index) => <li key={item.id}>
                <button type="button" aria-current={index === chapterIndex ? "step" : undefined}
                  onClick={() => selectChapter(index)}>
                  <span className="chapter-list-index" aria-hidden="true">{index + 1}</span>
                  <span className="chapter-list-title">{item.title}
                    {index === chapterIndex ? <small>Текущая часть</small> : null}
                  </span>
                  <span className="chapter-list-duration">{formatPlaybackTime(item.audio?.duration_sec ?? item.duration_sec)}</span>
                </button>
              </li>)}
            </ol>
          </nav> : null}

          <div className="walk-controls">
            <button className="stop-button" type="button" onClick={() => void stopTour()}>
              Выйти из прогулки
            </button>
          </div>

          <p className="walk-note" role="status">
            {audioStatus === "unlocking" ? "Проверяем запуск звука. Можно включить его кнопкой." : audioStatus === "loading" ? "Запускаем звук…" : audioStatus === "blocked" ? "Звук не запустился. Нажмите кнопку, чтобы попробовать ещё раз." : audioStatus === "error" ? "Не удалось воспроизвести аудио. Попробуйте запустить его ещё раз." : ""}
          </p>
          {hasStoryText && !chapter ? <details className="walk-transcript">
            <summary>Читать историю · около {storyMinutes} мин</summary>
            <StoryText story={firstPoi.story} />
          </details> : null}
          {walkContent.story.text_status === "ready" && walkContent.sources.length ? <StorySources content={walkContent} open={showSources} onToggle={() => setShowSources((value) => !value)} /> : null}
          {!chapter ? <RouteNotes notes={readyNotes} /> : null}

          <details className="debug-panel" open={isReplay || undefined}>
            <summary>Диагностика {isReplay ? "· replay" : ""}</summary>
            <dl>
              <DebugValue label="Источник" value={diagnostics.source ?? "—"} />
              <DebugValue label="Геопозиция" value={sourceLabels[diagnostics.sourceStatus]} />
              <DebugValue label="Точность" value={diagnostics.lastFix ? `${Math.round(diagnostics.lastFix.accuracyM)} м` : "—"} />
              <DebugValue label={chapter ? hasNextChapter ? "До следующей части" : "До финиша" : "До точки"} value={diagnostics.distanceM === null ? "—" : `${Math.round(diagnostics.distanceM)} м`} />
              <DebugValue label="Зона входа" value={`${triggerConfig.enterM} м`} />
              <DebugValue label="Кандидаты" value={`${candidateCount} / ${diagnostics.trigger.recentInside.length || triggerConfig.windowSize}`} />
              <DebugValue label="Триггер" value={diagnostics.trigger.phase} />
              <DebugValue label="Переход" value={advanceModeLabels[settings.advance]} />
              <DebugValue label="Аудио" value={audioLabels[audioStatus]} />
              <DebugValue label="Экран" value={wakeLabels[wakeStatus]} />
            </dl>
            {diagnostics.sourceError ? <p className="debug-error">{diagnostics.sourceError}</p> : null}
          </details>
        </section>
      ) : (
        <AroundScreen route={route} onStart={(index) => startTour(index === undefined, index)} updateAvailable={updateAvailable} initialTab={universal ? "walk" : undefined}>
          <section className="hero" id="top">
            <div className="hero-copy">
              <p className="kicker">{route.status === "draft" ? "Маршрут в подготовке" : `Аудиопрогулка · ${route.city}`}</p>
              <h1>{route.title}</h1>
              <p className="dek">{route.subtitle}</p>
              <dl className="route-facts">
                <div><dt>{route.status === "draft" ? "План пути" : "Путь"}</dt><dd>{route.walk ? `≈ ${Math.round(route.walk.distance_m / 50) * 50} м` : `${route.distance_km.toLocaleString("ru-RU")} км`}</dd></div>
                <div><dt>{route.status === "draft" ? "План времени" : "Время"}</dt><dd>{route.duration_min} минут</dd></div>
                <div><dt>Сейчас доступно</dt><dd>{chapter ? `${chapters.length} части · ${hasWalkAudio ? "аудио и текст" : "текст"}` : hasStoryText && usesTestAudio ? "История · текст" : usesTestAudio ? "Тестовая точка" : universal && !hasStoryText ? "Маршрут без историй" : "Первая история"}</dd></div>
              </dl>
              <button className="start-button" type="button" ref={startButtonRef} onClick={() => void startTour()}>
                <span>{savedCheckpoint ? "Продолжить прогулку" : "Начать прогулку"}</span><b aria-hidden="true">→</b>
              </button>
              {savedCheckpoint && savedChapterIndex >= 0 ? <>
                <p className="start-note">Часть {savedChapterIndex + 1} · {chapters[savedChapterIndex].title} · {formatPlaybackTime(savedCheckpoint.positionSec)}</p>
                <button type="button" className="restart-walk" onClick={() => startTour(false)}>Начать сначала</button>
              </> : null}
              <p className="start-note">{route.walk ? hasWalkAudio ? `Около ${route.duration_min} минут ходьбы без остановок. Первая запись включится при старте, следующие по кнопке «Дальше». Озвучка доступна.` : universal && !hasStoryText ? `Около ${route.duration_min} минут ходьбы. Истории и аудио для этого маршрута пока не подготовлены.` : `Около ${route.duration_min} минут ходьбы без остановок. Рассказы переключаются вручную; озвучка готовится.` : usesTestAudio ? "Проверка геолокации и звука на одной точке. Запись аудио готовится." : "Разрешите звук и геолокацию после нажатия."}</p>
              {chapters.length > 0 ? <a className="read-story-link" href="#walk-plan">Как пойдём · {chapters.length} {chapterWord(chapters.length)} <span aria-hidden="true">↓</span></a> : null}
              <a className="read-story-link" href="/create">Подготовить историю другого дома <span aria-hidden="true">→</span></a>
              {hasStoryText ? <a className="read-story-link" href="#story">Читать первую историю · около {storyMinutes} мин <span aria-hidden="true">↓</span></a> : null}
              {readyNotes.length > 0 ? <div><a className="read-story-link" href="#along-the-way">По дороге · короткие заметки ({readyNotes.length}) <span aria-hidden="true">↓</span></a></div> : null}
              <p className="start-note" role="status">{offlineStatus}</p>
              {view ? <button className="read-story-link offline-save-button" type="button" disabled={offlineBusy} onClick={() => void saveOffline()}>{offlineBusy ? "Сохраняем без сети…" : "Сохранить прогулку без сети ↓"}</button> : null}
              <div className="update-control">
                {updateAvailable ? <p role="status">Доступна новая версия сайта.</p> : null}
                <a href="/update.html">{updateAvailable ? "Обновить прогулку" : "Проверить обновление"}</a>
              </div>
            </div>

            <RouteMap route={route} universal={universal} />
          </section>

          <WalkPlanPreview chapters={chapters} />
          <section className="story-preview" id="story" aria-labelledby="story-title">
            <div className="story-number">{String(Math.min(99, Math.max(1, chapterIndex + 1))).padStart(2, "0")}</div>
            <div>
              <p className="kicker">{hasStoryText ? firstPoi.name : "История в подготовке"}</p>
              <h2 id="story-title">{firstPoi.story.opening}</h2>
              <p>{hasStoryText ? `Около ${storyMinutes} минут чтения.${hasWalkAudio ? " Озвучка доступна в записи прогулки." : usesTestAudio ? " Запись аудио готовится." : ""}` : "Короткая история с источниками рядом с местом событий."}</p>
              {hasStoryText ? <StoryText story={firstPoi.story} /> : null}
            </div>
            {firstPoi.story.text_status === "ready" && firstPoi.sources.length ? <StorySources content={firstPoi} open={showSources} onToggle={() => setShowSources((value) => !value)} /> : null}
          </section>
          <RouteNotes notes={readyNotes} narrated={hasWalkAudio} />
        </AroundScreen>
      )}

      <audio ref={audioRef} preload="auto" aria-label="Аудиогид"
        onTimeUpdate={() => syncPlaybackProgress()}
        onLoadedMetadata={() => {
          const audio = audioRef.current;
          if (!audio) return;
          // A fresh source resets the rate in some engines; reapply on every load.
          applyPlaybackRate(audio, liveRef.current.rate);
          if (sessionActiveRef.current && Number.isFinite(audio.duration)) setMediaDuration(audio.duration);
        }}
        onSeeked={() => syncPlaybackProgress(true)}
        onPlaying={() => {
          if (sessionActiveRef.current && audioRef.current && !audioRef.current.paused) {
            audioBusyRef.current = true;
            setAudioStatus("playing");
          }
        }}
        onEnded={() => { if (audioRef.current?.ended) finishAudio(); }}
        onPause={() => { if (audioRef.current?.paused) finishAudio(); }}
        onError={() => {
          if (sessionActiveRef.current && phase === "walking" && audioRef.current?.error) {
            playbackRef.current += 1;
            audioBusyRef.current = false;
            setAudioStatus("error");
          }
        }} />
    </main>
  );
}

function DebugValue({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function getStatusText(
  diagnostics: Diagnostics,
  maxAccuracyM: number,
) {
  if (diagnostics.sourceStatus === "permission-denied") return "Нет доступа к геолокации · звук доступен по кнопке";
  if (diagnostics.sourceStatus === "unavailable" || diagnostics.sourceStatus === "error") return "Нет сигнала GPS · звук доступен по кнопке";
  if (diagnostics.sourceStatus === "complete") return "Тестовый трек завершён";
  if (!diagnostics.lastFix) return "Ищем сигнал GPS…";
  if (diagnostics.lastFix.accuracyM > maxAccuracyM) return `Уточняем позицию · ±${Math.round(diagnostics.lastFix.accuracyM)} м`;
  if (diagnostics.trigger.phase === "inside") return "Вы у точки";
  if (diagnostics.trigger.phase === "cooldown") return "Точка пройдена";
  return `Слушаем город · ±${Math.round(diagnostics.lastFix.accuracyM)} м`;
}

function walkStatusLabel(status: NonNullable<import("./types").WalkStep["status"]>) {
  return {
    not_requested: "История для этой остановки ещё не заказана.",
    preparing: "История готовится. Остановку можно пройти вручную.",
    failed: "Подготовка истории прервалась. Текст пока недоступен.",
    review_required: "История ожидает редакторской проверки.",
    insufficient_evidence: "Для истории пока не хватило подтверждённых источников.",
    unavailable: "История этой остановки пока недоступна.",
    text_ready: "Текст готов; аудиозапись ещё не подготовлена.",
    ready: "История готова.",
  }[status];
}

function audioWord(value: number) {
  const remainder = value % 10;
  const tens = value % 100;
  return tens >= 11 && tens <= 14 ? "записей" : remainder === 1 ? "запись" : remainder >= 2 && remainder <= 4 ? "записи" : "записей";
}

function chapterWord(value: number) {
  const remainder = value % 10;
  const tens = value % 100;
  return tens >= 11 && tens <= 14 ? "частей" : remainder === 1 ? "часть" : remainder >= 2 && remainder <= 4 ? "части" : "частей";
}

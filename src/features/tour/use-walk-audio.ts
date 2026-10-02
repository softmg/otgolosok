"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  pauseAudioElement,
  playAudioSource,
  playTestTone,
  resumeAudioElement,
  seekAudioElement,
  stopAudioElement,
  unlockAudioElement,
} from "@/lib/audio";
import { createMediaSessionController, type MediaSessionController } from "@/lib/audio/media-session";
import type { PlaybackCheckpoint } from "@/lib/audio/playback-progress";
import type { WalkChapter } from "./walk-plan";

export type AudioStatus = "locked" | "unlocking" | "ready" | "loading" | "playing" | "paused" | "ended" | "blocked" | "error";

export type WalkAudioOptions = {
  /** Incremented whenever a walk starts or stops; stale async results compare against it. */
  sessionRef: RefObject<number>;
  /** True while a walk is running. */
  activeRef: RefObject<boolean>;
  /** Universal walks have no test tone: a chapter without a recording stays silent. */
  universal: boolean;
  routeId: string;
  chapters: WalkChapter[];
  /** The recording of the current chapter, if any. */
  source: string | null;
  walking: boolean;
  rate: number;
  saveCheckpoint: (checkpoint: PlaybackCheckpoint) => void;
  clearCheckpoint: () => void;
  /** A recording played to its end. */
  onEnded: () => void;
};

// Marks the element as not playing the walk's audio yet (a silent unlock clip or a
// stopped earlier story); never equal to a real source.
const NO_WALK_SOURCE = "about:blank#no-walk-source";

function applyPlaybackRate(audio: HTMLAudioElement, rate: number) {
  try { if (audio.playbackRate !== rate) audio.playbackRate = rate; }
  catch { /* Some engines reject a rate change while the source loads. */ }
}

/**
 * Plays the walk's recordings on one audio element: start inside the user's
 * click (iOS), pause/resume, seeking, resume checkpoints and lock-screen state.
 */
export function useWalkAudio(options: WalkAudioOptions) {
  const { sessionRef, activeRef, universal, routeId, chapters, source: currentSource, walking, rate, saveCheckpoint, clearCheckpoint, onEnded } = options;
  const [status, setStatus] = useState<AudioStatus>("locked");
  const [playbackTime, setPlaybackTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const busyRef = useRef(false);
  const playbackRef = useRef(0);
  const activeCheckpointRef = useRef<PlaybackCheckpoint | null>(null);
  const playbackSourceRef = useRef<string | null>(null);
  const restoringOffsetRef = useRef(false);
  const lastSavedTimeRef = useRef(0);
  const mediaRef = useRef<MediaSessionController | null>(null);

  useEffect(() => {
    const audioElement = audioRef.current;
    return () => {
      if (audioElement) stopAudioElement(audioElement);
      mediaRef.current?.release();
      mediaRef.current = null;
    };
  }, []);

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
    if (audioRef.current) applyPlaybackRate(audioRef.current, rate);
  }, [rate, status]);

  useEffect(() => {
    mediaRef.current?.setPlaybackState(status === "playing" ? "playing" : walking ? "paused" : "none");
  }, [status, walking]);

  /** Events of a clip that is not the expected source (the unlock clip, a stopped story) must not touch the player. */
  function ownsElement(audio: HTMLAudioElement) {
    return !playbackSourceRef.current || audio.getAttribute("src") === playbackSourceRef.current;
  }

  function sync(persist = false) {
    const audio = audioRef.current;
    if (!audio || !activeRef.current || restoringOffsetRef.current) return;
    if (!ownsElement(audio)) return;
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
      version: 1, routeId, chapterId: item.id,
      audioUrl: item.audio.url, positionSec,
    } : null;
    lastSavedTimeRef.current = positionSec;
    if (activeCheckpointRef.current) saveCheckpoint(activeCheckpointRef.current);
  }

  function finish() {
    if (!activeRef.current) return;
    busyRef.current = false;
    sync(true);
    const ended = Boolean(audioRef.current?.ended);
    if (ended) setStatus("ended");
    else setStatus((current) => current === "playing" ? "paused" : current);
    if (ended) onEnded();
  }

  async function play(source: string | null = currentSource, positionSec = 0, resume = false) {
    const audio = audioRef.current;
    if (!audio || !activeRef.current) return;

    const session = sessionRef.current;
    const playback = playbackRef.current + 1;
    playbackRef.current = playback;
    busyRef.current = true;
    const reuse = resume && source && !audio.error && audio.readyState >= 1 &&
      audio.getAttribute("src") === source && Math.abs(audio.currentTime - positionSec) < 0.5;
    playbackSourceRef.current = source;
    restoringOffsetRef.current = !reuse && positionSec > 0;
    setPlaybackTime(positionSec);
    if (!reuse) setMediaDuration(0);
    setStatus("loading");
    if (!source && !universal) {
      const didPlay = reuse ? await resumeAudioElement(audio) : await playTestTone(audio);
      if (sessionRef.current !== session || playbackRef.current !== playback) return;
      busyRef.current = false;
      setStatus(didPlay ? "playing" : audio.error ? "error" : "blocked");
      return;
    }
    if (!source) {
      busyRef.current = false;
      setStatus("ready");
      return;
    }
    const didPlay = reuse ? await resumeAudioElement(audio) : await playAudioSource(audio, source, positionSec);
    if (sessionRef.current !== session || playbackRef.current !== playback) return;
    if (!didPlay) {
      busyRef.current = false;
      setStatus(audio.error ? "error" : "blocked");
    } else {
      restoringOffsetRef.current = false;
      sync(true);
      busyRef.current = !audio.paused && !audio.ended;
      setStatus(audio.ended ? "ended" : audio.paused ? "paused" : "playing");
    }
  }

  function toggle() {
    if (!walking) return;
    if ((status === "playing" || status === "loading") && audioRef.current) {
      playbackRef.current += 1;
      sync(true);
      pauseAudioElement(audioRef.current);
      busyRef.current = false;
      setStatus("paused");
      return;
    }
    const position = status === "ended" ? 0 : activeCheckpointRef.current?.positionSec ?? playbackTime;
    void play(currentSource, position, status === "paused");
  }

  function seek(position: number) {
    const audio = audioRef.current;
    if (!audio || !activeRef.current || status === "loading" || status === "unlocking") return;
    const sought = seekAudioElement(audio, position);
    if (sought === null) return;
    restoringOffsetRef.current = false;
    if (activeCheckpointRef.current) activeCheckpointRef.current.positionSec = sought;
    sync(true);
    if (status === "ended" && sought < audio.duration) setStatus("paused");
  }

  /** Starts the audio side of a walk; call synchronously from the start click. */
  function begin(index: number, positionSec: number, source: string | null) {
    const audio = audioRef.current;
    const session = sessionRef.current;
    playbackRef.current += 1;
    const playback = playbackRef.current;
    // Keep this call before the first await: iOS grants playback to this exact
    // element only while the click still owns user activation.
    const unlockPromise = audio && !source && !universal ? unlockAudioElement(audio) : Promise.resolve(false);

    setChapterCheckpoint(index, positionSec);
    setPlaybackTime(positionSec);
    setStatus(source ? "loading" : universal ? "ready" : "unlocking");
    busyRef.current = universal ? Boolean(source) : true;

    // Audio readiness must never gate GPS or leave the walk controls disabled.
    if (source) {
      // Start the real clip within this click, retaining iOS user activation.
      void play(source, positionSec);
    } else if (!universal) {
      void unlockPromise.then((unlocked) => {
        if (sessionRef.current !== session || playbackRef.current !== playback) return;
        busyRef.current = false;
        setStatus(unlocked ? "ready" : "blocked");
      });
    }
    // Lock-screen controls are the point of the walk: the phone stays pocketed.
    mediaRef.current?.release();
    mediaRef.current = createMediaSessionController();
  }

  /**
   * Starts a universal walk without playing: the walker first goes to the stop.
   * Call synchronously from the start click, so that unlocking the element there
   * lets the story start by itself on arrival (iOS).
   */
  function prime(index: number) {
    const audio = audioRef.current;
    playbackRef.current += 1;
    playbackSourceRef.current = NO_WALK_SOURCE;
    restoringOffsetRef.current = false;
    // Keep this call before the first await. A failed unlock changes nothing visible:
    // the story then starts from the player's button, itself a new user gesture.
    if (audio) void unlockAudioElement(audio);
    setChapterCheckpoint(index);
    setPlaybackTime(0);
    setMediaDuration(0);
    busyRef.current = false;
    setStatus("ready");
    mediaRef.current?.release();
    mediaRef.current = createMediaSessionController();
  }

  /** Switches to another chapter; starting here, inside the click, preserves mobile user activation. */
  function switchTo(index: number, source: string | null, autoplay = true) {
    playbackRef.current += 1;
    if (audioRef.current) stopAudioElement(audioRef.current);
    // Late events of the stopped story must not show its time or duration for this chapter.
    playbackSourceRef.current = NO_WALK_SOURCE;
    busyRef.current = false;
    setStatus("ready");
    setChapterCheckpoint(index);
    setPlaybackTime(0);
    setMediaDuration(0);
    restoringOffsetRef.current = false;
    if (source && autoplay) void play(source);
  }

  /** Stops playback and keeps (or, for a completed walk, clears) the resume checkpoint. Call while the walk is still active. */
  function end(completed: boolean) {
    sync(true);
    if (completed) clearCheckpoint();
    else if (activeCheckpointRef.current) saveCheckpoint(activeCheckpointRef.current);
    activeCheckpointRef.current = null;
    playbackRef.current += 1;
    busyRef.current = false;
    restoringOffsetRef.current = false;
    if (audioRef.current) stopAudioElement(audioRef.current);
    mediaRef.current?.release();
    mediaRef.current = null;
    setStatus("locked");
  }

  const handlers = {
    onTimeUpdate: () => sync(),
    onLoadedMetadata: () => {
      const audio = audioRef.current;
      if (!audio) return;
      // A fresh source resets the rate in some engines; reapply on every load.
      applyPlaybackRate(audio, rate);
      if (activeRef.current && ownsElement(audio) && Number.isFinite(audio.duration)) setMediaDuration(audio.duration);
    },
    onSeeked: () => sync(true),
    onPlaying: () => {
      if (activeRef.current && audioRef.current && !audioRef.current.paused && ownsElement(audioRef.current)) {
        busyRef.current = true;
        setStatus("playing");
      }
    },
    onEnded: () => { if (audioRef.current?.ended && ownsElement(audioRef.current)) finish(); },
    onPause: () => { if (audioRef.current?.paused && ownsElement(audioRef.current)) finish(); },
    onError: () => {
      if (activeRef.current && walking && audioRef.current?.error && ownsElement(audioRef.current)) {
        playbackRef.current += 1;
        busyRef.current = false;
        setStatus("error");
      }
    },
  };

  return { audioRef, status, playbackTime, mediaDuration, busyRef, mediaRef, play, toggle, seek, begin, prime, switchTo, end, handlers };
}

export type WalkAudio = ReturnType<typeof useWalkAudio>;

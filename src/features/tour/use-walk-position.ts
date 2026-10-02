"use client";

import { useEffect, useRef, useState } from "react";
import { createTriggerState, processFix } from "@/lib/geo/trigger";
import type { PositionFix, TriggerConfig, TriggerState } from "@/lib/geo/types";
import {
  CLEAN_REPLAY_TRACK,
  createBrowserPositionSource,
  createReplayPositionSource,
  createWalkReplayTrack,
  WALK_REPLAY_INTERVAL_MS,
} from "@/lib/position";
import type { PositionSourceKind, PositionSourceStatus, StopPositionSource } from "@/lib/position";
import type { Coordinates } from "./types";

export type Diagnostics = {
  source: PositionSourceKind | null;
  sourceStatus: PositionSourceStatus | "idle";
  lastFix: PositionFix | null;
  distanceM: number | null;
  trigger: TriggerState;
  sourceError: string | null;
};

export const initialDiagnostics: Diagnostics = {
  source: null,
  sourceStatus: "idle",
  lastFix: null,
  distanceM: null,
  trigger: createTriggerState(),
  sourceError: null,
};

export type TrackingOptions = {
  /** `clean` replays a fixed test track; `walk` replays the routed line. */
  replayMode: string | null;
  /** Compresses the pace of the `walk` replay, 1–20. */
  speed: number;
  /** The routed line as [lon, lat] pairs, when the route has one. */
  path: ReadonlyArray<ReadonlyArray<number>> | null;
  /** Read on every fix: the stop the walk currently listens for. */
  live: () => { target: Coordinates; config: TriggerConfig };
  /** While a recording plays, arrivals are withheld. */
  busy: () => boolean;
  onEntered: () => void;
};

/** Follows the walker's position (or a replay) and reports arrivals at the current target stop. */
export function useWalkPosition() {
  const [diagnostics, setDiagnostics] = useState<Diagnostics>(initialDiagnostics);
  const stopSourceRef = useRef<StopPositionSource | null>(null);
  const triggerStateRef = useRef<TriggerState>(createTriggerState());
  const generationRef = useRef(0);
  const optionsRef = useRef<TrackingOptions | null>(null);

  useEffect(() => () => {
    generationRef.current += 1;
    stopSourceRef.current?.();
    stopSourceRef.current = null;
  }, []);

  function start(options: TrackingOptions) {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    stopSourceRef.current?.();
    optionsRef.current = options;
    const replay = options.replayMode === "clean" || options.replayMode === "walk";
    triggerStateRef.current = createTriggerState();
    setDiagnostics({ ...initialDiagnostics, source: replay ? "replay" : "browser", trigger: triggerStateRef.current });

    // `replay=walk` walks the routed line at an unhurried pace, so chapter
    // triggers can be checked at a desk; `speed` compresses that pace.
    const walkTrack = options.replayMode === "walk" && options.path
      ? createWalkReplayTrack(options.path.map(([lon, lat]) => ({ lat, lon })))
      : [];
    const source = walkTrack.length
      ? createReplayPositionSource({ fixes: walkTrack, intervalMs: Math.round(WALK_REPLAY_INTERVAL_MS / options.speed) })
      : replay
      ? createReplayPositionSource({ fixes: CLEAN_REPLAY_TRACK, intervalMs: 650 })
      : createBrowserPositionSource();

    stopSourceRef.current = source.subscribe((update) => {
      if (generationRef.current !== generation) return;

      if (update.type === "status") {
        setDiagnostics((current) => ({
          ...current,
          sourceStatus: update.status,
          sourceError: "error" in update ? update.error.message : null,
        }));
        return;
      }
      const { target, config } = options.live();
      const result = processFix(triggerStateRef.current, update.fix, target, config, options.busy());
      triggerStateRef.current = result.state;
      setDiagnostics((current) => ({
        ...current,
        lastFix: update.fix,
        distanceM: result.distanceM,
        trigger: result.state,
      }));
      if (result.event?.type === "entered") options.onEntered();
    });
  }

  function stop() {
    generationRef.current += 1;
    stopSourceRef.current?.();
    stopSourceRef.current = null;
    optionsRef.current = null;
    triggerStateRef.current = createTriggerState();
    setDiagnostics(initialDiagnostics);
  }

  /**
   * Asks the browser for the position again. Called from a tap, so a browser that has not been
   * answered yet shows its permission prompt; a denied site stays denied until the walker allows it.
   */
  function retry() {
    if (optionsRef.current) start(optionsRef.current);
  }

  /** The walk now listens for another stop, so earlier candidate fixes no longer apply. */
  function resetTrigger() {
    triggerStateRef.current = createTriggerState();
    setDiagnostics((current) => ({ ...current, trigger: triggerStateRef.current, distanceM: null }));
  }

  return { diagnostics, start, stop, resetTrigger, retry };
}

export function positionFailed(diagnostics: Diagnostics) {
  return ["permission-denied", "unavailable", "error"].includes(diagnostics.sourceStatus);
}

export function signalTone(diagnostics: Diagnostics, maxAccuracyM: number): "good" | "warning" | "neutral" {
  const reliableFix = diagnostics.sourceStatus === "active" && diagnostics.lastFix && diagnostics.lastFix.accuracyM <= maxAccuracyM;
  return positionFailed(diagnostics) ? "warning" : reliableFix ? "good" : diagnostics.lastFix ? "warning" : "neutral";
}

export function getStatusText(diagnostics: Diagnostics, maxAccuracyM: number) {
  if (diagnostics.sourceStatus === "permission-denied") return "Нет доступа к геолокации · звук доступен по кнопке";
  if (diagnostics.sourceStatus === "unavailable" || diagnostics.sourceStatus === "error") return "Нет сигнала GPS · звук доступен по кнопке";
  if (diagnostics.sourceStatus === "complete") return "Тестовый трек завершён";
  if (!diagnostics.lastFix) return "Ищем сигнал GPS…";
  if (diagnostics.lastFix.accuracyM > maxAccuracyM) return `Уточняем позицию · ±${Math.round(diagnostics.lastFix.accuracyM)} м`;
  if (diagnostics.trigger.phase === "inside") return "Вы у точки";
  if (diagnostics.trigger.phase === "cooldown") return "Точка пройдена";
  return `Слушаем город · ±${Math.round(diagnostics.lastFix.accuracyM)} м`;
}

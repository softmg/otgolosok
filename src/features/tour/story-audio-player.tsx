"use client";

import { useEffect, useRef, useState } from "react";
import { AudioPlayerControls } from "./audio-player-controls";
import styles from "./audio-player-controls.module.css";

type Status = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

const labels: Record<Status, string> = {
  idle: "Слушать историю", loading: "Загружаем запись", playing: "Пауза", paused: "Продолжить", ended: "Слушать ещё раз", error: "Повторить запуск звука",
};

/**
 * One story's recording outside a walk: the same compact player as the walk panel, over its own
 * hidden audio element. Closing the card stops the sound — a detached element would keep playing.
 */
export function StoryAudioPlayer({ src, className }: { src: string; className?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  // A failed preload is not the listener's problem yet: it is retried on «Слушать», and only a failed start is reported.
  const preloadFailed = useRef(false);

  useEffect(() => {
    const audio = audioRef.current;
    return () => audio?.pause();
  }, []);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) { audio.pause(); return; }
    if (status === "error" || preloadFailed.current) { preloadFailed.current = false; audio.load(); }
    setStatus("loading");
    // A refused or failed start (autoplay policy, network) leaves a retry, never a stuck spinner.
    audio.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setStatus("error");
    });
  };
  const seek = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(duration) || duration <= 0) return;
    audio.currentTime = Math.min(duration, Math.max(0, seconds));
    setPosition(audio.currentTime);
  };

  return <div className={className}>
    <audio ref={audioRef} src={src} preload="metadata" aria-label="Озвучка истории"
      onLoadedMetadata={event => setDuration(event.currentTarget.duration)}
      onDurationChange={event => setDuration(event.currentTarget.duration)}
      onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
      onPlaying={() => setStatus("playing")}
      onPause={event => setStatus(event.currentTarget.ended ? "ended" : "paused")}
      onEnded={() => setStatus("ended")}
      onError={() => { if (status === "idle") preloadFailed.current = true; else setStatus("error"); }} />
    <AudioPlayerControls compact className={styles.flush} position={position} duration={duration} canSeek={Number.isFinite(duration) && duration > 0}
      playing={status === "playing" || status === "loading"} label={labels[status]}
      onToggle={toggle} onSeek={seek} />
    {status === "error" ? <p className={styles.error} role="alert">Не удалось включить запись. Проверьте соединение и попробуйте ещё раз.</p> : null}
  </div>;
}

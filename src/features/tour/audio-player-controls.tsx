import { formatPlaybackTime } from "@/lib/audio/playback-progress";
import { playbackRates, type PlaybackRate } from "./walk-settings";

type Props = {
  compact?: boolean;
  position: number;
  duration: number;
  canSeek: boolean;
  playing: boolean;
  label: string;
  rate: PlaybackRate;
  onToggle: () => void;
  onSeek: (seconds: number) => void;
  onRate: (rate: PlaybackRate) => void;
};

const rateLabel = (rate: PlaybackRate) => `${String(rate).replace(".", ",")}×`;

export function AudioPlayerControls({ compact = false, position, duration, canSeek, playing, label, rate, onToggle, onSeek, onRate }: Props) {
  const maximum = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const current = Math.min(maximum, Math.max(0, position));
  if (compact) return <section className="session-audio" aria-label="Плеер истории">
    <button type="button" aria-label={label} onClick={onToggle}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{playing ? <path d="M6 4h4v16H6zM14 4h4v16h-4z" /> : <path d="m8 4 12 8-12 8z" />}</svg>
    </button>
    <div><input type="range" min={0} max={maximum || 1} step="any" value={current} disabled={!canSeek}
      aria-label="Позиция воспроизведения" aria-valuetext={`${formatPlaybackTime(current)} из ${formatPlaybackTime(maximum)}`}
      onChange={event => onSeek(Number(event.target.value))} />
      <div className="session-audio-time" aria-hidden="true"><span>{formatPlaybackTime(current)}</span><span>{formatPlaybackTime(maximum)}</span></div>
    </div>
  </section>;
  return <section className="audio-player" aria-label="Плеер истории">
    <div className="audio-player-time" aria-hidden="true">
      <span>{formatPlaybackTime(current)}</span><span>{formatPlaybackTime(maximum)}</span>
    </div>
    <input type="range" className="audio-timeline" min={0} max={maximum || 1} step="any"
      value={current} disabled={!canSeek} aria-label="Позиция воспроизведения"
      aria-valuetext={`${formatPlaybackTime(current)} из ${formatPlaybackTime(maximum)}`}
      onChange={(event) => onSeek(Number(event.target.value))} />
    <div className="audio-player-buttons">
      <button type="button" className="audio-skip" aria-label="Назад на 15 секунд"
        disabled={!canSeek || current <= 0} onClick={() => onSeek(current - 15)}><span aria-hidden="true">↶</span>15 с</button>
      <button className="audio-button" type="button" onClick={onToggle}>
        <span>{label}</span><b aria-hidden="true">{playing ? "Ⅱ" : "▶"}</b>
      </button>
      <button type="button" className="audio-skip" aria-label="Вперёд на 15 секунд"
        disabled={!canSeek || current >= maximum} onClick={() => onSeek(current + 15)}><span aria-hidden="true">↷</span>15 с</button>
    </div>
    <div className="audio-rate" role="group" aria-label="Скорость рассказа">
      {playbackRates.map((value) => (
        <button key={value} type="button" aria-pressed={value === rate}
          aria-label={`Скорость ${rateLabel(value)}`} onClick={() => onRate(value)}>{rateLabel(value)}</button>
      ))}
    </div>
  </section>;
}

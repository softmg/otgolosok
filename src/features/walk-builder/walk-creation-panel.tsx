"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import type { Coordinates } from "../tour/types";
import type { MapItem } from "../explore/explore-map";
import { ExploreIcon } from "../explore/icons";
import { useWalkDraft } from "./use-walk-draft";
import { creationReducer } from "./creation-state";
import { AddressInput } from "./address-input";
import { validStops, type Place } from "./model";
import { ResearchPanel } from "./research-panel";
import { describeLocateError, locateOnce } from "@/lib/position/locate";
import { Sheet } from "../shell/sheet";
import styles from "./walk-creation-panel.module.css";

export type CreationMap = { items: MapItem[]; geometry?: Coordinates[]; tunnels?: Array<[number, number]>; focus: Coordinates | null; picking: boolean };
export function WalkCreationPanel({ onClose, onMap, picked }: { onClose: () => void; onMap: (value: CreationMap) => void; picked: Coordinates | null }) {
  const w = useWalkDraft();
  const [state, dispatch] = useReducer(creationReducer, { step: "location", picking: false });
  const [chosenMode, setMode] = useState<"destination" | "time" | null>(null);
  const mode = chosenMode ?? w.initialMode;
  const [picker, setPicker] = useState<"choices" | "address" | "time" | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const locating = useRef<(() => void) | null>(null);
  // В StrictMode очистка срабатывает и без размонтирования: отменённый поиск не должен оставить панель занятой.
  useEffect(() => () => { if (locating.current) { locating.current(); locating.current = null; setGeoBusy(false); } }, []);
  const panel = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const busy = Boolean(w.busy) || geoBusy;
  const resolvePoint = useEffectEvent(async (point: Coordinates) => {
    const target = state.picking || picker ? w.target : w.draft.start ? "destination" : "start";
    const place = await w.resolve(point);
    if (!place) return;
    w.setTarget(target);
    if (target === "destination") setMode("destination");
    selectAddress(place, target);
    dispatch({ type: "return" });
  });
  const close = useEffectEvent(() => { if (picker) { setPicker(null); panel.current?.querySelector<HTMLButtonElement>(`[data-endpoint="${w.target}"]`)?.focus(); } else if (state.picking) dispatch({ type: "return" }); else onClose(); });
  useEffect(() => { title.current?.focus(); const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); }, []);
  // Apply a point selected by the external Leaflet map to the active endpoint.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (picked) void resolvePoint(picked); }, [picked]);
  useEffect(() => {
    // As in the walk session: the start and the finish are rings, stops are numbered like the stop list.
    const start = w.draft.start, stops = w.draft.stops, destination = w.draft.destination;
    const items: MapItem[] = [
      ...(start ? [{ id: "creation-start", title: `Старт: ${start.address}`, location: start.location, endpoint: true }] : []),
      ...stops.map((p, i) => ({ id: `creation-stop-${i}`, title: `Остановка ${i + 1}: ${p.address}`, location: p.location, number: i + 1 })),
      ...(destination ? [{ id: "creation-finish", title: `Финиш: ${destination.address}`, location: destination.location, endpoint: true }] : []),
    ];
    onMap({ items, geometry: w.draft.route?.geometry, tunnels: w.draft.route?.tunnels, focus: w.focus, picking: state.picking });
  }, [w.draft.start, w.draft.stops, w.draft.destination, w.draft.route, w.focus, state.picking, onMap]);

  // Адрес ищем один раз — по итоговой, самой точной точке.
  function locate() {
    locating.current?.();
    setGeoBusy(true);
    locating.current = locateOnce(update => {
      if (update.type === "fix" && !update.final) return;
      locating.current = null; setGeoBusy(false);
      if (update.type === "error") { w.setError(`${describeLocateError(update.code)} Выберите точку на карте или введите адрес.`); return; }
      void w.resolve({ lat: update.fix.lat, lon: update.fix.lon });
    });
  }
  function changeMode(next: "destination" | "time") {
    setMode(next); w.edit({ destination: null, mode: next === "time" ? "loop" : "open" });
    w.setTarget("destination");
  }
  // A built route opens on the walk page; the builder keeps only the form.
  async function build() { setPicker(null); await w.build(); }
  const built = Boolean(w.draft.route) && !state.picking;

  function selectAddress(place: Place, target = w.target) {
    if (target === "start") w.edit({ start: place });
    else if (target === "destination") w.edit({ destination: place, mode: "open" });
    else {
      const stops = [...w.draft.stops, place];
      if (!validStops(w.draft.start, stops, w.draft.destination)) { w.setError("Эту остановку нельзя добавить: проверьте расстояние и число остановок."); return; }
      w.edit({ stops });
    }
    w.setCandidate(null); setPicker(null);
  }
  function cancelAddress() {
    if (w.target === "start") w.edit({ start: null });
    else if (w.target === "destination") { setMode("destination"); w.edit({ destination: null, mode: "open" }); }
    w.setCandidate(null); w.setQuery(""); w.setError(""); setPicker(null);
    requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>(`[data-endpoint="${w.target}"]`)?.focus());
  }
  const inlineAddress = <AddressInput onCancel={cancelAddress} disabled={busy} key={w.target} label={w.target === "start" ? "Откуда" : w.target === "destination" ? "Куда" : "Остановка"} initialValue={w.target === "start" ? w.draft.start?.address : w.target === "destination" ? w.draft.destination?.address : ""} onResolve={async query => { const place = await w.resolve(query); if (place) selectAddress(place); }} />;
  const addressPicker = picker && (picker !== "address" || w.candidate) && <div id="creation-picker" className={styles.picker}>
            {picker === "choices" && <div className={styles.options}>
              <button onClick={() => { if (w.target === "destination") changeMode("destination"); setPicker("address"); }}>Ввести адрес</button>
              <button onClick={() => { if (w.target === "destination") changeMode("destination"); setPicker(null); dispatch({ type: "pick" }); }}>Выбрать на карте</button>
              {w.target === "destination" ? <button onClick={() => { if (mode !== "time") changeMode("time"); setPicker("time"); }}>По времени</button> : <button onClick={() => { setPicker("address"); locate(); }}>Моё местоположение</button>}
            </div>}

            {w.candidate && <div className={styles.candidate}><p>{w.candidate.address}</p><button className="ui-button" onClick={() => { w.confirmPlace(); setPicker(null); }}>Выбрать эту точку</button></div>}
            {picker === "time" && <><fieldset className={styles.time} disabled={busy}><legend>Время пешком</legend><div>{([30, 60, 90] as const).map(minutes => <button type="button" key={minutes} aria-pressed={w.draft.minutes === minutes} onClick={() => w.edit({ minutes })}>{minutes} мин</button>)}</div></fieldset><label className={styles.switch}><span>Вернуться к началу</span><input type="checkbox" checked={w.draft.mode === "loop"} onChange={e => w.edit({ mode: e.target.checked ? "loop" : "open" })} /></label></>}
          </div>;
  const step = state.picking ? "picking" : "form";
  const footer = w.loaded && built && w.openHref ? <button className={`ui-button ${styles.footerAction}`} disabled={busy || !!w.storageError} onClick={() => void w.openWalk()}>Открыть прогулку</button>
    : w.loaded && !built && !state.picking && w.draft.start && (mode === "time" || w.draft.destination)
      ? <button className={`ui-button ${styles.footerAction}`} disabled={busy || !w.draft.start || (mode === "destination" && !w.draft.destination) || !!w.candidate || !!w.storageError} onClick={() => void build()}>Построить прогулку</button>
      : null;

  return <Sheet name="creation" state={step} labelledBy="creation-title" sheetRef={panel} className={styles.panel}
    header={<div className={styles.heading}><h1 id="creation-title" className={styles.title} ref={title} tabIndex={-1}>{state.picking ? "Куда идём?" : "Прогулка"}</h1><button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть создание прогулки"><ExploreIcon name="close" /></button></div>}
    footer={footer}>
      {!w.loaded ? <p role="status">Открываем черновик…</p> : <>
        {!state.picking && <>
          <div className={styles.endpoints} data-creation="endpoints">
            {(["start", "destination"] as const).map(target => <div className={styles.endpoint} key={target}>{w.target === target && picker === "address" ? inlineAddress : <button data-endpoint={target} aria-label={target === "start" ? "Откуда" : "Куда"} aria-expanded={w.target === target && picker !== null} aria-controls="creation-picker" disabled={busy} onClick={() => { w.setTarget(target); w.setCandidate(null); w.setQuery(""); setPicker(w.target === target && picker ? null : "choices"); }}><span><small>{target === "start" ? "Откуда" : "Куда"}</small><strong>{target === "start" ? w.draft.start?.address ?? "Выберите начало" : mode === "time" ? `${w.draft.minutes} мин пешком${w.draft.mode === "loop" ? " · с возвращением" : ""}` : w.draft.destination?.address ?? "Выберите место или время"}</strong></span><svg className={styles.chevron} aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></button>}{w.target === target && addressPicker}</div>)}
          </div>
        </>}
        {state.picking && <div className={styles.mapPick}><p>Нажмите на карту в нужном месте.</p><button className="ui-button quiet" onClick={() => dispatch({ type: "return" })}>Отменить</button></div>}
        {built && w.draft.stops.length > 0 && <details className={styles.details}><summary>Остановки · {w.draft.stops.length}</summary><ol className={styles.stops} data-creation="stops">{w.draft.stops.map((stop, i) => <li key={`${stop.address}-${i}`}>{stop.address}</li>)}</ol>
          {w.nextPlace && <label className={styles.consent}><input type="checkbox" checked={w.reviewed} onChange={e => w.setReviewed(e.target.checked)} />Подготовить историю выбранной остановки с помощью ИИ. Факты будут проверены по источникам.</label>}
          {w.nextPlace && <button className="ui-button secondary" disabled={busy || !w.reviewed || !!w.activeJob || !!w.draft.submitting || !!w.storageError} onClick={() => void w.prepareNext()}>Подготовить историю</button>}
          {w.draft.jobs.length > 0 && <div className={styles.jobs}>{w.draft.jobs.map(job => <Link key={job.id} href={`/?job=${job.id}`}>История: {job.place.address} →</Link>)}</div>}
        </details>}
        <ResearchPanel draft={w.draft} current={w.current} persist={w.persist} offered={w.researchOffered} disabled={busy || !!w.storageError} chooseStartDisabled={busy} action={w.action} setBusy={w.setBusy} onApply={() => void w.openWalk()} onChooseStart={() => { w.setTarget("start"); w.edit({}); }} />
        {w.draft.submitting && <div className="ui-notice"><p>Результат отправки неизвестен. Введите ID истории из раздела запросов профиля.</p><label className="ui-field">ID истории<input value={w.recoveryId} onChange={e => w.setRecoveryId(e.target.value)} /></label><button className="ui-button secondary" onClick={() => void w.recoverJob()}>Восстановить</button></div>}
      </>}
      {w.storageError && <div role="alert" className="ui-notice">{w.storageError}<button className={styles.textButton} onClick={w.download}>Скачать черновик</button></div>}
      {w.error && <p className="ui-notice" role="alert">{w.error}</p>}
      {w.message && <p className="ui-notice" role="status">{w.message}</p>}
      {busy && <p role="status" className="ui-muted">{w.busy || "Определяем местоположение…"}</p>}
  </Sheet>;
}

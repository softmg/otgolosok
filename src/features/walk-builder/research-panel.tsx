"use client";

import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { terminalStages } from "../generator/types";
import { applyResearch, readResearchJob, researchKey, researchLookup, researchMatches, type Draft, type ResearchJob, type ResearchRef } from "./model";
import { request, RequestError } from "./request";

const phases = { discovery: "Ищем адреса поблизости", research: "Проверяем источники об адресах", routing: "Соединяем подтверждённые остановки", narration: "Готовим тексты и аудио", complete: "Прогулка готова" };

export function ResearchPanel({ draft, current, persist, offered, disabled, chooseStartDisabled, action: actionRef, setBusy, onApply, onChooseStart }: {
  draft: Draft; current: RefObject<Draft>; persist: (draft: Draft) => boolean;
  offered: boolean; disabled: boolean; chooseStartDisabled: boolean; action: RefObject<AbortController | null>;
  setBusy: (value: string) => void; onApply: () => void; onChooseStart: () => void;
}) {
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [restore, setRestore] = useState(0);
  const posting = useRef(false);
  // Only restoration or an explicit status check permits lookup of an uncertain send.
  const initial = useRef(draft.research);
  const ref = draft.research;
  const identity = ref ? `${researchKey(ref.request)}:${ref.recoveryToken}:${ref.id ?? "intent"}` : "";

  function accept(value: unknown, expected: ResearchRef) {
    const result = readResearchJob(value, expected);
    const latest = current.current.research;
    if (!latest || latest.recoveryToken !== expected.recoveryToken || researchKey(latest.request) !== researchKey(expected.request) || (latest.id && latest.id !== result.id)) return;
    setJob(previous => previous?.id === result.id && previous.revision > result.revision ? previous : result);
    // Keep the known ID in memory even if storage fails; persist never rolls back state.
    if (latest.id !== result.id) persist({ ...current.current, research: { ...latest, id: result.id } });
    setMissing(false); setError("");
  }
  const receive = useEffectEvent(accept);
  useEffect(() => {
    if (!ref || (!ref.id && initial.current !== ref)) return;
    const expected = ref;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        if (posting.current) { timer = setTimeout(() => void poll(), 3000); return; }
        const value = await request(expected.id ? `/api/walk-research-jobs/${expected.id}` : researchLookup(expected.request, expected.recoveryToken), controller.signal);
        if (controller.signal.aborted) return;
        const result = readResearchJob(value, expected);
        receive(result, expected); failures = 0;
        if (!terminalStages.has(result.stage)) timer = setTimeout(() => void poll(), 3000);
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof RequestError && caught.code === "NOT_FOUND") {
          setJob(null);
          setMissing(true); setError(expected.id ? "Сохранённая задача не найдена. Её ID остаётся в черновике." : "Сервер не нашёл задачу для сохранённой отправки. Можно явно попробовать снова.");
          return;
        }
        setError(`${caught instanceof Error ? caught.message : "Связь прервалась."} Продолжим проверять статус; работа на сервере не отменена.`);
        timer = setTimeout(() => void poll(), Math.min(60000, 3000 * 2 ** Math.min(++failures, 5)));
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
    // Identity, not draft edits or polling results, owns the read-only subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, restore]);

  async function submit(retry = false) {
    if (actionRef.current || posting.current || disabled || !consent) return;
    const latest = current.current;
    if (retry ? !job?.canRetry || latest.research?.id !== job.id : !(offered || (missing && latest.research && researchMatches(latest, latest.research))) || !latest.start || (latest.research && !missing && researchMatches(latest, latest.research))) return;
    posting.current = true;
    const controller = new AbortController(); actionRef.current = controller;
    setBusy(retry ? "Продолжаем исследование…" : "Отправляем исследование…"); setError("");
    try {
      const snapshot = { start: latest.start!, ...(latest.destination ? {destination:latest.destination} : {}), mode: latest.mode, minutes: latest.minutes };
      const expected: ResearchRef = retry ? latest.research! : { request: snapshot, stops: latest.stops, id: null, recoveryToken: latest.research && researchKey(latest.research.request) === researchKey(snapshot) ? latest.research.recoveryToken : crypto.randomUUID() };
      // The synchronous storage comparison also rejects stale tabs before any POST.
      if (!persist({ ...latest, research: expected })) return;
      if (!retry) initial.current = undefined;
      setMissing(false);
      const result = await request(retry ? `/api/walk-research-jobs/${expected.id}/retry` : "/api/walk-research-jobs", controller.signal, retry ? { revision: job!.revision } : { ...expected.request, consent: true, recoveryToken: expected.recoveryToken });
      accept(result, expected);
      if (retry) setRestore(n => n + 1);
    } catch (caught) {
      if (!controller.signal.aborted) {
        const rejected = caught instanceof RequestError && (caught.status < 500 || caught.status === 503);
        // An explicit HTTP rejection did not create a new job. Unknown transport outcomes retain intent.
        if (!retry && rejected) setMissing(true);
        setError(`${caught instanceof Error ? caught.message : "Ответ не получен."}${rejected ? "" : " Результат отправки неизвестен. Нажмите «Проверить статус» или вернитесь позже: новой отправки не будет."}`);
        if (retry) setRestore(n => n + 1);
      }
    } finally {
      posting.current = false;
      if (actionRef.current === controller) { actionRef.current = null; setBusy(""); }
    }
  }

  if (!offered && !ref) return null;
  const visibleJob = job && job.id === ref?.id ? job : null;
  const matches = !!ref && researchMatches(draft, ref);
  const canStart = (offered && (!ref || !matches || missing)) || (missing && matches);
  return <section aria-labelledby="walk-research">
    <h2 id="walk-research">Исследование района</h2>
    {offered ? <p>Для автоматического маршрута пока недостаточно готовых остановок. Можно поискать подтверждённые истории рядом или выбрать другое начало.</p> : null}
    {ref ? <p>Начало исследования: <strong>{ref.request.start.address}</strong>. {ref.request.minutes} мин пешком, {ref.request.mode === "loop" ? "с возвращением" : "без возвращения"}.</p> : null}
    {visibleJob ? <div role="status" aria-live="polite"><p><strong>{terminalStages.has(visibleJob.stage) && visibleJob.stage !== "ready" ? "Исследование остановлено" : visibleJob.stage === "queued" ? "Ждём своей очереди" : phases[visibleJob.phase]}</strong></p>{visibleJob.progress.total > 0 ? <p>Проверено адресов: {visibleJob.progress.checked} из {visibleJob.progress.total}. С подтверждениями: {visibleJob.progress.accepted}.</p> : null}{visibleJob.error ? <p className="walk-warning">{visibleJob.error.message}</p> : null}</div> : ref && !missing ? <p role="status">{ref.id ? "Проверяем сохранённое исследование…" : "Отправка сохранена. Можно проверить статус сейчас или при возвращении, без новой отправки."}</p> : null}
    {ref && !ref.id ? <button onClick={() => {
      if (actionRef.current || posting.current) return;
      initial.current = current.current.research;
      setRestore(n => n + 1);
    }}>Проверить статус</button> : null}
    {error ? <p className="walk-warning" role="alert">{error}</p> : null}
    {ref ? <details className="creation-details"><summary>Как продолжить позже</summary><p>Исследование продолжается после закрытия страницы. Вернитесь к прогулке из истории в этом браузере. Если сохранить черновик не удалось, скачайте его перед уходом.</p>{ref.id && <p className="walk-muted">ID исследования: {ref.id}</p>}</details> : null}
    {ref && !matches && !draft.researchApplied ? <p>Параметры или остановки изменены. Сохранённое исследование остаётся доступно, но его маршрут нельзя применить к этой версии прогулки.</p> : null}
    {canStart || visibleJob?.canRetry ? <>
      <p>Проверим не более 3 адресов поблизости. Подтверждений может не хватить, и прогулка не гарантирована. Время подготовки заранее неизвестно. Исследование и повтор расходуют общий лимит сервиса.</p>
      <label className="walk-check"><input type="checkbox" checked={consent} disabled={disabled} onChange={e => setConsent(e.target.checked)} /> Разрешаю передать координаты картографическому сервису, адреса провайдерам исследования, а также автоматически подготовить тексты и аудио для найденного маршрута.</label>
      <div className="walk-actions">{canStart ? <button className="walk-primary" disabled={disabled || !consent} onClick={() => void submit()}>Исследовать район</button> : null}{visibleJob?.canRetry ? <button disabled={disabled || !consent} onClick={() => void submit(true)}>Продолжить исследование</button> : null}</div>
    </> : null}
    {visibleJob?.stage === "ready" && !draft.researchApplied ? <><p>Применение сохранит готовый маршрут и ссылки на истории. Новые исследования, тексты или аудио при этом не заказываются.</p><button className="walk-primary" disabled={disabled || !matches} onClick={() => {
      try { if (persist(applyResearch(current.current, visibleJob))) onApply(); }
      catch (caught) { setError(caught instanceof Error ? caught.message : "Не удалось применить прогулку."); }
    }}>Использовать прогулку</button></> : null}
    {draft.researchApplied ? <p role="status">Исследованная прогулка применена. Готовые истории находятся ниже; дополнительных заказов нет.</p> : null}
    <button disabled={chooseStartDisabled} onClick={onChooseStart}>Выбрать другое начало</button>
  </section>;
}

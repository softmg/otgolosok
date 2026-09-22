"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { placeFromQuery, rememberMapJob } from "../explore/map-jobs";
import { jobUrl } from "../generator/offline";
import { terminalStages, type GenerationJob } from "../generator/types";
import type { Coordinates } from "../tour/types";
import { DRAFT_KEY, editDraft, emptyDraft, isJobId, isPlace, isPlan, isStage, parseDraft, rememberStory, storyAddressKey, saveDraft, validStops, type Draft, type Place } from "./model";
import { request, RejectedRequest, shouldOfferResearch } from "./request";
import { accountApi, getSession } from "../auth/client";
import { draftToWalkDocument, walkDocumentToDraft } from "../walks/adapters";
import { getLocalWalk, migrateLocalWalks, saveLocalWalk } from "../walks/local-store";
import { creationInputError } from "./creation-location";

function readJob(value: unknown): GenerationJob {
  if (!value || typeof value !== "object" || !("id" in value) || !("stage" in value) || !isJobId(value.id) || !isStage(value.stage)) throw new Error("Не удалось прочитать состояние истории.");
  return value as GenerationJob;
}

export function useWalkDraft() {
  const router=useRouter();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const current = useRef(draft);
  const stored = useRef<string | null>(null);
  const writable = useRef(false);
  const [initialMode, setInitialMode] = useState<"destination" | "time">("destination");
  const [localIdForView, setLocalIdForView] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const action = useRef<AbortController | null>(null);
  const [candidate, setCandidate] = useState<Place | null>(null);
  const [target, setTarget] = useState<"start" | "destination" | "stop">("start");
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<Coordinates | null>(null);
  const [selection, setSelection] = useState<"auto" | "manual">("auto");
  const [reviewed, setReviewed] = useState(false);
  const [researchOffered, setResearchOffered] = useState(false);
  const [pollId, setPollId] = useState<string | null>(null);
  const [recoveryId, setRecoveryId] = useState("");
  const [accountUser,setAccountUser]=useState<{id:string}|null>(null);
  const [serverWalk,setServerWalk]=useState<{id:string;revision:number}|null>(null);
  const localWalkId = useRef<string | null>(null);
  const localRevision = useRef<number | null>(null);
  const documentRef = useRef<ReturnType<typeof draftToWalkDocument> | null>(null);
  const accountOperationKey = useRef<string | null>(null);
  const statusRequest = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);

  // Browser storage is restored after hydration; account editing stays locked until its document loads.
  useEffect(() => {
    let active = true;
    async function restore() {
      try {
        stored.current = localStorage.getItem(DRAFT_KEY);
        let restored = parseDraft(stored.current);
        current.current = restored;
        const params = new URLSearchParams(location.search);
        const inputError = creationInputError(params);
        if (inputError) throw new Error(inputError);
        const incoming = placeFromQuery(params);
        const fresh = !params.get("id") && !params.get("local") && !params.get("resume");
        const hasSaved = Boolean(restored.start) && !fresh;
        const explicitWalkId = params.get("id");
        const walkId = explicitWalkId ?? (!params.get("local") && hasSaved ? localStorage.getItem("otgolosok:walk:active-account") : null);
        const migratedId = migrateLocalWalks(localStorage);
        const selectedLocalId = params.get("local") ?? (!walkId && hasSaved ? localStorage.getItem("otgolosok:walk:active-local") ?? migratedId : null);
        if (fresh) {
          let previousId = localStorage.getItem("otgolosok:walk:active-local") ?? migratedId;
          if (localStorage.getItem("otgolosok:walk:active-account") && restored.start) {
            previousId = crypto.randomUUID();
            saveLocalWalk(localStorage, draftToWalkDocument(restored, previousId), null);
          }
          if (previousId && stored.current) localStorage.setItem(`otgolosok:walk:pending:${previousId}`, stored.current);
          restored = emptyDraft();
        }
        if (selectedLocalId) {
          const pending = localStorage.getItem(`otgolosok:walk:pending:${selectedLocalId}`);
          if (pending) restored = parseDraft(pending);
          const item = getLocalWalk(localStorage, selectedLocalId);
          if (!item) throw new Error("Локальная прогулка не найдена. Исходные данные сохранены.");
          const sameDraft = selectedLocalId === localStorage.getItem("otgolosok:walk:active-local") || selectedLocalId === migratedId;
          restored = { ...walkDocumentToDraft(item.document, restored.jobs), ...(sameDraft || pending ? {research:restored.research,researchApplied:restored.researchApplied,submitting:restored.submitting} : {}) };
          localWalkId.current = item.document.id; localRevision.current = item.revision; documentRef.current = item.document;
        } else if (!walkId) localWalkId.current = crypto.randomUUID();
        // Session lookup is bounded; local editing remains available if the service is offline.
        let user = null;
        try { user = await getSession(); }
        catch (caught) { if (walkId) throw caught; if (active) setError("Не удалось проверить вход. Локальный черновик доступен."); }
        if (!active) return;
        setAccountUser(user);
        if (walkId) {
          if (!user) { router.replace(`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`); return; }
          const data = await accountApi(`/api/me/walks/${encodeURIComponent(walkId)}`);
          if (!active) return;
          if (data.walk.snapshotError) throw new Error(data.walk.snapshotError);
          const pendingAccount = localStorage.getItem("otgolosok:walk:active-account") === walkId;
          const pendingRevision = Number(localStorage.getItem("otgolosok:walk:active-revision"));
          if (pendingAccount && hasSaved && pendingRevision !== data.walk.revision) throw new Error("Прогулка в аккаунте изменилась. Скачайте черновик перед обновлением страницы.");
          restored = pendingAccount && hasSaved ? restored : data.walk.snapshot?.version === 2 ? walkDocumentToDraft(data.walk.snapshot) : parseDraft(JSON.stringify(data.walk.snapshot));
          documentRef.current = data.walk.snapshot;
          setServerWalk({ id: data.walk.id, revision: data.walk.revision });
          localStorage.setItem("otgolosok:walk:active-account",data.walk.id);
          localStorage.setItem("otgolosok:walk:active-revision",String(data.walk.revision));
        }
        if (!hasSaved && !walkId && !params.get("local") && isPlace(incoming)) restored = { ...emptyDraft(), start: incoming, title: `Прогулка от ${incoming.address}` };
        setInitialMode(restored.destination ? "destination" : hasSaved || selectedLocalId || walkId ? "time" : "destination");
        current.current = restored; setDraft(restored); writable.current = true;
        setSelection(restored.stops.length ? "manual" : "auto");
        setFocus(restored.start?.location ?? null); setLocalIdForView(localWalkId.current);
        if (!hasSaved && isPlace(incoming)) persist(restored);
      } catch (caught) { if (active) { setDraft(current.current); setStorageError(caught instanceof Error ? caught.message : "Не удалось открыть черновик."); } }
      finally { if (active) setLoaded(true); }
    }
    void restore();
    return () => { active = false; action.current?.abort(); statusRequest.current?.controller.abort(); statusRequest.current = null; };
    // Restore once for this document; the parent remounts when its identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function persist(next: Draft) {
    current.current = next; setDraft(next);
    if (!writable.current) return false;
    try {
      stored.current = saveDraft(localStorage, next, stored.current);
      if (localWalkId.current) {
        const document = draftToWalkDocument(next, localWalkId.current, documentRef.current);
        const item = saveLocalWalk(localStorage, document, localRevision.current);
        documentRef.current = document;
        localRevision.current = item.revision;
        localStorage.setItem("otgolosok:walk:active-local", item.document.id);
        localStorage.setItem(`otgolosok:walk:pending:${item.document.id}`, JSON.stringify(next));
        localStorage.removeItem("otgolosok:walk:active-account");
      }
      setStorageError(""); return true;
    } catch (caught) {
      writable.current = false;
      setStorageError(caught instanceof Error ? caught.message : "Не удалось сохранить. Не закрывайте страницу; скачайте копию.");
      return false;
    }
  }
  function edit(change: Parameters<typeof editDraft>[1]) {
    setReviewed(false); setError(""); setMessage(""); setResearchOffered(false);
    if (change.stops) setSelection("manual");
    else if (["start", "destination", "mode", "minutes"].some(key => Object.hasOwn(change, key))) setSelection("auto");
    persist(editDraft(current.current, change));
  }

  function refreshJobs(): Promise<void> {
    if (statusRequest.current) return statusRequest.current.promise;
    const controller = new AbortController();
    const promise = (async () => {
      const updates = new Map<string, GenerationJob>();
      for (const id of new Set(current.current.jobs.map(j => j.id))) {
        const job = readJob(await request(jobUrl(id), controller.signal));
        controller.signal.throwIfAborted();
        if (job.id !== id) throw new Error("Сервис вернул другую историю.");
        updates.set(id, job);
      }
      controller.signal.throwIfAborted();
      if (updates.size && !persist({ ...current.current, jobs: current.current.jobs.map(j => ({ ...j, stage: updates.get(j.id)?.stage ?? j.stage })) })) throw new Error("Не удалось сохранить обновлённые статусы.");
    })().finally(() => { if (statusRequest.current?.controller === controller) statusRequest.current = null; });
    statusRequest.current = { controller, promise };
    return promise;
  }
  const refreshOnFocus = useEffectEvent(() => {
    if (action.current || !writable.current) return;
    void refreshJobs().catch(caught => {
      if (caught instanceof Error && caught.name !== "AbortError") setError(caught.message);
    });
  });
  useEffect(() => {
    if (!loaded) return;
    refreshOnFocus();
    const focus = () => refreshOnFocus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [loaded]);

  const refreshForPoll = useEffectEvent(refreshJobs);
  // Refresh is GET-only, including terminal jobs retried in the linked generator.
  useEffect(() => {
    if (!pollId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (action.current) { timer = setTimeout(() => void poll(), 3000); return; }
        await refreshForPoll();
        if (controller.signal.aborted) return;
        const job = current.current.jobs.find(j => j.id === pollId);
        if (!job || terminalStages.has(job.stage)) { setPollId(null); return; }
        timer = setTimeout(() => void poll(), 3000);
      } catch (caught) {
        if (!controller.signal.aborted) { setError(caught instanceof Error ? caught.message : "Связь прервалась. Обновите статус кнопкой."); setPollId(null); }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pollId]);

  async function resolve(value: Coordinates | string) {
    if (action.current) return;
    setReviewed(false); setCandidate(null); setError("");
    const controller = new AbortController(); action.current = controller; setBusy("Ищем адрес…");
    try {
      const params = new URLSearchParams(typeof value === "string" ? { q: value } : { lat: String(value.lat), lon: String(value.lon) });
      const found = await request(`/api/story-place?${params}`, controller.signal);
      if (controller.signal.aborted) return;
      if (!isPlace(found)) throw new Error("Не найден точный адрес дома в Москве. Уточните улицу и номер.");
      const place = { address: found.address, location: { lat: found.location.lat, lon: found.location.lon } };
      setCandidate(place); setFocus(place.location);
      return place;
    } catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Не удалось найти адрес."); }
    finally { if (!controller.signal.aborted) { action.current = null; setBusy(""); } }
  }
  function confirmPlace() {
    if (!candidate) return;
    if (target === "start") edit({ start: candidate });
    else if (target === "destination") edit({ destination: candidate, mode: "open" });
    else {
      const stops = [...draft.stops, candidate];
      if (!validStops(draft.start, stops)) { setError("Добавьте от 1 до 10 разных мест, не совпадающих друг с другом."); return; }
      edit({ stops }); setSelection("manual");
    }
    setCandidate(null); setQuery("");
  }
  async function plan() {
    if (!draft.start || action.current || candidate) return;
    const snapshot = current.current;
    const controller = new AbortController(); action.current = controller; setBusy("Строим пешеходный маршрут…");
    setReviewed(false); setError(""); setResearchOffered(false); persist({ ...snapshot, route: null, researchApplied: false });
    try {
      const result = await request("/api/walk-plan", controller.signal, { start: snapshot.start, mode: snapshot.mode, minutes: snapshot.minutes, ...(snapshot.destination ? {destination:snapshot.destination} : {}), ...(selection === "manual" ? { stops: snapshot.stops } : {}) });
      if (controller.signal.aborted) return;
      if (!isPlan(result) || !validStops(snapshot.start, result.stops, snapshot.destination) || result.walkingMinutes > snapshot.minutes || (selection === "manual" && JSON.stringify(result.stops) !== JSON.stringify(snapshot.stops))) throw new Error("Сервис вернул некорректный маршрут. Попробуйте построить заново.");
      persist({ ...current.current, stops: result.stops, route: result }); setSelection("manual");
      setMessage("");
    } catch (caught) { if (!controller.signal.aborted) {
      const insufficient = shouldOfferResearch(selection, caught);
      setResearchOffered(insufficient);
      setError(insufficient ? "Рядом пока недостаточно готовых остановок для этой прогулки." : caught instanceof Error ? caught.message : "Маршрут недоступен.");
    } }
    finally { if (!controller.signal.aborted) { action.current = null; setBusy(""); } }
  }
  const places = draft.stops;
  const nextPlace = places.find(p => !p.contentId && !draft.jobs.some(j => storyAddressKey(j.place.address) === storyAddressKey(p.address)));
  const activeJob = draft.jobs.find(j => !terminalStages.has(j.stage));
  async function prepareNext() {
    if (action.current || !reviewed || !draft.route || draft.researchApplied || candidate || !nextPlace || activeJob || draft.submitting || !writable.current) return;
    const controller = new AbortController(); action.current = controller; setBusy("Создаём одну историю…"); setError("");
    try {
      await refreshJobs();
      controller.signal.throwIfAborted();
      if (current.current.jobs.some(j => !terminalStages.has(j.stage))) {
        setMessage("Другая история ещё готовится, возможно после повтора. Дождитесь завершения."); return;
      }
      // Record the intent only after revalidating every known job, before POST.
      if (!persist({ ...current.current, submitting: nextPlace })) return;
      const job = readJob(await request("/api/story-jobs", controller.signal, { address: nextPlace.address, idempotencyKey: crypto.randomUUID() }));
      if (controller.signal.aborted) return;
      const saved = persist({ ...current.current, submitting: null, jobs: rememberStory(current.current.jobs, { place: nextPlace, id: job.id, stage: job.stage }) });
      rememberMapJob(job, nextPlace);
      if (saved && !terminalStages.has(job.stage)) setPollId(job.id);
      setMessage("Ссылка на историю сохранена. Следующую можно подготовить после завершения этой.");
    } catch (caught) {
      if (!controller.signal.aborted) {
        if (caught instanceof RejectedRequest) {
          persist({ ...current.current, submitting: null });
          setError(caught.message);
        } else setError(`${caught instanceof Error ? caught.message : "Запрос прервался."} ${current.current.submitting ? "Результат отправки неизвестен. Не повторяем её автоматически." : "Новая история не отправлена. Обновите статусы и повторите действие."}`);
      }
    }
    finally { if (!controller.signal.aborted) { action.current = null; setBusy(""); } }
  }
  async function recoverJob() {
    if (!draft.submitting || !isJobId(recoveryId) || action.current) return;
    const controller = new AbortController(); action.current = controller; setBusy("Проверяем историю…"); setError("");
    try {
      await refreshJobs();
      controller.signal.throwIfAborted();
      const job = readJob(await request(jobUrl(recoveryId), controller.signal));
      if (controller.signal.aborted) return;
      if (job.id !== recoveryId || typeof job.address !== "string" || storyAddressKey(job.address) !== storyAddressKey(draft.submitting.address)) throw new Error("История относится к другому адресу.");
      persist({ ...current.current, submitting: null, jobs: rememberStory(current.current.jobs, { place: draft.submitting, id: job.id, stage: job.stage }) });
    } catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Не удалось проверить историю."); }
    finally { if (!controller.signal.aborted) { action.current = null; setBusy(""); } }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(current.current, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "otgolosok-walk.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function saveToAccount(){
    if(!accountUser){router.push(`/login?returnTo=${encodeURIComponent(location.pathname+location.search)}`);return;}
    setBusy("Сохраняем прогулку…");setError("");
    try {
      const id = serverWalk?.id ?? documentRef.current?.id ?? localWalkId.current ?? crypto.randomUUID();
      const snapshot = draftToWalkDocument(current.current, id, documentRef.current);
      documentRef.current = snapshot;
      const title = snapshot.title;
      if (serverWalk) {
        const data = await accountApi(`/api/me/walks/${serverWalk.id}`,{method:"PATCH",body:JSON.stringify({title,snapshot,revision:serverWalk.revision})});
        setServerWalk({id:data.walk.id,revision:data.walk.revision});
        localStorage.setItem("otgolosok:walk:active-account",data.walk.id);
        localStorage.setItem("otgolosok:walk:active-revision",String(data.walk.revision));
      } else {
        const keyName = `otgolosok:walk:account-operation:${id}`;
        const key = accountOperationKey.current ?? localStorage.getItem(keyName) ?? `walk-${crypto.randomUUID()}`;
        accountOperationKey.current = key;
        localStorage.setItem(keyName, key);
        const data = await accountApi("/api/me/walks",{method:"POST",body:JSON.stringify({title,snapshot,idempotencyKey:key})});
        setServerWalk({id:data.walk.id,revision:data.walk.revision});
        localStorage.setItem("otgolosok:walk:active-account",data.walk.id);
        localStorage.setItem("otgolosok:walk:active-revision",String(data.walk.revision));
        if(!new URLSearchParams(location.search).get("id"))history.replaceState(null,"",`/?walk=create&id=${data.walk.id}&edit=1`);
      }
      localWalkId.current = null;
      setMessage("Прогулка сохранена в личном кабинете.");
    } catch(caught) { setError(caught instanceof Error?caught.message:"Не удалось сохранить прогулку."); }
    finally {setBusy("");}
  }
  const openHref = serverWalk ? `/walk?id=${serverWalk.id}` : localIdForView ? `/walk?local=${localIdForView}` : null;
  return {initialMode,draft,current,persist,edit,loaded,storageError,message,error,busy,action,candidate,setCandidate,target,setTarget,query,setQuery,focus,selection,setSelection,reviewed,setReviewed,researchOffered,pollId,setPollId,recoveryId,setRecoveryId,resolve,confirmPlace,plan,prepareNext,recoverJob,download,saveToAccount,serverWalk,openHref,nextPlace,activeJob,setBusy,setError};
}

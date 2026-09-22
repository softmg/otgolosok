"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { BrandMark } from "../brand/brand-mark";
import { useRouter } from "next/navigation";
import { formatPlaybackTime } from "@/lib/audio/playback-progress";
import { jobUrl, isStorySaved, saveStoryOffline, removeSavedStory, savedStories } from "./offline";
import { placeFromQuery, rememberMapJob } from "../explore/map-jobs";
import { stageLabels, terminalStages, type GenerationJob } from "./types";

const LAST_JOB = "otgolosok:generated-job";
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const stages = ["researching","verifying","writing","voicing"] as const;

async function requestJob(path: string, body?: object, signal?: AbortSignal): Promise<GenerationJob> {
  const controller = new AbortController();
  const relay = () => controller.abort();
  signal?.addEventListener("abort",relay,{once:true});
  if (signal?.aborted) relay();
  const timer = setTimeout(relay,15000);
  try {
    const response = await fetch(path,{method:body?"POST":"GET",signal:controller.signal,
      ...(body?{headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message ?? "Сервис пока недоступен. Попробуйте позже.");
    if (!idPattern.test(value.id) || !(value.stage in stageLabels)) throw new Error("Не удалось прочитать состояние истории.");
    return value;
  } finally {clearTimeout(timer);signal?.removeEventListener("abort",relay);}
}

export function StoryGenerator() {
  const router = useRouter();
  const [address,setAddress] = useState("");
  const [job,setJob] = useState<GenerationJob|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [saved,setSaved] = useState(false);
  const [saving,setSaving] = useState(false);
  const [saveMessage,setSaveMessage] = useState("");
  const [library,setLibrary] = useState<GenerationJob[]>([]);
  const [refresh,setRefresh] = useState(0);
  const requestVersion = useRef(0);
  const requestedPlace = useRef<ReturnType<typeof placeFromQuery>>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const lastAudioSave = useRef(0);
  const activeRequest = useRef<AbortController|null>(null);

  function remember(value: GenerationJob) {
    rememberMapJob(value, requestedPlace.current);
    try {localStorage.setItem(LAST_JOB,value.id);} catch { /* Listening still works without persistence. */ }
    history.replaceState(null,"",`/create?job=${value.id}`);
  }

  useEffect(()=>{
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.register("/sw.js",{scope:"/",updateViaCache:"none"}).catch(()=>{});
    }
    const controller=new AbortController();activeRequest.current=controller;
    const version=requestVersion.current;
    void savedStories().then(setLibrary).catch(()=>{});
    void (async()=>{
      const params=new URLSearchParams(location.search);
      let id=params.get("job");
      if (!id && (params.has("address") || params.has("new"))) {
        setAddress((params.get("address") ?? "").slice(0,180));
        requestedPlace.current=placeFromQuery(params);
        return;
      }
      try {id ||= localStorage.getItem(LAST_JOB);} catch { /* No saved job. */ }
      if(!id||!idPattern.test(id))return;
      try {const value=await requestJob(jobUrl(id),undefined,controller.signal);if(version===requestVersion.current){setJob(value);setAddress(value.address);remember(value);}}
      catch {if(!controller.signal.aborted&&version===requestVersion.current)setError("Не удалось открыть последнюю историю. Проверьте интернет или выберите сохранённую ниже.");}
    })();
    return ()=>{controller.abort();activeRequest.current?.abort();};
  },[]);

  useEffect(()=>{
    if(!job||terminalStages.has(job.stage))return;
    const controller=new AbortController();activeRequest.current=controller;
    const version=requestVersion.current;
    const timer=setTimeout(()=>{
      void requestJob(jobUrl(job.id),undefined,controller.signal).then((value)=>{
        if(version===requestVersion.current){setJob(value);setError("");}
      }).catch(()=>{
        if(!controller.signal.aborted&&version===requestVersion.current){setError("Связь прервалась. Подготовка продолжается на сервере.");setRefresh((value)=>value+1);}
      });
    },error?8000:2500);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[job,error,refresh]);

  useEffect(()=>{
    let cancelled=false;
    if(job)void isStorySaved(job).then((value)=>{if(!cancelled)setSaved(value);}).catch(()=>{});
    return ()=>{cancelled=true;};
  },[job]);

  async function submit(event: FormEvent) {
    event.preventDefault();if(busy)return;
    requestVersion.current+=1;const version=requestVersion.current;
    activeRequest.current?.abort();const controller=new AbortController();activeRequest.current=controller;
    audioRef.current?.pause();setBusy(true);setError("");setSaveMessage("");setSaved(false);setJob(null);
    try {const value=await requestJob("/api/story-jobs",{address,idempotencyKey:crypto.randomUUID()},controller.signal);if(version===requestVersion.current){setJob(value);remember(value);}}
    catch(caught){if(version===requestVersion.current&&!controller.signal.aborted){const message=caught instanceof Error?caught.message:"Не удалось создать историю.";setError(message);if(message.includes("Войдите"))setTimeout(()=>router.push(`/login?returnTo=${encodeURIComponent(location.pathname+location.search)}`),700);}}
    finally {if(version===requestVersion.current)setBusy(false);}
  }

  async function retry() {
    if(!job||busy)return;setBusy(true);setError("");
    const version=requestVersion.current;
    try {const value=await requestJob(`${jobUrl(job.id)}/retry`,{revision:job.revision});if(version===requestVersion.current)setJob(value);}
    catch(caught){if(version===requestVersion.current)setError(caught instanceof Error?caught.message:"Не удалось повторить.");}
    finally {if(version===requestVersion.current)setBusy(false);}
  }

  async function toggleSaved() {
    if(!job||saving)return;setSaving(true);setSaveMessage("");
    const version=requestVersion.current;
    try {
      if(saved)await removeSavedStory(job);else await saveStoryOffline(job);
      const next=await isStorySaved(job);setLibrary(await savedStories());
      if(version===requestVersion.current){setSaved(next);setSaveMessage(next?"Текст и запись сохранены. Источники открываются при наличии интернета.":"Офлайн-копия удалена.");}
    } catch(caught){if(version===requestVersion.current)setSaveMessage(caught instanceof Error?caught.message:"Не удалось сохранить историю. Проверьте свободное место.");}
    finally {setSaving(false);}
  }

  function openSaved(value: GenerationJob) {
    requestVersion.current+=1;activeRequest.current?.abort();audioRef.current?.pause();
    setJob(value);setAddress(value.address);setSaved(true);setError("");setBusy(false);setSaveMessage("");remember(value);
  }

  function persistAudio(force=false) {
    const audio=audioRef.current;
    if(!job?.audio||!audio||audio.readyState<1||(!force&&Math.abs(audio.currentTime-lastAudioSave.current)<2))return;
    lastAudioSave.current=audio.currentTime;
    try {localStorage.setItem(`otgolosok:generated-audio:${job.audio.sha256}`,String(audio.currentTime));} catch { /* Optional resume. */ }
  }

  const activeIndex=job?stages.indexOf(job.stage as typeof stages[number]):-1;
  return <main className="shell generator-shell">
    <header className="masthead"><Link className="wordmark" href="/" prefetch={false}><BrandMark /></Link><span><Link className="generator-home" href="/account" prefetch={false}>Кабинет</Link> · <Link className="generator-home" href="/" prefetch={false}>На карту</Link></span></header>
    <section className="generator-intro" aria-labelledby="generator-title">
      <h1 id="generator-title">История одного дома</h1>
      <p>Укажите адрес в Москве. Найдём источники, подготовим короткий рассказ и озвучим его. Ориентир — 5–10 минут, если материалов достаточно.</p>
      <form onSubmit={submit} className="generator-form">
        <label htmlFor="story-address">Улица, дом и строение</label>
        <input id="story-address" name="address" value={address} onChange={(event)=>setAddress(event.target.value)} minLength={6} maxLength={180} required autoComplete="street-address" placeholder="Кожевническая улица, 16, строение 1" aria-describedby="address-note" />
        <p id="address-note">Для поиска отправим введённый адрес. Ваша геопозиция не нужна.</p>
        <button type="submit" className="start-button" disabled={busy||address.trim().length<6}><span>{busy?"Отправляем адрес…":"Подготовить историю"}</span><b aria-hidden="true">→</b></button>
      </form>
      {error?<p role="alert" className="generator-error">{error}</p>:null}
    </section>

    {job?<section className="generation-result" aria-labelledby="generation-status">
      <div className="generation-heading" role="status"><h2 id="generation-status">{stageLabels[job.stage]}</h2><span>{formatPlaybackTime(job.elapsedSec)}</span></div>
      <p className="generation-address">{job.address}</p>
      {!terminalStages.has(job.stage)?<>
        <ol className="generation-stages">{stages.map((stage,index)=><li key={stage} aria-current={index===activeIndex?"step":undefined} data-complete={index<activeIndex}><span aria-hidden="true">{index<activeIndex?"✓":index+1}</span>{stageLabels[stage]}</li>)}</ol>
        <p className="generation-help">Можно закрыть страницу. Подготовка продолжится, а здесь сохранится ссылка на результат.</p>
      </>:null}
      {job.error?<p className="generator-error" role="status">{job.error.message}</p>:null}
      {job.stage==="review_required"?<Link className="generator-secondary" href={`/admin?job=${job.id}`} prefetch={false}>Открыть в редакторской · нужен ключ доступа</Link>:null}
      {job.canRetry?<button type="button" className="generator-secondary" disabled={busy} onClick={()=>void retry()}>{busy?"Запускаем…":job.story?"Повторить озвучку":"Повторить подготовку"}</button>:null}
      {job.story?<article className="generated-story">
        <h2>{job.story.title}</h2><p className="generation-help">{job.story.verification==="editorial"?"Рассказ проверен и подтверждён редактором.":"Подготовлено автоматически. Факты сопоставлены с источниками; редактор ещё не проверял рассказ."}</p>
        {job.audio?<div className="generated-audio"><p>Слушать · {formatPlaybackTime(job.audio.durationSec)} · синтетический голос</p>
          <audio key={job.audio.sha256} ref={audioRef} controls preload="metadata" src={job.audio.url} aria-label="Озвучка новой истории"
            onTimeUpdate={()=>persistAudio()} onPause={()=>persistAudio(true)} onSeeked={()=>persistAudio(true)}
            onLoadedMetadata={()=>{const audio=audioRef.current;if(!audio||!job.audio)return;try{const position=Number(localStorage.getItem(`otgolosok:generated-audio:${job.audio.sha256}`));if(Number.isFinite(position)&&position>0&&position<audio.duration-1)audio.currentTime=position;}catch{/* Start at the beginning. */}}} />
          <button className="generator-secondary" type="button" disabled={saving} onClick={()=>void toggleSaved()}>{saving?"Сохраняем запись…":saved?"Удалить офлайн-копию":"Сохранить для прогулки без сети"}</button>
          {saveMessage?<p role="status">{saveMessage}</p>:null}
        </div>:<p className="generation-help">Текст уже можно читать. Запись появится после озвучки.</p>}
        {job.story.paragraphs.map((paragraph,index)=><p key={index} className="generated-paragraph">{paragraph.text}</p>)}
        {job.story.audioDisposition === "not_applicable_short_text" && <p>Готова короткая справка; озвучка для неё не запланирована.</p>}
        <details className="generated-sources"><summary>Источники и подтверждённые факты</summary>
          <ol>{job.story.sources.map((source)=><li key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a><span>{source.publisher}</span></li>)}</ol>
          <ul>{job.story.facts.map((fact)=><li key={fact.id}>{fact.claim}</li>)}</ul>
        </details>
      </article>:null}
    </section>:null}
    {library.length?<section className="saved-stories" aria-labelledby="saved-stories-title"><h2 id="saved-stories-title">Сохранено для прогулки</h2><ul>{library.map((item)=><li key={item.id}><button type="button" onClick={()=>openSaved(item)}>{item.story?.title}<span>{item.address}</span></button></li>)}</ul></section>:null}
    <footer className="generator-footer"><a href="/update.html">Обновить сайт</a><Link href="/" prefetch={false}>На карту историй</Link></footer>
  </main>;
}

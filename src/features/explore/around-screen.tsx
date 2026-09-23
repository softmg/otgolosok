"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import "./place-heading.css";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { WalkCreationPanel, type CreationMap } from "../walk-builder/walk-creation-panel";
import { BrandMark } from "../brand/brand-mark";
import type { Coordinates, Route } from "../tour/types";
import { getWalkChapters } from "../tour/walk-plan";
import { jobUrl } from "../generator/offline";
import { stageLabels, terminalStages, type GenerationJob } from "../generator/types";
import { ExploreMap, type MapFocus, type MapItem, type MapViewState } from "./explore-map";
import { ExploreIcon } from "./icons";
import { AppNavigation } from "../navigation/app-navigation";
import { isMoscowPoint, MOSCOW_CENTER, readMapJobs, type MapJob } from "./map-jobs";
import { nearbyRadii, nearbyStoryCatalog, recommendNearbyStories, type NearbyRadius } from "./nearby-stories";
import { selectExplorePanel } from "./panel-state";
import { rememberGeoPromptDismissal, shouldShowGeoPrompt } from "./geo-prompt";
import "./explore.css";

type Place = {label:string; address:string|null; location:Coordinates};
type StoryPin = MapItem & {address:string; duration?:number; chapter?:number; jobId?:string; placeId?:string; audioUrl?:string; status?:string; paragraphs?:string[]};
type CatalogPlace = {id:string;name:string;address:string|null;location:Coordinates;story:{title:string;paragraphs:Array<{text:string}>;sources?:unknown[];facts?:unknown[]}|null;audio:{url:string;durationSec:number}|null;distanceM:number|null};
type Tab = "nearby" | "walk";
// Keep the nearby viewport across client-side navigation, independently of walk maps.
const nearbyMapView: MapViewState = {current:null};
const MELNIKOV: StoryPin = {id:"4c76cc5f-0fcd-41db-a36e-e63cce9b3f09",jobId:"4c76cc5f-0fcd-41db-a36e-e63cce9b3f09",title:"Воздушные телефоны Дома Мельникова",address:"Кривоарбатский переулок, 10",location:{lat:55.74805556,lon:37.58944444},duration:56};
function distance(a:Coordinates,b:Coordinates){
  const rad=Math.PI/180,dlat=(b.lat-a.lat)*rad,dlon=(b.lon-a.lon)*rad;
  return 12742000*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlon/2)**2)));
}
const distanceLabel=(meters:number)=>meters<1000?`≈ ${Math.round(meters/50)*50 || 50} м`:`≈ ${(meters/1000).toFixed(1).replace(".",",")} км`;

export function AroundScreen({route,onStart,children,updateAvailable,initialTab}: {route:Route;onStart:(chapter?:number)=>void;children:ReactNode;updateAvailable:boolean;initialTab?:Tab}) {
  const router = useRouter();
  const params = useSearchParams();
  const creating = params.get("walk") === "create" || params.get("tab") === "walk";
  const [creationMap, setCreationMap] = useState<CreationMap>({items:[], focus:null, picking:false});
  const [picked, setPicked] = useState<Coordinates | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeCreation = useCallback(() => { router.replace("/", {scroll:false}); setPicked(null); setTimeout(() => opener.current?.focus(), 0); }, [router]);
  const rememberOpener = () => { opener.current = document.activeElement as HTMLElement; };
  const pathname=usePathname();
  const [tab,setTab]=useState<Tab>(initialTab ?? "nearby");
  const [search,setSearch]=useState(false),[query,setQuery]=useState("");
  const [selected,setSelected]=useState<string>();
  const [place,setPlace]=useState<Place|null>(null),[placeBusy,setPlaceBusy]=useState(false),[placeError,setPlaceError]=useState("");
  const [focus,setFocus]=useState<MapFocus|null>(null);
  const [user,setUser]=useState<(Coordinates&{accuracyM:number})|null>(null);
  const [nearbyCenter,setNearbyCenter]=useState<Coordinates|null>(null),[nearbyRadius,setNearbyRadius]=useState<NearbyRadius>(200);
  const [geo,setGeo]=useState<"idle"|"loading"|"ready"|"error"|"denied">("idle"),[geoMessage,setGeoMessage]=useState(""),[geoOutside,setGeoOutside]=useState(false);
  const [prompt,setPrompt]=useState(false);
  const [mapHintVisible,setMapHintVisible]=useState(true);
  const [tracked]=useState<MapJob[]>(()=>typeof window==="undefined"?[]:readMapJobs()),[jobs,setJobs]=useState<Record<string,GenerationJob>>({});
  const [catalog,setCatalog]=useState<CatalogPlace[]>([]);
  const lookup=useRef<AbortController|null>(null),geoVersion=useRef(0),geoTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const input=useRef<HTMLInputElement>(null);

  useEffect(()=>{
    const cancelLocation=()=>{geoVersion.current++;if(geoTimer.current)clearTimeout(geoTimer.current);};
    return ()=>{lookup.current?.abort();cancelLocation();};
  },[]);
  useEffect(()=>{if(search)input.current?.focus();},[search]);
  useEffect(()=>{
    const timer=setTimeout(()=>setPrompt(shouldShowGeoPrompt(localStorage)),0);
    return()=>clearTimeout(timer);
  },[]);
  useEffect(()=>{
    const controller=new AbortController(),params=new URLSearchParams({limit:"100",status:"ready"});
    if(nearbyCenter){params.set("lat",String(nearbyCenter.lat));params.set("lon",String(nearbyCenter.lon));params.set("radius","5000");}
    fetch(`/api/content/places?${params}`,{signal:controller.signal,cache:"no-store"}).then(response=>response.ok?response.json():Promise.reject()).then(value=>setCatalog(Array.isArray(value.places)?value.places:[])).catch(()=>{});
    return()=>controller.abort();
  },[nearbyCenter]);
  useEffect(()=>{
    if(!tracked.length)return;
    let disposed=false,running=false;
    const controller=new AbortController();
    const settled=new Set<string>();
    const refresh=async()=>{
      if(running||document.visibilityState!=="visible")return;
      running=true;
      try {
        const values=await Promise.all(tracked.map(async item=>{
          if(settled.has(item.id))return null;
          const request=new AbortController(),relay=()=>request.abort(),timer=setTimeout(relay,12000);
          controller.signal.addEventListener("abort",relay,{once:true});
          try{const response=await fetch(jobUrl(item.id),{signal:request.signal});
            const value=await response.json();
            if(!response.ok||value.id!==item.id||!(value.stage in stageLabels))return null;
            if(terminalStages.has(value.stage))settled.add(item.id);
            return value as GenerationJob;
          }catch{return null;}finally{clearTimeout(timer);controller.signal.removeEventListener("abort",relay);}
        }));
        if(!disposed)setJobs(current=>({...current,...Object.fromEntries(values.filter(value=>value!==null).map(value=>[value.id,value]))}));
      }finally{running=false;}
    };
    void refresh();const timer=setInterval(()=>void refresh(),15000);
    document.addEventListener("visibilitychange",refresh);
    return ()=>{disposed=true;controller.abort();clearInterval(timer);document.removeEventListener("visibilitychange",refresh);};
  },[tracked]);

  const pins=useMemo<StoryPin[]>(()=>{
    const chapters=getWalkChapters(route).map((chapter,index)=>({id:chapter.id,title:chapter.title,address:chapter.place,location:chapter.location,duration:chapter.audio?.duration_sec,chapter:index,number:index+1}));
    const own=tracked.filter(item=>item.id!==MELNIKOV.id).map(item=>{
      const job=jobs[item.id];return {...item,jobId:item.id,title:job?.story?.title??item.address,duration:job?.audio?.durationSec,pending:job?!terminalStages.has(job.stage):false,status:job?stageLabels[job.stage]:"Открыть подготовку"};
    });
    const places=catalog.map(place=>({id:place.id,placeId:place.id,title:place.story?.title??place.name,address:place.address??place.name,location:place.location,duration:place.audio?.durationSec,audioUrl:place.audio?.url,status:place.audio?"Готово к прослушиванию":"Текст готов",paragraphs:place.story?.paragraphs?.map(paragraph=>paragraph.text).filter(Boolean)}));
    return [...chapters,MELNIKOV,...own,...places.filter(place=>![...chapters,MELNIKOV,...own].some(existing=>existing.id===place.id))];
  },[route,tracked,jobs,catalog]);
  const recommendations=useMemo(()=>nearbyCenter?recommendNearbyStories(nearbyCenter,nearbyRadius,[...nearbyStoryCatalog(route),...catalog.filter(place=>place.audio&&place.story).map(place=>({id:place.id,title:place.story!.title,address:place.address??place.name,location:place.location,durationSec:place.audio!.durationSec,sourceCount:place.story!.sources?.length??1,factCount:place.story!.facts?.length??1}))]):[],[nearbyCenter,nearbyRadius,route,catalog]);
  const visible=useMemo(()=>[...pins].sort((a,b)=>user?distance(user,a.location)-distance(user,b.location):0),[pins,user]);
  const creationItems=useMemo(()=>[
    ...visible.filter(pin=>!creationMap.items.some(point=>distance(pin.location,point.location)<15)).map(pin=>({...pin,compact:true})),
    ...creationMap.items,
  ],[visible,creationMap.items]);
  const active=pins.find(pin=>pin.id===selected);
  const explorePanel=selectExplorePanel({nearbyCenter:Boolean(nearbyCenter),place:Boolean(place),placeBusy,placeError:Boolean(placeError)});
  const mapItems=useMemo(()=>place?[...visible,{id:"picked-place",title:place.address??"Выбранное место",location:place.location,pending:true}]:visible,[visible,place]);

  function select(pin:StoryPin){
    lookup.current?.abort();setPlaceBusy(false);setPlaceError("");setPlace(null);setSelected(pin.id);setFocus({...pin.location});setPrompt(false);setSearch(false);setTab("nearby");
  }
  function selectRecommendation(id:string){
    const direct=pins.find(pin=>pin.id===id);
    if(direct){select(direct);return;}
    const chapterIndex=getWalkChapters(route).findIndex(chapter=>chapter.content_id===id);
    const chapter=pins.find(pin=>pin.chapter===chapterIndex);
    if(chapter)select(chapter);
  }
  function openSearch(){setTab("nearby");setSearch(true);setPrompt(false);}
  function dismissGeoPrompt(){rememberGeoPromptDismissal(localStorage);setPrompt(false);}
  async function findPlace(value:Coordinates|string){
    lookup.current?.abort();const controller=new AbortController();lookup.current=controller;
    setPrompt(false);setSelected(undefined);setPlace(null);setPlaceError("");setPlaceBusy(true);setSearch(false);
    if(typeof value!=="string"){
      setFocus({...value});setNearbyCenter(value);
      if(!isMoscowPoint(value)){setPlaceBusy(false);setPlaceError("Пока готовим истории только о Москве. Можно выбрать московский дом или открыть готовую прогулку.");return;}
    }
    const timer=setTimeout(()=>controller.abort("timeout"),12000);
    try {
      const params=new URLSearchParams(typeof value==="string"?{q:value}:{lat:String(value.lat),lon:String(value.lon)});
      const response=await fetch(`/api/story-place?${params}`,{signal:controller.signal});const result=await response.json();
      if(!response.ok)throw new Error(result.error?.message??"Не удалось определить адрес.");
      if(!result.location||!isMoscowPoint(result.location))throw new Error("Выберите адрес в Москве.");
      if(lookup.current!==controller||controller.signal.aborted)return;
      setPlace(result);setFocus(result.location);setNearbyCenter(result.location);setSearch(false);
    }catch(error){
      if(lookup.current===controller&&(!controller.signal.aborted||controller.signal.reason==="timeout"))setPlaceError(controller.signal.aborted?"Поиск занял слишком много времени. Введите адрес вручную.":error instanceof Error?error.message:"Не удалось определить адрес.");
    }finally{clearTimeout(timer);if(lookup.current===controller)setPlaceBusy(false);}
  }
  function submitSearch(event:FormEvent){event.preventDefault();if(query.trim().length>=3)void findPlace(query.trim());}
  function locate(){
    const version=++geoVersion.current;setGeo("loading");setGeoMessage("");setGeoOutside(false);
    if(geoTimer.current)clearTimeout(geoTimer.current);
    const fail=(message:string,denied=false)=>{if(version!==geoVersion.current)return;geoVersion.current++;if(geoTimer.current)clearTimeout(geoTimer.current);setGeo(denied?"denied":"error");setGeoMessage(message);if(denied)setPrompt(false);};
    if(!navigator.geolocation){fail("Геолокация недоступна. Выберите дом на карте или найдите адрес.");return;}
    geoTimer.current=setTimeout(()=>fail("Не удалось определить положение. Попробуйте ещё раз или выберите дом на карте."),13000);
    navigator.geolocation.getCurrentPosition(position=>{
      if(version!==geoVersion.current)return;if(geoTimer.current)clearTimeout(geoTimer.current);
      const point={lat:position.coords.latitude,lon:position.coords.longitude,accuracyM:position.coords.accuracy};
      setUser(point);setFocus(point);setGeo("ready");setPrompt(false);
      setNearbyCenter(point.accuracyM<=50&&isMoscowPoint(point)?point:null);
      setGeoOutside(!isMoscowPoint(point));
      setGeoMessage(!isMoscowPoint(point)?"Вы сейчас за пределами нашего каталога.":point.accuracyM>50?`Положение приблизительное: точность около ${Math.round(point.accuracyM)} м. Выберите точку на карте, чтобы точно искать рядом.`:"");
    },error=>fail(error.code===1?"Нет доступа к геолокации. Можно разрешить его в настройках или выбрать место на карте.":"Не удалось определить положение. Выберите дом на карте или повторите попытку.",error.code===1),{enableHighAccuracy:true,timeout:12000,maximumAge:30000});
  }
  function showMoscow(){setFocus({...MOSCOW_CENTER,zoom:12});setGeoMessage("");setGeoOutside(false);}
  function metadata(pin:StoryPin){return [pin.duration?`${Math.ceil(pin.duration/60)} мин · аудио`:pin.status,user?`${distanceLabel(distance(user,pin.location))} по прямой`:null].filter(Boolean).join(" · ");}
  const createHref=place?.address?`/create?${new URLSearchParams({address:place.address,lat:String(place.location.lat),lon:String(place.location.lon)})}`:"/create?new=1";
  const walkStart=place?.address?place:active;
  const walkHref=walkStart?.address?`/?${new URLSearchParams({walk:"create",address:walkStart.address,lat:String(walkStart.location.lat),lon:String(walkStart.location.lon)})}`:"/?walk=create";

  return <>
    {creating && <WalkCreationPanel key={params.get("id") ?? params.get("local") ?? "create"} onClose={closeCreation} onMap={setCreationMap} picked={picked} />}
    {tab==="nearby"?<ExploreMap viewState={nearbyMapView} items={creating ? creationItems : mapItems} geometry={creating ? creationMap.geometry : undefined} routePadding={creating ? creationMap.padding : undefined} selectedId={selected??(place?"picked-place":undefined)} focus={creating ? creationMap.focus : focus} user={user} onSelect={id=>{const pin=pins.find(value=>value.id===id);if(pin){if(creating)setPicked(pin.location);else select(pin);}}} onPoint={point=>creating ? setPicked(point) : void findPlace(point)} />:null}
    <div className={`around-content ${creating?"creation-open ":""}${tab!=="nearby"?"scroll-view":""}${search?" searching":""}`}>
      <header className="around-header">
        <div className="around-topline"><Link href="/" prefetch={false} className="around-brand"><BrandMark /></Link><button className="around-icon" type="button" aria-label={search?"Закрыть поиск":"Найти адрес"} onClick={()=>search?setSearch(false):openSearch()}><ExploreIcon name={search?"close":"search"}/></button></div>
        {tab==="walk"?<h1 id="around-title" tabIndex={-1}>Пойдём гулять.</h1>:null}
        {search?<form className="around-search" onSubmit={submitSearch}><label htmlFor="map-address">Какой дом вас интересует?</label><div><input id="map-address" ref={input} value={query} onChange={event=>setQuery(event.target.value)} minLength={3} maxLength={180} required placeholder="Улица и номер дома в Москве" autoComplete="off"/><button type="submit" disabled={placeBusy||query.trim().length<3} aria-label="Найти дом"><ExploreIcon name="arrow"/></button></div><Link href={`/create?${new URLSearchParams(query.trim()?{address:query.trim()}:{new:"1"})}`} prefetch={false}>Ввести адрес для истории вручную →</Link></form>:null}
      </header>

      {tab==="walk"?<div className="around-route">{children}</div>:null}
      {tab!=="nearby"?<div className="around-about"><details><summary>О карте и геолокации</summary><p>Карту предоставляет OpenStreetMap. При её просмотре сервис получает запросы изображений выбранного района. Геолокация включается только по кнопке и используется на устройстве. Нажатая точка или введённый адрес отправляются для поиска адреса через Nominatim. Карта требует интернета; сохранённые записи работают без сети.</p></details><a href="/update.html">{updateAvailable?"Доступна новая версия · обновить":"Проверить обновление"}</a></div>:null}
    </div>

    {tab==="nearby"?<>
      {!search?<button className="around-locate around-icon" type="button" aria-label="Моё местоположение" onClick={locate} disabled={geo==="loading"}><ExploreIcon name="locate"/></button>:null}
      <div className="around-bottom">
        {geoMessage&&!search?<div className="around-geo-message"><div><p role="status">{geoMessage}{geoOutside?<> Пока доступны истории <span className="around-geo-nowrap"><button type="button" className="around-geo-link" onClick={showMoscow}>Москвы</button>.</span></>:null}</p>{geo==="denied"?<details className="around-geo-help">
          <summary>Как разрешить геолокацию</summary>
          <p><strong>На iPhone и iPad</strong></p>
          <ol>
            <li>В Safari нажмите значок меню страницы слева от адреса, затем «Ещё» (…) → «Настройки сайта» → «Геопозиция» → «Разрешить».</li>
            <li>Если доступ всё ещё закрыт, откройте «Настройки» телефона → «Конфиденциальность и безопасность» → «Службы геолокации». Включите их и разрешите доступ для «Веб-сайты Safari» или вашего браузера при использовании.</li>
            <li>Вернитесь на сайт и повторите попытку.</li>
          </ol>
          <p>Если открыли сайт с экрана «Домой», проверьте его разрешение в «Службах геолокации». Если его нет в списке, откройте сайт в Safari.</p>
          <p>В другом браузере откройте настройки разрешений этого сайта и разрешите доступ к местоположению. Также проверьте геолокацию на устройстве.</p>
          <a href="https://support.apple.com/ru-ru/102515" target="_blank" rel="noopener noreferrer">Инструкция Apple ↗</a>
          <button className="around-text-button" type="button" onClick={locate}>Проверить снова</button>
        </details>:null}</div><button type="button" aria-label="Скрыть сообщение" onClick={()=>{setGeoMessage("");setGeoOutside(false);}}><ExploreIcon name="close"/></button></div>:null}
        {prompt&&!active&&!place&&!placeBusy&&!placeError&&!search?<section className="around-location-card" aria-labelledby="location-title"><button type="button" className="around-icon around-location-close" aria-label="Закрыть карточку" onClick={dismissGeoPrompt}><ExploreIcon name="close"/></button><h2 id="location-title">Смотрите истории рядом с вами</h2><button type="button" className="around-primary" onClick={locate} disabled={geo==="loading"}>{geo==="loading"?"Определяем положение…":geo==="denied"||geo==="error"?"Проверить снова":"Включить геолокацию"}<ExploreIcon name="locate"/></button></section>
        :active?<section className="around-place-card" aria-labelledby="selected-place-title"><div className="around-card-label"><span>{active.pending?"Готовим для вас":active.chapter!==undefined?`По дороге · часть ${active.chapter+1}`:"История места"}</span><button type="button" className="around-icon" aria-label="Закрыть карточку" onClick={()=>setSelected(undefined)}><ExploreIcon name="close"/></button></div><h2 id="selected-place-title">{active.title}</h2>{active.title!==active.address?<p>{active.address}</p>:null}<small>{metadata(active)}</small>{active.paragraphs?.length?<div className="around-story-text">{active.paragraphs.map((paragraph,index)=><p key={index}>{paragraph}</p>)}</div>:null}{active.audioUrl?<audio controls preload="metadata" src={active.audioUrl}>Ваш браузер не поддерживает аудио.</audio>:null}{active.chapter!==undefined?<button type="button" className="around-primary" onClick={()=>onStart(active.chapter)}>Слушать эту часть <ExploreIcon name="headphones"/></button>:active.jobId?<Link className="around-primary" href={`/create?job=${active.jobId}`} prefetch={false}>{active.duration?"Открыть и слушать":"Открыть подготовку"}<ExploreIcon name={active.duration?"headphones":"arrow"}/></Link>:active.placeId&&!active.paragraphs?.length?<p>Проверенный текст доступен в карточке места{active.audioUrl?"; запись можно слушать здесь.":"; озвучивание ещё не готово."}</p>:null}</section>
        :explorePanel==="place"?<section className="around-place-card" aria-labelledby="new-place-title"><header className="around-place-heading"><h2 id="new-place-title">{placeBusy?"Определяем адрес…":place?.address??"О чём расскажет этот дом?"}</h2><button type="button" className="around-icon" aria-label="Закрыть выбранное место" onClick={()=>{lookup.current?.abort();setPlace(null);setPlaceBusy(false);setPlaceError("");setNearbyCenter(null);}}><ExploreIcon name="close"/></button></header>{placeError?<p role="status">{placeError}</p>:placeBusy?<p role="status">Смотрим, какой дом находится рядом с выбранной точкой.</p>:!place?.address?<p>У этой точки нет точного номера дома. Введите адрес, чтобы мы искали историю нужного здания.</p>:null}{!placeBusy?<Link className="around-primary" href={createHref} prefetch={false}>{place?.address?"Подготовить историю этого дома":"Ввести адрес вручную"}<ExploreIcon name="plus"/></Link>:null}{place?.address?<Link className="around-secondary" href={walkHref} onClick={rememberOpener} prefetch={false}>Создать прогулку отсюда <ExploreIcon name="walk"/></Link>:null}</section>
        :explorePanel==="nearby"?<section className="around-place-card nearby-recommendations" aria-labelledby="nearby-title"><div className="around-card-label"><span>Готовые истории рядом</span></div><h2 id="nearby-title">В радиусе {nearbyRadius} м</h2><div className="nearby-radius" aria-label="Радиус поиска">{nearbyRadii.map(radius=><button key={radius} type="button" aria-pressed={nearbyRadius===radius} onClick={()=>setNearbyRadius(radius)}>{radius} м</button>)}</div>{recommendations.length?<ol className="nearby-story-list">{recommendations.map((story,index)=><li key={story.id}><div><strong>{story.title}</strong><span>{story.address} · {Math.round(story.distanceM)} м по прямой</span>{index===0?<small>{story.reason}</small>:null}</div><button type="button" className={index===0?"around-primary":"around-secondary"} onClick={()=>selectRecommendation(story.id)}>{index===0?"Слушать":"Альтернатива"}<ExploreIcon name={index===0?"headphones":"arrow"}/></button></li>)}</ol>:<div className="nearby-empty"><p>В этом радиусе пока нет готовой проверенной истории.</p>{nearbyRadius<300?<button type="button" className="around-secondary" onClick={()=>setNearbyRadius(nearbyRadii[nearbyRadii.indexOf(nearbyRadius)+1])}>Искать в большем радиусе <ExploreIcon name="arrow"/></button>:<button type="button" className="around-secondary" onClick={()=>{setNearbyCenter(null);setPlace(null);setPrompt(false);}}>Выбрать другую точку <ExploreIcon name="map"/></button>}</div>}</section>
        :!search&&mapHintVisible?<div className="around-map-hint"><span><strong>Какой дом вам интересен?</strong>Нажмите на карту — найдём его историю.</span><button className="around-icon" type="button" aria-label="Закрыть подсказку" onClick={()=>setMapHintVisible(false)}><ExploreIcon name="close"/></button></div>:null}
        {active?.address&&!placeBusy?<Link className="around-secondary" href={walkHref} onClick={rememberOpener} prefetch={false}>Создать прогулку отсюда <ExploreIcon name="walk"/></Link>:null}
        {updateAvailable?<a className="around-update" href="/update.html">Доступна новая версия · обновить</a>:null}
      </div>
    </>:null}
    {pathname === "/" && <AppNavigation onWalk={rememberOpener} embedded active={creating ? "walk" : tab} onNearby={()=>{if(creating)closeCreation();setTab("nearby");setSearch(false);}} />}
  </>;
}

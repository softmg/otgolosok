"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type Ref } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { WalkCreationPanel, type CreationMap } from "../walk-builder/walk-creation-panel";
import type { Coordinates, Route } from "../tour/types";
import { getWalkChapters } from "../tour/walk-plan";
import { jobUrl } from "../generator/offline";
import { stageLabels, terminalStages, type GenerationJob } from "../generator/types";
import type { MapFocus, MapViewState } from "./explore-map";
import { ExploreIcon } from "./icons";
import { AppNavigation } from "../navigation/app-navigation";
import { isMoscowPoint, MOSCOW_CENTER, MOSCOW_ZOOM, readMapJobs, type MapJob } from "./map-jobs";
import { nearbyRadiusForAccuracy, recommendNearbyStories, type NearbyRadius } from "./nearby-stories";
import { isWalkCreation, selectExplorePanel } from "./panel-state";
import { useMapCatalog } from "./use-map-catalog";
import { rememberGeoPromptDismissal, shouldShowGeoPrompt } from "./geo-prompt";
import { MapShell } from "../shell/map-shell";
import { MapControlButton } from "../shell/map-controls";
import { AroundHeader } from "./around-header";
import { GeoNotice, LocationPromptSheet, MapHintNotice, NearbySheet, PlaceSheet, StorySheet } from "./around-sheets";
import type { StoryPin } from "./story-pin";
import a from "./around.module.css";
import styles from "./around-screen.module.css";
import { toUserMessage } from "@/lib/errors/user-message";
import { describeLocateError, locateOnce } from "@/lib/position/locate";

type Place = {label:string; address:string|null; location:Coordinates};
// Keep the nearby viewport across client-side navigation, independently of walk maps.
const nearbyMapView: MapViewState = {current:null};
function distance(a:Coordinates,b:Coordinates){
  const rad=Math.PI/180,dlat=(b.lat-a.lat)*rad,dlon=(b.lon-a.lon)*rad;
  return 12742000*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlon/2)**2)));
}
const walkChapterAt=(route:Route,index?:number)=>index===undefined?undefined:getWalkChapters(route)[index];

// openChapter — часть, на которой остановили прогулку: карта открывается с её карточкой,
// а startRef получает кнопку «Слушать эту часть», чтобы вернуть на неё фокус.
export function AroundScreen({route,onStart,updateAvailable,openChapter,startRef}: {route:Route;onStart:(chapter?:number)=>void;updateAvailable:boolean;openChapter?:number;startRef?:Ref<HTMLButtonElement>}) {
  const router = useRouter();
  const params = useSearchParams();
  const creating = isWalkCreation(params);
  const [creationMap, setCreationMap] = useState<CreationMap>({items:[], focus:null, picking:false});
  const [picked, setPicked] = useState<Coordinates | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeCreation = useCallback(() => { router.replace("/", {scroll:false}); setPicked(null); setTimeout(() => opener.current?.focus(), 0); }, [router]);
  const rememberOpener = () => { opener.current = document.activeElement as HTMLElement; };
  const pathname=usePathname();
  const [search,setSearch]=useState(false),[query,setQuery]=useState("");
  const [selected,setSelected]=useState(()=>walkChapterAt(route,openChapter)?.id);
  const [place,setPlace]=useState<Place|null>(null),[placeBusy,setPlaceBusy]=useState(false),[placeError,setPlaceError]=useState("");
  const [focus,setFocus]=useState<MapFocus|null>(()=>{const chapter=walkChapterAt(route,openChapter);return chapter?{...chapter.location}:null;});
  const [user,setUser]=useState<(Coordinates&{accuracyM:number})|null>(null);
  const [nearbyCenter,setNearbyCenter]=useState<Coordinates|null>(null),[nearbyRadius,setNearbyRadius]=useState<NearbyRadius>(200);
  const [geo,setGeo]=useState<"idle"|"loading"|"ready"|"error"|"denied">("idle"),[geoMessage,setGeoMessage]=useState(""),[geoOutside,setGeoOutside]=useState(false);
  const [prompt,setPrompt]=useState(false);
  const [mapHintVisible,setMapHintVisible]=useState(true);
  const [tracked]=useState<MapJob[]>(()=>typeof window==="undefined"?[]:readMapJobs()),[jobs,setJobs]=useState<Record<string,GenerationJob>>({});
  const {places:catalog,status:catalogStatus,nearbyStatus,maintenance:catalogMaintenance,retry:retryCatalog,onViewport}=useMapCatalog(nearbyCenter,nearbyRadius);
  const lookup=useRef<AbortController|null>(null),locating=useRef<(()=>void)|null>(null);
  const input=useRef<HTMLInputElement>(null);

  // Отменённый поиск позиции не должен оставить кнопку в «Определяем положение…»: в StrictMode очистка срабатывает и без размонтирования.
  useEffect(()=>()=>{lookup.current?.abort();if(locating.current){locating.current();locating.current=null;setGeo("idle");}},[]);
  useEffect(()=>{if(search)input.current?.focus();},[search]);
  // Кнопка поиска в шапке прогулки ведёт на /?search=1: открываем поле адреса и убираем параметр из адреса.
  useEffect(()=>{
    if(params.get("search")!=="1")return;
    const timer=setTimeout(()=>{
      setSearch(true);setPrompt(false);
      const rest=new URLSearchParams(params.toString());rest.delete("search");
      router.replace(rest.size?`${pathname}?${rest}`:pathname,{scroll:false});
    },0);
    return()=>clearTimeout(timer);
  },[params,pathname,router]);
  useEffect(()=>{
    const timer=setTimeout(()=>setPrompt(shouldShowGeoPrompt(localStorage)),0);
    return()=>clearTimeout(timer);
  },[]);
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
    const chapters=getWalkChapters(route).flatMap((chapter,index)=>index===openChapter?[{id:chapter.id,title:chapter.title,address:chapter.place,location:chapter.location,duration:chapter.audio?.duration_sec,chapter:index,number:index+1}]:[]);
    const own=tracked.map(item=>{
      const job=jobs[item.id];return {...item,jobId:item.id,title:job?.story?.title??item.address,duration:job?.audio?.durationSec,pending:job?!terminalStages.has(job.stage):false,status:job?stageLabels[job.stage]:"Открыть подготовку"};
    });
    // The text, sources and audio of a catalog point load when its sheet opens (usePlaceStory).
    const places=catalog.map(place=>({id:place.id,placeId:place.id,title:place.title,address:place.address,location:place.location,duration:place.durationSec??undefined,status:place.durationSec!=null?"Готово к прослушиванию":"Текст готов",hasPhoto:place.photo,clusterable:true}));
    return [...chapters,...own,...places.filter(place=>![...chapters,...own].some(existing=>existing.id===place.id))];
  },[route,openChapter,tracked,jobs,catalog]);
  const recommendations=useMemo(()=>nearbyCenter?recommendNearbyStories(nearbyCenter,nearbyRadius,catalog.flatMap(place=>place.durationSec!=null?[{id:place.id,title:place.title,address:place.address,location:place.location,durationSec:place.durationSec,sourceCount:place.sources,factCount:place.facts}]:[])):[],[nearbyCenter,nearbyRadius,catalog]);
  const visible=useMemo(()=>[...pins].sort((a,b)=>user?distance(user,a.location)-distance(user,b.location):0),[pins,user]);
  const creationItems=useMemo(()=>[
    ...visible.filter(pin=>!creationMap.items.some(point=>distance(pin.location,point.location)<15)).map(pin=>({...pin,compact:true})),
    ...creationMap.items,
  ],[visible,creationMap.items]);
  const active=pins.find(pin=>pin.id===selected);
  const explorePanel=selectExplorePanel({nearbyCenter:Boolean(nearbyCenter),place:Boolean(place),placeBusy,placeError:Boolean(placeError)});
  const mapItems=useMemo(()=>place?[...visible,{id:"picked-place",title:place.address??"Выбранное место",location:place.location,pending:true}]:visible,[visible,place]);

  function select(pin:StoryPin){
    lookup.current?.abort();setPlaceBusy(false);setPlaceError("");setPlace(null);setSelected(pin.id);setFocus({...pin.location});setPrompt(false);setSearch(false);
  }
  function selectRecommendation(id:string){
    const direct=pins.find(pin=>pin.id===id);
    if(direct){select(direct);return;}
  }
  function openSearch(){setSearch(true);setPrompt(false);}
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
      if(lookup.current===controller&&(!controller.signal.aborted||controller.signal.reason==="timeout"))setPlaceError(controller.signal.aborted?"Поиск занял слишком много времени. Введите адрес вручную.":toUserMessage(error,"Не удалось определить адрес."));
    }finally{clearTimeout(timer);if(lookup.current===controller)setPlaceBusy(false);}
  }
  function submitSearch(event:FormEvent){event.preventDefault();if(query.trim().length>=3)void findPlace(query.trim());}
  // Сначала показываем грубую точку, затем уточняем её; поиск рядом запускаем по итоговой.
  function locate(){
    locating.current?.();
    setGeo("loading");setGeoMessage("");setGeoOutside(false);
    let first=true;
    locating.current=locateOnce(update=>{
      if(update.type==="error"){
        locating.current=null;
        const denied=update.code==="permission-denied";
        setGeo(denied?"denied":"error");
        setGeoMessage(`${describeLocateError(update.code)} ${denied?"Можно разрешить его в настройках или выбрать место на карте.":"Выберите дом на карте или повторите попытку."}`);
        if(denied)setPrompt(false);
        return;
      }
      const point={lat:update.fix.lat,lon:update.fix.lon,accuracyM:update.fix.accuracyM};
      setUser(point);
      if(first||update.final)setFocus(point);
      first=false;
      if(!update.final)return;
      locating.current=null;
      const inMoscow=isMoscowPoint(point),radius=nearbyRadiusForAccuracy(point.accuracyM);
      setGeo("ready");setPrompt(false);setGeoOutside(!inMoscow);
      if(inMoscow&&radius){setNearbyRadius(current=>current>=radius?current:radius);setNearbyCenter(point);}
      else setNearbyCenter(null);
      setGeoMessage(!inMoscow?"Вы сейчас за пределами нашего каталога.":radius?"":`Положение приблизительное${Number.isFinite(point.accuracyM)?`: точность около ${Math.round(point.accuracyM)} м`:""}. Выберите точку на карте, чтобы точно искать рядом.`);
    });
  }
  function showMoscow(){setFocus({...MOSCOW_CENTER,zoom:MOSCOW_ZOOM});setGeoMessage("");setGeoOutside(false);}
  const createHref=place?.address?`/create?${new URLSearchParams({address:place.address,lat:String(place.location.lat),lon:String(place.location.lon)})}`:"/create?new=1";
  const walkStart=place?.address?place:active;
  const walkHref=walkStart?.address?`/?${new URLSearchParams({walk:"create",address:walkStart.address,lat:String(walkStart.location.lat),lon:String(walkStart.location.lon)})}`:"/?walk=create";
  function closePlace(){lookup.current?.abort();setPlace(null);setPlaceBusy(false);setPlaceError("");setNearbyCenter(null);}

  const sheet = creating
    ? <WalkCreationPanel key={params.get("id") ?? params.get("local") ?? "create"} onClose={closeCreation} onMap={setCreationMap} picked={picked} />
    : search ? null
    : prompt&&!active&&!place&&!placeBusy&&!placeError ? <LocationPromptSheet geo={geo} onLocate={locate} onDismiss={dismissGeoPrompt} />
    : active ? <StorySheet story={active} walkHref={active.address&&!placeBusy?walkHref:null} startRef={startRef} onStart={onStart} onClose={()=>setSelected(undefined)} onWalk={rememberOpener} />
    : explorePanel==="place" ? <PlaceSheet address={place?.address??null} busy={placeBusy} error={placeError} createHref={createHref} walkHref={place?.address?walkHref:null} onClose={closePlace} onWalk={rememberOpener} />
    : explorePanel==="nearby" ? <NearbySheet status={nearbyStatus} radius={nearbyRadius} recommendations={recommendations} onRadius={setNearbyRadius} onSelect={selectRecommendation} onClose={()=>{setNearbyCenter(null);setPlace(null);setPrompt(false);}} />
    : null;
  // An empty slot must stay null: the shell gives the dock room only when there is something to show.
  const noticeList = [
    catalogStatus!=="ready"||catalogMaintenance?<div key="catalog" className={styles.catalogStatus} data-region="catalog-status"><span role="status" aria-atomic="true">{catalogMaintenance?"Сервис обновляется. Карта загрузится автоматически.":catalogStatus==="error"?"Не все места загрузились.":"Загружаем места…"}</span>{catalogStatus==="loading"&&!catalogMaintenance?<progress aria-label="Загрузка мест на карте"/>:null}{catalogStatus==="error"&&!catalogMaintenance?<button type="button" onClick={retryCatalog}>Повторить загрузку мест</button>:null}</div>:null,
    !creating&&geoMessage&&!search?<GeoNotice key="geo" message={geoMessage} outside={geoOutside} denied={geo==="denied"} onMoscow={showMoscow} onRetry={locate} onClose={()=>{setGeoMessage("");setGeoOutside(false);}} />:null,
    !creating&&!sheet&&!search&&mapHintVisible?<MapHintNotice key="hint" onClose={()=>setMapHintVisible(false)} />:null,
    !creating&&updateAvailable?<a key="update" className={a.notice} href="/update.html">Доступна новая версия · обновить</a>:null,
  ].filter(Boolean);
  const notices = noticeList.length ? noticeList : null;

  return <>
    <MapShell
      map={{onViewport,viewState:nearbyMapView,items:creating?creationItems:mapItems,geometry:creating?creationMap.geometry:undefined,selectedId:selected??(place?"picked-place":undefined),focus:creating?creationMap.focus:focus,user,
        onSelect:id=>{const pin=pins.find(value=>value.id===id);if(pin){if(creating)setPicked(pin.location);else select(pin);}},
        onPoint:point=>creating?setPicked(point):void findPlace(point)}}
      header={<AroundHeader search={search&&!creating} query={query} busy={placeBusy} inputRef={input} onToggle={()=>search?setSearch(false):openSearch()} onQuery={setQuery} onSubmit={submitSearch} />}
      controls={search||creating?null:<MapControlButton aria-label="Моё местоположение" onClick={locate} disabled={geo==="loading"}><ExploreIcon name="locate"/></MapControlButton>}
      notices={notices}
      sheet={sheet} />
    {pathname === "/" && <AppNavigation onWalk={rememberOpener} embedded active={creating ? "walk" : "nearby"} onNearby={()=>{if(creating)closeCreation();setSearch(false);}} />}
  </>;
}

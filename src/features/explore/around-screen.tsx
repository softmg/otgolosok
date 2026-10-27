"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type Ref } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { WalkCreationPanel, type CreationMap } from "../walk-builder/walk-creation-panel";
import type { Coordinates, Route } from "../tour/types";
import { getWalkChapters } from "../tour/walk-plan";
import { createStoryJob, isJobId, readStoryJob, retryStoryJob } from "../generator/api";
import { stageLabels, terminalStages, type GenerationJob } from "../generator/types";
import type { MapFocus, MapViewState } from "./explore-map";
import type { MapViewport } from "./catalog-bounds";
import { useAroundFood } from "../food/use-around-food";
import { useAroundParking } from "../parking/use-around-parking";
import { ParkingSheet } from "../parking/parking-sheet";
import type { ParkingPlace } from "../parking/types";
import type { FoodPlace } from "../food/types";
import { ExploreIcon } from "./icons";
import { AppNavigation } from "../navigation/app-navigation";
import { cityAtPoint, useCurrentCity, type City } from "../city/current-city";
import { isMoscowPoint, readMapJobs, rememberMapJob, rememberMapPlace, type MapJob } from "./map-jobs";
import { nearbyRadiusForAccuracy, recommendNearbyStories, type NearbyRadius } from "./nearby-stories";
import { isWalkCreation, selectExplorePanel } from "./panel-state";
import { useMapCatalog } from "./use-map-catalog";
import { useWalkOverview } from "./use-walk-overview";
import { walkColorIndex } from "./walk-overview";
import { WalkOverviewSheet } from "./walk-overview-sheet";
import type { MapFitTarget, WalkLine } from "./explore-map";
import { rememberGeoPromptDismissal, shouldShowGeoPrompt } from "./geo-prompt";
import { MapShell } from "../shell/map-shell";
import { MapControlButton } from "../shell/map-controls";
import { FoodSheet, GeoNotice, LinkNotice, LocationPromptSheet, MapHintNotice, NearbySheet, PlaceSheet, StorySheet } from "./around-sheets";
import { catalogPin, isExpandableStory, isLinkablePlace, linkedPlacePin, type StoryPin } from "./story-pin";
import { isPlaceId, placeMapUrl } from "./place-link";
import { usePlaceStory } from "./place-story";
import { usePlaceUrl } from "./use-place-url";
import { useExpandableSheet } from "../shell/use-expandable-sheet";
import { useHideNavigation } from "../navigation/navigation-visibility";
import { openDataAttribution } from "./source-attribution";
import a from "./around.module.css";
import styles from "./around-screen.module.css";
import { toUserMessage } from "@/lib/errors/user-message";
import { describeLocateError, locateOnce, type LocateErrorCode } from "@/lib/position/locate";
import { useI18n } from "@/lib/i18n/provider";
import { unlocalizedPath, type Locale } from "@/lib/i18n/locale";
import { translate } from "@/lib/i18n/translate";

type Place = {label:string; address:string|null; location:Coordinates};
// Keep the nearby viewport across client-side navigation, independently of walk maps.
const nearbyMapView: MapViewState = {current:null};
function distance(a:Coordinates,b:Coordinates){
  const rad=Math.PI/180,dlat=(b.lat-a.lat)*rad,dlon=(b.lon-a.lon)*rad;
  return 12742000*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlon/2)**2)));
}
const walkChapterAt=(route:Route,index?:number)=>index===undefined?undefined:getWalkChapters(route)[index];
/** The card of a story the user ordered: its text and recording once ready, otherwise how far preparation got. */
export function jobPin(item:MapJob,job:GenerationJob|undefined,locale:Locale="ru"):StoryPin{
  const story=job?.story,pending=job?!terminalStages.has(job.stage):false,label=translate(locale,job?stageLabels[job.stage]:"Загружаем состояние истории");
  const note=!story?undefined:story.verification==="editorial"?translate(locale,"Рассказ проверен и подтверждён редактором.")
    :translate(locale, job?.audio ? "Подготовлено автоматически: факты сопоставлены с источниками, редактор ещё не проверял рассказ. Озвучено синтетическим голосом." : pending ? "Подготовлено автоматически: факты сопоставлены с источниками, редактор ещё не проверял рассказ. Запись появится после озвучки." : "Подготовлено автоматически: факты сопоставлены с источниками, редактор ещё не проверял рассказ.");
  return {...item,jobId:item.id,title:story?.title??item.address,duration:job?.audio?.durationSec,pending,status:label,
    paragraphs:story?.paragraphs.map(paragraph=>paragraph.text),audioUrl:job?.audio?.url,
    attribution:openDataAttribution(story?.sources),sources:story?.sources,
    progress:{label,pending:!job||pending,note,error:job?.error?.message,canRetry:job?.canRetry??false,retryLabel:translate(locale,story?"Повторить озвучку":"Повторить подготовку")}};
}

// openChapter — часть, на которой остановили прогулку: карта открывается с её карточкой,
// а startRef получает кнопку «Слушать эту часть», чтобы вернуть на неё фокус.
export function AroundScreen({route,onStart,updateAvailable,openChapter,startRef}: {route:Route;onStart:(chapter?:number)=>void;updateAvailable:boolean;openChapter?:number;startRef?:Ref<HTMLButtonElement>}) {
  const { locale, path, t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const creating = isWalkCreation(params);
  const food = useAroundFood(creating);
  const [selectedFood, setSelectedFood] = useState<FoodPlace | null>(null);
  const [creationMap, setCreationMap] = useState<CreationMap>({items:[], focus:null, picking:false});
  const parking = useAroundParking(creating, creationMap.travelMode === "driving");
  const [selectedParking, setSelectedParking] = useState<ParkingPlace | null>(null);
  const [picked, setPicked] = useState<Coordinates | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const rememberOpener = () => { opener.current = document.activeElement as HTMLElement; };
  const pathname=usePathname();
  const [selected,setSelected]=useState(()=>walkChapterAt(route,openChapter)?.id);
  const {urlPlace,invalid:invalidLink,openPlace,leavePlace,replaceUrl}=usePlaceUrl();
  // Leaving the builder returns to the story it was opened from, with that story's URL; no router navigation.
  const closeCreation = useCallback(() => { replaceUrl(path(selected&&isPlaceId(selected)?placeMapUrl(selected):"/")); setPicked(null); setTimeout(() => opener.current?.focus(), 0); }, [path,replaceUrl,selected]);
  const [place,setPlace]=useState<Place|null>(null),[placeBusy,setPlaceBusy]=useState(false),[placeError,setPlaceError]=useState("");
  const [focus,setFocus]=useState<MapFocus|null>(()=>{const chapter=walkChapterAt(route,openChapter);return chapter?{...chapter.location}:null;});
  const [user,setUser]=useState<(Coordinates&{accuracyM:number})|null>(null);
  const [nearbyCenter,setNearbyCenter]=useState<Coordinates|null>(null),[nearbyRadius,setNearbyRadius]=useState<NearbyRadius>(200);
  const [geo,setGeo]=useState<"idle"|"loading"|"ready"|"error"|"denied">("idle"),[geoMessage,setGeoMessage]=useState(""),[geoOutside,setGeoOutside]=useState(false);
  const [geoError,setGeoError]=useState<LocateErrorCode|null>(null);
  const [,chooseCity]=useCurrentCity();
  const geoStatusId=useId();
  const [prompt,setPrompt]=useState(false);
  const [mapHintVisible,setMapHintVisible]=useState(true);
  // The place a URL change selected; the map moves to it once its pin is known (a linked place may still be loading).
  const [focusPlace,setFocusPlace]=useState<string|null>(null),[seenUrlPlace,setSeenUrlPlace]=useState<string|null>(null);
  const [linkNotice,setLinkNotice]=useState("");
  const [tracked,setTracked]=useState<MapJob[]>(()=>typeof window==="undefined"?[]:readMapJobs()),[jobs,setJobs]=useState<Record<string,GenerationJob>>({});
  const [preparing,setPreparing]=useState(false),[prepareError,setPrepareError]=useState("");
  const [retrying,setRetrying]=useState(false),[retryError,setRetryError]=useState("");
  const prepareRequest=useRef<AbortController|null>(null);
  const {places:catalog,status:catalogStatus,nearbyStatus,maintenance:catalogMaintenance,retry:retryCatalog,onViewport}=useMapCatalog(nearbyCenter,nearbyRadius);
  const onFoodViewport = food.onViewport;
  const onParkingViewport = parking.onViewport;
  const walkOverview = useWalkOverview(creating);
  const onWalkViewport = walkOverview.onViewport;
  // Keys of the overview walks under the last tap on their lines, nearest first, and the one highlighted.
  const [walkHits,setWalkHits]=useState<string[]>([]),[selectedWalk,setSelectedWalk]=useState<string|null>(null);
  // The chosen walk is fitted into the free map above its card: a tapped line is otherwise mostly under the sheet.
  const [walkFit,setWalkFit]=useState<MapFitTarget|null>(null);
  const handleViewport = useCallback((area: MapViewport) => { onViewport(area); onFoodViewport(area); onParkingViewport(area); onWalkViewport(area); }, [onViewport, onFoodViewport, onParkingViewport, onWalkViewport]);
  const lookup=useRef<AbortController|null>(null),locating=useRef<(()=>void)|null>(null);

  // Отменённый поиск позиции не должен оставить кнопку в «Определяем положение…»: в StrictMode очистка срабатывает и без размонтирования.
  useEffect(()=>()=>{lookup.current?.abort();if(locating.current){locating.current();locating.current=null;setGeo("idle");}},[]);
  useEffect(()=>{
    const timer=setTimeout(()=>setPrompt((()=>{try{return shouldShowGeoPrompt(localStorage);}catch{return true;}})()),0);
    return()=>clearTimeout(timer);
  },[]);
  // Разрешение может быть отозвано или выдано в настройках без перезагрузки карты.
  useEffect(()=>{
    if(!navigator.permissions)return;
    let disposed=false,status:PermissionStatus|null=null,previous:PermissionState|null=null;
    const changed=()=>{
      if(disposed||!status)return;
      const before=previous;previous=status.state;
      if(status.state==="denied"){
        locating.current?.();locating.current=null;
        setGeo("denied");setGeoError("permission-denied");setUser(null);
      }else{
        if(before==="denied"||(before!==null&&status.state==="granted")){setGeoMessage("");setGeoOutside(false);}
        if(before==="granted"&&status.state==="prompt"){
          locating.current?.();locating.current=null;setGeo("idle");setGeoError(null);setUser(null);
        }
        setGeo(current=>current==="denied"?"idle":current);
        setGeoError(current=>current==="permission-denied"?null:current);
      }
    };
    void (async()=>{
      try{
        const permission=await navigator.permissions.query({name:"geolocation"});
        if(disposed)return;
        status=permission;status.addEventListener("change",changed);changed();
      }catch{
        // Если браузер не умеет проверять разрешение, узнаем состояние при нажатии.
      }
    })();
    return()=>{disposed=true;status?.removeEventListener("change",changed);};
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
          try{const value=await readStoryJob(item.id,controller.signal);
            if(value.id!==item.id)return null;
            if(terminalStages.has(value.stage))settled.add(item.id);
            return value;
          }catch{return null;}
        }));
        if(!disposed)setJobs(current=>({...current,...Object.fromEntries(values.filter(value=>value!==null).map(value=>[value.id,value]))}));
      }finally{running=false;}
    };
    // Preparation takes a few minutes and its card shows each stage, so unfinished jobs are checked often.
    void refresh();const timer=setInterval(()=>void refresh(),5000);
    document.addEventListener("visibilitychange",refresh);
    return ()=>{disposed=true;controller.abort();clearInterval(timer);document.removeEventListener("visibilitychange",refresh);};
  },[tracked]);

  // /?job=<id> opens a story the user ordered (links from the profile, the editorial desk and the walk builder).
  // The job knows only its address, so a story not yet bookmarked on this device is placed by geocoding it.
  // Removing the parameter re-runs this effect, so the request is cancelled only on unmount or by the next link.
  const jobLink=useRef<AbortController|null>(null);
  useEffect(()=>()=>jobLink.current?.abort(),[]);
  useEffect(()=>{
    const id=params.get("job");
    if(id===null)return;
    jobLink.current?.abort();const controller=new AbortController();jobLink.current=controller;
    const rest=new URLSearchParams(params.toString());rest.delete("job");
    router.replace(rest.size?`${pathname}?${rest}`:pathname,{scroll:false});
    void (async()=>{
      try{
        if(!isJobId(id))throw new Error("Ссылка на историю повреждена.");
        const job=await readStoryJob(id,controller.signal);
        let record=readMapJobs().find(item=>item.id===id)??null;
        if(!record){
          const response=await fetch(`/api/story-place?${new URLSearchParams({q:job.address})}`,{signal:controller.signal});
          const result=await response.json().catch(()=>null);
          if(!response.ok||!result?.location)throw new Error(result?.error?.message??"Не удалось найти дом этой истории на карте.");
          record=rememberMapPlace({id,address:job.address,location:result.location});
          if(!record)throw new Error("Дом этой истории находится вне Москвы.");
        }
        const found=record;
        setTracked(current=>[found,...current.filter(item=>item.id!==id)]);
        setJobs(current=>({...current,[id]:job}));
        setPlace(null);setPrompt(false);setSelectedFood(null);setSelected(id);setFocus({...found.location});
      }catch(error){if(!controller.signal.aborted)setGeoMessage(toUserMessage(error,"Не удалось открыть историю.",locale));}
    })();
  },[params,pathname,router,locale]);

  // The URL names the selected catalog place: a link, Back/Forward or the "Рядом" tab change it, the screen follows.
  // The walk builder has its own URL and keeps the story it was opened from.
  if(!creating&&urlPlace!==seenUrlPlace){
    setSeenUrlPlace(urlPlace);
    if(urlPlace){
      if(urlPlace!==selected){setSelected(urlPlace);setFocusPlace(urlPlace);setRetryError("");setWalkHits([]);setSelectedWalk(null);setWalkFit(null);}
      setPlace(null);setPlaceBusy(false);setPlaceError("");setPrompt(false);
    }else if(selected&&isPlaceId(selected)){setSelected(undefined);setFocusPlace(null);}
  }
  // A place opened by the URL cancels the address lookup of a house tapped before.
  useEffect(()=>{if(urlPlace)lookup.current?.abort();},[urlPlace]);

  const pins=useMemo<StoryPin[]>(()=>{
    const chapters=getWalkChapters(route).flatMap((chapter,index)=>index===openChapter?[{id:chapter.id,title:chapter.title,address:chapter.place,location:chapter.location,duration:chapter.audio?.duration_sec,chapter:index,number:index+1}]:[]);
    const own=tracked.map(item=>jobPin(item,jobs[item.id],locale));
    const places=catalog.map(item=>catalogPin(item,locale));
    return [...chapters,...own,...places.filter(place=>![...chapters,...own].some(existing=>existing.id===place.id))];
  },[route,openChapter,tracked,jobs,catalog,locale]);
  // A linked place outside the loaded map cells opens from its detail; its catalog pin replaces it once the cell loads.
  const linkedId=selected&&isPlaceId(selected)&&!pins.some(pin=>pin.id===selected)?selected:undefined;
  const linked=usePlaceStory(linkedId);
  const linkedHeader=linkedId&&linked.status==="ready"?linked.story?.place:undefined;
  const linkedPin=useMemo(()=>linkedId&&linkedHeader&&linked.story?linkedPlacePin(linkedId,linkedHeader,linked.story,locale):undefined,[linkedId,linkedHeader,linked.story,locale]);
  const storyPins=useMemo(()=>linkedPin?[...pins,linkedPin]:pins,[pins,linkedPin]);
  const linkFailure=invalidLink?t("Ссылка на историю повреждена."):linkedId&&linked.status==="missing"?t("Эта история больше недоступна."):"";
  if(linkFailure&&linkNotice!==linkFailure)setLinkNotice(linkFailure);
  // A damaged or unpublished link leaves the URL without adding a step.
  useEffect(()=>{if(linkFailure)leavePlace({replace:true});},[linkFailure,leavePlace]);
  const focusPin=focusPlace?storyPins.find(value=>value.id===focusPlace):undefined;
  if(focusPin){setFocusPlace(null);setFocus({...focusPin.location});}
  const recommendations=useMemo(()=>nearbyCenter?recommendNearbyStories(nearbyCenter,nearbyRadius,catalog.flatMap(place=>place.durationSec!=null?[{id:place.id,title:place.title,address:place.address,location:place.location,durationSec:place.durationSec,sourceCount:place.sources,factCount:place.facts}]:[]),locale):[],[nearbyCenter,nearbyRadius,catalog,locale]);
  const visible=useMemo(()=>[...storyPins].sort((a,b)=>user?distance(user,a.location)-distance(user,b.location):0),[storyPins,user]);
  const creationItems=useMemo(()=>[
    ...visible.filter(pin=>!creationMap.items.some(point=>distance(pin.location,point.location)<15)).map(pin=>({...pin,compact:true})),
    ...creationMap.items,
  ],[visible,creationMap.items]);
  const active=storyPins.find(pin=>pin.id===selected);
  const explorePanel=selectExplorePanel({nearbyCenter:Boolean(nearbyCenter),place:Boolean(place),placeBusy,placeError:Boolean(placeError)});
  const foodItems=useMemo(()=>food.places.map(value=>({id:`food:${value.id}`,title:value.name,location:{lat:value.lat,lon:value.lon},foodKind:value.kind})),[food.places]);
  const parkingItems=useMemo(()=>parking.places.map(value=>({id:`parking:${value.id}`,title:value.name,location:value.location,parking:true})),[parking.places]);
  const mapItems=useMemo(()=>[...visible,...foodItems,...parkingItems,...(place?[{id:"picked-place",title:place.address??t("Выбранное место"),location:place.location,pending:true}]:[])],[visible,foodItems,parkingItems,place,t]);
  const foodPlace = food.visible ? selectedFood : null;
  const parkingPlace = parking.visible ? selectedParking : null;
  const walkLines=useMemo<WalkLine[]>(()=>walkOverview.walks.map(walk=>({key:walk.key,colorIndex:walkColorIndex(walk.key),line:walk.line})),[walkOverview.walks]);
  // Tapped walks that are still loaded; switching the layer off or a reload that drops a walk closes its card.
  const tappedWalks=useMemo(()=>walkOverview.visible?walkHits.flatMap(key=>walkOverview.walks.find(walk=>walk.key===key)??[]):[],[walkOverview.visible,walkOverview.walks,walkHits]);
  const shownWalk=tappedWalks.some(walk=>walk.key===selectedWalk)?selectedWalk:null;
  function closeWalks(){setWalkHits([]);setSelectedWalk(null);setWalkFit(null);}
  function chooseWalk(key:string){
    setSelectedWalk(key);
    const walk=walkOverview.walks.find(value=>value.key===key);
    if(walk)setWalkFit({points:walk.line.map(([lat,lon])=>({lat,lon})),keepUserView:false});
  }
  function selectWalks(keys:string[],{choose=true}:{choose?:boolean}={}){
    setSelectedParking(null);
    lookup.current?.abort();prepareRequest.current?.abort();setPlaceBusy(false);setPlaceError("");setPlace(null);setPreparing(false);setPrepareError("");setNearbyCenter(null);
    setSelected(undefined);setSelectedFood(null);setRetryError("");setLinkNotice("");setPrompt(false);leavePlace();
    setWalkHits(keys);setSelectedWalk(null);setWalkFit(null);
    if(keys[0]&&(choose||keys.length===1))chooseWalk(keys[0]);
  }
  function selectFood(value: FoodPlace){
    setSelectedParking(null);
    lookup.current?.abort();prepareRequest.current?.abort();setPlaceBusy(false);setPlaceError("");setPlace(null);setPreparing(false);setPrepareError("");setNearbyCenter(null);setSelected(undefined);setRetryError("");setLinkNotice("");setPrompt(false);leavePlace();closeWalks();setSelectedFood(value);setFocus({lat:value.lat,lon:value.lon});
  }

  function select(pin:StoryPin){
    setSelectedParking(null);
    lookup.current?.abort();setPlaceBusy(false);setPlaceError("");setPlace(null);setRetryError("");setLinkNotice("");setSelectedFood(null);closeWalks();setSelected(pin.id);setFocus({...pin.location});setPrompt(false);
    // Every opened place is a history step; any other story takes the place out of the URL.
    if(isLinkablePlace(pin))openPlace(pin.id);else leavePlace();
  }
  function selectRecommendation(id:string){
    const direct=storyPins.find(pin=>pin.id===id);
    if(direct){select(direct);return;}
  }
  function dismissGeoPrompt(){try{rememberGeoPromptDismissal(localStorage);}catch{/* Storage is optional. */}setPrompt(false);}
  async function findPlace(value:Coordinates){
    setSelectedParking(null);
    lookup.current?.abort();const controller=new AbortController();lookup.current=controller;
    prepareRequest.current?.abort();setPreparing(false);setPrepareError("");
    leavePlace();
    setPrompt(false);setSelectedFood(null);closeWalks();setSelected(undefined);setPlace(null);setPlaceError("");setPlaceBusy(true);
    setFocus({...value});setNearbyCenter(value);
    // New stories are prepared for Moscow houses only; other cities have ready walks.
    if(!isMoscowPoint(value)){setPlaceBusy(false);setPlaceError(cityAtPoint(value)?t("Здесь пока можно слушать готовые прогулки. Истории о домах на выбор готовим только в Москве."):t("Пока готовим истории только о Москве. Можно выбрать московский дом или открыть готовую прогулку."));return;}
    const timer=setTimeout(()=>controller.abort("timeout"),12000);
    try {
      const params=new URLSearchParams({lat:String(value.lat),lon:String(value.lon)});
      const response=await fetch(`/api/story-place?${params}`,{signal:controller.signal});const result=await response.json();
      if(!response.ok)throw new Error(result.error?.message??"Не удалось определить адрес.");
      if(!result.location||!isMoscowPoint(result.location))throw new Error("Выберите адрес в Москве.");
      if(lookup.current!==controller||controller.signal.aborted)return;
      setPlace(result);setFocus(result.location);setNearbyCenter(result.location);
    }catch(error){
      if(lookup.current===controller&&(!controller.signal.aborted||controller.signal.reason==="timeout"))setPlaceError(controller.signal.aborted?t("Адрес определялся слишком долго. Нажмите на дом ещё раз."):toUserMessage(error,"Не удалось определить адрес.",locale));
    }finally{clearTimeout(timer);if(lookup.current===controller)setPlaceBusy(false);}
  }
  // Сначала показываем грубую точку, затем уточняем её; поиск рядом запускаем по итоговой.
  function locate(){
    locating.current?.();
    setGeo("loading");setGeoError(null);setUser(null);setGeoMessage("");setGeoOutside(false);
    let first=true;
    locating.current=locateOnce(update=>{
      if(update.type==="error"){
        locating.current=null;
        const denied=update.code==="permission-denied";
        setGeo(denied?"denied":"error");setGeoError(update.code);setUser(null);
        setGeoMessage(`${t(describeLocateError(update.code))} ${t(denied?"Можно разрешить его в настройках, выбрать город или место на карте.":"Выберите город, дом на карте или повторите попытку.")}`);
        if(denied)setPrompt(false);
        return;
      }
      const point={lat:update.fix.lat,lon:update.fix.lon,accuracyM:update.fix.accuracyM};
      setUser(point);
      if(first||update.final)setFocus(point);
      first=false;
      if(!update.final)return;
      locating.current=null;
      const here=cityAtPoint(point),radius=nearbyRadiusForAccuracy(point.accuracyM);
      setGeo("ready");setPrompt(false);setGeoOutside(!here);
      if(here)chooseCity(here);
      if(here&&radius){setNearbyRadius(current=>current>=radius?current:radius);setNearbyCenter(point);}
      else setNearbyCenter(null);
      setGeoMessage(!here?t("Вы сейчас за пределами нашего каталога."):radius?"":Number.isFinite(point.accuracyM)?t("Положение приблизительное: точность около {accuracy} м. Выберите точку на карте, чтобы точно искать рядом.",{accuracy:Math.round(point.accuracyM)}):t("Положение приблизительное. Выберите точку на карте, чтобы точно искать рядом."));
    });
  }
  function showCity(city:City){chooseCity(city);setFocus({...city.center,zoom:city.zoom});setGeoMessage("");setGeoOutside(false);}
  // The story is prepared for the house the user picked; its card replaces the place card and shows the progress.
  async function prepareStory(){
    const target=place;
    if(!target?.address||preparing)return;
    prepareRequest.current?.abort();const controller=new AbortController();prepareRequest.current=controller;
    setPreparing(true);setPrepareError("");
    try{
      const job=await createStoryJob(target.address,controller.signal);
      if(controller.signal.aborted)return;
      rememberMapJob(job,{address:target.address,location:target.location});
      const record={id:job.id,address:job.address,location:target.location};
      setTracked(current=>[record,...current.filter(item=>item.id!==job.id)]);
      setJobs(current=>({...current,[job.id]:job}));
      lookup.current?.abort();setPlace(null);setNearbyCenter(null);setRetryError("");leavePlace();setSelected(job.id);
    }catch(error){
      if(controller.signal.aborted)return;
      if((error as {status?:number}).status===401){router.push(path(`/login?returnTo=${encodeURIComponent(location.pathname+location.search)}`));return;}
      setPrepareError(toUserMessage(error,"Не удалось начать подготовку истории.",locale));
    }finally{if(prepareRequest.current===controller){prepareRequest.current=null;setPreparing(false);}}
  }
  async function retryStory(){
    const job=active?.jobId?jobs[active.jobId]:undefined;
    if(!job||retrying)return;
    setRetrying(true);setRetryError("");
    try{
      const value=await retryStoryJob(job);
      setJobs(current=>({...current,[value.id]:value}));
      // A new list restarts polling, which has already stopped watching this finished job.
      setTracked(current=>[...current]);
    }catch(error){setRetryError(toUserMessage(error,"Не удалось повторить.",locale));}
    finally{setRetrying(false);}
  }
  // A point without a house number still starts a walk: the builder needs a readable label, so it gets a neutral one.
  const walkStart=place?{address:place.address??t("Точка на карте"),location:place.location}:active;
  // The builder prepares walks in Moscow only, so a story of another city offers no walk from it.
  const walkHref=walkStart&&!isMoscowPoint(walkStart.location)?null:walkStart?.address?`/?${new URLSearchParams({walk:"create",address:walkStart.address,lat:String(walkStart.location.lat),lon:String(walkStart.location.lon)})}`:"/?walk=create";
  function closePlace(){lookup.current?.abort();prepareRequest.current?.abort();setPlace(null);setPlaceBusy(false);setPlaceError("");setPreparing(false);setPrepareError("");setNearbyCenter(null);}

  // The story sheet is shown when nothing outranks it below (the location prompt only shows without a story).
  const storyShown=!creating&&Boolean(active);
  const reading=useExpandableSheet(storyShown&&active&&isExpandableStory(active)?active.id:undefined);
  // The expanded story covers the screen, the navigation included.
  useHideNavigation(reading.expanded);
  const sheet = creating
    ? <WalkCreationPanel key={params.get("id") ?? params.get("local") ?? "create"} onClose={closeCreation} onMap={setCreationMap} picked={picked} />
    : parkingPlace ? <ParkingSheet place={parkingPlace} attribution={parking.manifest?.attribution} onClose={()=>setSelectedParking(null)} />
    : foodPlace&&food.manifest ? <FoodSheet place={foodPlace} manifest={food.manifest} hours={food.hours} distanceM={user?distance(user,foodPlace):undefined} onClose={()=>setSelectedFood(null)} />
    : tappedWalks.length ? <WalkOverviewSheet walks={tappedWalks} selected={shownWalk} onSelect={chooseWalk} onOpen={rememberOpener} onClose={closeWalks} />
    : prompt&&!active&&!linkedId&&!place&&!placeBusy&&!placeError ? <LocationPromptSheet geo={geo} onLocate={locate} onDismiss={dismissGeoPrompt} />
    : active ? <StorySheet story={active} walkHref={active.address&&!placeBusy?walkHref:null} startRef={startRef} onStart={onStart}
        onClose={()=>{
          // Closing a place is a step without it: Back brings the card back. An expanded card's entry is rewritten,
          // so Back lands on the collapsed card rather than on the reading view.
          if(isLinkablePlace(active)){
            if(reading.expanded){reading.dismiss({keepHistoryEntry:true});leavePlace({replace:true});}
            else leavePlace();
          }else reading.dismiss();
          setSelected(undefined);setRetryError("");
        }}
        // The link pushes its own history entry; going back first would race with it.
        onWalk={()=>{reading.dismiss({keepHistoryEntry:true});rememberOpener();}}
        expanded={reading.expanded} onExpand={reading.expand} onCollapse={reading.collapse}
        retrying={retrying} retryError={retryError} onRetry={active.jobId?()=>void retryStory():undefined} />
    : explorePanel==="place" ? <PlaceSheet address={place?.address??null} busy={placeBusy} error={placeError} preparing={preparing} prepareError={prepareError} walkHref={place?walkHref:null} onPrepare={()=>void prepareStory()} onClose={closePlace} onWalk={rememberOpener} />
    : explorePanel==="nearby" ? <NearbySheet status={nearbyStatus} radius={nearbyRadius} recommendations={recommendations} onRadius={setNearbyRadius} onSelect={selectRecommendation} onClose={()=>{setNearbyCenter(null);setPlace(null);setPrompt(false);}} />
    : null;
  // An empty slot must stay null: the shell gives the dock room only when there is something to show.
  const noticeList = [
    parking.visible&&parking.unavailable?<p key="parking-unavailable" className={a.notice} role="status">{t("Парковки пока недоступны. Попробуйте позже.")}</p>:null,
    parking.zoomHint?<p key="parking-zoom" className={a.notice} role="status">{t("Приблизьте карту, чтобы увидеть парковки")}</p>:null,
    parking.visible&&parking.error?<div key="parking-error" className={styles.catalogStatus} role="status"><span>{t("Не удалось загрузить парковки")}</span><button type="button" onClick={()=>void parking.retry()}>{t("Повторить загрузку парковок")}</button></div>:null,
    parking.loading?<p key="parking-loading" className={a.notice} role="status">{t("Загружаем парковки…")}</p>:null,
    !creating&&food.zoomHint?<p key="food-zoom" className={a.notice} role="status">{t("Приблизьте карту, чтобы увидеть заведения")}</p>:null,
    !creating&&food.error?<div key="food-error" className={styles.catalogStatus} role="status"><span>{t("Не удалось загрузить заведения")}</span><button type="button" onClick={()=>void food.retry()}>{t("Повторить загрузку заведений")}</button></div>:null,
    !creating&&food.loading?<p key="food-loading" className={a.notice} role="status">{t("Загружаем заведения…")}</p>:null,
    walkOverview.error?<div key="walks-error" className={styles.catalogStatus} role="status"><span>{t("Не удалось загрузить прогулки")}</span><button type="button" onClick={walkOverview.retry}>{t("Повторить загрузку прогулок")}</button></div>:null,
    walkOverview.loading&&!walkOverview.walks.length?<p key="walks-loading" className={a.notice} role="status">{t("Загружаем прогулки…")}</p>:null,
    catalogStatus!=="ready"||catalogMaintenance?<div key="catalog" className={styles.catalogStatus} data-region="catalog-status"><span role="status" aria-atomic="true">{t(catalogMaintenance?"Сервис обновляется. Карта загрузится автоматически.":catalogStatus==="error"?"Не все места загрузились.":"Загружаем места…")}</span>{catalogStatus==="loading"&&!catalogMaintenance?<progress aria-label={t("Загрузка мест на карте")}/>:null}{catalogStatus==="error"&&!catalogMaintenance?<button type="button" onClick={retryCatalog}>{t("Повторить загрузку мест")}</button>:null}</div>:null,
    !creating&&linkedId&&linked.status==="loading"?<LinkNotice key="link" message={t("Открываем историю…")} onClose={()=>leavePlace({replace:true})} />
    :!creating&&linkedId&&(linked.status==="error"||(linked.status==="ready"&&!linkedHeader))?<LinkNotice key="link" message={t("Не удалось открыть историю.")} alert onRetry={linked.status==="error"?linked.retry:undefined} onClose={()=>leavePlace({replace:true})} />
    :!creating&&linkNotice?<LinkNotice key="link" message={linkNotice} onClose={()=>setLinkNotice("")} />:null,
    !creating&&geoMessage?<GeoNotice key="geo" message={geoMessage} outside={geoOutside} failed={geo==="denied"||geo==="error"} denied={geo==="denied"} onCity={showCity} onRetry={locate} onClose={()=>{setGeoMessage("");setGeoOutside(false);}} />:null,
    !creating&&!sheet&&mapHintVisible?<MapHintNotice key="hint" onClose={()=>setMapHintVisible(false)} />:null,
    !creating&&updateAvailable?<a key="update" className={a.notice} href={`/update.html?lang=${locale}`}>{t("Доступна новая версия · обновить")}</a>:null,
  ].filter(Boolean);
  const notices = noticeList.length ? noticeList : null;

  const geoControlState=geo==="denied"?"denied":geoError==="unsupported"?"unavailable":geo==="loading"?"locating":geo==="error"||(geo==="ready"&&user&&user.accuracyM>50)?"weak":geo==="ready"?"ready":"idle";
  const geoDescription=geoControlState==="denied"?t("Нет доступа к геолокации.")
    :geoControlState==="unavailable"?t("Геолокация недоступна в этом браузере.")
    :geoControlState==="locating"?t("Определяем положение…")
    :geoControlState==="weak"?user&&Number.isFinite(user.accuracyM)?t("Низкая точность геолокации: около {accuracy} м.",{accuracy:Math.round(user.accuracyM)}):t("Не удаётся определить точное местоположение.")
    :geoControlState==="ready"?t("Местоположение определено."):t("Моё местоположение");
  const geoIcon=geoControlState==="denied"||geoControlState==="unavailable"?"locateOff":geoControlState==="weak"?"locateWeak":"locate";

  return <>
    <MapShell
      map={{onViewport:handleViewport,viewState:nearbyMapView,walkLines:creating?undefined:walkLines,fitTarget:creating?null:walkFit,selectedWalk:creating?null:shownWalk,onWalks:creating?undefined:selectWalks,items:creating?[...creationItems,...parkingItems.filter(item=>!creationItems.some(existing=>existing.id===item.id))]:mapItems,routeSegments:creating?creationMap.routeSegments:undefined,geometry:creating?creationMap.geometry:undefined,tunnels:creating?creationMap.tunnels:undefined,selectedId:parkingPlace?`parking:${parkingPlace.id}`:foodPlace?`food:${foodPlace.id}`:selected??(place?"picked-place":undefined),focus:creating?creationMap.focus:focus,user,
        onSelect:id=>{const parkingValue=parking.places.find(value=>`parking:${value.id}`===id);if(parkingValue){if(creating)setPicked(parkingValue.pedestrianAccess);else{lookup.current?.abort();prepareRequest.current?.abort();setPlaceBusy(false);setPlace(null);setPlaceError("");setPreparing(false);setSelected(undefined);setSelectedFood(null);setPrompt(false);setNearbyCenter(null);leavePlace();closeWalks();setSelectedParking(parkingValue);setFocus(parkingValue.location);}return;}const value=food.places.find(value=>`food:${value.id}`===id);if(!creating&&value){selectFood(value);return;}const pin=storyPins.find(value=>value.id===id);if(pin){if(creating)setPicked(pin.location);else select(pin);}},
        onPoint:point=>creating?setPicked(point):void findPlace(point)}}
      controls={creating?null:<><MapControlButton aria-label={t("Парковки")} aria-pressed={parking.enabled} className={styles.layerToggle} onClick={()=>{setSelectedParking(null);parking.toggle();}}><span aria-hidden="true">P</span></MapControlButton>{walkOverview.unavailable?null:<MapControlButton aria-label={t("Прогулки на карте")} aria-pressed={walkOverview.enabled} className={styles.layerToggle} onClick={()=>{if(walkOverview.enabled)closeWalks();walkOverview.toggle();}}><ExploreIcon name="routes"/></MapControlButton>}{walkOverview.visible&&walkOverview.inView.length?<button type="button" className={styles.walkListLink} onClick={()=>selectWalks(walkOverview.inView.map(walk=>walk.key),{choose:false})}>{t("Список прогулок на карте: {count}",{count:walkOverview.inView.length})}</button>:null}{!food.unavailable&&food.manifest?<MapControlButton aria-label={t("Еда")} aria-pressed={food.enabled} className={styles.layerToggle} onClick={()=>{setSelectedFood(null);food.toggle();}}><ExploreIcon name="cup"/></MapControlButton>:null}<MapControlButton aria-label={t("Моё местоположение")} aria-describedby={geoStatusId} aria-busy={geo==="loading"} title={geoDescription} data-location-state={geoControlState} className={styles.geoControl} onClick={locate} disabled={geo==="loading"}><ExploreIcon name={geoIcon}/><span id={geoStatusId} className={styles.geoStatus} role="status">{geoDescription}</span></MapControlButton></>}
      notices={notices}
      sheet={sheet} sheetExpanded={reading.expanded&&storyShown} onCollapseSheet={reading.collapse} />
    {unlocalizedPath(pathname) === "/" && <AppNavigation onWalk={rememberOpener} embedded active={creating ? "walk" : "nearby"} onNearby={()=>{if(creating)closeCreation();}} />}
  </>;
}

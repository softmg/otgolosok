"use client";

import { useEffect, useRef, useState } from "react";
import type * as Leaflet from "leaflet";
import type { Coordinates } from "../tour/types";
import "leaflet/dist/leaflet.css";
import "./map-dots.css";

export type MapItem = {id:string; title:string; location:Coordinates; number?:number; pending?:boolean; compact?:boolean};
export type MapFocus = Coordinates & {zoom?:number};
export type MapViewState = {current: {center:Coordinates; zoom:number; focus:MapFocus|null}|null};
export function ExploreMap({items,selectedId,focus,user,onSelect,onPoint,geometry,mapLabel,viewState,routePadding}: {
  items: MapItem[]; selectedId?:string; focus:MapFocus|null; user:(Coordinates&{accuracyM:number})|null;
  onSelect:(id:string)=>void; onPoint:(point:Coordinates)=>void;
  geometry?: Coordinates[]; mapLabel?: string; viewState?: MapViewState; routePadding?: {top:number;right:number;bottom:number;left:number};
}) {
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<{L:typeof Leaflet; map:Leaflet.Map; markers:Leaflet.LayerGroup; position:Leaflet.LayerGroup; route:Leaflet.LayerGroup}|null>(null);
  const handlers = useRef({onSelect,onPoint});
  const appliedFocus = useRef<Coordinates|null>(null);
  const [ready,setReady] = useState(false);
  const [tileError,setTileError] = useState(false);
  const [mapError,setMapError] = useState(false);
  useEffect(()=>{handlers.current={onSelect,onPoint};},[onSelect,onPoint]);

  useEffect(()=>{
    let disposed=false;
    let observer:ResizeObserver|undefined;
    let saveView:(()=>void)|undefined;
    void import("leaflet").then((L)=>{
      if(disposed||!container.current)return;
      const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;
      const saved=viewState?.current;
      appliedFocus.current=saved?.focus??null;
      // Leaflet 1.9 leaves its zoom transition timer alive after remove().
      // Zoom immediately so switching tabs mid-zoom cannot touch a removed map.
      const map=L.map(container.current,{zoomControl:false,attributionControl:false,zoomAnimation:false,fadeAnimation:!reduced,markerZoomAnimation:false,minZoom:3,maxZoom:19}).setView(saved?[saved.center.lat,saved.center.lon]:[55.7249,37.6507],saved?.zoom??16);
      if(viewState){
        saveView=()=>{const center=map.getCenter();viewState.current={center:{lat:center.lat,lon:center.lng},zoom:map.getZoom(),focus:appliedFocus.current};};
        map.on("moveend zoomend",saveView);
      }
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,updateWhenIdle:true,keepBuffer:1}).on("tileerror",()=>setTileError(true)).on("tileload",()=>setTileError(false)).addTo(map);
      L.control.zoom({position:"bottomright",zoomInTitle:"Приблизить",zoomOutTitle:"Отдалить"}).addTo(map);
      map.on("click",(event:Leaflet.LeafletMouseEvent)=>handlers.current.onPoint({lat:event.latlng.lat,lon:event.latlng.lng}));
      runtime.current={L,map,markers:L.layerGroup().addTo(map),position:L.layerGroup().addTo(map),route:L.layerGroup().addTo(map)};
      observer=new ResizeObserver(()=>{if(!disposed)map.invalidateSize();});observer.observe(container.current);
      setReady(true);
    }).catch(()=>{if(!disposed)setMapError(true);});
    return ()=>{
      disposed=true;
      observer?.disconnect();
      const map=runtime.current?.map;
      if(map){
        saveView?.();
        // Leaflet may emit a delayed resize event after remove().
        if(saveView)map.off("moveend zoomend",saveView);
        map.remove();
      }
      runtime.current=null;
    };
  },[viewState]);

  useEffect(()=>{
    const rt=runtime.current;if(!rt||!ready)return;
    rt.markers.clearLayers();
    for(const item of items) {
      const active=item.id===selectedId;
      // Marker contents are fixed symbols/numbers, never upstream HTML.
      const label=item.number ? String(item.number) : item.pending ? "…" : "♪";
      const icon=item.compact ? rt.L.divIcon({className:"explore-dot",html:"<span></span>",iconSize:[32,32],iconAnchor:[16,16]}) : rt.L.divIcon({className:`explore-pin${active?" selected":""}${item.pending?" pending":""}`,html:`<span><b>${label}</b></span>`,iconSize:[44,52],iconAnchor:[22,48]});
      const marker=rt.L.marker([item.location.lat,item.location.lon],{icon,title:item.title,alt:item.title,keyboard:true,zIndexOffset:item.compact?-1000:0,bubblingMouseEvents:false}).addTo(rt.markers);
      marker.on("click",()=>handlers.current.onSelect(item.id));
      marker.getElement()?.setAttribute("aria-pressed",String(active));
    }
  },[items,selectedId,ready]);

  useEffect(()=>{
    const rt=runtime.current;if(!rt||!ready||!focus)return;
    // A remount must not replay the old selection over a manually moved view.
    if(focus===appliedFocus.current)return;
    appliedFocus.current=focus;
    rt.map.setView([focus.lat,focus.lon],focus.zoom??Math.max(rt.map.getZoom(),16),{animate:false});
    if(focus.zoom===undefined)rt.map.panBy([0,80],{animate:false});
  },[focus,ready]);

  useEffect(()=>{
    const rt=runtime.current;if(!rt||!ready)return;
    rt.route.clearLayers();
    if(!geometry || geometry.length<2)return;
    const line=rt.L.polyline(geometry.map(p=>[p.lat,p.lon] as [number,number]),{color:"#203e38",weight:5,opacity:.9,interactive:false}).addTo(rt.route);
    rt.map.fitBounds(line.getBounds(),{paddingTopLeft:routePadding?[routePadding.left,routePadding.top]:[35,35],paddingBottomRight:routePadding?[routePadding.right,routePadding.bottom]:[35,35],maxZoom:17,animate:false});
  },[geometry,ready,routePadding]);

  useEffect(()=>{
    const rt=runtime.current;if(!rt||!ready)return;
    rt.position.clearLayers();if(!user)return;
    // Keep the user's position visually distinct from story pins.  A custom
    // icon is more reliable than a tiny circleMarker on high-DPI/mobile maps.
    rt.L.circle([user.lat,user.lon],{radius:Math.min(Math.max(user.accuracyM,20),5000),color:"#246b90",weight:2,fillColor:"#246b90",fillOpacity:.16,interactive:false}).addTo(rt.position);
    const icon=rt.L.divIcon({className:"explore-user-position",html:"<span aria-hidden=\"true\"></span>",iconSize:[30,30],iconAnchor:[15,15]});
    rt.L.marker([user.lat,user.lon],{icon,interactive:false,zIndexOffset:1000}).addTo(rt.position);
  },[user,ready]);

  return <div className="explore-map-layer">
    <div ref={container} className="explore-map" aria-label={mapLabel??"Карта историй. Выберите отметку или нажмите на дом, чтобы подготовить историю."} />
    {!ready?<p className="map-loading" role="status">{mapError?"Карта не загрузилась. Откройте список историй.":"Загружаем карту…"}</p>:null}
    {tileError?<p className="map-network-note" role="status">Карта требует интернета. Сохранённые истории доступны в разделе «Сохранено».</p>:null}
    <a className="map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>
  </div>;
}

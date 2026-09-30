import { afterEach, expect, it, vi } from "vitest";
import type { MapFocus, MapViewState } from "./explore-map";

const mock=vi.hoisted(()=>({effects:[] as Array<()=>void|(()=>void)>,maps:[] as Array<{setView:ReturnType<typeof vi.fn<([lat,lng]:number[],zoom:number)=>unknown>>;panBy:ReturnType<typeof vi.fn>;fire:(event:string)=>void}>}));
vi.mock("react",()=>({
  useRef:(current:unknown)=>({current:current??{}}),
  useState:()=>[true,vi.fn()],
  useEffect:(effect:()=>void|(()=>void))=>mock.effects.push(effect),
}));
vi.mock("./map-clusters",()=>({
  loadMapLibrary:()=>import("leaflet"),
  createMapClusters:()=>({addTo:vi.fn().mockReturnThis(),addLayers:vi.fn()}),
}));
vi.mock("leaflet",()=>{
  const layer=()=>({addTo:vi.fn().mockReturnThis(),on:vi.fn().mockReturnThis(),clearLayers:vi.fn()});
  return {
    map:()=>{
      let center={lat:0,lng:0},zoom=0,removed=false;
      const listeners=new Map<string,Set<()=>void>>();
      const map={
        setView:vi.fn(([lat,lng]:number[],value:number)=>{center={lat,lng};zoom=value;return map;}),
        getCenter:()=>{if(removed)throw new Error("Cannot read a removed map");return center;},getZoom:()=>zoom,
        on:(events:string,handler:()=>void)=>{for(const event of events.split(" ")){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event)!.add(handler);}},
        off:(events:string,handler:()=>void)=>{for(const event of events.split(" "))listeners.get(event)?.delete(handler);},
        fire:(event:string)=>{listeners.get(event)?.forEach(handler=>handler());},
        remove:vi.fn(()=>{removed=true;}),invalidateSize:vi.fn(),panBy:vi.fn(),
      };
      mock.maps.push(map);return map;
    },
    tileLayer:layer,layerGroup:layer,control:{zoom:layer,scale:layer},
  };
});

import { ExploreMap } from "./explore-map";

afterEach(()=>{mock.effects=[];mock.maps=[];vi.unstubAllGlobals();});

async function mount(viewState?:MapViewState,focus:MapFocus|null=null){
  vi.stubGlobal("matchMedia",()=>({matches:true}));
  vi.stubGlobal("ResizeObserver",class{observe(){} disconnect(){}});
  mock.effects=[];
  ExploreMap({items:[],focus,user:null,onSelect:vi.fn(),onPoint:vi.fn(),viewState});
  const effects=[...mock.effects];
  effects[0]();
  const cleanup=effects[1]();
  await vi.dynamicImportSettled();
  effects.slice(2).forEach(effect=>effect());
  return {map:mock.maps.at(-1)!,cleanup};
}

it("restores the actual center and zoom after leaving and returning to the map",async()=>{
  const state:MapViewState={current:null};
  const first=await mount(state);
  expect(first.map.setView).toHaveBeenCalledWith([55.7249,37.6507],16);
  first.map.setView([55.76,37.61],14);
  first.cleanup?.();
  const returned=await mount(state);
  expect(returned.map.setView).toHaveBeenCalledExactlyOnceWith([55.76,37.61],14);
  returned.cleanup?.();
});

it("does not replay old focus, but allows a new selection to recenter",async()=>{
  const focus={lat:55.75,lon:37.6};
  const state:MapViewState={current:null};
  const first=await mount(state,focus);
  first.map.setView([55.76,37.61],14);
  first.cleanup?.();
  const returned=await mount(state,focus);
  expect(returned.map.setView).toHaveBeenCalledExactlyOnceWith([55.76,37.61],14);
  expect(returned.map.panBy).not.toHaveBeenCalled();
  returned.cleanup?.();
  const selected=await mount(state,{...focus});
  expect(selected.map.setView).toHaveBeenLastCalledWith([55.75,37.6],16,{animate:false});
  selected.cleanup?.();
});

it("does not share the nearby viewport with maps that do not opt in",async()=>{
  const state:MapViewState={current:{center:{lat:55.76,lon:37.61},zoom:14,focus:null}};
  const other=await mount();
  expect(other.map.setView).toHaveBeenCalledExactlyOnceWith([55.7249,37.6507],16);
  other.cleanup?.();
  expect(state.current?.zoom).toBe(14);
});

it("opens a Moscow overview from a foreign viewport and preserves it across navigation",async()=>{
  const state:MapViewState={current:{center:{lat:52.52,lon:13.405},zoom:19,focus:null}};
  const focus:MapFocus={lat:55.74,lon:37.62,zoom:12};
  const first=await mount(state,focus);
  expect(first.map.setView).toHaveBeenLastCalledWith([55.74,37.62],12,{animate:false});
  first.cleanup?.();
  const returned=await mount(state,focus);
  expect(returned.map.setView).toHaveBeenCalledExactlyOnceWith([55.74,37.62],12);
  returned.cleanup?.();
});

it("ignores late resize events from an unmounted map without losing the saved view",async()=>{
  const state:MapViewState={current:null};
  const first=await mount(state);
  first.map.setView([55.76,37.61],14);
  first.map.fire("moveend");
  expect(state.current?.center).toEqual({lat:55.76,lon:37.61});
  first.cleanup?.();
  const returned=await mount(state);
  returned.map.setView([55.77,37.62],15);
  returned.map.fire("zoomend");
  expect(()=>{
    first.map.fire("moveend");
    first.map.fire("zoomend");
  }).not.toThrow();
  expect(state.current).toEqual({center:{lat:55.77,lon:37.62},zoom:15,focus:null});
  returned.cleanup?.();
});

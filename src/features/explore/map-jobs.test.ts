import { afterEach, describe, expect, it, vi } from "vitest";
import { isMoscowPoint, MOSCOW_CENTER, parseMapJobs, placeFromQuery, rememberMapJob, readMapJobs } from "./map-jobs";
import type { GenerationJob } from "../generator/types";

const id="11111111-1111-4111-a111-111111111111";
const place={address:"Москва, Арбат, 10",location:{lat:55.75,lon:37.6}};
afterEach(()=>vi.unstubAllGlobals());
describe("map bookmarks",()=>{
  it("rejects malformed storage, foreign coordinates and duplicate IDs",()=>{
    expect(parseMapJobs("not-json")).toEqual([]);
    expect(parseMapJobs(JSON.stringify([{id,...place},{id,...place},{id:"bad",...place},{id:"22222222-2222-4222-a222-222222222222",...place,location:{lat:0,lon:0}}]))).toEqual([{id,...place}]);
  });
  it("requires an explicit valid address and both coordinates in a link",()=>{
    expect(placeFromQuery(new URLSearchParams({address:place.address,lat:"55.75",lon:"37.6"}))).toEqual(place);
    for(const query of ["address=Арбат&lat=55.75","address=Арбат&lat=&lon=37.6","address=Арбат&lat=NaN&lon=37.6","lat=55.75&lon=37.6"]){expect(placeFromQuery(new URLSearchParams(query))).toBeNull();}
  });
  it("does not attach an edited address to the originally selected map point",()=>{
    const memory=new Map<string,string>();
    vi.stubGlobal("localStorage",{getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>memory.set(key,value)});
    rememberMapJob({id,address:"Москва, Арбат, 11"} as GenerationJob,place);
    expect(readMapJobs()).toEqual([]);
    rememberMapJob({id,address:"Москва, Арбат, 10"} as GenerationJob,place);
    expect(readMapJobs()).toEqual([{id,...place}]);
    rememberMapJob({id,address:"Москва, Арбат, 10"} as GenerationJob,place);
    expect(readMapJobs()).toHaveLength(1);
  });
  it("keeps generation usable when browser storage is unavailable",()=>{
    vi.stubGlobal("localStorage",{getItem:()=>{throw new Error("denied");},setItem:()=>{throw new Error("denied");}});
    expect(()=>rememberMapJob({id,address:place.address} as GenerationJob,place)).not.toThrow();
    expect(readMapJobs()).toEqual([]);
  });
});
describe("возврат к карте Москвы",()=>{
  it("ведёт в точку внутри каталога, чтобы после перехода были видны истории",()=>{
    expect(isMoscowPoint(MOSCOW_CENTER)).toBe(true);
  });
});

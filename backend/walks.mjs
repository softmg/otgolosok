import { MAX_WALK_STOPS, MAX_ROUTE_TUNNELS } from "./walk-document.mjs";
import discoveryCatalog from './walk-discovery-catalog.json' with { type: 'json' };

const fail = (code) => Object.assign(new Error(code), {code});
const inBox = (p) => p && typeof p.lat === 'number' && typeof p.lon === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat >= 55.48 && p.lat <= 55.98 && p.lon >= 37.30 && p.lon <= 37.95;
const keys = (v, allowed) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
const clean = (v, max) => typeof v === 'string' && v.length <= max && !/[\p{Cc}\p{Cf}<>]/u.test(v) ? v.trim().replace(/\s+/g, ' ') : '';
// Signals that a building may carry researchable history. A name alone qualifies
// every shop and office tower; most Moscow landmarks carry their title in the
// linked Wikidata item rather than in an OSM name tag.
const DISCOVERY_TAGS = ['[historic]', '[heritage]', '[tourism=museum]', '[wikidata]', '[wikipedia]', '[architect]'];
const notable = (t) => Boolean(t.historic && t.historic !== 'no' || t.heritage && t.heritage !== 'no' || t.tourism === 'museum'
  || /^Q[1-9]\d{0,15}$/.test(t.wikidata ?? '') || clean(t.wikipedia, 300) || clean(t.architect, 300));
const distance = (a,b) => {
  const rad = Math.PI / 180;
  const h = Math.sin((b.lat-a.lat)*rad/2)**2 + Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin((b.lon-a.lon)*rad/2)**2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1,h)));
};
const AUTO_STOP_LIMITS = {30:5,60:8,90:10};
const NEAR_ROUTE_METERS = 50;
// Automatic walks without a destination aim for at least this share of the chosen walking time.
export const MIN_BUDGET_SHARE = 0.75;
// Valhalla's pedestrian default is about 5.1 km/h; streets add roughly a third to straight lines.
const WALK_METERS_PER_MINUTE = 85;
const STRAIGHT_TO_WALK = 1.3;
// Valhalla snaps every location to its nearest pedestrian edge. A wide radius lets it
// pick a different edge for each leg at the same stop, which breaks the walk into
// pieces; the reachability floor keeps points off closed patches of paths.
const SNAP_RADIUS_METERS = 0;
const MIN_REACHABILITY_NODES = 500;
// Valhalla error codes for "no path" and "no suitable edges near a location".
const UNROUTABLE_CODES = [442, 171];
// The start, the destination and user-chosen stops may lie inside a courtyard;
// an automatic stop farther from the street than this is a poor candidate.
const MAX_POINT_SNAP_METERS = 150;
const MAX_AUTO_STOP_SNAP_METERS = 75;
// A landmark this close to the start is the first stop without a walking leg.
const START_STOP_METERS = 40;
export const MAX_AUTO_ROUTER_CALLS = 12;
const MAX_SPACING_STEPS = 16;
const MIN_SPACING_STEP_METERS = 20;
const RANK_WINDOW_METERS = 150;
const contentId = value => typeof value === 'string' && /^osm:(node|way|relation):\d+$/.test(value);
const readinessRank = {none:0,story:1,audio:2};
// Same normalization as addressKey in domain.mjs, without hashing.
const sameAddressKey = address => address.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[.,]/g,' ').replace(/\s+/g,' ').trim();
const publicStop = p => ({address:p.address,location:p.location,...(p.contentId?{contentId:p.contentId}:{})});

// Approximate a point against a short Moscow walking polyline. Besides the
// distance, progress keeps landmarks in walking order instead of creating
// backtracking between nearby buildings.
function routeProximity(point, geometry) {
  let best={distanceM:Infinity,progressM:Infinity},passed=0;
  for(let i=1;i<geometry.length;i++) {
    const a=geometry[i-1],b=geometry[i],lat=(a.lat+b.lat+point.lat)/3*Math.PI/180;
    const scaleX=111320*Math.cos(lat),scaleY=111320;
    const bx=(b.lon-a.lon)*scaleX,by=(b.lat-a.lat)*scaleY;
    const px=(point.lon-a.lon)*scaleX,py=(point.lat-a.lat)*scaleY;
    const length2=bx*bx+by*by,t=length2?Math.max(0,Math.min(1,(px*bx+py*by)/length2)):0;
    const segmentM=Math.sqrt(length2),distanceM=Math.hypot(px-bx*t,py-by*t);
    if(distanceM<best.distanceM)best={distanceM,progressM:passed+segmentM*t};
    passed+=segmentM;
  }
  return best;
}

// Greedy chain for a walk without a destination. Consecutive stops keep at least
// spacingM between them, so a larger spacing spreads the same number of stories
// over a longer walk. Straight-line distances only shape the chain; the router
// still measures and accepts every walk. Among comparably placed landmarks,
// ready content and the map catalog win, as on routes with a destination.
export function selectChain({start,candidates,stopLimit,spacingM,loop,straightBudgetM}) {
  const chain=[];let current=start,used=0;
  while(chain.length<stopLimit) {
    const eligible=[];
    for(const candidate of candidates) {
      if(chain.includes(candidate))continue;
      const step=distance(current.location,candidate.location);
      if(step<spacingM||[start,...chain].some(p=>distance(p.location,candidate.location)<spacingM/2))continue;
      if(used+step+(loop?distance(candidate.location,start.location):0)>straightBudgetM)continue;
      eligible.push({candidate,step});
    }
    if(!eligible.length)break;
    const reach=Math.max(spacingM*1.5,spacingM+RANK_WINDOW_METERS),near=eligible.filter(item=>item.step<=reach);
    const next=near.length
      ?near.sort((a,b)=>b.candidate.contentRank-a.candidate.contentRank||b.candidate.catalogRank-a.candidate.catalogRank||a.step-b.step)[0]
      :eligible.sort((a,b)=>a.step-b.step)[0];
    chain.push(next.candidate);used+=next.step;current=next.candidate;
  }
  return chain;
}

function place(p) {
  if (!keys(p,['address','location','contentId']) || !clean(p.address,240) || !keys(p.location,['lat','lon']) || !inBox(p.location) || (p.contentId!==undefined&&!contentId(p.contentId))) throw fail('WALK_INVALID');
  return {address:clean(p.address,240),location:{lat:p.location.lat,lon:p.location.lon},...(p.contentId?{contentId:p.contentId}:{})};
}

// Valhalla's default shape is a latitude/longitude polyline with six decimals.
function decode(shape) {
  if (typeof shape !== 'string' || !shape.length || shape.length > 200000) throw fail('WALK_UNAVAILABLE');
  const points=[]; let i=0,lat=0,lon=0;
  function delta() {
    let value=0,shift=0,byte;
    do {
      if(i>=shape.length || shift>30)throw fail('WALK_UNAVAILABLE');
      byte=shape.charCodeAt(i++)-63;
      if(byte<0||byte>63)throw fail('WALK_UNAVAILABLE');
      value+=(byte&31)*2**shift;shift+=5;
    } while(byte>=32);
    return value%2 ? -(value+1)/2 : value/2;
  }
  while(i<shape.length) {
    lat+=delta();lon+=delta();const p={lat:lat/1e6,lon:lon/1e6};
    if(!inBox(p)||points.length>=12000)throw fail('WALK_UNAVAILABLE');
    points.push(p);
  }
  if(points.length<2)throw fail('WALK_UNAVAILABLE');
  return points;
}

const MAX_RESPONSE_BYTES=1024*1024;
// Reads a JSON body up to MAX_RESPONSE_BYTES; aborting the signal cancels the stream.
async function readJson(response,signal) {
  const reader=response.body.getReader(),chunks=[];let size=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',cancel,{once:true});
  try {
    while(true) {
      signal.throwIfAborted();
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;if(size>MAX_RESPONSE_BYTES)throw fail('WALK_UNAVAILABLE');chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally {signal.removeEventListener('abort',cancel);cancel();}
}

// An http(s) URL without credentials, otherwise null.
const routerEndpoint=value=>{
  if(!value)return null;
  try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.toString():null;}
  catch {return null;}
};

// Tunnel data only changes how the line is drawn, and the planner shares one hard
// budget between routing and this lookup. A failed lookup is not retried: the walk
// is shown with a solid line, and the next route build asks again.
export const TRACE_TIMEOUT_MS=1500;
const TRACE_MIN_REMAINING_MS=2000;
const TUNNEL_MATCH_METERS=3;
// Distance in metres from a point to a short polyline, on a local plane.
function polylineDistance(point,line) {
  const scaleX=111320*Math.cos(point.lat*Math.PI/180),scaleY=111320;
  const at=p=>({x:(p.lon-point.lon)*scaleX,y:(p.lat-point.lat)*scaleY});
  let best=Math.hypot(at(line[0]).x,at(line[0]).y);
  for(let i=1;i<line.length;i++) {
    const a=at(line[i-1]),b=at(line[i]),dx=b.x-a.x,dy=b.y-a.y,length2=dx*dx+dy*dy;
    const t=length2?Math.max(0,Math.min(1,-(a.x*dx+a.y*dy)/length2)):0;
    best=Math.min(best,Math.hypot(a.x+dx*t,a.y+dy*t));
  }
  return best;
}

/**
 * Covered stretches of a routed walk as [a, b] vertex ranges of the concatenated
 * geometry (each leg after the first drops its first point, as in measureRoute).
 * Valhalla's matched shape does not keep our vertices, so tunnel edges are mapped
 * back geometrically. Best effort: any failure returns null, never a partial set.
 * @param {Array<Array<{lat:number,lon:number}>>} legs
 * @param {{fetchImpl:WalkFetch,traceUrl:string|undefined|null,signal?:AbortSignal,timeoutMs?:number}} options
 * @returns {Promise<Array<[number,number]>|null>}
 */
export async function traceTunnels(legs,{fetchImpl,traceUrl,signal,timeoutMs=TRACE_TIMEOUT_MS}) {
  const url=routerEndpoint(traceUrl);
  if(!url||signal?.aborted)return null;
  const controller=new AbortController(),abort=()=>controller.abort();
  const timer=setTimeout(abort,timeoutMs);
  signal?.addEventListener('abort',abort,{once:true});
  try {
    const covered=new Set();let offset=0;
    for(const leg of legs) {
      const body={shape:leg.map(p=>({lat:p.lat,lon:p.lon})),costing:'pedestrian',shape_match:'walk_or_snap',
        filters:{attributes:['edge.tunnel','edge.begin_shape_index','edge.end_shape_index','shape'],action:'include'}};
      const response=await fetchImpl(url,{method:'POST',body:JSON.stringify(body),redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json',Accept:'application/json','User-Agent':'Otgolosok/0.1 (+https://otgolosok.online)'}});
      if(!response?.ok||!response.body?.getReader){await response?.body?.cancel();return null;}
      const data=await readJson(response,controller.signal);
      if(!Array.isArray(data?.edges)||data.edges.length>20000)return null;
      const shape=decode(data.shape);
      for(const edge of data.edges) {
        if(edge?.tunnel!==true)continue;
        const begin=edge.begin_shape_index,end=edge.end_shape_index;
        if(!Number.isSafeInteger(begin)||!Number.isSafeInteger(end)||begin<0||end<begin||end>=shape.length)return null;
        const part=shape.slice(begin,end+1);
        for(let i=1;i<leg.length;i++)
          if(polylineDistance(leg[i-1],part)<=TUNNEL_MATCH_METERS&&polylineDistance(leg[i],part)<=TUNNEL_MATCH_METERS)covered.add(offset+i-1);
      }
      offset+=Math.max(0,leg.length-1);
    }
    // Segment g joins vertices g and g+1; consecutive covered segments form one range.
    /** @type {Array<[number,number]>} */
    const ranges=[];
    for(const segment of [...covered].sort((a,b)=>a-b)) {
      const last=ranges.at(-1);
      if(last&&last[1]===segment)last[1]=segment+1;else ranges.push([segment,segment+1]);
    }
    return ranges.length<=MAX_ROUTE_TUNNELS?ranges:null;
  } catch {return null;}
  finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
}

/**
 * @typedef {{type?: string, id?: number, lat?: number, lon?: number, center?: {lat: number, lon: number},
 *   tags?: Record<string, string>}} OverpassElement
 * @typedef {(url: string, init: {method: string, body: string, redirect?: "error" | "follow" | "manual", signal: AbortSignal,
 *   headers: Record<string, string>}) => Promise<Response>} WalkFetch
 */

/**
 * @param {{fetchImpl?: WalkFetch, now?: () => number, routerUrl?: string, traceUrl?: string, overpassUrl?: string,
 *   discoveryElements?: OverpassElement[] | null, candidateProvider?: ((query: {lat: number, lon: number, radius: number, limit: number, published: boolean}) => any) | null,
 *   timeoutMs?: number, minIntervalMs?: number, maxWaiters?: number, maxWaitMs?: number}} [options]
 */
export function createWalkPlanner({fetchImpl=fetch, now=Date.now,
  routerUrl=process.env.WALK_ROUTER_URL,traceUrl=process.env.WALK_TRACE_URL,
  overpassUrl=process.env.WALK_OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter',
  discoveryElements=process.env.WALK_DISCOVERY_SOURCE==='overpass'?null:discoveryCatalog.elements,candidateProvider=null,
  timeoutMs=12000, minIntervalMs=2000, maxWaiters=8, maxWaitMs=10000}={}) {
  const traceEndpoint=routerEndpoint(traceUrl);
  // One plan at a time, started at least minIntervalMs apart, keeps the router
  // and Overpass load bounded. Other requests wait in a short FIFO queue; one
  // client may start at most one plan per interval.
  let active=false,lastStart=-Infinity,pumpTimer=null;
  const waiters=[],recentByClient=new Map();
  const pump=()=>{
    if(active||!waiters.length||pumpTimer)return;
    const delay=lastStart+minIntervalMs-now();
    if(delay>0){pumpTimer=setTimeout(()=>{pumpTimer=null;pump();},delay);return;}
    const next=waiters.shift();clearTimeout(next.timer);
    active=true;lastStart=now();next.resolve();
  };
  const acquire=()=>{
    if(!active&&!waiters.length&&now()-lastStart>=minIntervalMs){active=true;lastStart=now();return;}
    if(waiters.length>=maxWaiters)throw fail('WALK_BUSY');
    return new Promise((resolve,reject)=>{
      const waiter={resolve,timer:setTimeout(()=>{waiters.splice(waiters.indexOf(waiter),1);reject(fail('WALK_BUSY'));},maxWaitMs)};
      waiters.push(waiter);pump();
    });
  };
  const release=()=>{active=false;pump();};
  const limitClient=client=>{
    if(!client)return;
    const time=now(),last=recentByClient.get(client);
    if(last!==undefined&&time-last<minIntervalMs)throw fail('WALK_RATE_LIMITED');
    if(recentByClient.size>=1024)for(const [key,value] of recentByClient)if(time-value>=minIntervalMs)recentByClient.delete(key);
    recentByClient.set(client,time);
  };
  // storiesOnly: automatic stops come only from places with published content
  // (promo walks for YouTube Shorts); ordinary walks also take plain landmarks.
  return async function planWalk(input,{client=null,storiesOnly=false}={}) {
    if(!keys(input,['start','mode','minutes','stops','destination']) || !['loop','open'].includes(input.mode) || ![30,60,90].includes(input.minutes))throw fail('WALK_INVALID');
    const stopLimit=AUTO_STOP_LIMITS[input.minutes];
    const destination=input.destination==null?null:place(input.destination);
    if(destination&&input.mode!=='open')throw fail('WALK_INVALID');
    const start=place(input.start), manual=Object.hasOwn(input,'stops');
    if(manual&&(!Array.isArray(input.stops)||input.stops.length<(destination?0:1)||input.stops.length>MAX_WALK_STOPS))throw fail('WALK_INVALID');
    let stops=manual?input.stops.map(place):[];
    // The first stop may be the start building itself; every other pair stays apart.
    const distinct=[start,...stops,...(destination?[destination]:[])];
    if(distinct.some((p,i)=>distinct.slice(0,i).some((q,j)=>!(stops.length&&i===1&&j===0)&&distance(p.location,q.location)<5)))throw fail('WALK_INVALID');
    if(!routerUrl)throw fail('WALK_UNAVAILABLE');
    limitClient(client);
    await acquire();
    // Leg shapes of measured routes stay off the public route object.
    const controller=new AbortController(),startedAt=now(),legsOf=new WeakMap();let timer,discovering=false;
    const unavailable=()=>fail(discovering?'WALK_DISCOVERY_UNAVAILABLE':'WALK_UNAVAILABLE');
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},timeoutMs);});
    // A router answers "no path" with a 4xx JSON body; routerErrors turns those
    // codes into WALK_UNROUTABLE, which measureRoute reports as a rejected route.
    async function request(url,body,contentType,{routerErrors=false}={}) {
      const response=await fetchImpl(url,{method:'POST',body,redirect:'error',signal:controller.signal,headers:{'Content-Type':contentType,Accept:'application/json','User-Agent':'Otgolosok/0.1 (+https://otgolosok.online)'}});
      const clientError=routerErrors&&response?.status>=400&&response.status<500;
      if((!response?.ok&&!clientError)||!response.body?.getReader){await response?.body?.cancel();throw fail('WALK_UNAVAILABLE');}
      const data=await readJson(response,controller.signal);
      if(clientError)throw fail(UNROUTABLE_CODES.includes(data?.error_code)?'WALK_UNROUTABLE':'WALK_UNAVAILABLE');
      return data;
    }
    // A usable route reports its walking time and whether it fits the chosen budget.
    // An unusable one is rejected with a reason and, when the router data points at
    // one, the index of the stop to blame in routeStops. A first stop at the start
    // building is not routed: it adds no walking leg.
    async function measureRoute(routeStops,{autoStops=false}={}) {
        const atStart=routeStops.length>0&&distance(routeStops[0].location,start.location)<=START_STOP_METERS;
        const offset=atStart?1:0,routed=routeStops.slice(offset);
        const closing=destination??(input.mode==='loop'?start:null);
        const points=[start,...routed,...(closing?[closing]:[])];
        const stopAt=j=>j>=1&&j<=routed.length?j-1+offset:null;
        const rejected=(reason,stopIndex=null)=>({kind:'rejected',reason,stopIndex});
        if(points.length<2)return rejected('zero_leg');
        const url=new URL(routerUrl);
        if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw fail('WALK_UNAVAILABLE');
        const location=p=>({...p.location,type:'break',radius:SNAP_RADIUS_METERS,minimum_reachability:MIN_REACHABILITY_NODES});
        let data;
        try {data=await request(url.toString(),JSON.stringify({locations:points.map(location),costing:'pedestrian',units:'kilometers',shape_format:'polyline6'}),'application/json',{routerErrors:true});}
        catch(error) {if(error?.code==='WALK_UNROUTABLE')return rejected('unroutable');throw error;}
        const trip=data?.trip;
        if(trip?.status!==0||trip.units!=='kilometers'||!Array.isArray(trip.legs)||trip.legs.length!==points.length-1)throw fail('WALK_UNAVAILABLE');
        // Validate every leg first, so malformed data is never mistaken for a bad stop.
        const shapes=trip.legs.map(leg=>{
          const s=leg?.summary;
          if(!s||!Number.isFinite(s.time)||s.time<0||!Number.isFinite(s.length)||s.length<0||s.time>86400||s.length>100)throw fail('WALK_UNAVAILABLE');
          // Distinct landmarks can snap onto the same pedestrian access point.
          if(s.time===0||s.length===0)return null;
          const shape=decode(leg.shape);
          let measured=0;for(let j=1;j<shape.length;j++)measured+=distance(shape[j-1],shape[j]);
          if(Math.abs(measured-s.length*1000)>Math.max(100,s.length*1000*0.25))throw fail('WALK_UNAVAILABLE');
          return shape;
        });
        // The start and the destination cannot be swapped for other points: say which one is off the street.
        const first=shapes[0],last=shapes.at(-1);
        if(first&&distance(first[0],start.location)>MAX_POINT_SNAP_METERS||input.mode==='loop'&&last&&distance(last.at(-1),start.location)>MAX_POINT_SNAP_METERS)throw fail('WALK_START_UNREACHABLE');
        if(destination&&last&&distance(last.at(-1),destination.location)>MAX_POINT_SNAP_METERS)throw fail('WALK_DESTINATION_UNREACHABLE');
        const geometry=[];let seconds=0,distanceM=0;
        for(const [i,shape] of shapes.entries()) {
          if(!shape)return rejected('zero_leg',stopAt(i+1)??stopAt(i));
          if(stopAt(i+1)!==null&&distance(shape.at(-1),points[i+1].location)>(autoStops?MAX_AUTO_STOP_SNAP_METERS:MAX_POINT_SNAP_METERS))return rejected('far_stop',stopAt(i+1));
          // Snapping a stop to different pedestrian edges can leave a real gap.
          // Reject this stop, never draw an invented connecting segment.
          if(geometry.length&&distance(geometry.at(-1),shape[0])>10)return rejected('gap',stopAt(i));
          const s=trip.legs[i].summary;
          seconds+=s.time;distanceM+=s.length*1000;geometry.push(...(geometry.length?shape.slice(1):shape));
          if(geometry.length>12000)throw fail('WALK_UNAVAILABLE');
        }
        const direct=points.slice(1).reduce((sum,p,i)=>sum+distance(points[i].location,p.location),0);
        const fits=seconds<=input.minutes*60&&distanceM<=input.minutes*90&&distanceM<=Math.max(1200,direct*4);
        const route={stops:routeStops.map(publicStop),geometry,distanceM:Math.round(distanceM),walkingMinutes:Math.ceil(seconds/60),attribution:'© OpenStreetMap contributors; pedestrian routing by Valhalla. Map information is not verified historical evidence.'};
        legsOf.set(route,shapes);
        return {kind:'route',seconds,fits,route};
    }
    async function routeStops(routeStops,options) {
      const measured=await measureRoute(routeStops,options);
      return measured.kind==='route'&&measured.fits?measured.route:null;
    }
    // The nearest landmarks cluster into a short walk in dense areas, so spacing
    // between stops is searched until the walk reaches the time floor. A stop that
    // makes a route unusable is excluded and the search goes on without it. Every
    // router call counts against one budget; the longest fitting walk is kept for
    // sparse areas. The start landmark, if any, leads every measured walk.
    async function fillBudget(candidates,stopLimit,landmark) {
      const loop=input.mode==='loop',budget=input.minutes*60,floor=MIN_BUDGET_SHARE*budget;
      let straightBudgetM=input.minutes*WALK_METERS_PER_MINUTE/STRAIGHT_TO_WALK,calls=0;
      const excluded=new Set(),measured=new Map();
      const chainFor=(spacingM,limitM=straightBudgetM)=>selectChain({start,candidates:candidates.filter(c=>!excluded.has(c)),stopLimit,spacingM,loop,straightBudgetM:limitM});
      const straightLength=chain=>[start,...chain,...(loop?[start]:[])].slice(1).reduce((sum,p,i,points)=>sum+distance((i?points[i-1]:start).location,p.location),0);
      const retry=result=>result.kind==='rejected'&&result.stopIndex!==null;
      // Null once the router budget is spent. A blamed stop is excluded from later chains.
      async function measure(chain) {
        const key=JSON.stringify(chain.map(p=>p.address));
        if(!measured.has(key)) {
          if(calls>=MAX_AUTO_ROUTER_CALLS)return null;
          calls++;
          const result=await measureRoute(landmark?[landmark,...chain]:chain,{autoStops:true});
          if(retry(result))excluded.add(chain[result.stopIndex-(landmark?1:0)]);
          measured.set(key,result);
        }
        return measured.get(key);
      }
      let chain,result;
      while(true) {
        controller.signal.throwIfAborted();
        chain=chainFor(0);
        // The straight-line estimate may be too strict for sparse areas; let the router decide.
        if(chain.length<2)chain=chainFor(0,Infinity);
        if(chain.length<2)throw fail('WALK_NOT_FOUND');
        result=await measure(chain);
        if(!result)throw fail('WALK_NOT_FOUND');
        if(!retry(result))break;
      }
      if(result.kind==='route'&&result.fits&&result.seconds>=floor)return result.route;
      if(result.kind!=='route'||!result.fits) {
        // Spreading stops only lengthens a walk that is already too long.
        for(let stops=chain.slice(0,-1);stops.length>=2;) {
          controller.signal.throwIfAborted();
          const trimmed=await measure(stops);
          if(!trimmed)break;
          if(trimmed.kind==='route'&&trimmed.fits)return trimmed.route;
          stops=retry(trimmed)?stops.filter(p=>!excluded.has(p)):stops.slice(0,-1);
        }
        throw fail('WALK_NOT_FOUND');
      }
      let best=result,lo=0,hi=straightBudgetM/2,spacingM=straightBudgetM/(stopLimit+(loop?1:0));
      for(let step=0;step<MAX_SPACING_STEPS&&hi-lo>=MIN_SPACING_STEP_METERS;step++) {
        controller.signal.throwIfAborted();
        const chain=chainFor(spacingM);
        let route=null;
        if(chain.length>=2) {
          const measuredChain=await measure(chain);
          if(!measuredChain)break;
          // The same spacing without the excluded stop may still work.
          if(retry(measuredChain))continue;
          if(measuredChain.kind==='route')route=measuredChain;
        }
        if(route) {
          // Streets wind more or less than assumed: learn the ratio from the router
          // so the next chains end just below the budget.
          const calibrated=straightLength(chain)*budget/route.seconds*0.97;
          if(route.seconds>budget) {straightBudgetM=Math.min(straightBudgetM*0.97,calibrated);continue;}
          straightBudgetM=Math.max(straightBudgetM,calibrated);
        }
        // Too few stops, an unroutable chain or a detour-heavy walk need tighter spacing.
        if(!route?.fits)hi=spacingM;
        else if(route.seconds>=floor)return route.route;
        else {if(route.seconds>best.seconds)best=route;lo=spacingM;}
        spacingM=(lo+hi)/2;
      }
      return best.route;
    }

    async function run() {
      // Check the destination before discovery, and never sacrifice it for a candidate.
      const directRoute=destination&&!manual?await routeStops([]):null;
      if(destination && !manual && !directRoute)throw fail('WALK_NOT_FOUND');
      if(!manual) {
        discovering=true;
        // Discovery is bounded; straight-line distances only rank candidates, never form a route.
        // A loop must also cover the return leg; routing below enforces the actual budget.
        const radius=Math.min(4050,input.minutes*90/(input.mode==='loop'?2:1)),around=`around:${radius},${start.location.lat},${start.location.lon}`;
        let elements=discoveryElements;
        if(storiesOnly)elements=[];
        else if(elements===null) {
          // An address is the only handle the story pipeline has on a building.
          const query=`[out:json][timeout:8];(${DISCOVERY_TAGS.map(tag=>`nwr(${around})[building]["addr:street"]["addr:housenumber"]${tag};`).join('')});out center tags 160;`;
          const data=await request(overpassUrl,new URLSearchParams({data:query}).toString(),'application/x-www-form-urlencoded');
          if(!Array.isArray(data?.elements)||data.elements.length>500||data.remark)throw unavailable();
          elements=data.elements;
        }
        let supplied=[];
        if(candidateProvider) {
          supplied=await candidateProvider({lat:start.location.lat,lon:start.location.lon,radius,limit:500,published:storiesOnly});
          if(!Array.isArray(supplied)||supplied.length>500||supplied.some(item=>!item||!contentId(item.id)||!clean(item.address,240)||!inBox(item.location)||!Object.hasOwn(readinessRank,item.readiness)))throw unavailable();
        }
        const suppliedById=new Map(supplied.map(item=>[item.id,item]));
        // Landmarks near the start compete for the first stop at the start itself.
        // One closer than 5 m can only be that stop: as a routed stop it would
        // coincide with the start.
        const candidates=[],nearStart=[];
        const addCandidate=item=>{
          const p=item.location,fromStart=distance(start.location,p);
          if(storiesOnly&&!item.contentId)return;
          if(fromStart>radius)return;
          if(destination&&(distance(p,destination.location)<5||fromStart+distance(p,destination.location)>input.minutes*90))return;
          if([...candidates,...nearStart].some(candidate=>(item.catalogId&&candidate.catalogId===item.catalogId)||candidate.address===item.address||distance(candidate.location,p)<5))return;
          if(fromStart<=START_STOP_METERS)nearStart.push(item);
          if(fromStart>=5)candidates.push(item);
        };
        for(const e of elements) {
          const t=e?.tags,p=e?.center??e;
          if(!t||!inBox(p)||!clean(t.building,80)||t.building==='no'||!notable(t))continue;
          const street=clean(t['addr:street'],160),house=clean(t['addr:housenumber'],40);
          if(!street||!house||!/^\d[\p{L}\p{N}\s/.,-]*$/u.test(house))continue;
          const catalogId=['node','way','relation'].includes(e.type)&&Number.isSafeInteger(e.id)?`osm:${e.type}:${e.id}`:null;
          const published=catalogId?suppliedById.get(catalogId):null;
          addCandidate({address:`Москва, ${street}, ${house}`,location:{lat:p.lat,lon:p.lon},catalogId,contentRank:published?readinessRank[published.readiness]:0,catalogRank:published?1:0,
            ...(published&&published.readiness!=='none'?{contentId:published.id}:{})});
        }
        for(const item of supplied)addCandidate({address:clean(item.address,240),location:{lat:item.location.lat,lon:item.location.lon},catalogId:item.id,
          contentRank:readinessRank[item.readiness],catalogRank:1,...(item.readiness!=='none'?{contentId:item.id}:{})});
        // The catalog point of the start building itself wins, then ready content.
        const startKey=sameAddressKey(start.address);
        const landmark=nearStart.map(item=>({item,same:sameAddressKey(item.address)===startKey,fromStart:distance(start.location,item.location)}))
          .sort((a,b)=>Number(b.same)-Number(a.same)||b.item.contentRank-a.item.contentRank||b.item.catalogRank-a.item.catalogRank||a.fromStart-b.fromStart)[0]?.item??null;
        if(landmark&&candidates.includes(landmark))candidates.splice(candidates.indexOf(landmark),1);
        if(destination) {
          discovering=false;
          if(landmark)stops.push(landmark);
          // The landmark is not routed, so the direct route already is its walk.
          let result=landmark?{...directRoute,stops:[publicStop(landmark)]}:directRoute,current=start,attempts=0;
          if(landmark)legsOf.set(result,legsOf.get(directRoute));
          // Landmarks that the direct walking line already passes should win
          // over detours. Keep them ordered along the line.
          const alongRoute=candidates.map(candidate=>({candidate,...routeProximity(candidate.location,directRoute.geometry)}))
            .filter(item=>item.distanceM<=NEAR_ROUTE_METERS)
            .sort((a,b)=>b.candidate.contentRank-a.candidate.contentRank||b.candidate.catalogRank-a.candidate.catalogRank||a.progressM-b.progressM||a.distanceM-b.distanceM)
            .slice(0,stopLimit).sort((a,b)=>a.progressM-b.progressM);
          for(const item of alongRoute) {
            if(stops.length>=stopLimit||attempts>=16)break;
            candidates.splice(candidates.indexOf(item.candidate),1);attempts++;
            const next=await routeStops([...stops,item.candidate],{autoStops:true});
            if(next){stops.push(item.candidate);current=item.candidate;result=next;}
          }
          // Try alternatives instead of discarding every stop after one costly detour.
          // Bound router work independently of the size of the OSM catalog.
          for(;candidates.length&&stops.length<stopLimit&&attempts<16;attempts++) {
            candidates.sort((a,b)=>b.contentRank-a.contentRank||b.catalogRank-a.catalogRank||(distance(current.location,a.location)+distance(a.location,destination.location))-(distance(current.location,b.location)+distance(b.location,destination.location)));
            const candidate=candidates.shift();
            const next=await routeStops([...stops,candidate],{autoStops:true});
            if(next){stops.push(candidate);current=candidate;result=next;}
          }
          return result;
        }
        if(candidates.length<2)throw fail('WALK_STOPS_NOT_FOUND');
        discovering=false;
        return await fillBudget(candidates,stopLimit-(landmark?1:0),landmark);
      }
      while(true) {
        controller.signal.throwIfAborted();
        const result=await routeStops(stops);
        if(result)return result;
        if(manual||stops.length<=(destination?0:2))throw fail('WALK_NOT_FOUND');
        stops=stops.slice(0,-1);
      }
    }

    try {
      const route=await Promise.race([run(),deadline]);
      // Only the chosen route is traced, and only while enough of the plan's budget remains.
      const legs=legsOf.get(route);
      if(legs&&traceEndpoint&&startedAt+timeoutMs-now()>=TRACE_MIN_REMAINING_MS) {
        const tunnels=await traceTunnels(legs,{fetchImpl,traceUrl:traceEndpoint,signal:controller.signal});
        if(tunnels?.length)route.tunnels=tunnels;
      }
      return route;
    }
    catch(error) {if(['WALK_NOT_FOUND','WALK_STOPS_NOT_FOUND','WALK_DISCOVERY_UNAVAILABLE','WALK_START_UNREACHABLE','WALK_DESTINATION_UNREACHABLE'].includes(error?.code))throw error;throw unavailable();}
    finally {clearTimeout(timer);controller.abort();release();}
  };
}

import discoveryCatalog from './walk-discovery-catalog.mjs';

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
const MAX_WALK_STOPS = 10;
const AUTO_STOP_LIMITS = {30:5,60:8,90:10};
const NEAR_ROUTE_METERS = 50;
const contentId = value => typeof value === 'string' && /^osm:(node|way|relation):\d+$/.test(value);
const readinessRank = {none:0,story:1,audio:2};

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

export function createWalkPlanner({fetchImpl=fetch, now=Date.now,
  routerUrl=process.env.WALK_ROUTER_URL,
  overpassUrl=process.env.WALK_OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter',
  discoveryElements=process.env.WALK_DISCOVERY_SOURCE==='overpass'?null:discoveryCatalog.elements,candidateProvider=null,
  timeoutMs=12000, minIntervalMs=2000}={}) {
  let active=false,lastStart=-Infinity;
  return async function planWalk(input) {
    if(!keys(input,['start','mode','minutes','stops','destination']) || !['loop','open'].includes(input.mode) || ![30,60,90].includes(input.minutes))throw fail('WALK_INVALID');
    const stopLimit=AUTO_STOP_LIMITS[input.minutes];
    const destination=input.destination==null?null:place(input.destination);
    if(destination&&input.mode!=='open')throw fail('WALK_INVALID');
    const start=place(input.start), manual=Object.hasOwn(input,'stops');
    if(manual&&(!Array.isArray(input.stops)||input.stops.length<(destination?0:1)||input.stops.length>MAX_WALK_STOPS))throw fail('WALK_INVALID');
    let stops=manual?input.stops.map(place):[];
    const distinct=[start,...stops,...(destination?[destination]:[])];
    if(distinct.some((p,i)=>distinct.slice(0,i).some(q=>distance(p.location,q.location)<5)))throw fail('WALK_INVALID');
    if(!routerUrl)throw fail('WALK_UNAVAILABLE');
    if(active||now()-lastStart<minIntervalMs)throw fail('WALK_BUSY');
    active=true;lastStart=now();
    const controller=new AbortController();let timer,discovering=false;
    const unavailable=()=>fail(discovering?'WALK_DISCOVERY_UNAVAILABLE':'WALK_UNAVAILABLE');
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},timeoutMs);});
    async function request(url,body,contentType) {
      const response=await fetchImpl(url,{method:'POST',body,redirect:'error',signal:controller.signal,headers:{'Content-Type':contentType,Accept:'application/json','User-Agent':'Otgolosok/0.1 (+https://otgolosok.softmg.tech)'}});
      if(!response?.ok||!response.body?.getReader){await response?.body?.cancel();throw fail('WALK_UNAVAILABLE');}
      const reader=response.body.getReader(),chunks=[];let size=0;
      const cancel=()=>{void reader.cancel().catch(()=>{});};
      controller.signal.addEventListener('abort',cancel,{once:true});
      try {
        while(true) {
          controller.signal.throwIfAborted();
          const {done,value}=await reader.read();if(done)break;
          size+=value.byteLength;if(size>1024*1024)throw fail('WALK_UNAVAILABLE');chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString());
      } finally {controller.signal.removeEventListener('abort',cancel);cancel();}
    }
    async function routeStops(routeStops) {
        const points=[start,...routeStops,...(destination?[destination]:input.mode==='loop'?[start]:[])];
        const url=new URL(routerUrl);
        if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw fail('WALK_UNAVAILABLE');
        const data=await request(url.toString(),JSON.stringify({locations:points.map(p=>({...p.location,type:'break',radius:100})),costing:'pedestrian',units:'kilometers',shape_format:'polyline6'}),'application/json');
        if(data?.error_code===442)throw fail('WALK_NOT_FOUND');
        const trip=data?.trip;
        if(trip?.status!==0||trip.units!=='kilometers'||!Array.isArray(trip.legs)||trip.legs.length!==points.length-1)throw fail('WALK_UNAVAILABLE');
        const geometry=[];let seconds=0,distanceM=0;
        for(const [i,leg] of trip.legs.entries()) {
          const s=leg?.summary;
          if(!s||!Number.isFinite(s.time)||s.time<0||!Number.isFinite(s.length)||s.length<0||s.time>86400||s.length>100)throw fail('WALK_UNAVAILABLE');
          // Distinct landmarks can snap onto the same pedestrian access point.
          // This candidate adds no walkable leg; it is not a service outage.
          if(s.time===0||s.length===0)return null;
          const shape=decode(leg.shape);
          if(distance(shape[0],points[i].location)>150||distance(shape.at(-1),points[i+1].location)>150)throw fail('WALK_UNAVAILABLE');
          // Snapping a stop to different pedestrian edges can leave a real gap.
          // Reject this candidate, never draw an invented connecting segment.
          if(geometry.length&&distance(geometry.at(-1),shape[0])>10)return null;
          let measured=0;for(let j=1;j<shape.length;j++)measured+=distance(shape[j-1],shape[j]);
          if(Math.abs(measured-s.length*1000)>Math.max(100,s.length*1000*0.25))throw fail('WALK_UNAVAILABLE');
          seconds+=s.time;distanceM+=s.length*1000;geometry.push(...(geometry.length?shape.slice(1):shape));
          if(geometry.length>12000)throw fail('WALK_UNAVAILABLE');
        }
        const direct=points.slice(1).reduce((sum,p,i)=>sum+distance(points[i].location,p.location),0);
        if(seconds<=input.minutes*60&&distanceM<=input.minutes*90&&distanceM<=Math.max(1200,direct*4)) {
          const publicStops=routeStops.map(p=>({address:p.address,location:p.location,...(p.contentId?{contentId:p.contentId}:{})}));
          return {stops:publicStops,geometry,distanceM:Math.round(distanceM),walkingMinutes:Math.ceil(seconds/60),attribution:'© OpenStreetMap contributors; pedestrian routing by Valhalla. Map information is not verified historical evidence.'};
        }
      return null;
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
        if(elements===null) {
          // An address is the only handle the story pipeline has on a building.
          const query=`[out:json][timeout:8];(${DISCOVERY_TAGS.map(tag=>`nwr(${around})[building]["addr:street"]["addr:housenumber"]${tag};`).join('')});out center tags 160;`;
          const data=await request(overpassUrl,new URLSearchParams({data:query}).toString(),'application/x-www-form-urlencoded');
          if(!Array.isArray(data?.elements)||data.elements.length>500||data.remark)throw unavailable();
          elements=data.elements;
        }
        let supplied=[];
        if(candidateProvider) {
          supplied=await candidateProvider({lat:start.location.lat,lon:start.location.lon,radius,limit:500});
          if(!Array.isArray(supplied)||supplied.length>500||supplied.some(item=>!item||!contentId(item.id)||!clean(item.address,240)||!inBox(item.location)||!Object.hasOwn(readinessRank,item.readiness)))throw unavailable();
        }
        const suppliedById=new Map(supplied.map(item=>[item.id,item]));
        const candidates=[];
        const addCandidate=item=>{
          const p=item.location;
          if(distance(start.location,p)>radius||distance(start.location,p)<5)return;
          if(destination&&(distance(p,destination.location)<5||distance(start.location,p)+distance(p,destination.location)>input.minutes*90))return;
          if(candidates.some(candidate=>(item.catalogId&&candidate.catalogId===item.catalogId)||candidate.address===item.address||distance(candidate.location,p)<5))return;
          candidates.push(item);
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
        if(destination) {
          discovering=false;
          let result=directRoute,current=start,attempts=0;
          // Landmarks that the direct walking line already passes should win
          // over detours. Keep them ordered along the line.
          const alongRoute=candidates.map(candidate=>({candidate,...routeProximity(candidate.location,directRoute.geometry)}))
            .filter(item=>item.distanceM<=NEAR_ROUTE_METERS)
            .sort((a,b)=>b.candidate.contentRank-a.candidate.contentRank||b.candidate.catalogRank-a.candidate.catalogRank||a.progressM-b.progressM||a.distanceM-b.distanceM)
            .slice(0,stopLimit).sort((a,b)=>a.progressM-b.progressM);
          for(const item of alongRoute) {
            if(stops.length>=stopLimit||attempts>=16)break;
            candidates.splice(candidates.indexOf(item.candidate),1);attempts++;
            const next=await routeStops([...stops,item.candidate]);
            if(next){stops.push(item.candidate);current=item.candidate;result=next;}
          }
          // Try alternatives instead of discarding every stop after one costly detour.
          // Bound router work independently of the size of the OSM catalog.
          for(;candidates.length&&stops.length<stopLimit&&attempts<16;attempts++) {
            candidates.sort((a,b)=>b.contentRank-a.contentRank||b.catalogRank-a.catalogRank||(distance(current.location,a.location)+distance(a.location,destination.location))-(distance(current.location,b.location)+distance(b.location,destination.location)));
            const candidate=candidates.shift();
            const next=await routeStops([...stops,candidate]);
            if(next){stops.push(candidate);current=candidate;result=next;}
          }
          return result;
        }
        let current=start;
        while(candidates.length&&stops.length<stopLimit) {
          candidates.sort((a,b)=>distance(current.location,a.location)-distance(current.location,b.location));
          current=candidates.shift();stops.push(current);
        }
        if(!destination&&stops.length<2)throw fail('WALK_STOPS_NOT_FOUND');
        discovering=false;
      }
      while(true) {
        controller.signal.throwIfAborted();
        const result=await routeStops(stops);
        if(result)return result;
        if(manual||stops.length<=(destination?0:2))throw fail('WALK_NOT_FOUND');
        stops=stops.slice(0,-1);
      }
    }

    try {return await Promise.race([run(),deadline]);}
    catch(error) {if(['WALK_NOT_FOUND','WALK_STOPS_NOT_FOUND','WALK_DISCOVERY_UNAVAILABLE'].includes(error?.code))throw error;throw unavailable();}
    finally {clearTimeout(timer);controller.abort();active=false;}
  };
}

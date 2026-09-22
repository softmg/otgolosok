import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalkPlanner } from './walks.mjs';
import discoveryCatalog from './walk-discovery-catalog.mjs';

const start={address:'Москва, Арбат, 1',location:{lat:55.75,lon:37.60}};
const stop=n=>({address:`Москва, Арбат, ${n+2}`,location:{lat:55.75+n*0.001,lon:37.60}});
const input=(extra={})=>({start,mode:'loop',minutes:30,stops:[stop(1),stop(2)],...extra});
function encode(points) {
  let lat=0,lon=0,out='';
  for(const p of points) {
    const a=Math.round(p.lat*1e6),b=Math.round(p.lon*1e6);
    for(let d of [a-lat,b-lon]) {
      d=d<0?-d*2-1:d*2;
      while(d>=32){out+=String.fromCharCode((d%32)+95);d=Math.floor(d/32);}
      out+=String.fromCharCode(d+63);
    }
    lat=a;lon=b;
  }
  return out;
}
function route(request,time=100) {
  const points=request.locations;
  return {trip:{status:0,units:'kilometers',legs:points.slice(1).map((p,i)=>({summary:{time,length:Math.abs(p.lat-points[i].lat)*111.195},shape:encode([points[i],{lat:(p.lat+points[i].lat)/2,lon:p.lon},p])}))}};
}
// One qualifying signal each: a name is never required, and most Moscow landmarks
// carry their title in the linked Wikidata item instead of an OSM name tag.
const signals=[{historic:'building'},{heritage:'2'},{wikidata:'Q1676676'},{architect:'Фёдор Шехтель'}];
const candidates=()=>({elements:[1,2,3,4].map(n=>({type:'way',center:stop(n).location,tags:{building:'yes','addr:street':'Арбат','addr:housenumber':String(n+2),...signals[n-1]}}))});
function fixture(handler) {
  const calls=[];
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',overpassUrl:'https://osm.test/',discoveryElements:null,minIntervalMs:0,fetchImpl:async(url,options)=>{
    calls.push({url:String(url),options});
    return Response.json(await handler(String(url),options,calls));
  }});
  return {plan,calls};
}

for(const mode of ['loop','open'])test(`manual ${mode} preserves stop order and returns upstream geometry`,async()=>{
  const {plan,calls}=fixture((url,o)=>route(JSON.parse(o.body)));
  const stops=[stop(2),stop(1)];const result=await plan(input({mode,stops}));
  const request=JSON.parse(calls[0].options.body);
  assert.equal(request.costing,'pedestrian');assert.equal(request.units,'kilometers');
  assert.deepEqual(request.locations.map(({lat,lon})=>({lat,lon})),[start,...stops,...(mode==='loop'?[start]:[])].map(p=>p.location));
  assert.deepEqual(result.stops,stops);assert.deepEqual(result.geometry[0],start.location);
  assert.deepEqual(result.geometry.at(-1),mode==='loop'?start.location:stops.at(-1).location);
  assert.equal(result.geometry.length,mode==='loop'?7:5);
  assert.ok(result.distanceM>300);assert.ok(result.walkingMinutes<=30);
  assert.match(result.attribution,/OpenStreetMap/);
});

test('strict input validation makes no upstream calls',async()=>{
  const {plan,calls}=fixture(()=>{throw new Error('must not fetch');});
  for(const value of [null,[],{},input({mode:'drive'}),input({minutes:'30'}),input({minutes:31}),input({extra:true}),input({stops:[]}),input({stops:undefined}),input({stops:Array.from({length:11},(_,i)=>stop(i+1))}),input({stops:[start]}),input({stops:[stop(1),stop(1)]}),input({start:{...start,address:'<script>'}}),input({start:{...start,address:'a'.repeat(241)}}),input({start:{...start,location:{lat:'55.75',lon:37.6}}}),input({start:{...start,location:{lat:56,lon:37.6}}}),input({start:{...start,location:{lat:55.75,lon:NaN}}}),input({start:{...start,location:{...start.location,z:1}}})]) {
    await assert.rejects(plan(value),{code:'WALK_INVALID'});
  }
  assert.equal(calls.length,0);
});

test('manual routes accept ten distinct stops',async()=>{
  const stops=Array.from({length:10},(_,index)=>stop(index+1));
  const {plan}=fixture((url,o)=>route(JSON.parse(o.body)));
  const result=await plan({start,mode:'open',minutes:30,stops});
  assert.deepEqual(result.stops,stops);
});

for(const mode of ['loop','open'])test(`automatic ${mode} selects ordered addressed buildings`,async()=>{
  const data=candidates();
  data.elements.reverse();data.elements.push(...[
    {...data.elements[0],tags:{...data.elements[0].tags,'addr:housenumber':'<123>'}},
    {...data.elements[0],tags:{building:'yes','addr:street':'Арбат','addr:housenumber':'99',name:'Бизнес-центр'}},
    {...data.elements[0],tags:{building:'yes',historic:'building'}},
    {...data.elements[0],center:{lat:55.9,lon:37.6}},
  ]);
  const {plan,calls}=fixture((url,o)=>url.includes('osm')?data:route(JSON.parse(o.body)));
  const result=await plan({start,mode,minutes:30});
  assert.deepEqual(result.stops,[1,2,3,4].map(stop));
  const query=new URLSearchParams(calls[0].options.body).get('data');
  assert.ok(query.includes(`around:${mode==='loop'?1350:2700},55.75,37.6`));
  assert.doesNotMatch(query,/\[name\]/);
  for(const tag of ['[historic]','[heritage]','[tourism=museum]','[wikidata]','[wikipedia]','[architect]'])
    assert.ok(query.includes(`[building]["addr:street"]["addr:housenumber"]${tag}`),tag);
  assert.deepEqual(result.geometry.at(-1),mode==='loop'?start.location:stop(4).location);
});

test('automatic over-budget routes shorten, never return a fabricated fallback',async()=>{
  const {plan,calls}=fixture((url,o)=>url.includes('osm')?candidates():route(JSON.parse(o.body),500));
  const result=await plan({start,mode:'loop',minutes:30});
  assert.equal(result.stops.length,2);assert.equal(result.walkingMinutes,25);assert.equal(calls.length,4);
  const impossible=fixture((url,o)=>url.includes('osm')?candidates():route(JSON.parse(o.body),1000));
  await assert.rejects(impossible.plan({start,mode:'loop',minutes:30}),{code:'WALK_NOT_FOUND'});
  assert.equal(impossible.calls.length,4);
  await assert.rejects(impossible.plan(input()),{code:'WALK_NOT_FOUND'});
});

test('too few automatic candidates fail honestly',async()=>{
  const {plan}=fixture(()=>({elements:candidates().elements.slice(0,1)}));
  await assert.rejects(plan({start,mode:'open',minutes:90}),{code:'WALK_STOPS_NOT_FOUND'});
});

for(const mode of ['loop','open'])test(`automatic ${mode} routes reachable stops beyond the former discovery radius`,async()=>{
  const elements=[7,8].map(n=>({...candidates().elements[0],center:stop(n).location,tags:{...candidates().elements[0].tags,'addr:housenumber':String(n+2)}}));
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:elements,fetchImpl:async(url,o)=>Response.json(route(JSON.parse(o.body),400))});
  const result=await plan({start,mode,minutes:30});
  assert.deepEqual(result.stops,[stop(7),stop(8)]);
  assert.ok(result.walkingMinutes<=30);
  assert.ok(result.distanceM<=2700);
});

test('expanded discovery still rejects routes exceeding the actual walking budget',async()=>{
  const elements=[7,8].map(n=>({...candidates().elements[0],center:stop(n).location,tags:{...candidates().elements[0].tags,'addr:housenumber':String(n+2)}}));
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:elements,fetchImpl:async(url,o)=>Response.json(route(JSON.parse(o.body),1000))});
  await assert.rejects(plan({start,mode:'loop',minutes:30}),{code:'WALK_NOT_FOUND'});
});

test('bundled catalog finds stops near Gorky Park for a 30-minute walk',async()=>{
  let calls=0;
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',fetchImpl:async()=>{calls++;throw new Error('router unavailable');}});
  await assert.rejects(plan({start:{address:'Москва, Парк Горького',location:{lat:55.731,lon:37.601}},mode:'loop',minutes:30}),{code:'WALK_UNAVAILABLE'});
  assert.equal(calls,1);
});

test('a routed but enormous detour is rejected even when reported time fits',async()=>{
  const {plan}=fixture((url,o)=>{
    const request=JSON.parse(o.body),data=route(request);
    data.trip.legs[0]={summary:{time:100,length:3.224655},shape:encode([start.location,{lat:55.765,lon:37.6},stop(1).location])};
    return data;
  });
  await assert.rejects(plan(input({minutes:90})),{code:'WALK_NOT_FOUND'});
});

test('rejects malformed router payloads and geometry',async()=>{
  for(const mutate of [
    ()=>null,
    d=>({...d,trip:{...d.trip,units:'miles'}}),
    d=>{d.trip.legs.pop();return d;},
    d=>{d.trip.legs[0].summary.time='100';return d;},
    d=>{d.trip.legs[0].shape='~';return d;},
    d=>{d.trip.legs[0].shape=encode([{lat:55.9,lon:37.6},stop(1).location]);return d;},
    d=>{d.trip.legs[0].summary.length=80;return d;},
  ]) {
    const {plan}=fixture((url,o)=>mutate(route(JSON.parse(o.body))));
    await assert.rejects(plan(input()),{code:'WALK_UNAVAILABLE'});
  }
});

test('rejects malformed, oversized, and failing upstream responses',async()=>{
  for(const fetchImpl of [async()=>new Response('private',{status:500}),async()=>new Response('{'),async()=>new Response('x'.repeat(1024*1024+1)),async()=>{throw new Error('secret');}]) {
    const plan=createWalkPlanner({routerUrl:'https://router.test/route',fetchImpl});
    await assert.rejects(plan(input()),{code:'WALK_UNAVAILABLE',message:'WALK_UNAVAILABLE'});
  }
  for(const data of [{}, {elements:[],remark:'timeout'}, {elements:Array(501).fill({})}]) {
    const {plan}=fixture(()=>data);
    await assert.rejects(plan({start,mode:'loop',minutes:30}),{code:'WALK_DISCOVERY_UNAVAILABLE'});
  }
});

test('missing router, concurrency, cooldown and total deadline are bounded',async()=>{
  await assert.rejects(createWalkPlanner({routerUrl:''})(input()),{code:'WALK_UNAVAILABLE'});
  let clock=0,signal;
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',timeoutMs:25,now:()=>clock,fetchImpl:async(url,o)=>{signal=o.signal;return new Promise(()=>{});}});
  const first=plan(input());
  await assert.rejects(plan(input()),{code:'WALK_BUSY'});
  await assert.rejects(first,{code:'WALK_UNAVAILABLE'});assert.equal(signal.aborted,true);
  await assert.rejects(plan(input()),{code:'WALK_BUSY'});
  clock=2001;await assert.rejects(plan(input()),{code:'WALK_UNAVAILABLE'});
});

test('total deadline also covers a stalled response body',async()=>{
  let cancelled=false;
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',timeoutMs:20,fetchImpl:async()=>new Response(new ReadableStream({start(){},cancel(){cancelled=true;}}))});
  await assert.rejects(plan(input()),{code:'WALK_UNAVAILABLE'});
  assert.equal(cancelled,true);
});

test('offline discovery routes both modes without contacting Overpass',async()=>{
  const elements=candidates().elements;
  const original=structuredClone(elements);
  const calls=[];
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:elements,minIntervalMs:0,fetchImpl:async(url,options)=>{
    assert.equal(url,'https://router.test/route');
    calls.push(JSON.parse(options.body));
    return Response.json(route(calls.at(-1)));
  }});
  for(const mode of ['loop','open']) {
    const result=await plan({start,mode,minutes:30});
    assert.deepEqual(result.stops,[1,2,3,4].map(stop));
    assert.equal(calls.at(-1).costing,'pedestrian');
    assert.equal(calls.at(-1).locations.length,mode==='loop'?6:5);
  }
  assert.equal(calls.length,2);
  assert.deepEqual(elements,original);
});

test('offline discovery applies the radius, building and notability filters without external fallback',async()=>{
  const elements=candidates().elements;
  elements.push({...elements[0],center:{lat:55.9,lon:37.6}});
  elements[1]={...elements[1],tags:{...elements[1].tags,building:'no'}};
  elements[2]={...elements[2],tags:{...elements[2].tags,'addr:housenumber':'<bad>'}};
  // A named, addressed building with no notability signal is not a stop.
  elements[3]={...elements[3],tags:{...elements[3].tags,architect:'',name:'Бизнес-центр'}};
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:elements,fetchImpl:async()=>assert.fail('must not fetch')});
  await assert.rejects(plan({start,mode:'loop',minutes:30}),{code:'WALK_STOPS_NOT_FOUND'});
});

test('bundled Moscow catalog supports automatic discovery by default',async()=>{
  assert.equal(discoveryCatalog.license,'ODbL-1.0');
  assert.match(discoveryCatalog.sourceSha256,/^[a-f0-9]{64}$/);
  assert.ok(discoveryCatalog.elements.length>1500);
  // Wikidata and Wikipedia links carry most of the catalog; a name tag is optional.
  assert.ok(discoveryCatalog.elements.filter(e=>!e.tags.name).length>500);
  assert.ok(discoveryCatalog.elements.every(e=>e.tags.building&&e.tags['addr:street']&&e.tags['addr:housenumber']));
  const calls=[];
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',fetchImpl:async(url,options)=>{
    assert.equal(url,'https://router.test/route');
    calls.push(JSON.parse(options.body));
    throw new Error('router unavailable');
  }});
  await assert.rejects(plan({start:{address:'Москва, Арбат, 1',location:{lat:55.7521,lon:37.6007}},mode:'loop',minutes:30}),{code:'WALK_UNAVAILABLE'});
  assert.equal(calls.length,1);
  assert.ok(calls[0].locations.length>=4);
});

test('Overpass transport failures and deadlines identify discovery, then release the gate',async()=>{
  let failDiscovery=true;
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',overpassUrl:'https://osm.test/',discoveryElements:null,minIntervalMs:0,timeoutMs:20,fetchImpl:async(url,options)=>{
    if(url==='https://osm.test/') {
      if(failDiscovery)return new Promise(()=>{});
      return Response.json(candidates());
    }
    return Response.json(route(JSON.parse(options.body)));
  }});
  await assert.rejects(plan({start,mode:'loop',minutes:30}),{code:'WALK_DISCOVERY_UNAVAILABLE'});
  failDiscovery=false;
  assert.equal((await plan({start,mode:'loop',minutes:30})).stops.length,4);
  const unavailable=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:null,fetchImpl:async()=>{throw new Error('private');}});
  await assert.rejects(unavailable({start,mode:'loop',minutes:30}),{code:'WALK_DISCOVERY_UNAVAILABLE',message:'WALK_DISCOVERY_UNAVAILABLE'});
});

for (const stops of [[], [stop(1)]]) test(`destination remains final with ${stops.length} stops`, async () => {
  const {plan}=fixture((url,o)=>route(JSON.parse(o.body)));
  const result=await plan(input({mode:'open',destination:stop(4),stops}));
  assert.deepEqual(result.geometry.at(-1),stop(4).location);
  assert.deepEqual(result.stops,stops);
});
test('destination rejects loop and coincident endpoints before transport', async () => {
  const {plan,calls}=fixture(()=>{throw new Error('unexpected');});
  for(const extra of [{destination:stop(4)},{mode:'open',destination:start},{mode:'open',destination:stop(1)}])
    await assert.rejects(plan(input(extra)),{code:'WALK_INVALID'});
  assert.equal(calls.length,0);
});
test('automatic destination survives lack of historical candidates', async () => {
  const {plan}=fixture((url,o)=>url.includes('osm')?{elements:[]}:route(JSON.parse(o.body)));
  const result=await plan({start,mode:'open',minutes:30,destination:stop(4)});
  assert.deepEqual(result.geometry.at(-1),stop(4).location);
  assert.deepEqual(result.stops,[]);
});

test('unreachable destination is rejected before historical discovery', async () => {
  const {plan,calls}=fixture((url,o)=>route(JSON.parse(o.body),2000));
  await assert.rejects(plan({start,mode:'open',minutes:30,destination:stop(4)}),{code:'WALK_NOT_FOUND'});
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/router/);
});

test('over-budget candidates are removed without losing destination', async () => {
  const {plan}=fixture((url,o)=>url.includes('osm')?candidates():route(JSON.parse(o.body),1000));
  const result=await plan({start,mode:'open',minutes:30,destination:stop(5)});
  assert.deepEqual(result.geometry.at(-1),stop(5).location);
  assert.deepEqual(result.stops,[]);
});

test('automatic destination tries another landmark when the nearest exceeds budget', async () => {
  const {plan}=fixture((url,o)=>{
    if(url.includes('osm'))return candidates();
    const request=JSON.parse(o.body);
    return route(request,request.locations.some(p=>p.lat===stop(1).location.lat)?2000:100);
  });
  const result=await plan({start,mode:'open',minutes:30,destination:stop(5)});
  assert.ok(result.stops.length>0);
  assert.ok(result.stops.every(p=>p.location.lat!==stop(1).location.lat));
  assert.deepEqual(result.geometry.at(-1),stop(5).location);
});

test('automatic destination also includes a fifth landmark directly along the route', async () => {
  const data=candidates();
  data.elements.push({...data.elements[0],center:stop(5).location,tags:{...data.elements[0].tags,'addr:housenumber':'7'}});
  const {plan}=fixture((url,o)=>url.includes('osm')?data:route(JSON.parse(o.body)));
  const result=await plan({start,mode:'open',minutes:30,destination:stop(8)});
  assert.deepEqual(result.stops,[1,2,3,4,5].map(stop));
  assert.deepEqual(result.geometry.at(-1),stop(8).location);
});

for(const [minutes,expected] of [[30,5],[60,8],[90,10]]) test(`automatic destination uses a ${expected}-stop cap for ${minutes} minutes`, async () => {
  const data={elements:Array.from({length:10},(_,index)=>{
    const n=index+1;
    return {...candidates().elements[0],center:stop(n).location,tags:{...candidates().elements[0].tags,'addr:housenumber':String(n+2)}};
  })};
  const {plan}=fixture((url,o)=>url.includes('osm')?data:route(JSON.parse(o.body)));
  const result=await plan({start,mode:'open',minutes,destination:stop(12)});
  assert.deepEqual(result.stops,Array.from({length:expected},(_,index)=>stop(index+1)));
  assert.deepEqual(result.geometry.at(-1),stop(12).location);
});

for(const [minutes,expected] of [[30,5],[60,8],[90,10]]) test(`automatic loop uses a ${expected}-stop cap for ${minutes} minutes`, async () => {
  const data={elements:Array.from({length:10},(_,index)=>{
    const n=index+1;
    return {...candidates().elements[0],center:stop(n).location,tags:{...candidates().elements[0].tags,'addr:housenumber':String(n+2)}};
  })};
  const {plan}=fixture((url,o)=>url.includes('osm')?data:route(JSON.parse(o.body)));
  const result=await plan({start,mode:'loop',minutes});
  assert.deepEqual(result.stops,Array.from({length:expected},(_,index)=>stop(index+1)));
  assert.deepEqual(result.geometry.at(-1),start.location);
});

test('published audio and stories win the limited slots along a route', async () => {
  const supplied=Array.from({length:6},(_,index)=>{
    const n=index+1;
    return {id:`osm:node:${n}`,address:stop(n).address,location:stop(n).location,readiness:n===6?'audio':n===5?'story':'none'};
  });
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:[],candidateProvider:()=>supplied,minIntervalMs:0,
    fetchImpl:async(url,o)=>Response.json(route(JSON.parse(o.body)))});
  const result=await plan({start,mode:'open',minutes:30,destination:stop(8)});
  assert.deepEqual(result.stops.map(item=>item.contentId),[undefined,undefined,undefined,'osm:node:5','osm:node:6']);
  assert.deepEqual(result.stops.map(item=>item.address),[1,2,3,5,6].map(n=>stop(n).address));
});

test('map catalog candidates win equal empty slots over fallback discovery', async () => {
  const supplied=Array.from({length:5},(_,index)=>{
    const n=index+6;
    return {id:`osm:node:${n}`,address:stop(n).address,location:stop(n).location,readiness:'none'};
  });
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:candidates().elements,candidateProvider:()=>supplied,minIntervalMs:0,
    fetchImpl:async(url,o)=>Response.json(route(JSON.parse(o.body)))});
  const result=await plan({start,mode:'open',minutes:30,destination:stop(12)});
  assert.deepEqual(result.stops.map(item=>item.address),[6,7,8,9,10].map(n=>stop(n).address));
});

test('distinct landmarks ten metres apart remain separate stops', async () => {
  const close=Array.from({length:5},(_,index)=>({id:`osm:node:${index+20}`,address:`Москва, Плотная улица, ${index+1}`,
    location:{lat:55.7501+index*0.0001,lon:37.6},readiness:'story'}));
  const destination={address:'Москва, Плотная улица, 10',location:{lat:55.751,lon:37.6}};
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:[],candidateProvider:()=>close,minIntervalMs:0,
    fetchImpl:async(url,o)=>Response.json(route(JSON.parse(o.body)))});
  const result=await plan({start,mode:'open',minutes:30,destination});
  assert.deepEqual(result.stops.map(item=>item.address),close.map(item=>item.address));
});

test('an optional stop with disconnected snapped legs does not discard a valid route', async () => {
  const {plan}=fixture((url,o)=>{
    if(url.includes('osm'))return candidates();
    const request=JSON.parse(o.body),data=route(request);
    if(request.locations.length>2) {
      const from=request.locations[1],to=request.locations[2];
      data.trip.legs[1].shape=encode([{lat:from.lat+0.0003,lon:from.lon},to]);
    }
    return data;
  });
  const result=await plan({start,mode:'open',minutes:30,destination:stop(5)});
  assert.deepEqual(result.stops,[]);
  assert.deepEqual(result.geometry[0],start.location);
  assert.deepEqual(result.geometry.at(-1),stop(5).location);
});

test('a manual route with disconnected legs is not returned as a walking track', async () => {
  const {plan}=fixture((url,o)=>{
    const request=JSON.parse(o.body),data=route(request);
    const from=request.locations[1],to=request.locations[2];
    data.trip.legs[1].shape=encode([{lat:from.lat+0.0003,lon:from.lon},to]);
    return data;
  });
  await assert.rejects(plan(input()),{code:'WALK_NOT_FOUND'});
});

test('an optional landmark snapped onto the start does not discard the route', async () => {
  const {plan}=fixture((url,o)=>{
    if(url.includes('osm'))return candidates();
    const request=JSON.parse(o.body),data=route(request);
    if(request.locations.some(p=>p.lat===stop(1).location.lat)) {
      data.trip.legs[0]={summary:{time:0,length:0},shape:encode([start.location,start.location])};
    }
    return data;
  });
  const result=await plan({start,mode:'open',minutes:30,destination:stop(5)});
  assert.deepEqual(result.stops,[stop(2),stop(3),stop(4)]);
  assert.deepEqual(result.geometry[0],start.location);
  assert.deepEqual(result.geometry.at(-1),stop(5).location);
});

test('zero-length required legs are an unusable route, not a router outage', async () => {
  const {plan}=fixture((url,o)=>{
    const data=route(JSON.parse(o.body));
    data.trip.legs[0]={summary:{time:0,length:0},shape:encode([start.location,start.location])};
    return data;
  });
  await assert.rejects(plan(input()),{code:'WALK_NOT_FOUND'});
  await assert.rejects(plan({start,mode:'open',minutes:30,destination:stop(5)}),{code:'WALK_NOT_FOUND'});
});

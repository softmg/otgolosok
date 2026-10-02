import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalkPlanner, MAX_AUTO_ROUTER_CALLS, selectChain, traceTunnels, TRACE_TIMEOUT_MS } from './walks.mjs';
import discoveryCatalog from './walk-discovery-catalog.json' with { type: 'json' };

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
/** @returns {{elements: import('./walks.mjs').OverpassElement[]}} */
const candidates=()=>({elements:[1,2,3,4].map(n=>({type:'way',center:stop(n).location,tags:{building:'yes','addr:street':'Арбат','addr:housenumber':String(n+2),...signals[n-1]}}))});
function fixture(handler) {
  const calls=[];
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',overpassUrl:'https://osm.test/',discoveryElements:null,minIntervalMs:0,fetchImpl:async(url,options)=>{
    calls.push({url:String(url),options});
    const value=await handler(String(url),options,calls);
    return value instanceof Response?value:Response.json(value);
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
  for(const value of [null,[],{},input({mode:'drive'}),input({minutes:'30'}),input({minutes:31}),input({extra:true}),input({stops:[]}),input({stops:undefined}),input({stops:Array.from({length:41},(_,i)=>stop(i+1))}),input({stops:[stop(1),start]}),input({stops:[stop(1),stop(1)]}),input({start:{...start,address:'<script>'}}),input({start:{...start,address:'a'.repeat(241)}}),input({start:{...start,location:{lat:'55.75',lon:37.6}}}),input({start:{...start,location:{lat:56,lon:37.6}}}),input({start:{...start,location:{lat:55.75,lon:NaN}}}),input({start:{...start,location:{...start.location,z:1}}})]) {
    await assert.rejects(plan(value),{code:'WALK_INVALID'});
  }
  assert.equal(calls.length,0);
});

for(const count of [11,28,40])test(`manual routes accept ${count} distinct stops in order`,async()=>{
  const stops=Array.from({length:count},(_,index)=>stop(index+1));
  const {plan}=fixture((url,o)=>route(JSON.parse(o.body)));
  const result=await plan({start,mode:'open',minutes:90,stops});
  assert.deepEqual(result.stops,stops);
  assert.deepEqual(result.geometry.at(-1),stops.at(-1).location);
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
  for(const fetchImpl of [async()=>new Response('private',{status:500}),async()=>new Response(JSON.stringify({error_code:154,error:'Path distance exceeds the max distance limit'}),{status:400}),async()=>new Response('{',{status:400}),async()=>new Response('{'),async()=>new Response('x'.repeat(1024*1024+1)),async()=>{throw new Error('secret');}]) {
    const plan=createWalkPlanner({routerUrl:'https://router.test/route',fetchImpl});
    await assert.rejects(plan(input()),{code:'WALK_UNAVAILABLE',message:'WALK_UNAVAILABLE'});
  }
  for(const data of [{}, {elements:[],remark:'timeout'}, {elements:Array(501).fill({})}]) {
    const {plan}=fixture(()=>data);
    await assert.rejects(plan({start,mode:'loop',minutes:30}),{code:'WALK_DISCOVERY_UNAVAILABLE'});
  }
});

test('missing router, total deadline and the waiting queue are bounded',{timeout:5000},async()=>{
  await assert.rejects(createWalkPlanner({routerUrl:''})(input()),{code:'WALK_UNAVAILABLE'});
  const signals=[];
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',timeoutMs:25,minIntervalMs:0,maxWaiters:1,fetchImpl:async(url,o)=>{signals.push(o.signal);return new Promise(()=>{});}});
  const first=plan(input()),second=plan(input());
  await assert.rejects(plan(input()),{code:'WALK_BUSY'});
  await assert.rejects(first,{code:'WALK_UNAVAILABLE'});assert.equal(signals[0].aborted,true);
  // The queued plan runs once the first one ends and gets its own deadline.
  await assert.rejects(second,{code:'WALK_UNAVAILABLE'});assert.equal(signals.length,2);assert.equal(signals[1].aborted,true);
});

test('a plan that waits in the queue too long is refused as busy',{timeout:5000},async()=>{
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',timeoutMs:300,minIntervalMs:0,maxWaitMs:20,fetchImpl:async()=>new Promise(()=>{})});
  const first=plan(input()).catch(error=>error);
  const began=Date.now();
  await assert.rejects(plan(input()),{code:'WALK_BUSY'});
  assert.ok(Date.now()-began<250);
  assert.equal((await first).code,'WALK_UNAVAILABLE');
});

test('simultaneous plans from different clients are served in arrival order, spaced by the interval',{timeout:5000},async()=>{
  const started=[];
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:null,minIntervalMs:40,fetchImpl:async(url,o)=>{
    const request=JSON.parse(o.body);started.push({lat:request.locations[1].lat,at:performance.now()});return Response.json(route(request));
  }});
  const results=await Promise.all([1,2,3].map(n=>plan(input({stops:[stop(n)]}),{client:`client-${n}`})));
  assert.deepEqual(results.map(result=>result.stops[0]),[1,2,3].map(stop));
  assert.deepEqual(started.map(call=>call.lat),[1,2,3].map(n=>stop(n).location.lat));
  // Timers may fire a millisecond early; the gap is the interval, not zero.
  for(let index=1;index<started.length;index++)assert.ok(started[index].at-started[index-1].at>=35,`gap ${started[index].at-started[index-1].at}`);
});

test('one client cannot start plans faster than the interval, others are not affected',{timeout:5000},async()=>{
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:null,minIntervalMs:60,fetchImpl:async(url,o)=>Response.json(route(JSON.parse(o.body)))});
  await plan(input(),{client:'a'});
  await assert.rejects(plan(input(),{client:'a'}),{code:'WALK_RATE_LIMITED'});
  assert.ok((await plan(input(),{client:'b'})).geometry.length>0);
  await new Promise(done=>setTimeout(done,70));
  assert.ok((await plan(input(),{client:'a'})).geometry.length>0);
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
  }
  assert.ok(calls.every(call=>call.costing==='pedestrian'));
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
  // Every catalog place keeps its id for the photo, with or without a story.
  assert.deepEqual(result.stops.map(item=>item.placeId),[1,2,3,5,6].map(n=>`osm:node:${n}`));
  assert.deepEqual(result.stops.map(item=>item.address),[1,2,3,5,6].map(n=>stop(n).address));
});

// Promo walks for YouTube Shorts tell a story at every stop, so nearer landmarks without
// published content must not take the slots, as they do in ordinary walks.
test('stories-only walks skip nearer landmarks without published content', async () => {
  const supplied=Array.from({length:8},(_,index)=>{
    const n=index+1;
    return {id:`osm:node:${n}`,address:stop(n).address,location:stop(n).location,readiness:n<=3?'none':n===8?'audio':'story'};
  });
  const queries=[];
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:candidates().elements,
    candidateProvider:query=>{queries.push(query);return query.published?supplied.filter(item=>item.readiness!=='none'):supplied;},minIntervalMs:0,
    fetchImpl:async(url,o)=>Response.json(route(JSON.parse(o.body)))});
  const ordinary=await plan({start,mode:'loop',minutes:30});
  assert.ok(ordinary.stops.some(item=>!item.contentId),'an ordinary walk still takes nearer landmarks without stories');
  const stories=await plan({start,mode:'loop',minutes:30},{storiesOnly:true});
  assert.ok(stories.stops.length>=2);
  assert.ok(stories.stops.every(item=>/^osm:node:[4-8]$/.test(item.contentId??'')),JSON.stringify(stories.stops));
  assert.deepEqual(queries.map(query=>query.published),[false,true]);
});

test('stories-only discovery never queries Overpass', async () => {
  const supplied=[4,5,6].map(n=>({id:`osm:node:${n}`,address:stop(n).address,location:stop(n).location,readiness:'story'}));
  const urls=[];
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',overpassUrl:'https://osm.test/',discoveryElements:null,candidateProvider:()=>supplied,minIntervalMs:0,
    fetchImpl:async(url,o)=>{urls.push(String(url));return Response.json(route(JSON.parse(o.body)));}});
  const result=await plan({start,mode:'loop',minutes:30},{storiesOnly:true});
  assert.ok(result.stops.every(item=>item.contentId));
  assert.ok(urls.length>0&&urls.every(url=>url.startsWith('https://router.test/')),urls.join(' '));
});

test('stories-only walks with fewer than two published stories fail honestly', async () => {
  const supplied=[{id:'osm:node:4',address:stop(4).address,location:stop(4).location,readiness:'story'}];
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:candidates().elements,candidateProvider:()=>supplied,minIntervalMs:0,
    fetchImpl:async(url,o)=>Response.json(route(JSON.parse(o.body)))});
  await assert.rejects(plan({start,mode:'loop',minutes:30},{storiesOnly:true}),{code:'WALK_STOPS_NOT_FOUND'});
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

// Valhalla-like timing: leg time follows its length at ~5 km/h, unlike the constant-time mock above.
// Streets wind: the returned shape really is `detour` times longer than the straight line.
const metres=(a,b)=>{
  const rad=Math.PI/180,h=Math.sin((b.lat-a.lat)*rad/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin((b.lon-a.lon)*rad/2)**2;
  return 12742000*Math.asin(Math.sqrt(Math.min(1,h)));
};
// mutate may move shape points in place, e.g. to open a junction gap.
function walkRoute(request,detour=1.3,mutate=null) {
  const points=request.locations;
  const legs=points.slice(1).map((p,i)=>{
    const straight=metres(points[i],p),length=straight*detour;
    const bend={lat:(points[i].lat+p.lat)/2+straight/2*Math.sqrt(detour**2-1)/111195,lon:(points[i].lon+p.lon)/2};
    return {summary:{time:length/1.4,length:length/1000},shape:[points[i],bend,p]};
  });
  mutate?.(legs.map(leg=>leg.shape),points);
  return {trip:{status:0,units:'kilometers',legs:legs.map(leg=>({...leg,shape:encode(leg.shape)}))}};
}
// Notable addressed buildings every ~150 m around the start, as in central Moscow.
const grid=(half=12,stepM=150)=>{
  const elements=[];let id=1;
  for(let y=-half;y<=half;y++)for(let x=-half;x<=half;x++) {
    if(!x&&!y)continue;
    elements.push({type:'way',id:id++,center:{lat:start.location.lat+y*stepM/111195,lon:start.location.lon+x*stepM/(111195*Math.cos(start.location.lat*Math.PI/180))},
      tags:{building:'yes','addr:street':`Улица ${y+half}`,'addr:housenumber':String(x+half+1),historic:'building'}});
  }
  return elements;
};
const gridPlanner=({elements=grid(),detour=1.3,respond=request=>walkRoute(request,detour),...extra}={})=>{
  const calls=[];
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:elements,minIntervalMs:0,...extra,
    fetchImpl:async(url,o)=>{
      calls.push(JSON.parse(o.body));
      const value=respond(calls.at(-1));
      return value instanceof Response?value:Response.json(value);
    }});
  return {plan,calls};
};

for(const detour of [1.3,1.6])for(const mode of ['loop','open'])for(const minutes of [30,60,90])test(`automatic ${mode} fills at least 75% of a ${minutes}-minute walk in a dense area, detour ${detour}`,async()=>{
  const {plan,calls}=gridPlanner({detour});
  const result=await plan({start,mode,minutes});
  assert.ok(result.walkingMinutes>=0.75*minutes,`${result.walkingMinutes} min for ${minutes}`);
  assert.ok(result.walkingMinutes<=minutes);
  assert.ok(result.stops.length>=2&&result.stops.length<={30:5,60:8,90:10}[minutes]);
  if(mode==='loop')assert.deepEqual(result.geometry.at(-1),start.location);
  assert.ok(calls.length<=MAX_AUTO_ROUTER_CALLS);
});

const east=(m,extra={})=>({address:`Москва, Восточная улица, ${m}`,location:{lat:start.location.lat,lon:start.location.lon+m/62600},contentRank:0,catalogRank:0,...extra});
const west=(m,extra={})=>({address:`Москва, Западная улица, ${m}`,location:{lat:start.location.lat,lon:start.location.lon-m/62600},contentRank:0,catalogRank:0,...extra});
for(const [name,spacingM,candidates,expected] of [
  ['nearest without spacing',0,[east(100),west(400)],'Москва, Восточная улица, 100'],
  ['ready audio within the rank window',0,[east(60),west(120,{contentRank:2})],'Москва, Западная улица, 120'],
  ['map catalog within the rank window',0,[east(60),west(120,{catalogRank:1})],'Москва, Западная улица, 120'],
  ['readiness before catalog',0,[east(60,{catalogRank:1}),west(120,{contentRank:1})],'Москва, Западная улица, 120'],
  ['rank does not pull a far landmark',0,[east(60),west(400,{contentRank:2})],'Москва, Восточная улица, 60'],
  ['spacing skips close landmarks',300,[east(100),west(320)],'Москва, Западная улица, 320'],
  ['ready audio within a spaced window',300,[east(320),west(420,{contentRank:2})],'Москва, Западная улица, 420'],
])test(`selectChain picks ${name}`,()=>{
  const chain=selectChain({start,candidates,stopLimit:1,spacingM,loop:true,straightBudgetM:5000});
  assert.equal(chain[0].address,expected);
});

test('selectChain respects the stop cap, spacing and the straight-line budget of a loop',()=>{
  const candidates=[100,200,300,400,500,600].map(m=>east(m));
  assert.equal(selectChain({start,candidates,stopLimit:3,spacingM:0,loop:true,straightBudgetM:5000}).length,3);
  assert.deepEqual(selectChain({start,candidates,stopLimit:3,spacingM:190,loop:false,straightBudgetM:5000}).map(c=>c.address),[200,400,600].map(m=>east(m).address));
  // Going out 300 m and back is 600 m; the 400 m landmark would need 800 m.
  assert.deepEqual(selectChain({start,candidates,stopLimit:10,spacingM:0,loop:true,straightBudgetM:600}).map(c=>c.address),[100,200,300].map(m=>east(m).address));
});

test('a sparse area returns the longest fitting walk instead of failing',async()=>{
  const elements=grid(1,150);
  const {plan,calls}=gridPlanner({elements});
  const result=await plan({start,mode:'loop',minutes:60});
  assert.ok(result.walkingMinutes<45);
  assert.ok(result.stops.length>=2);
  const fitting=calls.map(call=>walkRoute(call).trip.legs.reduce((sum,leg)=>sum+leg.summary.time,0)).filter(seconds=>seconds<=3600);
  assert.equal(result.walkingMinutes,Math.ceil(Math.max(...fitting)/60));
});

test('landmarks beyond the straight-line estimate are still checked by the router',async()=>{
  const elements=[-1,1].map((side,index)=>({type:'way',id:index+1,center:{lat:start.location.lat,lon:start.location.lon+side*1000/62600},
    tags:{building:'yes','addr:street':'Дальняя улица','addr:housenumber':String(index+1),historic:'building'}}));
  const fast=gridPlanner({elements,detour:1});
  const result=await fast.plan({start,mode:'loop',minutes:60});
  assert.equal(result.stops.length,2);
  assert.ok(fast.calls.length>=1);
  const slow=gridPlanner({elements,detour:1.6});
  await assert.rejects(slow.plan({start,mode:'loop',minutes:60}),{code:'WALK_NOT_FOUND'});
  assert.ok(slow.calls.length>=1);
});

test('the spacing search makes a bounded number of router calls',async()=>{
  let calls=0;
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:grid(),minIntervalMs:0,
    fetchImpl:async(url,o)=>{
      calls++;
      // Implausibly fast walking keeps every measured walk short of the floor.
      const data=walkRoute(JSON.parse(o.body));
      for(const leg of data.trip.legs)leg.summary.time/=10;
      return Response.json(data);
    }});
  const result=await plan({start,mode:'loop',minutes:90});
  assert.ok(result.walkingMinutes<68);
  assert.ok(calls>1&&calls<=MAX_AUTO_ROUTER_CALLS,`${calls} router calls`);
});

test('an unusable spaced walk does not abort the search',async()=>{
  let calls=0;
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:grid(),minIntervalMs:0,fetchImpl:async(url,o)=>{
    const data=walkRoute(JSON.parse(o.body));
    if(++calls===2)data.trip.legs[1]={summary:{time:0,length:0},shape:data.trip.legs[1].shape};
    return Response.json(data);
  }});
  const result=await plan({start,mode:'loop',minutes:60});
  assert.ok(calls>2);
  assert.ok(result.walkingMinutes>=45&&result.walkingMinutes<=60);
});

// Valhalla answers "no path" with HTTP 400 and a JSON body.
const noPath=()=>new Response(JSON.stringify({error_code:442,error:'No path could be found for input'}),{status:400});
const moved=(p,northM,eastM)=>({lat:p.lat+northM/111195,lon:p.lon+eastM/(111195*Math.cos(p.lat*Math.PI/180))});
const at=(points,place)=>points.findIndex((p,i)=>i>0&&p.lat===place.location.lat&&p.lon===place.location.lon);
// Constant-time legs built from shapes, so a test can bend one while lengths stay consistent.
// A null shape is a zero-length leg.
/** @param {any} request @param {(shapes: any[], points: any[]) => void} [mutate] */
function shapedRoute(request,mutate=()=>{}) {
  const points=request.locations.map(({lat,lon})=>({lat,lon}));
  const shapes=points.slice(1).map((p,i)=>[points[i],{lat:(p.lat+points[i].lat)/2,lon:p.lon},p]);
  mutate(shapes,points);
  return {trip:{status:0,units:'kilometers',legs:shapes.map(shape=>{
    if(!shape)return {summary:{time:0,length:0},shape:encode([points[0],points[0]])};
    let length=0;for(let j=1;j<shape.length;j++)length+=metres(shape[j-1],shape[j]);
    return {summary:{time:100,length:length/1000},shape:encode(shape)};
  })}};
}

test('a router "no path" answer for a manual walk is not an outage',async()=>{
  const {plan}=fixture(()=>noPath());
  await assert.rejects(plan(input()),{code:'WALK_NOT_FOUND'});
  await assert.rejects(plan({start,mode:'open',minutes:30,destination:stop(4)}),{code:'WALK_NOT_FOUND'});
});

test('every router location snaps to its nearest well-connected pedestrian edge',async()=>{
  const {plan,calls}=gridPlanner();
  await plan({start,mode:'loop',minutes:60});
  assert.ok(calls.length>0);
  for(const call of calls)for(const location of call.locations)
    assert.deepEqual({type:location.type,radius:location.radius,minimum_reachability:location.minimum_reachability},{type:'break',radius:0,minimum_reachability:500});
});

test('a landmark that breaks the walk at a junction is excluded, not trimmed around',async()=>{
  let blamed=null;
  const {plan,calls}=gridPlanner({respond:request=>walkRoute(request,1.3,(shapes,points)=>{
    blamed??=points[2];
    const k=points.findIndex((p,i)=>i>0&&i<points.length-1&&p.lat===blamed.lat&&p.lon===blamed.lon);
    if(k>0)shapes[k][0]=moved(shapes[k][0],35,0);
  })});
  const result=await plan({start,mode:'loop',minutes:30});
  assert.ok(result.walkingMinutes>=0.75*30,`${result.walkingMinutes} min`);
  assert.ok(result.stops.length>=3);
  assert.ok(result.stops.every(p=>p.location.lat!==blamed.lat||p.location.lon!==blamed.lon));
  assert.ok(calls.length<=MAX_AUTO_ROUTER_CALLS);
});

test('an automatic landmark snapped far from its building is skipped, not a router outage',async()=>{
  const {plan}=fixture((url,o)=>url.includes('osm')?candidates():shapedRoute(JSON.parse(o.body),(shapes,points)=>{
    const k=at(points,stop(2));
    if(k>0)shapes[k-1][2]=moved(shapes[k-1][2],0,100);
  }));
  const result=await plan({start,mode:'loop',minutes:30});
  assert.ok(result.stops.length>=2);
  assert.ok(result.stops.every(p=>p.address!==stop(2).address));
});

// Rows: what goes wrong at which stop. Automatic walks drop that stop; a walk the user
// put together is reported as not found instead of silently losing a stop.
for(const mode of ['loop','open'])for(const [position,target] of /** @type {Array<[string, ReturnType<typeof stop>]>} */ ([['first',stop(1)],['middle',stop(2)],['last',stop(4)]]))for(const [defect,mutate] of /** @type {Array<[string, (shapes: any[], k: number) => void]>} */ ([
  ['a zero-length leg',(shapes,k)=>{shapes[k-1]=null;}],
  ['a junction gap',(shapes,k)=>{shapes[k][0]=moved(shapes[k][0],35,0);}],
  ['a far arrival',(shapes,k)=>{shapes[k-1][2]=moved(shapes[k-1][2],0,200);}],
])) {
  // An open walk without a destination has no junction after its last stop.
  if(defect==='a junction gap'&&position==='last'&&mode==='open')continue;
  const respond=request=>shapedRoute(request,(shapes,points)=>{const k=at(points,target);if(k>0)mutate(shapes,k);});
  test(`${defect} at the ${position} stop of an automatic ${mode} walk excludes that stop`,async()=>{
    const {plan}=fixture((url,o)=>url.includes('osm')?candidates():respond(JSON.parse(o.body)));
    const result=await plan({start,mode,minutes:30});
    assert.ok(result.stops.length>=2);
    assert.ok(result.stops.every(p=>p.address!==target.address),JSON.stringify(result.stops));
  });
  test(`${defect} at the ${position} stop of a manual ${mode} walk is not found`,async()=>{
    const {plan}=fixture((url,o)=>respond(JSON.parse(o.body)));
    await assert.rejects(plan(input({mode,stops:[stop(1),stop(2),stop(4)]})),{code:'WALK_NOT_FOUND'});
  });
}

test('a start off the pedestrian network is reported as such, for automatic and manual walks',async()=>{
  const respond=request=>shapedRoute(request,shapes=>{shapes[0][0]=moved(shapes[0][0],-200,0);});
  const {plan}=fixture((url,o)=>url.includes('osm')?candidates():respond(JSON.parse(o.body)));
  await assert.rejects(plan({start,mode:'loop',minutes:30}),{code:'WALK_START_UNREACHABLE'});
  await assert.rejects(plan(input({mode:'open'})),{code:'WALK_START_UNREACHABLE'});
  // A loop also returns to the start.
  const closing=fixture((url,o)=>shapedRoute(JSON.parse(o.body),shapes=>{shapes.at(-1)[2]=moved(shapes.at(-1)[2],0,200);}));
  await assert.rejects(closing.plan(input()),{code:'WALK_START_UNREACHABLE'});
});

test('a destination off the pedestrian network is reported before discovery',async()=>{
  const {plan,calls}=fixture((url,o)=>url.includes('osm')?candidates():shapedRoute(JSON.parse(o.body),shapes=>{shapes.at(-1)[2]=moved(shapes.at(-1)[2],0,200);}));
  await assert.rejects(plan({start,mode:'open',minutes:30,destination:stop(4)}),{code:'WALK_DESTINATION_UNREACHABLE'});
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/router/);
  await assert.rejects(plan(input({mode:'open',destination:stop(4)})),{code:'WALK_DESTINATION_UNREACHABLE'});
});

test('no path through an optional landmark skips it and keeps the earlier stops',async()=>{
  const {plan}=fixture((url,o)=>{
    if(url.includes('osm'))return candidates();
    const request=JSON.parse(o.body);
    return at(request.locations,stop(3))>0?noPath():route(request);
  });
  const result=await plan({start,mode:'open',minutes:30,destination:stop(5)});
  assert.deepEqual(result.stops,[stop(1),stop(2),stop(4)]);
  assert.deepEqual(result.geometry.at(-1),stop(5).location);
});

test('no path for an automatic walk without destination keeps searching within the budget',async()=>{
  const {plan,calls}=fixture((url,o)=>{
    if(url.includes('osm'))return candidates();
    const request=JSON.parse(o.body);
    return request.locations.length>=6?noPath():route(request);
  });
  const result=await plan({start,mode:'loop',minutes:30});
  assert.deepEqual(result.stops,[1,2,3].map(stop));
  const always=fixture(url=>url.includes('osm')?candidates():noPath());
  await assert.rejects(always.plan({start,mode:'loop',minutes:30}),{code:'WALK_NOT_FOUND'});
  assert.ok(calls.length>1&&always.calls.length-1<=MAX_AUTO_ROUTER_CALLS);
});

test('an always-unusable router stops after the router-call budget',async()=>{
  const {plan,calls}=gridPlanner({respond:request=>{
    const data=walkRoute(request);
    data.trip.legs[0].summary={time:0,length:0};
    return data;
  }});
  await assert.rejects(plan({start,mode:'loop',minutes:90}),{code:'WALK_NOT_FOUND'});
  assert.equal(calls.length,MAX_AUTO_ROUTER_CALLS);
});

// The geocoded start and the catalog point of the same building are a few metres apart.
const startBuilding=(metresAway,extra={})=>({type:'way',id:900,center:moved(start.location,metresAway,0),
  tags:{building:'yes','addr:street':'Арбат','addr:housenumber':'1',historic:'building',...extra}});
const requestHas=(call,place)=>JSON.parse(call.options.body).locations.some(p=>Math.abs(p.lat-place.location.lat)<1e-9&&Math.abs(p.lon-place.location.lon)<1e-9);

for(const metresAway of [16,3])test(`the start building ${metresAway} m away becomes stop 1 without a walking leg`,async()=>{
  const data=candidates();data.elements.push(startBuilding(metresAway));
  const {plan,calls}=fixture((url,o)=>url.includes('osm')?data:route(JSON.parse(o.body)));
  const result=await plan({start,mode:'loop',minutes:30});
  const landmark=result.stops[0];
  assert.equal(landmark.address,'Москва, Арбат, 1');
  assert.ok(metres(landmark.location,start.location)<metresAway+1);
  assert.equal(result.stops.filter(p=>p.address==='Москва, Арбат, 1').length,1);
  assert.ok(result.stops.length>=3&&result.stops.length<=5);
  const routerCalls=calls.filter(call=>call.url.includes('router'));
  assert.ok(routerCalls.every(call=>!requestHas(call,landmark)));
  assert.deepEqual(result.geometry[0],start.location);
  // Rebuilding the pinned walk sends the same router request.
  const rebuilt=fixture((url,o)=>route(JSON.parse(o.body)));
  assert.deepEqual(await rebuilt.plan({start,mode:'loop',minutes:30,stops:result.stops}),result);
  assert.ok(routerCalls.some(call=>call.options.body===rebuilt.calls[0].options.body));
});

test('the start building wins over a nearer landmark with another address',async()=>{
  const data={elements:[...candidates().elements,startBuilding(30),{...startBuilding(10),id:901,tags:{...startBuilding(10).tags,'addr:housenumber':'1А'}}]};
  const {plan}=fixture((url,o)=>url.includes('osm')?data:route(JSON.parse(o.body)));
  const result=await plan({start,mode:'loop',minutes:30});
  assert.equal(result.stops[0].address,'Москва, Арбат, 1');
  // The other nearby landmark stays an ordinary stop.
  assert.ok(result.stops.slice(1).some(p=>p.address==='Москва, Арбат, 1А'));
});

test('a destination walk with only the start building returns it with one router call',async()=>{
  const {plan,calls}=fixture((url,o)=>url.includes('osm')?{elements:[startBuilding(16)]}:route(JSON.parse(o.body)));
  const result=await plan({start,mode:'open',minutes:30,destination:stop(4)});
  assert.deepEqual(result.stops.map(p=>p.address),['Москва, Арбат, 1']);
  assert.deepEqual(result.geometry.at(-1),stop(4).location);
  assert.equal(calls.filter(call=>call.url.includes('router')).length,1);
});

test('stories-only walks never take a start building without a published story',async()=>{
  const supplied=[{id:'osm:node:1',address:'Москва, Арбат, 1',location:moved(start.location,16,0),readiness:'none'},
    ...[4,5,6].map(n=>({id:`osm:node:${n}`,address:stop(n).address,location:stop(n).location,readiness:'story'}))];
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',discoveryElements:[],candidateProvider:()=>supplied,minIntervalMs:0,
    fetchImpl:async(url,o)=>Response.json(route(JSON.parse(o.body)))});
  assert.equal((await plan({start,mode:'loop',minutes:30})).stops[0].address,'Москва, Арбат, 1');
  const stories=await plan({start,mode:'loop',minutes:30},{storiesOnly:true});
  assert.ok(stories.stops.every(p=>p.contentId),JSON.stringify(stories.stops));
});

test('a manual walk may start at its first stop, but no other stop may coincide with the start',async()=>{
  const {plan,calls}=fixture((url,o)=>route(JSON.parse(o.body)));
  const here={address:'Москва, Арбат, 1',location:moved(start.location,3,0)};
  const result=await plan(input({stops:[here,stop(1),stop(2)]}));
  assert.deepEqual(result.stops,[here,stop(1),stop(2)]);
  assert.equal(calls.length,1);assert.ok(!requestHas(calls[0],here));
  await assert.rejects(plan(input({stops:[stop(1),here]})),{code:'WALK_INVALID'});
  await assert.rejects(plan(input({mode:'open',stops:[here],destination:{address:'Москва, Арбат, 50',location:moved(start.location,0,3)}})),{code:'WALK_INVALID'});
});

// Tunnel lookup: the chosen route is traced leg by leg against Valhalla's trace_attributes.
const TRACE='https://router.test/trace_attributes';
const mid=(a,b,t=0.5)=>({lat:a.lat+(b.lat-a.lat)*t,lon:a.lon+(b.lon-a.lon)*t});
// About one metre east: the matched shape never repeats our vertices exactly.
const nudge=p=>({lat:p.lat,lon:p.lon+0.000015});
/**
 * @param {(body:any,options:any,calls:any[])=>Response|Promise<Response>} trace
 * @param {{osm?:any,onRoute?:()=>void,traceUrl?:string,now?:()=>number,timeoutMs?:number}} [options]
 */
function traceFixture(trace,{osm=null,onRoute=()=>{},...options}={}) {
  const calls=[];
  const plan=createWalkPlanner({routerUrl:'https://router.test/route',traceUrl:TRACE,overpassUrl:'https://osm.test/',discoveryElements:null,minIntervalMs:0,...options,fetchImpl:async(url,o)=>{
    if(String(url).startsWith('https://osm.test/')){calls.push({url:String(url)});return Response.json(osm);}
    calls.push({url:String(url),body:JSON.parse(o.body)});
    if(String(url)===TRACE)return trace(JSON.parse(o.body),o,calls);
    onRoute();
    return Response.json(route(JSON.parse(o.body)));
  }});
  return {plan,calls,traces:()=>calls.filter(call=>call.url===TRACE)};
}
// Fixture legs are [from, midpoint, to]. Leg 0 has its second half in a tunnel and
// leg 1 its first half, so the two covered segments meet at stop 1 and merge.
function tunnelAnswer(body) {
  const [from,middle,to]=body.shape,leg=body.shape;
  const outbound=leg[0].lat===start.location.lat&&leg.at(-1).lat===stop(1).location.lat;
  const inbound=leg[0].lat===stop(1).location.lat;
  if(outbound) {
    const shape=[from,mid(from,middle),middle,mid(middle,to),to].map(nudge);
    return Response.json({edges:[{begin_shape_index:0,end_shape_index:2},{tunnel:true,begin_shape_index:2,end_shape_index:4}],shape:encode(shape)});
  }
  if(inbound) {
    const shape=[from,mid(from,middle,0.3),middle,to].map(nudge);
    return Response.json({edges:[{tunnel:true,begin_shape_index:0,end_shape_index:2},{tunnel:false,begin_shape_index:2,end_shape_index:3}],shape:encode(shape)});
  }
  return Response.json({edges:[{begin_shape_index:0,end_shape_index:1}],shape:encode([from,to])});
}

test('the chosen route gets tunnel ranges mapped back by geometry and merged across a stop',async()=>{
  const {plan,traces}=traceFixture(tunnelAnswer);
  const result=await plan(input());
  assert.deepEqual(result.tunnels,[[1,3]]);
  assert.equal(traces().length,3);
  for(const call of traces()) {
    assert.equal(call.body.shape_match,'walk_or_snap');assert.equal(call.body.costing,'pedestrian');
    assert.deepEqual(call.body.filters.attributes,['edge.tunnel','edge.begin_shape_index','edge.end_shape_index','shape']);
  }
  assert.deepEqual(traces().map(call=>call.body.shape.length),[3,3,3]);
});

test('a route without tunnel edges has no tunnels key',async()=>{
  const {plan}=traceFixture(body=>Response.json({edges:[{begin_shape_index:0,end_shape_index:body.shape.length-1}],shape:encode(body.shape)}));
  const result=await plan(input());
  assert.equal('tunnels' in result,false);
});

for(const [name,traceUrl] of [['unset',undefined],['empty',''],['not http','ftp://router.test/trace'],['with credentials','https://user:secret@router.test/trace'],['malformed','not a url']])
  test(`trace URL ${name}: no lookup and a plain route`,async()=>{
    const {plan,calls}=traceFixture(()=>{throw new Error('must not trace');},{traceUrl});
    const result=await plan(input());
    assert.equal('tunnels' in result,false);
    assert.ok(calls.every(call=>call.url==='https://router.test/route'));
  });

for(const [name,answer] of /** @type {Array<[string,(body:any)=>Response]>} */ ([
  ['HTTP 500',()=>new Response('private',{status:500})],
  ['HTTP 400 with error_code',()=>new Response(JSON.stringify({error_code:443,error:'Exact route match algorithm failed'}),{status:400})],
  ['malformed JSON',()=>new Response('{')],
  ['oversized body',()=>new Response('x'.repeat(1024*1024+1))],
  ['broken shape',()=>Response.json({edges:[{tunnel:true,begin_shape_index:0,end_shape_index:1}],shape:'!'})],
  ['index past the shape',body=>Response.json({edges:[{tunnel:true,begin_shape_index:0,end_shape_index:9}],shape:encode(body.shape)})],
  ['network error',()=>{throw new Error('secret');}],
]))test(`trace failure (${name}) keeps the route without tunnels`,async()=>{
  // The first leg succeeds with a tunnel; a later failure must drop it too (all or nothing).
  const {plan}=traceFixture((body,o,calls)=>calls.filter(call=>call.url===TRACE).length===1?tunnelAnswer(body):answer(body));
  const result=await plan(input());
  assert.equal('tunnels' in result,false);
  assert.equal(result.stops.length,2);
});

test('a hanging trace is abandoned after its own timeout, and the plan still succeeds',async()=>{
  const signals=[];
  const {plan}=traceFixture((body,o)=>{signals.push(o.signal);return new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(o.signal.reason)));});
  const begun=Date.now(),result=await plan(input());
  const elapsed=Date.now()-begun;
  assert.equal('tunnels' in result,false);
  assert.ok(elapsed>=TRACE_TIMEOUT_MS-50&&elapsed<TRACE_TIMEOUT_MS+1500,`${elapsed} ms`);
  assert.equal(signals.length,1);assert.equal(signals[0].aborted,true);
});

test('no trace is requested when less than two seconds of the plan budget remain',async()=>{
  let clock=0;
  const {plan,traces}=traceFixture(tunnelAnswer,{now:()=>clock,timeoutMs:12000,onRoute:()=>{clock=10500;}});
  const result=await plan(input());
  assert.equal(traces().length,0);
  assert.equal('tunnels' in result,false);
});

test('candidate measurements are never traced, only the final route',async()=>{
  const {plan,calls,traces}=traceFixture(tunnelAnswer,{osm:candidates()});
  const result=await plan({start,mode:'loop',minutes:30});
  const routed=calls.filter(call=>call.url==='https://router.test/route');
  assert.ok(routed.length>1,'several candidate routes were measured');
  const lastRoute=calls.lastIndexOf(routed.at(-1));
  assert.ok(calls.slice(0,lastRoute).every(call=>call.url!==TRACE),'no trace before routing ends');
  assert.equal(traces().length,result.stops.length+1);
});

test('traceTunnels offsets later legs by the shared joint vertex',async()=>{
  const a=start.location,b=stop(1).location,c=stop(2).location;
  const legs=[[a,mid(a,b),b],[b,mid(b,c,0.25),mid(b,c,0.5),mid(b,c,0.75),c]];
  const fetchImpl=async(url,o)=>{
    const shape=JSON.parse(o.body).shape;
    // Only the middle of the second leg is covered: global segments 3 and 4.
    if(shape.length===5)return Response.json({edges:[{begin_shape_index:0,end_shape_index:1},{tunnel:true,begin_shape_index:1,end_shape_index:3},{begin_shape_index:3,end_shape_index:4}],shape:encode(shape.map(nudge))});
    return Response.json({edges:[{begin_shape_index:0,end_shape_index:2}],shape:encode(shape)});
  };
  assert.deepEqual(await traceTunnels(legs,{fetchImpl,traceUrl:TRACE}),[[3,5]]);
  const aborted=new AbortController();aborted.abort();
  assert.equal(await traceTunnels(legs,{fetchImpl,traceUrl:TRACE,signal:aborted.signal}),null);
});

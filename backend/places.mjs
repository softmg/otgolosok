const BOX = {west:37.30,south:55.48,east:37.95,north:55.98};
const TTL = 86400000;
const MAX_BYTES = 256 * 1024;
const fail = (code) => Object.assign(new Error(code), {code});
const text = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g,' ') : '';
const inBox = (lat,lon) => Number.isFinite(lat)&&Number.isFinite(lon)&&lat>=BOX.south&&lat<=BOX.north&&lon>=BOX.west&&lon<=BOX.east;
const moscow = (value) => /^(москва|moscow|город москва|moscow city|г\. москва)$/i.test(text(value));

function result(item) {
  if (!item || item.error) throw fail('PLACE_NOT_FOUND');
  const lat=Number(item.lat),lon=Number(item.lon),a=item.address??{};
  const locality=a.city??a.town??a.municipality??a.state;
  if(!inBox(lat,lon)||!moscow(locality)||/московск\S*\s+област|moscow\s+oblast/i.test(a.state??''))throw fail('PLACE_NOT_FOUND');
  const street=text(a.road||a.pedestrian||a.residential||a.footway||a.path||a.street),house=text(a.house_number);
  return {label:text(a.building||a.amenity||item.name||item.display_name).slice(0,220),
    address:street&&house?`Москва, ${street}, ${house}`:null,location:{lat,lon},
    osmId:item.osm_type&&item.osm_id?`${item.osm_type}/${item.osm_id}`:'',attribution:'© OpenStreetMap contributors'};
}

async function readJson(response,controller) {
  if(!response?.ok){await response?.body?.cancel();throw fail('PLACE_UNAVAILABLE');}
  if(!response.body?.getReader)throw fail('PLACE_UNAVAILABLE');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try {
    while(true){
      controller.signal.throwIfAborted();
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>MAX_BYTES){controller.abort();throw fail('PLACE_UNAVAILABLE');}
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } finally {await reader.cancel().catch(()=>{});}
}

// Only explicit user requests. One shared gate per service, no autocomplete or
// background/bulk lookup. The compatible provider can be changed in server env.
export function createPlaceResolver({fetchImpl=fetch,now=Date.now,baseUrl=process.env.PLACE_GEOCODER_URL??'https://nominatim.openstreetmap.org/'}={}) {
  const cache=new Map();let inFlight=false,lastStart=-Infinity;
  return async function resolvePlace(input){
    if(!input||typeof input!=='object'||Array.isArray(input))throw fail('PLACE_INVALID');
    const keys=Object.keys(input).sort();
    const point=keys.join(',')==='lat,lon',query=keys.join(',')==='q';
    let key,params;
    if(point){
      if(!inBox(input.lat,input.lon))throw fail('PLACE_INVALID');
      key=`r:${input.lat},${input.lon}`;
      params={lat:String(input.lat),lon:String(input.lon),zoom:'18'};
    }else if(query){
      const q=text(input.q);
      if(q.length<3||q.length>180||/(?:^|\s)(?:[a-z][a-z\d+.-]*:|\/\/|www\.)/i.test(q))throw fail('PLACE_INVALID');
      key=`s:${q.toLocaleLowerCase('ru')}`;
      params={q,countrycodes:'ru',viewbox:`${BOX.west},${BOX.north},${BOX.east},${BOX.south}`,bounded:'1',limit:'1'};
    }else throw fail('PLACE_INVALID');
    const current=now(),cached=cache.get(key);
    if(cached&&current-cached.at<TTL)return cached.value;
    cache.delete(key);
    if(inFlight||current-lastStart<1100)throw fail('PLACE_BUSY');
    inFlight=true;lastStart=current;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const url=new URL(point?'reverse':'search',baseUrl.endsWith('/')?baseUrl:baseUrl+'/');
      url.search=new URLSearchParams({...params,format:'jsonv2',addressdetails:'1'}).toString();
      const response=await fetchImpl(url.toString(),{signal:controller.signal,headers:{'User-Agent':'Otgolosok/0.1 (+https://otgolosok.online)',Accept:'application/json','Accept-Language':'ru'}});
      const payload=await readJson(response,controller);
      if(query&&!Array.isArray(payload))throw fail('PLACE_UNAVAILABLE');
      const value=result(query?payload[0]:payload);
      cache.set(key,{at:now(),value});while(cache.size>128)cache.delete(cache.keys().next().value);
      return value;
    }catch(error){if(error?.code==='PLACE_NOT_FOUND')throw error;throw fail('PLACE_UNAVAILABLE');}
    finally{clearTimeout(timer);inFlight=false;}
  };
}

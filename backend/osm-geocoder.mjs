import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";

const RADIUS_METERS = 300;
const METERS_PER_DEGREE = 6371000 * Math.PI / 180;
const validPoint = point => Number.isFinite(point?.lat) && Number.isFinite(point?.lon)
  && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
const fail = code => Object.assign(new Error("Не удалось прочитать локальный адресный индекс OSM."), {code});

function segmentDistance(a, b) {
  const dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;
  const t=length ? Math.max(0,Math.min(1,-(a[0]*dx+a[1]*dy)/length)) : 0;
  return Math.hypot(a[0]+t*dx,a[1]+t*dy);
}

function lineDistance(points) {
  let distance=Infinity;
  for(let i=1;i<points.length;i++) distance=Math.min(distance,segmentDistance(points[i-1],points[i]));
  return distance;
}

function inRing(points) {
  let inside=false;
  for(let i=0,j=points.length-1;i<points.length;j=i++) {
    const [x,y]=points[i], [previousX,previousY]=points[j];
    if ((y>0)!==(previousY>0) && 0 < (previousX-x)*(-y)/(previousY-y)+x) inside=!inside;
  }
  return inside;
}

function locate(geometry, point) {
  const scaleX=METERS_PER_DEGREE*Math.cos(point.lat*Math.PI/180);
  const project=([lon,lat])=>[(lon-point.lon)*scaleX,(lat-point.lat)*METERS_PER_DEGREE];
  if(geometry.type==="Point") return {distance:Math.hypot(...project(geometry.coordinates)),inside:false,boundary:false};
  if(geometry.type==="LineString") return {distance:lineDistance(geometry.coordinates.map(project)),inside:false,boundary:false};
  if(!["Polygon","MultiPolygon"].includes(geometry.type)) throw fail("OSM_ADDRESS_INDEX_INVALID");
  const polygons=geometry.type==="Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let distance=Infinity,inside=false;
  for(const polygon of polygons) {
    const rings=polygon.map(ring=>ring.map(project));
    distance=Math.min(distance,...rings.map(lineDistance));
    if(inRing(rings[0]) && !rings.slice(1).some(inRing)) inside=true;
  }
  const boundary=distance<0.02;
  return {distance:inside||boundary?0:distance,inside,boundary};
}

/** Offline search context only: a host building/nearby address is never assigned to the place. */
export function openOsmGeocoder(path) {
  try { statSync(path); }
  catch(error) { if(error.code==="ENOENT") return null; throw fail("OSM_ADDRESS_INDEX_INVALID"); }
  let db;
  try {
    db=new DatabaseSync(path,{readOnly:true,timeout:5000});
    const source=JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='manifest'").get()?.value ?? "null");
    if(source?.schemaVersion!==1 || !/^[a-f0-9]{64}$/.test(source.sourceSha256) || !source.attribution) throw fail("OSM_ADDRESS_INDEX_INVALID");
    const select=db.prepare(`SELECT f.*,b.min_lon,b.max_lon,b.min_lat,b.max_lat FROM bounds b
      JOIN features f ON f.id=b.id WHERE b.min_lon<=? AND b.max_lon>=? AND b.min_lat<=? AND b.max_lat>=?`);
    let closed=false;
    return {
      source,
      close() { if(!closed) { db.close(); closed=true; } },
      resolve(place) {
        const point=place.location;
        const result={version:1,source,location:validPoint(point)?{lat:point.lat,lon:point.lon}:null,
          radiusMeters:RADIUS_METERS,status:"unmatched",containingBuilding:null,nearbyAddresses:[],street:null,district:null};
        if(!validPoint(point)) return {...result,status:"invalid_coordinates"};
        try {
          const latDelta=RADIUS_METERS/METERS_PER_DEGREE;
          const lonDelta=latDelta/Math.max(0.001,Math.cos(point.lat*Math.PI/180));
          const candidates=select.all(point.lon+lonDelta,point.lon-lonDelta,point.lat+latDelta,point.lat-latDelta)
            .filter(row=>row.osm_id!==(place.id??place.placeId)).map(row=>{
              const position=locate(JSON.parse(row.geometry),point);
              return {...row,...position,area:(row.max_lon-row.min_lon)*(row.max_lat-row.min_lat)};
            }).filter(row=>row.distance<=RADIUS_METERS);
          candidates.sort((a,b)=>a.distance-b.distance || a.area-b.area || a.osm_id.localeCompare(b.osm_id));
          const view=(row,relation="nearby")=>row?{osmId:row.osm_id,name:row.name,address:row.address,
            distanceMeters:Math.round(row.distance),relation}:null;
          const building=candidates.find(row=>row.kind==="building" && (row.inside||row.boundary));
          result.containingBuilding=view(building,building?.boundary?"point_on_boundary":"point_in_building");
          const addresses=new Set(building?[building.address]:[]);
          for(const row of candidates) {
            if(!row.address || addresses.has(row.address) || result.nearbyAddresses.length>=2) continue;
            addresses.add(row.address);result.nearbyAddresses.push(view(row));
          }
          result.street=view(candidates.find(row=>row.kind==="street"));
          const district=candidates.find(row=>row.kind==="district" && (row.inside||row.boundary));
          result.district=view(district,district?.boundary?"point_on_boundary":"point_in_district");
          if(result.containingBuilding||result.nearbyAddresses.length||result.street||result.district) result.status="matched";
          return result;
        } catch { throw fail("OSM_ADDRESS_LOOKUP_FAILED"); }
      },
    };
  } catch { db?.close(); throw fail("OSM_ADDRESS_INDEX_INVALID"); }
}

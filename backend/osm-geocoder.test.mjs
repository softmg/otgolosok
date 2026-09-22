import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOsmGeocoder } from "./osm-geocoder.mjs";

const ring = (west, south, east, north) => [[west,south],[east,south],[east,north],[west,north],[west,south]];
const polygon = (outer, ...holes) => ({ type:"MultiPolygon", coordinates:[[outer,...holes]] });
const place = { id:"osm:node:99", location:{lat:55.75,lon:37.61} };

function fixture(t, features) {
  const directory = mkdtempSync(join(tmpdir(), "osm-geocoder-"));
  t.after(() => rmSync(directory, {recursive:true,force:true}));
  const path = join(directory, "addresses.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE features(id INTEGER PRIMARY KEY,osm_id TEXT UNIQUE,kind TEXT,name TEXT,address TEXT,geometry TEXT);
    CREATE VIRTUAL TABLE bounds USING rtree(id,min_lon,max_lon,min_lat,max_lat);`);
  db.prepare("INSERT INTO metadata VALUES ('manifest',?)").run(JSON.stringify({schemaVersion:1,source:"fixture",sourceSha256:"a".repeat(64),attribution:"© OpenStreetMap contributors",license:"ODbL-1.0"}));
  for (const [i,f] of features.entries()) {
    const points=f.geometry.coordinates.flat(Infinity);
    const lons=points.filter((_,i)=>i%2===0),lats=points.filter((_,i)=>i%2===1);
    db.prepare("INSERT INTO features VALUES (?,?,?,?,?,?)").run(i+1,f.id??`osm:way:${i+1}`,f.kind??"building",f.name??null,f.address??null,JSON.stringify(f.geometry));
    db.prepare("INSERT INTO bounds VALUES (?,?,?,?,?)").run(i+1,Math.min(...lons),Math.max(...lons),Math.min(...lats),Math.max(...lats));
  }
  db.close();
  const resolver=openOsmGeocoder(path);
  t.after(()=>resolver.close());
  return {resolver,path,directory};
}

test("full address index finds an unnamed host building, street and district without assigning a postal address",t=>{
  const {resolver}=fixture(t,[
    {address:"Москва, Тестовая улица, 1",geometry:polygon(ring(37.609,55.749,37.611,55.751))},
    {kind:"street",name:"Тестовая улица",geometry:{type:"LineString",coordinates:[[37.611,55.74],[37.611,55.76]]}},
    {kind:"district",name:"Тестовый район",geometry:polygon(ring(37.60,55.74,37.62,55.76))},
  ]);
  const result=resolver.resolve(place);
  assert.equal(result.containingBuilding.address,"Москва, Тестовая улица, 1");
  assert.equal(result.containingBuilding.relation,"point_in_building");
  assert.equal(result.street.name,"Тестовая улица");
  assert.ok(result.street.distanceMeters>0 && result.street.distanceMeters<100);
  assert.equal(result.district.name,"Тестовый район");
  assert.equal(result.source.sourceSha256,"a".repeat(64));
  assert.equal(result.postalAddress,undefined);
  assert.deepEqual(result.location,place.location);
});

test("courtyards and holes are not buildings; distance is measured to geometry rather than its centre",t=>{
  const {resolver}=fixture(t,[{address:"Москва, Тестовая улица, 1",geometry:polygon(ring(37.60,55.74,37.62,55.76),ring(37.6099,55.7499,37.6101,55.7501))}]);
  const result=resolver.resolve(place);
  assert.equal(result.containingBuilding,null);
  assert.equal(result.nearbyAddresses[0].relation,"nearby");
  assert.ok(result.nearbyAddresses[0].distanceMeters>0 && result.nearbyAddresses[0].distanceMeters<15);
});

test("a point on a wall is explicitly a boundary match, and separate multipolygon parts work",t=>{
  const {resolver}=fixture(t,[{address:"Москва, Тестовая улица, 1",geometry:{type:"MultiPolygon",coordinates:[[ring(37.5,55.7,37.51,55.71)],[ring(37.61,55.749,37.612,55.751)]]}}]);
  const result=resolver.resolve(place);
  assert.equal(result.containingBuilding.relation,"point_on_boundary");
  assert.equal(result.containingBuilding.distanceMeters,0);
});

test("nearby nodes are landmarks, duplicate addresses are bounded, far objects and own ID are excluded",t=>{
  const features=[
    {id:place.id,kind:"address",address:"Сам объект",geometry:{type:"Point",coordinates:[37.61,55.75]}},
    ...[1,2,3,4].map(i=>({kind:"address",address:i<=2?"Первый адрес":`Адрес ${i}`,geometry:{type:"Point",coordinates:[37.61+i*0.0001,55.75]}})),
    {kind:"address",address:"Далёкий адрес",geometry:{type:"Point",coordinates:[37.7,55.75]}},
  ];
  const {resolver}=fixture(t,features);
  const result=resolver.resolve(place);
  assert.equal(result.containingBuilding,null);
  assert.deepEqual(result.nearbyAddresses.map(f=>f.address),["Первый адрес","Адрес 3"]);
});

test("missing coverage and invalid coordinates return no invented location",t=>{
  const {resolver}=fixture(t,[]);
  assert.equal(resolver.resolve(place).status,"unmatched");
  for(const location of [null,{lat:NaN,lon:37},{lat:91,lon:37},{lat:55,lon:181}]) {
    const result=resolver.resolve({location});
    assert.equal(result.status,"invalid_coordinates");
    assert.equal(result.containingBuilding,null);
    assert.deepEqual(result.nearbyAddresses,[]);
  }
});

test("missing optional index is distinct from a corrupt or incompatible index",t=>{
  const {directory}=fixture(t,[]);
  assert.equal(openOsmGeocoder(join(directory,"absent.sqlite")),null);
  const bad=join(directory,"bad.sqlite");writeFileSync(bad,"invalid sqlite");
  assert.throws(()=>openOsmGeocoder(bad),{code:"OSM_ADDRESS_INDEX_INVALID"});
  const incompatible=join(directory,"version.sqlite");
  const db=new DatabaseSync(incompatible);
  db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)");
  db.prepare("INSERT INTO metadata VALUES ('manifest',?)").run(JSON.stringify({schemaVersion:2}));
  db.close();
  assert.throws(()=>openOsmGeocoder(incompatible),{code:"OSM_ADDRESS_INDEX_INVALID"});
});

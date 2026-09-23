#!/usr/bin/env node
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../backend/store.mjs";
import { openOsmGeocoder } from "../backend/osm-geocoder.mjs";
import { buildIdentityCandidates, IDENTITY_RULES_VERSION } from "../backend/identity-triage.mjs";

// Offline triage of weak_identity places: catalog tags, name frequency and the local OSM address
// index. No network and no model calls; the regular eligibility filter is not changed.
const args=new Set(process.argv.slice(2)),dryRun=args.has("--dry-run"),allowMissingIndex=args.has("--without-address-index");
if([...args].some(arg=>!["--dry-run","--without-address-index"].includes(arg)))throw new Error("Usage: node scripts/assess-identity-candidates.mjs [--dry-run] [--without-address-index]");
const dataDirectory=resolve(process.env.DATA_DIR??"backend/data"),database=join(dataDirectory,"jobs.sqlite");
const geocoder=openOsmGeocoder(process.env.OSM_ADDRESS_INDEX??join(dataDirectory,"osm-addresses.sqlite"));
// Without the index every candidate loses its address anchor and lands in enrich/manual; that must be a deliberate choice.
if(!geocoder&&!allowMissingIndex)throw new Error("OSM address index not found. Build it first or pass --without-address-index.");
try {
  const db=new DatabaseSync(database,{readOnly:true});
  let places;
  try {
    places=db.prepare("SELECT id,name,address,lat,lon,tags_json,geometry_json,content_hash FROM places WHERE archived=0 ORDER BY id").all()
      .map(row=>({id:row.id,name:row.name,address:row.address,location:{lat:row.lat,lon:row.lon},tags:JSON.parse(row.tags_json),
        geometry:row.geometry_json?JSON.parse(row.geometry_json):null,contentHash:row.content_hash}));
  } finally {db.close();}
  const candidates=buildIdentityCandidates(places,{resolveLocation:geocoder?place=>geocoder.resolve(place):null});
  const summary={rulesVersion:IDENTITY_RULES_VERSION,places:places.length,candidates:candidates.length,addressIndex:geocoder?geocoder.source.sourceSha256:null,
    tiers:Object.fromEntries(["auto","enrich","manual"].map(tier=>[tier,candidates.filter(item=>item.tier===tier).length]))};
  if(dryRun)console.log(JSON.stringify(summary,null,2));
  else {
    const store=createStore(database);
    try {console.log(JSON.stringify({...summary,...store.replaceIdentityCandidates(candidates)},null,2));}
    finally {store.close();}
  }
} finally {geocoder?.close();}

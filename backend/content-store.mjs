import { randomUUID } from "node:crypto";
import { sha256 } from "./domain.mjs";
import { assessPlaceEligibility, CONTENT_PROFILE_VERSION } from "./place-eligibility.mjs";
import { osmPostalAddress } from "./osm-context.mjs";
import { IDENTITY_RULES_VERSION, IDENTITY_TIERS } from "./identity-triage.mjs";

const encode = JSON.stringify;
const decode = value => value == null ? null : JSON.parse(value);
const iso = now => new Date(now()).toISOString();
const fail = (code, message=code) => Object.assign(new Error(message),{code});
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ERROR_CODE_SQL = "json_extract(i.error_json,'$.code')";

export const BATCH_ITEM_STATES = {
  all: null,
  ready: ["ready"],
  working: ["working"],
  waiting: ["queued", "retry_wait"],
  stopped: ["failed", "review_required", "insufficient_evidence", "cancelled"],
};

export const IDENTITY_PILOT_LIMIT = 50;
const IDENTITY_POLICIES = ["standard", "weak_identity"];
// Everything derived from the facts step onward; research and fetched sources stay, so a restart repeats no paid search.
const FACTS_STAGE_KEYS = ["evidence","editorialVersion","factsRejection","draft","draftCandidateRaw","review","reviewRounds"];
const factsCheckpoint = json => {if(!json)return null;const checkpoint=JSON.parse(json);for(const key of FACTS_STAGE_KEYS)delete checkpoint[key];return encode(checkpoint);};
const contentInputKey = (place,profile) => sha256(encode({placeId:place.id,contentHash:place.content_hash,profile,profileVersion:CONTENT_PROFILE_VERSION}));

function addressOf(place) {
  return osmPostalAddress(place.tags);
}

function viewPlace(row) {
  if(!row)return null;
  return {id:row.id,name:row.name,address:row.address,location:{lat:row.lat,lon:row.lon},tags:decode(row.tags_json),
    geometry:decode(row.geometry_json),provenance:decode(row.provenance_json),contentHash:row.content_hash,archived:Boolean(row.archived),updatedAt:row.updated_at};
}

function viewBatch(row,counts={}) {
  if(!row)return null;
  return {id:row.id,name:row.name,state:row.state,mode:row.mode,textProfile:row.text_profile,ttsProfile:row.tts_profile,
    identityPolicy:row.identity_policy??"standard",createdAt:row.created_at,updatedAt:row.updated_at,counts:{total:Number(counts.total??0),queued:Number(counts.queued??0),
      working:Number(counts.working??0),ready:Number(counts.ready??0),failed:Number(counts.failed??0)}};
}

export function createContentStore({db,now,transaction}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS osm_imports (id TEXT PRIMARY KEY, source TEXT NOT NULL, source_sha256 TEXT NOT NULL,
      rules_version TEXT NOT NULL, coverage TEXT NOT NULL, complete INTEGER NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS places (id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT, lat REAL NOT NULL, lon REAL NOT NULL,
      tags_json TEXT NOT NULL, content_hash TEXT NOT NULL, import_id TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS place_osm_aliases (osm_type TEXT NOT NULL, osm_id TEXT NOT NULL, place_id TEXT NOT NULL,
      import_id TEXT NOT NULL, PRIMARY KEY(osm_type,osm_id));
    CREATE TABLE IF NOT EXISTS content_batches (id TEXT PRIMARY KEY, request_key TEXT UNIQUE, name TEXT NOT NULL,state TEXT NOT NULL,
      mode TEXT NOT NULL,text_profile TEXT NOT NULL,tts_profile TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS content_jobs (id TEXT PRIMARY KEY,input_key TEXT NOT NULL UNIQUE,place_id TEXT NOT NULL,state TEXT NOT NULL,
      profile TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 3,next_attempt_at TEXT NOT NULL,
      checkpoint_json TEXT,error_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS content_jobs_available_idx ON content_jobs(state,next_attempt_at,created_at);
    CREATE TABLE IF NOT EXISTS content_job_attempts (job_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,
      started_at TEXT NOT NULL,finished_at TEXT,error_json TEXT,PRIMARY KEY(job_id,generation));
    CREATE TABLE IF NOT EXISTS batch_items (batch_id TEXT NOT NULL,place_id TEXT NOT NULL,text_job_id TEXT NOT NULL,state TEXT NOT NULL,
      error_json TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(batch_id,place_id));
    CREATE TABLE IF NOT EXISTS place_texts (id TEXT PRIMARY KEY,place_id TEXT NOT NULL,input_key TEXT NOT NULL UNIQUE,profile TEXT NOT NULL,
      content_hash TEXT NOT NULL,story_json TEXT NOT NULL,evidence_json TEXT NOT NULL,verification TEXT NOT NULL,audio_json TEXT,approved_story_json TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS place_identity_candidates (place_id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,rules_version TEXT NOT NULL,
      tier TEXT NOT NULL,score INTEGER NOT NULL,category TEXT NOT NULL,reasons_json TEXT NOT NULL,signals_json TEXT NOT NULL,
      location_json TEXT NOT NULL,assessed_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS place_identity_candidates_tier_idx ON place_identity_candidates(tier,score DESC);
  `);
  const columns=new Set(db.prepare("PRAGMA table_info(places)").all().map(column=>column.name));
  if(!columns.has("geometry_json"))db.exec("ALTER TABLE places ADD COLUMN geometry_json TEXT");
  if(!columns.has("provenance_json"))db.exec("ALTER TABLE places ADD COLUMN provenance_json TEXT");
  if(!db.prepare("PRAGMA table_info(place_texts)").all().some(column=>column.name==="audio_json"))db.exec("ALTER TABLE place_texts ADD COLUMN audio_json TEXT");
  if(!db.prepare("PRAGMA table_info(place_texts)").all().some(column=>column.name==="approved_story_json"))db.exec("ALTER TABLE place_texts ADD COLUMN approved_story_json TEXT");
  if(!db.prepare("PRAGMA table_info(place_texts)").all().some(column=>column.name==="audio_target_profile"))db.exec("ALTER TABLE place_texts ADD COLUMN audio_target_profile TEXT");
  const contentJobColumns=new Set(db.prepare("PRAGMA table_info(content_jobs)").all().map(column=>column.name));
  if(!contentJobColumns.has("profile_version"))db.exec("ALTER TABLE content_jobs ADD COLUMN profile_version TEXT NOT NULL DEFAULT '1'");
  if(!contentJobColumns.has("priority"))db.exec("ALTER TABLE content_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
  // weak_identity jobs come only from triage pilots: stricter evidence and never auto-approved.
  if(!contentJobColumns.has("identity_policy"))db.exec("ALTER TABLE content_jobs ADD COLUMN identity_policy TEXT NOT NULL DEFAULT 'standard'");
  if(!db.prepare("PRAGMA table_info(content_batches)").all().some(column=>column.name==="identity_policy"))db.exec("ALTER TABLE content_batches ADD COLUMN identity_policy TEXT NOT NULL DEFAULT 'standard'");

  const batchCounts=id=>db.prepare(`SELECT count(*) total,sum(state IN ('queued','retry_wait')) queued,
    sum(state='working') working,sum(state='ready') ready,sum(state IN ('failed','review_required','insufficient_evidence','cancelled')) failed
    FROM batch_items WHERE batch_id=?`).get(id);
  const syncItems=(jobId,state,error=null)=>db.prepare("UPDATE batch_items SET state=?,error_json=?,updated_at=? WHERE text_job_id=?")
    .run(state,error?encode(error):null,iso(now),jobId);
  const latestApprovedAudio=placeId=>db.prepare(`SELECT audio_json FROM place_texts WHERE place_id=?
    AND audio_json IS NOT NULL AND audio_json<>'null'
    ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(placeId)?.audio_json;
  const cancelAudioForPlace=(placeId,timestamp)=>db.prepare(`UPDATE external_audio_jobs SET state='cancelled',lease_token_hash=NULL,
    lease_expires_at=NULL,worker_id=NULL,claim_request_id=NULL,error_json=?,updated_at=? WHERE state IN ('queued','retry_wait','leased')
    AND source_job_id IN (SELECT 'place-text:'||id FROM place_texts WHERE place_id=?)`)
    .run(encode({code:"CANCELLED",message:"Superseded or cancelled by editor."}),timestamp,placeId);

  function validateBatch({requestKey,name,limit,textProfile,mode,identityPolicy}) {
    if(typeof requestKey!=="string"||requestKey.length<8||requestKey.length>100||typeof name!=="string"||!name.trim()||!["text-only","text-and-audio"].includes(mode)
      ||!Number.isSafeInteger(limit)||limit<1||limit>5000||!["story-v1","description-v1"].includes(textProfile)
      ||(mode==="text-and-audio"&&textProfile!=="story-v1")||!IDENTITY_POLICIES.includes(identityPolicy))throw fail("BAD_REQUEST");
  }
  /** Runs inside the caller's transaction. A shared job keeps its input key; the stricter identity policy wins while it is unfinished. */
  function insertBatch({requestKey,name,places,textProfile,mode,ttsProfile,identityPolicy,state}) {
    if(!places.length)throw fail("BAD_REQUEST");
    const timestamp=iso(now),id=randomUUID();
    db.prepare(`INSERT INTO content_batches (id,request_key,name,state,mode,text_profile,tts_profile,created_at,updated_at,identity_policy)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id,requestKey,name.trim(),state,mode,textProfile,ttsProfile,timestamp,timestamp,identityPolicy);
    for(const place of places){const inputKey=contentInputKey(place,textProfile);
      let job=db.prepare("SELECT * FROM content_jobs WHERE input_key=?").get(inputKey);
      if(!job){const jobId=randomUUID();db.prepare(`INSERT INTO content_jobs
        (id,input_key,place_id,state,profile,profile_version,priority,attempts,max_attempts,next_attempt_at,checkpoint_json,error_json,created_at,updated_at,identity_policy)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(jobId,inputKey,place.id,"queued",textProfile,CONTENT_PROFILE_VERSION,0,0,3,timestamp,null,null,timestamp,timestamp,identityPolicy);job={id:jobId,state:"queued"};}
      else if(identityPolicy==="weak_identity"&&job.state!=="ready")db.prepare("UPDATE content_jobs SET identity_policy='weak_identity',updated_at=? WHERE id=?").run(timestamp,job.id);
      db.prepare("INSERT INTO batch_items VALUES (?,?,?,?,?,?)").run(id,place.id,job.id,job.state,null,timestamp);}
    return viewBatch(db.prepare("SELECT * FROM content_batches WHERE id=?").get(id),batchCounts(id));
  }
  /**
   * Without an explicit list a batch takes the next places, by name, that pass the regular eligibility filter
   * and have no text job for this profile yet — the same rule as `create-osm-batch.mjs --next`.
   */
  function nextEligiblePlaces(limit,textProfile) {
    const jobExists=db.prepare("SELECT 1 FROM content_jobs WHERE input_key=?"),places=[];
    for(const row of db.prepare("SELECT * FROM places WHERE archived=0 ORDER BY name,id").iterate()){
      if(!assessPlaceEligibility({name:row.name,address:row.address,location:{lat:row.lat,lon:row.lon},tags:decode(row.tags_json)}).eligible)continue;
      if(jobExists.get(contentInputKey(row,textProfile)))continue;
      places.push(row);if(places.length>=limit)break;
    }
    if(!places.length)throw fail("NO_ELIGIBLE_PLACES");
    return places;
  }
  const currentCandidates=`FROM place_identity_candidates c JOIN places p ON p.id=c.place_id
    WHERE p.archived=0 AND c.content_hash=p.content_hash AND c.rules_version=?`;
  const viewCandidate=row=>({placeId:row.place_id,name:row.name,address:row.address,tier:row.tier,score:Number(row.score),category:row.category,
    reasons:decode(row.reasons_json),signals:decode(row.signals_json),location:decode(row.location_json),assessedAt:row.assessed_at,
    job:row.job_state?{state:row.job_state,identityPolicy:row.job_policy}:null});

  return {
    importPlaces(catalog,{complete=false}={}) {
      if(!catalog||!Array.isArray(catalog.places)||!catalog.places.length||typeof catalog.sourceSha256!=="string")throw fail("BAD_REQUEST");
      return transaction(()=>{
        const timestamp=iso(now),id=randomUUID();
        db.prepare("INSERT INTO osm_imports VALUES (?,?,?,?,?,?,?,?)").run(id,String(catalog.source??""),catalog.sourceSha256,
          String(catalog.rulesVersion??"unknown"),String(catalog.coverage??"unknown"),complete?1:0,encode({...catalog,places:undefined}),timestamp);
        const upsert=db.prepare(`INSERT INTO places
          (id,name,address,lat,lon,tags_json,content_hash,import_id,archived,created_at,updated_at,geometry_json,provenance_json)
          VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,address=excluded.address,lat=excluded.lat,lon=excluded.lon,tags_json=excluded.tags_json,
          content_hash=excluded.content_hash,import_id=excluded.import_id,archived=0,updated_at=excluded.updated_at,
          geometry_json=excluded.geometry_json,provenance_json=excluded.provenance_json`);
        const alias=db.prepare("INSERT INTO place_osm_aliases VALUES (?,?,?,?) ON CONFLICT(osm_type,osm_id) DO UPDATE SET place_id=excluded.place_id,import_id=excluded.import_id");
        for(const place of catalog.places) {
          if(!place||typeof place.placeId!=="string"||!place.name||!Number.isFinite(place.location?.lat)||!Number.isFinite(place.location?.lon))throw fail("BAD_REQUEST");
          const tags=place.tags??{},geometry=place.geometry??{type:"Point",coordinates:[place.location.lon,place.location.lat]},
            provenance=place.provenance??{source:"OpenStreetMap",osmType:place.osmType,osmId:place.osmId,timestamp:place.timestamp??null},
            hash=sha256(encode({name:place.name,location:place.location,geometry,tags}));
          upsert.run(place.placeId,String(place.name).slice(0,250),addressOf(place),place.location.lat,place.location.lon,encode(tags),hash,id,timestamp,timestamp,encode(geometry),encode(provenance));
          alias.run(place.osmType,String(place.osmId),place.placeId,id);
        }
        if(complete)db.prepare("UPDATE places SET archived=1,updated_at=? WHERE import_id<>?").run(timestamp,id);
        return {id,count:catalog.places.length,complete,createdAt:timestamp};
      });
    },
    listPlaces({limit=50,offset=0,q="",status="all",lat=null,lon=null,radius=null}={}) {
      if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||typeof q!=="string"||q.length>200||!["all","ready","missing"].includes(status)
        ||([lat,lon,radius].some(value=>value!==null)&&(!Number.isFinite(lat)||!Number.isFinite(lon)||!Number.isFinite(radius)||lat<55.05||lat>56.05||lon<36.75||lon>38.25||radius<50||radius>5000)))throw fail("BAD_REQUEST");
      const filters=["p.archived=0"],params=[];
      if(q.trim()){filters.push("(instr(casefold(p.name),casefold(?))>0 OR instr(casefold(COALESCE(p.address,'')),casefold(?))>0)");params.push(q.trim(),q.trim());}
      if(status==="ready")filters.push("EXISTS(SELECT 1 FROM place_texts t WHERE t.place_id=p.id AND t.approved_story_json IS NOT NULL)");
      if(status==="missing")filters.push("NOT EXISTS(SELECT 1 FROM place_texts t WHERE t.place_id=p.id)");
      if(lat!==null){const latDelta=radius/111320,lonDelta=radius/(111320*Math.cos(lat*Math.PI/180));filters.push("p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?");params.push(lat-latDelta,lat+latDelta,lon-lonDelta,lon+lonDelta);}
      const distanceSql=lat===null?"NULL":`6371000*2*asin(min(1,sqrt(pow(sin(radians(p.lat-?)/2),2)+cos(radians(?))*cos(radians(p.lat))*pow(sin(radians(p.lon-?)/2),2))))`;
      const distanceParams=lat===null?[]:[lat,lat,lon];if(lat!==null){filters.push(`${distanceSql}<=?`);params.push(...distanceParams,radius);}
      const rows=db.prepare(`SELECT p.*,(SELECT approved_story_json FROM place_texts t WHERE t.place_id=p.id AND t.approved_story_json IS NOT NULL ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) story_json,
        (SELECT audio_json FROM place_texts t WHERE t.place_id=p.id AND t.approved_story_json IS NOT NULL AND t.audio_json IS NOT NULL AND t.audio_json<>'null' ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) audio_json,
        (SELECT count(*) FROM place_texts t WHERE t.place_id=p.id) text_count,
        ${distanceSql} distance_m FROM places p WHERE ${filters.join(" AND ")} ORDER BY ${lat===null?"p.name,p.id":"distance_m,p.name,p.id"} LIMIT ? OFFSET ?`).all(...distanceParams,...params,limit+1,offset);
      const total=Number(db.prepare(`SELECT count(*) n FROM places p WHERE ${filters.join(" AND ")}`).get(...params).n);
      return {total,places:rows.slice(0,limit).map(row=>({...viewPlace(row),story:row.story_json?decode(row.story_json):null,audio:decode(row.audio_json),
        textStatus:row.story_json?"approved":Number(row.text_count)?"draft":"none",distanceM:row.distance_m==null?null:Number(row.distance_m)})),hasMore:rows.length>limit};
    },
    listWalkCandidates({lat,lon,radius,limit=500}={}) {
      if(!Number.isFinite(lat)||!Number.isFinite(lon)||!Number.isFinite(radius)||lat<55.05||lat>56.05||lon<36.75||lon>38.25||radius<50||radius>5000||!Number.isSafeInteger(limit)||limit<1||limit>500)throw fail("BAD_REQUEST");
      const latDelta=radius/111320,lonDelta=radius/(111320*Math.cos(lat*Math.PI/180));
      const distanceSql=`6371000*2*asin(min(1,sqrt(pow(sin(radians(p.lat-?)/2),2)+cos(radians(?))*cos(radians(p.lat))*pow(sin(radians(p.lon-?)/2),2))))`;
      const rows=db.prepare(`SELECT p.id,p.name,p.address,p.lat,p.lon,
        (SELECT approved_story_json FROM place_texts t WHERE t.place_id=p.id AND t.approved_story_json IS NOT NULL ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) story_json,
        (SELECT verification FROM place_texts t WHERE t.place_id=p.id AND t.approved_story_json IS NOT NULL ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) verification,
        (SELECT audio_json FROM place_texts t WHERE t.place_id=p.id AND t.approved_story_json IS NOT NULL AND t.audio_json IS NOT NULL AND t.audio_json<>'null' ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1) audio_json,
        ${distanceSql} distance_m FROM places p WHERE p.archived=0 AND p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ? AND ${distanceSql}<=?
        ORDER BY distance_m,p.name,p.id LIMIT ?`).all(lat,lat,lon,lat-latDelta,lat+latDelta,lon-lonDelta,lon+lonDelta,lat,lat,lon,radius,limit);
      return rows.map(row=>({id:row.id,address:(row.address??`Москва, ${row.name}`).slice(0,180),location:{lat:row.lat,lon:row.lon},
        readiness:row.audio_json?"audio":row.story_json&&row.verification!=="test_placeholder"?"story":"none"}));
    },
    getPlace(id) {
      const place=viewPlace(db.prepare("SELECT * FROM places WHERE id=? AND archived=0").get(id));
      if(!place)return null;
      const text=db.prepare("SELECT * FROM place_texts WHERE place_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id);
      const audio=latestApprovedAudio(id);
      return {...place,text:text?{id:text.id,profile:text.profile,story:decode(text.approved_story_json),draft:decode(text.story_json),verification:text.verification,audio:decode(audio),createdAt:text.created_at}:null};
    },
    getPublishedPlace(id) {
      const place=viewPlace(db.prepare("SELECT * FROM places WHERE id=? AND archived=0").get(id));if(!place)return null;
      const text=db.prepare("SELECT * FROM place_texts WHERE place_id=? AND approved_story_json IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id);if(!text)return null;
      const audio=latestApprovedAudio(id);
      return {...place,text:{id:text.id,profile:text.profile,story:decode(text.approved_story_json),verification:text.verification,audio:decode(audio),createdAt:text.created_at}};
    },
    createBatch({requestKey,name="OSM batch",placeIds=null,limit=50,textProfile="story-v1",mode="text-only",ttsProfile=null,identityPolicy="standard"}) {
      validateBatch({requestKey,name,limit,textProfile,mode,identityPolicy});
      return transaction(()=>{
        const existing=db.prepare("SELECT * FROM content_batches WHERE request_key=?").get(requestKey);if(existing)return viewBatch(existing,batchCounts(existing.id));
        let places;
        if(placeIds!==null){if(!Array.isArray(placeIds)||!placeIds.length||placeIds.length>limit||placeIds.some(id=>typeof id!=="string"))throw fail("BAD_REQUEST");
          const select=db.prepare("SELECT * FROM places WHERE id=? AND archived=0");places=placeIds.map(id=>select.get(id));if(places.some(place=>!place))throw fail("BAD_REQUEST");}
        else places=nextEligiblePlaces(limit,textProfile);
        return insertBatch({requestKey,name,places,textProfile,mode,ttsProfile,identityPolicy,state:"running"});
      });
    },
    /** Replaces the whole assessment: rows of places that became eligible or were archived must not linger. */
    replaceIdentityCandidates(candidates,{rulesVersion=IDENTITY_RULES_VERSION}={}) {
      if(!Array.isArray(candidates)||rulesVersion!==IDENTITY_RULES_VERSION)throw fail("BAD_REQUEST");
      for(const item of candidates)if(!item||typeof item.placeId!=="string"||typeof item.contentHash!=="string"||!IDENTITY_TIERS.includes(item.tier)
        ||!Number.isSafeInteger(item.score)||item.score<0||item.score>100||typeof item.category!=="string"||!Array.isArray(item.reasons)||!Array.isArray(item.signals)||!item.location)throw fail("BAD_REQUEST");
      return transaction(()=>{
        const timestamp=iso(now);db.prepare("DELETE FROM place_identity_candidates").run();
        const insert=db.prepare("INSERT INTO place_identity_candidates VALUES (?,?,?,?,?,?,?,?,?,?)");
        for(const item of candidates)insert.run(item.placeId,item.contentHash,rulesVersion,item.tier,item.score,item.category.slice(0,64),encode(item.reasons),encode(item.signals),encode(item.location),timestamp);
        return {assessedAt:timestamp,total:candidates.length,tiers:Object.fromEntries(IDENTITY_TIERS.map(tier=>[tier,candidates.filter(item=>item.tier===tier).length]))};
      });
    },
    listIdentityCandidates({tier="all",category="all",q="",queue="all",limit=50,offset=0}={}) {
      if(!["all",...IDENTITY_TIERS].includes(tier)||typeof category!=="string"||!(category==="all"||/^[a-z_]+(?::[a-z0-9_;:-]{1,60})?$/.test(category))
        ||typeof q!=="string"||q.length>200||!["all","none","queued"].includes(queue)
        ||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw fail("BAD_REQUEST");
      const job=`(SELECT %s FROM content_jobs j WHERE j.place_id=c.place_id ORDER BY j.created_at DESC,j.id DESC LIMIT 1)`;
      const filters=[],params=[];
      if(tier!=="all"){filters.push("c.tier=?");params.push(tier);}
      if(category!=="all"){filters.push("c.category=?");params.push(category);}
      if(q.trim()){filters.push("instr(casefold(p.name),casefold(?))>0");params.push(q.trim());}
      if(queue!=="all")filters.push(`${queue==="none"?"NOT ":""}EXISTS(SELECT 1 FROM content_jobs j WHERE j.place_id=c.place_id)`);
      const where=filters.map(filter=>` AND ${filter}`).join("");
      const rows=db.prepare(`SELECT c.*,p.name,p.address,${job.replace("%s","j.state")} job_state,${job.replace("%s","j.identity_policy")} job_policy
        ${currentCandidates}${where} ORDER BY c.score DESC,p.name,p.id LIMIT ? OFFSET ?`).all(IDENTITY_RULES_VERSION,...params,limit+1,offset);
      const total=Number(db.prepare(`SELECT count(*) n ${currentCandidates}${where}`).get(IDENTITY_RULES_VERSION,...params).n);
      const tiers=Object.fromEntries(IDENTITY_TIERS.map(name=>[name,0]));
      for(const row of db.prepare(`SELECT c.tier,count(*) n ${currentCandidates} GROUP BY c.tier`).all(IDENTITY_RULES_VERSION))tiers[row.tier]=Number(row.n);
      // Categories follow the tier filter only, so the category list does not collapse to the selected one.
      const categories=db.prepare(`SELECT c.category,count(*) n ${currentCandidates}${tier==="all"?"":" AND c.tier=?"} GROUP BY c.category ORDER BY n DESC,c.category`)
        .all(IDENTITY_RULES_VERSION,...(tier==="all"?[]:[tier])).map(row=>({category:row.category,count:Number(row.n)}));
      const stored=Number(db.prepare("SELECT count(*) n FROM place_identity_candidates").get().n),current=Object.values(tiers).reduce((sum,value)=>sum+value,0);
      return {items:rows.slice(0,limit).map(viewCandidate),total,hasMore:rows.length>limit,tiers,categories,stale:stored-current,
        rulesVersion:IDENTITY_RULES_VERSION,assessedAt:db.prepare("SELECT max(assessed_at) value FROM place_identity_candidates").get().value??null,pilotLimit:IDENTITY_PILOT_LIMIT};
    },
    /**
     * A bounded, paused pilot from current `auto` candidates without any text job yet. Categories take turns by
     * score so one numerous type cannot fill the pilot. A repeated requestKey returns the first batch untouched.
     */
    createIdentityPilot({requestKey,name,limit=20,mode="text-only",ttsProfile=null}) {
      const batchName=name??`Пилот weak_identity · ${new Date(now()).toLocaleString("ru-RU")}`;
      validateBatch({requestKey,name:batchName,limit,textProfile:"story-v1",mode,identityPolicy:"weak_identity"});
      if(limit>IDENTITY_PILOT_LIMIT)throw fail("BAD_REQUEST");
      return transaction(()=>{
        const existing=db.prepare("SELECT * FROM content_batches WHERE request_key=?").get(requestKey);
        if(existing)return {batch:viewBatch(existing,batchCounts(existing.id)),created:false};
        const jobExists=db.prepare("SELECT 1 FROM content_jobs WHERE input_key=?"),buckets=new Map();
        for(const row of db.prepare(`SELECT p.*,c.category,c.score ${currentCandidates} AND c.tier='auto' ORDER BY c.score DESC,p.name,p.id`).all(IDENTITY_RULES_VERSION)){
          if(jobExists.get(contentInputKey(row,"story-v1")))continue;
          if(!buckets.has(row.category))buckets.set(row.category,[]);buckets.get(row.category).push(row);}
        const places=[],lists=[...buckets.values()];
        while(places.length<limit&&lists.some(list=>list.length))for(const list of lists){if(places.length>=limit)break;if(list.length)places.push(list.shift());}
        if(!places.length)throw fail("NO_IDENTITY_CANDIDATES");
        const batch=insertBatch({requestKey,name:batchName,places,textProfile:"story-v1",mode,ttsProfile:mode==="text-and-audio"?ttsProfile:null,identityPolicy:"weak_identity",state:"paused"});
        return {batch,created:true};
      });
    },
    listBatches() {return db.prepare("SELECT * FROM content_batches ORDER BY created_at DESC").all().map(row=>viewBatch(row,batchCounts(row.id)));},
    listBatchItems(batchId,{limit=50,offset=0,status="all",error="all"}={}) {
      if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0||!Object.hasOwn(BATCH_ITEM_STATES,status)
        ||typeof error!=="string"||!(error==="all"||error==="none"||ERROR_CODE.test(error)))throw fail("BAD_REQUEST");
      if(!db.prepare("SELECT 1 FROM content_batches WHERE id=?").get(batchId))return null;
      const states=BATCH_ITEM_STATES[status],byStatus=states?` AND i.state IN (${states.map(()=>"?").join(",")})`:"",statusParams=states??[];
      // The filter reads the code out of error_json, so it stays correct whether an error-free item holds SQL NULL or the JSON literal null.
      const byError=error==="all"?"":error==="none"?` AND ${ERROR_CODE_SQL} IS NULL`:` AND ${ERROR_CODE_SQL}=?`,
        filter=byStatus+byError,params=[...statusParams,...(error==="all"||error==="none"?[]:[error])];
      const total=Number(db.prepare(`SELECT count(*) n FROM batch_items i WHERE i.batch_id=?${filter}`).get(batchId,...params).n);
      const items=db.prepare(`SELECT i.*,p.name,p.address FROM batch_items i JOIN places p ON p.id=i.place_id
        WHERE i.batch_id=?${filter} ORDER BY p.name,p.id LIMIT ? OFFSET ?`).all(batchId,...params,limit,offset)
        .map(item=>({placeId:item.place_id,name:item.name,address:item.address,state:item.state,error:decode(item.error_json)}));
      // Codes are counted under the status filter only, so the editor can switch between them without losing the list of what exists.
      const errors=db.prepare(`SELECT ${ERROR_CODE_SQL} code,count(*) n FROM batch_items i WHERE i.batch_id=?${byStatus}
        GROUP BY code ORDER BY n DESC,code`).all(batchId,...statusParams).map(row=>({code:row.code??null,count:Number(row.n)}));
      return {items,total,hasMore:offset+items.length<total,errors};
    },
    getBatch(id) {const row=db.prepare("SELECT * FROM content_batches WHERE id=?").get(id);if(!row)return null;
      const items=db.prepare(`SELECT i.*,p.name,p.address FROM batch_items i JOIN places p ON p.id=i.place_id WHERE i.batch_id=? ORDER BY p.name,p.id`).all(id)
      .map(item=>({placeId:item.place_id,name:item.name,address:item.address,state:item.state,error:decode(item.error_json)}));return {...viewBatch(row,batchCounts(id)),items};},
    getContentStats() {
      const places=Number(db.prepare("SELECT count(*) n FROM places WHERE archived=0").get().n);
      const texts=Number(db.prepare("SELECT count(*) n FROM place_texts").get().n);
      const audio=Number(db.prepare("SELECT count(*) n FROM place_texts WHERE audio_json IS NOT NULL").get().n);
      const jobs=Object.fromEntries(db.prepare("SELECT state,count(*) n FROM content_jobs GROUP BY state").all().map(row=>[row.state,Number(row.n)]));
      const external=Object.fromEntries(db.prepare("SELECT state,count(*) n FROM external_audio_jobs GROUP BY state").all().map(row=>[row.state,Number(row.n)]));
      const oldest=db.prepare("SELECT min(created_at) value FROM content_jobs WHERE state IN ('queued','retry_wait')").get().value;
      const usage=db.prepare("SELECT checkpoint_json FROM content_jobs WHERE checkpoint_json IS NOT NULL").all().reduce((sum,row)=>{const checkpoint=decode(row.checkpoint_json);return sum+Number(checkpoint?.usageTokens??0);},0);
      return {places,texts,audio,jobs,external,oldestTextQueuedAt:oldest,textUsageTokens:usage};
    },
    setBatchPriority(id,priority) {if(!Number.isSafeInteger(priority)||priority<0||priority>1000)throw fail("BAD_REQUEST");return transaction(()=>{const row=db.prepare("SELECT * FROM content_batches WHERE id=?").get(id);if(!row)return null;
      const timestamp=iso(now);db.prepare(`UPDATE content_jobs SET priority=?,updated_at=? WHERE id IN
        (SELECT text_job_id FROM batch_items WHERE batch_id=?) AND state IN ('queued','retry_wait')`).run(priority,timestamp,id);return this.getBatch(id);});},
    setBatchState(id,state) {if(!["running","paused","cancelled"].includes(state))throw fail("BAD_REQUEST");return transaction(()=>{const row=db.prepare("SELECT * FROM content_batches WHERE id=?").get(id);if(!row)return null;
      const timestamp=iso(now);db.prepare("UPDATE content_batches SET state=?,updated_at=? WHERE id=?").run(state,timestamp,id);
      if(state==="cancelled"){const pending=db.prepare("SELECT text_job_id FROM batch_items WHERE batch_id=? AND state IN ('queued','retry_wait')").all(id);
        db.prepare("UPDATE batch_items SET state='cancelled',updated_at=? WHERE batch_id=? AND state IN ('queued','retry_wait')").run(timestamp,id);
        for(const {text_job_id} of pending){const references=Number(db.prepare("SELECT count(*) n FROM batch_items WHERE text_job_id=? AND state IN ('queued','retry_wait','working')").get(text_job_id).n);if(!references)db.prepare("UPDATE content_jobs SET state='cancelled',updated_at=? WHERE id=? AND state IN ('queued','retry_wait')").run(timestamp,text_job_id);}
        for(const {place_id} of db.prepare("SELECT place_id FROM batch_items WHERE batch_id=?").all(id))cancelAudioForPlace(place_id,timestamp);}
      return this.getBatch(id);});},
    /**
     * restartFrom: "auto" resumes from the checkpoint, "facts" keeps fetched sources and extracts facts again (no paid search),
     * "research" starts over. A still queued item may be reset to an earlier stage, since no attempt has started on it.
     */
    retryBatchItem(batchId,placeId,{restartFrom="auto"}={}) {return transaction(()=>{if(!["auto","facts","research"].includes(restartFrom))throw fail("BAD_REQUEST");const item=db.prepare("SELECT * FROM batch_items WHERE batch_id=? AND place_id=?").get(batchId,placeId);
      const retryable=["failed","review_required","insufficient_evidence","retry_wait",...(restartFrom==="auto"?[]:["queued"])];if(!item||!retryable.includes(item.state))return null;
      const job=db.prepare("SELECT checkpoint_json FROM content_jobs WHERE id=?").get(item.text_job_id),checkpoint=restartFrom==="research"?null:restartFrom==="facts"?factsCheckpoint(job?.checkpoint_json):job?.checkpoint_json??null;
      const timestamp=iso(now);db.prepare("UPDATE content_jobs SET state='queued',attempts=0,next_attempt_at=?,error_json=NULL,checkpoint_json=?,updated_at=? WHERE id=?").run(timestamp,checkpoint,timestamp,item.text_job_id);
      db.prepare("UPDATE batch_items SET state='queued',error_json=NULL,updated_at=? WHERE batch_id=? AND place_id=?").run(timestamp,batchId,placeId);return this.getBatch(batchId);});},
    claimContentJob() {return transaction(()=>{const timestamp=iso(now);const row=db.prepare(`SELECT j.* FROM content_jobs j WHERE j.state IN ('queued','retry_wait') AND j.next_attempt_at<=? AND j.attempts<j.max_attempts
        AND EXISTS(SELECT 1 FROM batch_items i JOIN content_batches b ON b.id=i.batch_id WHERE i.text_job_id=j.id AND i.state IN ('queued','retry_wait') AND b.state='running') ORDER BY j.priority DESC,j.created_at,j.id LIMIT 1`).get(timestamp);
      if(!row)return null;const generation=Number(row.attempts)+1;db.prepare("UPDATE content_jobs SET state='working',attempts=attempts+1,updated_at=? WHERE id=?").run(timestamp,row.id);
      db.prepare("INSERT OR REPLACE INTO content_job_attempts VALUES (?,?,?, ?,NULL,NULL)").run(row.id,generation,"working",timestamp);syncItems(row.id,"working");
      const place=viewPlace(db.prepare("SELECT * FROM places WHERE id=?").get(row.place_id));return {id:row.id,place,profile:row.profile,profileVersion:row.profile_version,identityPolicy:row.identity_policy,checkpoint:decode(row.checkpoint_json),attempts:Number(row.attempts)+1};});},
    updateContentCheckpoint(id,checkpoint) {db.prepare("UPDATE content_jobs SET checkpoint_json=?,updated_at=? WHERE id=?").run(encode(checkpoint),iso(now),id);},
    completeContentJob(id,{story,evidence,verification="automatic",autoApprove:requestedAutoApprove=false}) {return transaction(()=>{const row=db.prepare("SELECT * FROM content_jobs WHERE id=?").get(id);if(!row||row.state!=="working")throw fail("CONFLICT");
      // The store, not the caller, decides: a weakly identified place is published only by an editor.
      const autoApprove=requestedAutoApprove&&row.identity_policy!=="weak_identity";
      const audioProfiles=()=>autoApprove&&story.audioDisposition!=="not_applicable_short_text"?db.prepare(`SELECT b.tts_profile,max(b.created_at) created_at FROM batch_items i JOIN content_batches b ON b.id=i.batch_id
        WHERE i.text_job_id=? AND b.mode='text-and-audio' AND b.tts_profile IS NOT NULL GROUP BY b.tts_profile ORDER BY created_at,b.tts_profile`).all(id).map(item=>item.tts_profile):[];
      const existing=db.prepare("SELECT * FROM place_texts WHERE input_key=?").get(row.input_key);if(existing){const timestamp=iso(now),selected=decode(existing.story_json);
        if(autoApprove&&!existing.approved_story_json)db.prepare("UPDATE place_texts SET approved_story_json=? WHERE id=?").run(encode(selected),existing.id);
        db.prepare("UPDATE content_jobs SET state='ready',updated_at=? WHERE id=?").run(timestamp,id);syncItems(id,"ready");return{id:existing.id,placeId:existing.place_id,story:selected,audioProfiles:audioProfiles()};}
      const timestamp=iso(now),textId=randomUUID();db.prepare(`INSERT INTO place_texts
        (id,place_id,input_key,profile,content_hash,story_json,evidence_json,verification,audio_json,approved_story_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `)
        .run(textId,row.place_id,row.input_key,row.profile,sha256(encode(story)),encode(story),encode(evidence),verification,null,autoApprove||verification==="editorial"?encode(story):null,timestamp);
      db.prepare("UPDATE content_jobs SET state='ready',error_json=NULL,updated_at=? WHERE id=?").run(timestamp,id);db.prepare("UPDATE content_job_attempts SET state='ready',finished_at=? WHERE job_id=? AND generation=?").run(timestamp,id,row.attempts);syncItems(id,"ready");
      return {id:textId,placeId:row.place_id,story,sourceRevision:0,audioProfiles:audioProfiles()};});},
    failContentJob(id,error,state="failed") {if(!["failed","review_required","insufficient_evidence"].includes(state))throw fail("BAD_REQUEST");return transaction(()=>{const row=db.prepare("SELECT * FROM content_jobs WHERE id=?").get(id);if(!row)return null;
      const retryable=new Set(["TIMEOUT","PROVIDER_BUSY","PROVIDER_FAILED","NETWORK_ERROR","SOURCE_ACCESS_FAILED","INTERRUPTED"]);const timestamp=iso(now),retry=state==="failed"&&retryable.has(error?.code)&&Number(row.attempts)<Number(row.max_attempts),next=retry?"retry_wait":state;
      db.prepare("UPDATE content_jobs SET state=?,next_attempt_at=?,error_json=?,updated_at=? WHERE id=?").run(next,new Date(now()+(row.attempts<=1?30000:120000)).toISOString(),encode(error),timestamp,id);db.prepare("UPDATE content_job_attempts SET state=?,finished_at=?,error_json=? WHERE job_id=? AND generation=?").run(next,timestamp,encode(error),id,row.attempts);syncItems(id,next,error);return {id,state:next,error};});},
    recoverContentJobs() {const timestamp=iso(now),error={code:"INTERRUPTED",message:"Подготовка прервана. Задание можно повторить."};const rows=db.prepare("SELECT id,attempts FROM content_jobs WHERE state='working'").all();for(const row of rows){db.prepare("UPDATE content_jobs SET state='retry_wait',next_attempt_at=?,error_json=?,updated_at=? WHERE id=?").run(timestamp,encode(error),timestamp,row.id);db.prepare("UPDATE content_job_attempts SET state='retry_wait',finished_at=?,error_json=? WHERE job_id=? AND generation=?").run(timestamp,encode(error),row.id,row.attempts);syncItems(row.id,"retry_wait",error);}return rows.length;},
    approvePlaceText(placeId,story=null) {return transaction(()=>{let row=db.prepare(`SELECT * FROM place_texts WHERE place_id=? ORDER BY
        CASE WHEN approved_story_json IS NOT NULL THEN 1 ELSE 0 END DESC,created_at DESC,rowid DESC LIMIT 1`).get(placeId);if(!row)return null;
      const selected=story??decode(row.story_json);if(!selected||typeof selected.title!=="string"||!Array.isArray(selected.paragraphs)||!selected.paragraphs.length)throw fail("BAD_REQUEST");
      const timestamp=iso(now),selectedJson=encode(selected),approvedStory=decode(row.approved_story_json),sameApproved=approvedStory
        &&approvedStory.title===selected.title&&approvedStory.paragraphs?.map(paragraph=>paragraph.text).join("\n\n")===selected.paragraphs.map(paragraph=>paragraph.text).join("\n\n");if(approvedStory&&!sameApproved){
        cancelAudioForPlace(placeId,timestamp);
        const id=randomUUID(),inputKey=sha256(encode({editorialParent:row.id,story:selected}));db.prepare(`INSERT INTO place_texts
          (id,place_id,input_key,profile,content_hash,story_json,evidence_json,verification,audio_json,approved_story_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id,placeId,inputKey,row.profile,sha256(selectedJson),selectedJson,row.evidence_json,"editorial",null,selectedJson,timestamp);row=db.prepare("SELECT * FROM place_texts WHERE id=?").get(id);
      } else if(!row.approved_story_json){db.prepare("UPDATE place_texts SET approved_story_json=?,verification='editorial' WHERE id=?").run(selectedJson,row.id);row=db.prepare("SELECT * FROM place_texts WHERE id=?").get(row.id);}
      const profiles=selected.audioDisposition==="not_applicable_short_text"?[]:db.prepare(`SELECT b.tts_profile,max(b.created_at) created_at FROM batch_items i JOIN content_batches b ON b.id=i.batch_id JOIN content_jobs j ON j.id=i.text_job_id
        WHERE j.place_id=? AND b.mode='text-and-audio' AND b.tts_profile IS NOT NULL GROUP BY b.tts_profile ORDER BY created_at,b.tts_profile`).all(placeId).map(item=>item.tts_profile);
      const approved=this.getPlace(placeId);return {...approved,text:{...approved.text,story:selected},audioProfiles:profiles};});},
  };
}

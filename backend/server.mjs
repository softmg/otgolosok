import { createServer as httpServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createStore } from "./store.mjs";
import { createProvider } from "./provider.mjs";
import { createYandexTts } from "./yandex-tts.mjs";
import { ttsVoiceOptions } from "./tts-voices.mjs";
import { normalizeAddress, addressKey, publicJob, failure } from "./domain.mjs";
import { safeError, startWorker } from "./pipeline.mjs";
import { createPlaceResolver } from "./places.mjs";
import { createWalkPlanner } from "./walks.mjs";
import { adminAuth, adminDetail, adminSummary } from "./admin.mjs";
import { validateWalkResearch, publicWalkResearch, walkResearchKey } from "./walk-research.mjs";
import { createBackendLogger } from "./logs.mjs";
import { ingestAudio } from "./audio-ingest.mjs";
import { startContentWorker } from "./content-pipeline.mjs";
import { openOsmGeocoder } from "./osm-geocoder.mjs";
import { createAuth, authRequestHandler, authSession, sessionCsrfToken, validSessionCsrf, verifySessionPassword } from "./auth.mjs";
import { favoriteSummary } from "./favorite-summary.mjs";
import { createAccountStore } from "./account-store.mjs";
import { resolveWalkView } from "./walk-view.mjs";
import { builtinRoutes } from "./builtin-routes.mjs";
import { catalogWalkView } from "./walk-catalog.mjs";
import { normalizeForSpeech } from "./text-normalizer.mjs";
import { loadLocalTtsConfig } from "./local-tts.mjs";
import { createTtsApiClient } from "./tts-api-client.mjs";
import { startTtsApiWorker } from "./tts-api-worker.mjs";

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
// Digests keep the comparison constant-time regardless of the candidate length.
function sameSecret(expected,candidate) {
  if(typeof expected!=="string"||!expected||typeof candidate!=="string")return false;
  const digest=value=>createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected),digest(candidate));
}

// Lease tokens are HMACs, so a known fallback secret would let any worker forge them.
export function workerLeaseSecret({env=process.env,transport,randomSecret=()=>randomBytes(32).toString("hex")}={}) {
  const secret=env.WORKER_LEASE_SECRET;
  const required=transport!=="http"&&(env.NODE_ENV==="production"||Boolean(env.WORKER_API_TOKEN));
  if(required&&(typeof secret!=="string"||secret.length<32))throw new Error("WORKER_LEASE_SECRET must contain at least 32 characters when external TTS workers are enabled");
  return secret||randomSecret();
}
function json(res,status,value) {
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
  res.end(JSON.stringify(value));
}
async function body(req,maxBytes=2048) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw failure("BAD_REQUEST");
  const chunks=[];let size=0;
  for await (const chunk of req) {size+=chunk.length;if(size>maxBytes)throw failure("BAD_REQUEST");chunks.push(chunk);}
  try {const value=JSON.parse(Buffer.concat(chunks).toString());if (!value||Array.isArray(value)||typeof value!=="object")throw new Error();return value;}
  catch {throw failure("BAD_REQUEST");}
}

export async function sendFile(req,res,path,type,immutable=false) {
  let info;
  try {info=await stat(path);} catch {json(res,404,{error:{message:"Файл не найден."}});return;}
  if (!info.isFile()) {json(res,404,{error:{message:"Файл не найден."}});return;}
  const headers={"Content-Type":type,"Accept-Ranges":"bytes","X-Content-Type-Options":"nosniff","Cache-Control":immutable?"public, max-age=31536000, immutable":"no-cache"};
  let start=0,end=info.size-1,status=200;
  if (req.headers.range) {
    const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match||(!match[1]&&!match[2])) {res.writeHead(416,{"Content-Range":`bytes */${info.size}`});res.end();return;}
    start=match[1]?Number(match[1]):Math.max(0,info.size-Number(match[2]));
    end=match[1]&&match[2]?Math.min(Number(match[2]),info.size-1):info.size-1;
    if (!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=info.size) {res.writeHead(416,{"Content-Range":`bytes */${info.size}`});res.end();return;}
    headers["Content-Range"]=`bytes ${start}-${end}/${info.size}`;status=206;
  }
  headers["Content-Length"]=Math.max(0,end-start+1);
  res.writeHead(status,headers);
  if(req.method==="HEAD"||!info.size){res.end();return;}
  const stream=createReadStream(path,{start,end});
  res.once("close",()=>stream.destroy());stream.once("error",()=>res.destroy());stream.pipe(res);
}

export function createApp({store,provider,osmGeocoder=null,yandexTts=null,origin,audioDirectory,staticDirectory,workerEnabled=true,localTts=loadLocalTtsConfig({}),ttsApiClient=null,resolvePlace=createPlaceResolver(),planWalk=null,discoverResearch,planResearchWalk,adminToken=process.env.ADMIN_TOKEN,allowLegacyAdminToken,workerToken=process.env.WORKER_API_TOKEN,logs=null,audioIngest=ingestAudio,auth=null,authSecret="",accountStore=null,closeAuth=async()=>{}}) {
  const walkPlanner=planWalk??createWalkPlanner({candidateProvider:query=>store.listWalkCandidates?.(query)??[]});
  const speechProviders={openai:provider,yandex:yandexTts};
  const ttsProviders=[{id:"openai",label:"OpenAI",available:Boolean(provider),...ttsVoiceOptions("openai",provider?.voice)},
    {id:"yandex",label:"Яндекс SpeechKit",available:Boolean(yandexTts),...ttsVoiceOptions("yandex",yandexTts?.voice)}];
  const worker=(provider||yandexTts)&&workerEnabled?startWorker({store,provider,speechProviders,audioDirectory,discoverResearch,planResearchWalk,logs}):null;
  const contentWorker=provider&&workerEnabled?startContentWorker({store,provider,logs,resolveLocation:osmGeocoder ? place=>osmGeocoder.resolve(place) : null,concurrency:Number(process.env.CONTENT_WORKER_CONCURRENCY??1),autoApprove:process.env.CONTENT_AUTO_APPROVE==="true"}):null;
  const ttsApiWorker=workerEnabled&&localTts.transport==="http"&&ttsApiClient?startTtsApiWorker({store,client:ttsApiClient,audioDirectory,profileId:localTts.defaultProfile,logs}):null;
  const authorizeAdmin=adminAuth(adminToken);
  const legacyAdminEnabled=allowLegacyAdminToken??(!auth||process.env.ALLOW_LEGACY_ADMIN_TOKEN==="true");
  const server=httpServer(async(req,res)=>{
    try {
      const url=new URL(req.url,"http://localhost");
      const session=auth?await authSession(auth,req):null;
      if(auth&&url.pathname==="/api/auth/session") {json(res,200,{user:session?{id:session.user.id,email:session.user.email,name:session.user.name,role:session.user.role}:null,csrfToken:session?sessionCsrfToken(authSecret,session.session.id):null});return;}
      if(auth&&url.pathname.startsWith("/api/auth/")){await authRequestHandler(auth)(req,res);return;}
      if(url.pathname==="/api/auth/session"&&!auth){json(res,200,{user:null});return;}
      if(url.pathname==="/api/me"||url.pathname.startsWith("/api/me/")) {
        if(!session||!accountStore){json(res,401,{error:{code:"UNAUTHORIZED",message:"Войдите в аккаунт."}});return;}
        if(!origin||req.headers.origin&&req.headers.origin!==origin||req.headers["sec-fetch-site"]==="cross-site") {json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
        if(!["GET","HEAD"].includes(req.method)&&!validSessionCsrf(authSecret,session.session.id,req.headers["x-csrf-token"])) {json(res,403,{error:{code:"CSRF",message:"Обновите страницу и повторите действие."}});return;}
        if(url.pathname==="/api/me"&&req.method==="GET"){json(res,200,{user:{id:session.user.id,email:session.user.email,name:session.user.name}});return;}
        if(url.pathname==="/api/me"&&req.method==="PATCH"){const input=await body(req);if(Object.keys(input).some(k=>k!=="name"))throw failure("BAD_REQUEST");const name=accountStore.updateProfile(session.user.id,input.name);json(res,200,{user:{id:session.user.id,email:session.user.email,name}});return;}
        if(url.pathname==="/api/me"&&req.method==="DELETE"){const input=await body(req);if(Object.keys(input).some(key=>key!=="password")||!await verifySessionPassword(auth,req,input.password)){json(res,403,{error:{code:"PASSWORD_INVALID",message:"Неверный пароль."}});return;}store.revokeWalkResearchAccess?.(accountStore.researchJobIds(session.user.id));accountStore.deleteAccountData(session.user.id);json(res,200,{success:true});return;}
        const accountQuery=()=>{const entries=[...url.searchParams];if(entries.some(([key,value])=>!['limit','cursor'].includes(key)||(key==='limit'&&!/^\d+$/.test(value)))||new Set(entries.map(([key])=>key)).size!==entries.length)throw failure('BAD_REQUEST');return {limit:Number(url.searchParams.get('limit')??20),after:url.searchParams.get('cursor')};};
        if(url.pathname==="/api/me/walks"&&req.method==="GET"){json(res,200,accountStore.listWalks(session.user.id,...Object.values(accountQuery())));return;}
        if(url.pathname==="/api/me/walks"&&req.method==="POST"){const input=await body(req,100000);json(res,201,{walk:accountStore.createWalk(session.user.id,input)});return;}
        const ownWalk=new RegExp(`^/api/me/walks/(${UUID})$`).exec(url.pathname);
        const ownWalkView=new RegExp(`^/api/me/walks/(${UUID})/view$`).exec(url.pathname);
        if(ownWalkView&&req.method==="GET"){
          const walk=accountStore.getWalk(session.user.id,ownWalkView[1]);
          if(!walk){json(res,404,{error:{code:"NOT_FOUND",message:"Прогулка не найдена."}});return;}
          if(walk.snapshotError){json(res,409,{error:{code:"INVALID_WALK",message:"Снимок прогулки повреждён. Скачайте исходную копию и восстановите её."}});return;}
          json(res,200,resolveWalkView(walk.snapshot,walk.revision,store));return;
        }
        const ownWalkSharing=new RegExp(`^/api/me/walks/(${UUID})/sharing$`).exec(url.pathname);
        if(ownWalkSharing&&req.method==="PUT"){const input=await body(req);if(Object.keys(input).some(key=>!["revision","enabled"].includes(key))){throw failure("BAD_REQUEST");}const walk=accountStore.setWalkSharing(session.user.id,ownWalkSharing[1],input.revision,input.enabled);json(res,walk?200:404,walk?{walk}:{error:{code:"NOT_FOUND",message:"Прогулка не найдена."}});return;}
        if(ownWalk&&req.method==="GET"){const walk=accountStore.getWalk(session.user.id,ownWalk[1]);json(res,walk?200:404,walk?{walk}:{error:{code:"NOT_FOUND",message:"Walk not found."}});return;}
        if(ownWalk&&req.method==="PATCH"){const walk=accountStore.updateWalk(session.user.id,ownWalk[1],await body(req,100000));json(res,walk?200:404,walk?{walk}:{error:{code:"NOT_FOUND",message:"Walk not found."}});return;}
        if(ownWalk&&req.method==="DELETE"){json(res,accountStore.deleteWalk(session.user.id,ownWalk[1])?200:404,{success:true});return;}
        if(url.pathname==="/api/me/requests"&&req.method==="GET"){json(res,200,accountStore.listRequests(session.user.id,...Object.values(accountQuery())));return;}
        if(url.pathname==="/api/me/favorites"&&req.method==="GET"){const data=accountStore.listFavorites(session.user.id,...Object.values(accountQuery()));json(res,200,{...data,favorites:data.favorites.map(item=>favoriteSummary(item,{userId:session.user.id,accountStore,store,routes:builtinRoutes}))});return;}
        if(url.pathname==="/api/me/import"&&req.method==="POST"){json(res,200,{result:accountStore.importLocal(session.user.id,await body(req,110000))});return;}
        const favorite=/^\/api\/me\/favorites\/(story|walk)\/([a-zA-Z0-9-]{1,128})$/.exec(url.pathname);
        if(favorite&&req.method==="PUT"){accountStore.setFavorite(session.user.id,favorite[1],favorite[2]);json(res,200,{success:true});return;}
        if(favorite&&req.method==="DELETE"){accountStore.deleteFavorite(session.user.id,favorite[1],favorite[2]);json(res,200,{success:true});return;}
        json(res,404,{error:{code:"NOT_FOUND",message:"Account endpoint not found."}});return;
      }
      if(url.pathname==="/api/worker/v1/claim"||url.pathname.startsWith("/api/worker/v1/jobs/")) {
        if(localTts.transport==="http"){json(res,503,{error:{code:"WORKER_DISABLED",message:"HTTP TTS transport is active."}});return;}
        const rawToken=typeof req.headers.authorization==="string"&&req.headers.authorization.startsWith("Bearer ")?req.headers.authorization.slice(7):"";
        const credential=store.authenticateWorkerToken(rawToken);
        if(!sameSecret(workerToken,rawToken)&&!credential){res.setHeader("WWW-Authenticate","Bearer");json(res,401,{error:{code:"UNAUTHORIZED",message:"Worker authentication required."}});return;}
        if(url.search)throw failure("BAD_REQUEST");
        const workerId=String(req.headers["x-worker-id"]??"");
        if(!workerId||workerId.length>100)throw failure("BAD_REQUEST");
        if(req.method==="POST"&&url.pathname==="/api/worker/v1/claim") {
          const input=await body(req,4096);
          if(Object.keys(input).some(key=>!["requestId","profileIds","textPreparationVersions","version"].includes(key))
            ||!Array.isArray(input.profileIds)||!input.profileIds.length||input.profileIds.length>20||input.profileIds.some(profile=>typeof profile!=="string"))throw failure("BAD_REQUEST");
          const profileIds=credential?input.profileIds.filter(profile=>credential.profiles.includes(profile)):input.profileIds;
          if(!profileIds.length){json(res,403,{error:{code:"FORBIDDEN",message:"Worker profile not permitted."}});return;}
          store.recordWorkerHeartbeat({credentialId:credential?.id??"static",workerName:workerId,version:input.version,profileIds});
          const job=store.claimExternalAudio({workerId:credential?`${credential.id}:${workerId}`:workerId,requestId:input.requestId,profileIds,textPreparationVersions:input.textPreparationVersions??[]});
          if(!job){res.writeHead(204,{"Cache-Control":"no-store","Retry-After":"10"});res.end();return;}
          json(res,200,{job});return;
        }
        const workerMatch=new RegExp(`^/api/worker/v1/jobs/(${UUID})(?:/(heartbeat|fail|result))?$`).exec(url.pathname);
        if(!workerMatch){json(res,404,{error:{code:"NOT_FOUND",message:"Worker endpoint not found."}});return;}
        if(req.method==="GET"&&!workerMatch[2]){const job=store.getExternalAudio(workerMatch[1]);
          const visible=job&&(!credential||job.workerId===`${credential.id}:${workerId}`);
          json(res,visible?200:404,visible?{job}:{error:{code:"NOT_FOUND",message:"Job not found."}});return;}
        const effectiveWorkerId=credential?`${credential.id}:${workerId}`:workerId;
        const generation=Number(req.headers["x-lease-generation"]),leaseToken=String(req.headers["x-lease-token"]??"");
        if(!Number.isSafeInteger(generation)||generation<1||!leaseToken)throw failure("BAD_REQUEST");
        if(req.method==="POST"&&workerMatch[2]==="heartbeat") {
          const progress=req.headers["content-length"]!=="0"&&req.headers["content-length"]!==undefined?await body(req,1024):null;
          if(progress&&(Object.keys(progress).some(key=>!["stage","percent"].includes(key))||(progress.stage!==undefined&&(typeof progress.stage!=="string"||progress.stage.length>40))||(progress.percent!==undefined&&(!Number.isFinite(progress.percent)||progress.percent<0||progress.percent>100))))throw failure("BAD_REQUEST");
          json(res,200,{job:store.heartbeatExternalAudio(workerMatch[1],{workerId:effectiveWorkerId,generation,leaseToken,progress})});return;
        }
        if(req.method==="POST"&&workerMatch[2]==="fail") {
          const input=await body(req,2048);
          if(Object.keys(input).some(key=>!["failureId","code","message"].includes(key)))throw failure("BAD_REQUEST");
          json(res,200,{job:store.failExternalAudio(workerMatch[1],{workerId:effectiveWorkerId,generation,leaseToken,failureId:input.failureId,code:input.code,message:input.message})});return;
        }
        if(req.method==="PUT"&&workerMatch[2]==="result") {
          const uploadId=String(req.headers["x-upload-id"]??""),expected=String(req.headers["x-content-sha256"]??"");
          const accepted=store.getExternalAudio(workerMatch[1]);
          if(accepted?.receipt?.uploadId===uploadId){if(accepted.receipt.uploadSha256!==expected)throw failure("CONFLICT");json(res,200,{job:accepted});return;}
          store.validateExternalAudioLease(workerMatch[1],{workerId:effectiveWorkerId,generation,leaseToken});
          const expectedProfile=store.getExternalAudio(workerMatch[1])?.profile;
          const preparationVersion=String(req.headers["x-tts-preparation-version"]??""),configSha256=String(req.headers["x-tts-config-sha256"]??"");
          if(expectedProfile?.textPreparation?.version&&preparationVersion!==expectedProfile.textPreparation.version)throw failure("BAD_REQUEST");
          if(expectedProfile?.configSha256&&configSha256!==expectedProfile.configSha256)throw failure("BAD_REQUEST");
          if(expectedProfile?.modelSha256&&String(req.headers["x-tts-model-sha256"]??"")!==expectedProfile.modelSha256)throw failure("BAD_REQUEST");
          if(expectedProfile?.speaker&&String(req.headers["x-tts-voice"]??"")!==expectedProfile.speaker)throw failure("BAD_REQUEST");
          const uploaded=await audioIngest(req,audioDirectory,{expectedUploadSha256:expected});
          if(uploaded.uploadSha256!==expected)throw failure("AUDIO_CHECKSUM");
          const artifact={...uploaded.artifact,model:String(req.headers["x-tts-model"]??"external").slice(0,100),voice:String(req.headers["x-tts-voice"]??"external").slice(0,64),
            ...(preparationVersion?{preparationVersion,preparedTextSha256:String(req.headers["x-tts-prepared-text-sha256"]??"")||null}:{}),...(configSha256?{configSha256}:{})};
          try {json(res,200,{job:store.acceptExternalAudio(workerMatch[1],{workerId:effectiveWorkerId,generation,leaseToken,uploadId,uploadSha256:expected,artifact})});}
          catch(error){throw error;}
          return;
        }
        json(res,405,{error:{code:"METHOD_NOT_ALLOWED",message:"Method not allowed."}});return;
      }
      const researchMatch=new RegExp(`^/api/walk-research-jobs(?:/(${UUID})(/retry)?)?$`).exec(url.pathname);
      if(researchMatch) {
        if(auth&&(!session||!accountStore)){json(res,401,{error:{code:"UNAUTHORIZED",message:"Войдите, чтобы исследовать прогулку."}});return;}
        let job;
        if(req.method==="GET"&&!researchMatch[2]) {
          if(researchMatch[1]) {
            if(auth&&!accountStore.ownsRequest(session.user.id,researchMatch[1])){json(res,404,{error:{code:"NOT_FOUND",message:"Walk research job not found."}});return;}
            if(url.search)throw failure("BAD_REQUEST");
            job=store.get(researchMatch[1]);
            if(job?.kind!=="walk_research")job=null;
          } else {
            const entries=[...url.searchParams];
            if(![5,7].includes(entries.length)||new Set(entries.map(([k])=>k)).size!==entries.length||entries.some(([k,v])=>!["lat","lon","mode","minutes","recoveryToken","destinationLat","destinationLon"].includes(k)||!v.trim()))throw failure("BAD_REQUEST");
            const q=Object.fromEntries(entries);
            if(!/^(30|60|90)$/.test(q.minutes)||![q.lat,q.lon].every(v=>/^-?\d+(?:\.\d+)?$/.test(v)))throw failure("BAD_REQUEST");
            if ((q.destinationLat === undefined) !== (q.destinationLon === undefined) || (q.destinationLat !== undefined && ![q.destinationLat,q.destinationLon].every(v=>/^-?\d+(?:\.\d+)?$/.test(v)))) throw failure("BAD_REQUEST");
            const request=validateWalkResearch({start:{location:{lat:Number(q.lat),lon:Number(q.lon)}},mode:q.mode,minutes:Number(q.minutes),...(q.destinationLat?{destination:{location:{lat:Number(q.destinationLat),lon:Number(q.destinationLon)}}}:{})},true);
            job=store.lookupWalkResearch(request,q.recoveryToken);
            if(auth&&job&&!accountStore.ownsRequest(session.user.id,job.id)) {
              if(!accountStore.beginGeneration){accountStore.attachRequest(session.user.id,job.id,"walk_research",q.recoveryToken);}
              else {
              const intent=accountStore.beginGeneration(session.user.id,q.recoveryToken,"walk_research",walkResearchKey(request),0,Number(process.env.USER_DAILY_GENERATION_LIMIT??6));
              if(intent.jobId&&intent.jobId!==job.id)throw failure("CONFLICT");
              accountStore.completeGeneration(session.user.id,q.recoveryToken,job.id);
              }
            }
          }
        } else if(req.method==="POST"&&(!researchMatch[1]||researchMatch[2])) {
          if(!origin||req.headers.origin!==origin||![undefined,"same-origin","none"].includes(req.headers["sec-fetch-site"])) {json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          if(url.search)throw failure("BAD_REQUEST");
          const input=await body(req);
          if(researchMatch[2]) {
            if(auth&&!accountStore.ownsRequest(session.user.id,researchMatch[1])){json(res,404,{error:{code:"NOT_FOUND",message:"Walk research job not found."}});return;}
            if(Object.keys(input).length!==1||!Number.isSafeInteger(input.revision)||input.revision<0)throw failure("BAD_REQUEST");
            if(!provider){json(res,503,{error:{code:"PROVIDER_UNAVAILABLE",message:"Story provider unavailable."}});return;}
            const quotaKey=`walk-retry-${researchMatch[1]}-${input.revision}`;if(auth)accountStore.reserveGeneration(session.user.id,quotaKey,3,Number(process.env.USER_DAILY_GENERATION_LIMIT??6));
            try{job=store.retryWalkResearch(researchMatch[1],input.revision);}catch(error){if(auth)accountStore.releaseGeneration(session.user.id,quotaKey);throw error;}
          } else {
            const request=validateWalkResearch(input),existing=store.lookupWalkResearch(request,input.recoveryToken);
            const intent=auth&&accountStore.beginGeneration?accountStore.beginGeneration(session.user.id,input.recoveryToken,"walk_research",walkResearchKey(request),existing?0:3,Number(process.env.USER_DAILY_GENERATION_LIMIT??6)):null;
            if(auth&&!accountStore.beginGeneration&&!existing)accountStore.reserveGeneration(session.user.id,input.recoveryToken,3,Number(process.env.USER_DAILY_GENERATION_LIMIT??6));
            try {job=intent?.jobId?store.get(intent.jobId):store.createWalkResearch(input,{allowCreate:Boolean(provider)});if(auth&&job){if(accountStore.completeGeneration)accountStore.completeGeneration(session.user.id,input.recoveryToken,job.id);else accountStore.attachRequest(session.user.id,job.id,"walk_research",input.recoveryToken);}}
            catch(error) {
              if(auth&&!intent?.jobId){if(accountStore.cancelGeneration)accountStore.cancelGeneration(session.user.id,input.recoveryToken);else if(!existing)accountStore.releaseGeneration(session.user.id,input.recoveryToken);}
              if(error.code!=="PROVIDER_UNAVAILABLE")throw error;
              json(res,503,{error:{code:"PROVIDER_UNAVAILABLE",message:"Story provider unavailable."}});return;
            }
          }
        } else {json(res,405,{error:{code:"METHOD_NOT_ALLOWED",message:"Method not allowed."}});return;}
        json(res,job?200:404,job?publicWalkResearch(job):{error:{code:"NOT_FOUND",message:"Walk research job not found."}});
        if(req.method==="POST")worker?.wake();
        return;
      }
      if(url.pathname==="/api/story-admin"||url.pathname.startsWith("/api/story-admin/")) {
        const roleAuthorized=session?.user?.role==="editor";
        const status=roleAuthorized?200:legacyAdminEnabled?authorizeAdmin(req.headers.authorization):401;
        if(status!==200) {
          if(status===429)res.setHeader("Retry-After","60");
          if(status===401)res.setHeader("WWW-Authenticate","Bearer");
          json(res,status,{error:{code:status===429?"ADMIN_THROTTLED":"UNAUTHORIZED",message:"Admin authentication required."}});return;
        }
        if(roleAuthorized&&!["GET","HEAD"].includes(req.method)&&!validSessionCsrf(authSecret,session.session.id,req.headers["x-csrf-token"])) {json(res,403,{error:{code:"CSRF",message:"Refresh the editor and retry."}});return;}
        if(req.method==="GET"&&url.pathname==="/api/story-admin/walks") {
          const entries=[...url.searchParams];
          if(entries.some(([key,value])=>!["limit","offset"].includes(key)||!/^\d+$/.test(value))||new Set(entries.map(([key])=>key)).size!==entries.length)throw failure("BAD_REQUEST");
          json(res,200,store.listWalksAdmin({limit:Number(url.searchParams.get("limit")??50),offset:Number(url.searchParams.get("offset")??0)}));return;
        }
        if(req.method==="GET"&&url.pathname==="/api/story-admin/content/places") {
          const entries=[...url.searchParams];if(entries.some(([key,value])=>!["limit","offset","q","status"].includes(key)||(["limit","offset"].includes(key)&&!/^\d+$/.test(value))))throw failure("BAD_REQUEST");
          json(res,200,store.listPlaces({limit:Number(url.searchParams.get("limit")??50),offset:Number(url.searchParams.get("offset")??0),q:url.searchParams.get("q")??"",status:url.searchParams.get("status")??"all"}));return;
        }
        if(req.method==="GET"&&url.pathname==="/api/story-admin/content/batches") {if(url.search)throw failure("BAD_REQUEST");json(res,200,{batches:store.listBatches()});return;}
        if(req.method==="GET"&&url.pathname==="/api/story-admin/content/stats") {if(url.search)throw failure("BAD_REQUEST");json(res,200,{...store.getContentStats(),audioQueue:store.getExternalAudioStats()});return;}
        if(req.method==="GET"&&url.pathname==="/api/story-admin/content/audio") {
          const entries=[...url.searchParams];if(entries.some(([key,value])=>key!=="state"||!value)||entries.length>1)throw failure("BAD_REQUEST");
          const states=(url.searchParams.get("state")??"failed,cancelled").split(",");json(res,200,{audioJobs:store.listExternalAudio({states})});return;
        }
        if(req.method==="POST"&&url.pathname==="/api/story-admin/content/audio/bulk") {
          if(!origin||req.headers.origin!==origin){json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const input=await body(req,4096);
          if(Object.keys(input).some(key=>!["profileId","limit"].includes(key)))throw failure("BAD_REQUEST");
          const result=await store.enqueueMissingPlaceAudio({profileId:input.profileId??localTts.defaultProfile,limit:input.limit??500});
          json(res,200,result);return;
        }
        if(req.method==="GET"&&url.pathname==="/api/story-admin/content/workers") {if(url.search)throw failure("BAD_REQUEST");json(res,200,{transport:localTts.transport,workers:store.listWorkerCredentials(),heartbeats:store.listWorkerHeartbeats()});return;}
        if(req.method==="POST"&&url.pathname==="/api/story-admin/content/workers") {if(localTts.transport==="http"){json(res,503,{error:{code:"WORKER_DISABLED",message:"HTTP TTS transport is active."}});return;}if(!origin||req.headers.origin!==origin){json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          json(res,201,{worker:store.createWorkerCredential(await body(req,4096))});return;}
        const revokeWorker=new RegExp(`^/api/story-admin/content/workers/(${UUID})/revoke$`).exec(url.pathname);
        if(revokeWorker&&req.method==="POST"){if(!origin||req.headers.origin!==origin){json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const revoked=store.revokeWorkerCredential(revokeWorker[1]);json(res,revoked?200:404,revoked?{worker:revoked}:{error:{code:"NOT_FOUND",message:"Worker not found."}});return;}
        if(req.method==="POST"&&url.pathname==="/api/story-admin/content/batches") {
          if(!origin||req.headers.origin!==origin) {json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const input=await body(req,65536);if(input.mode==="text-and-audio"&&!input.ttsProfile)input.ttsProfile=localTts.defaultProfile;
          let batch;
          try{batch=store.createBatch(input);}
          catch(error){if(error.code!=="NO_ELIGIBLE_PLACES")throw error;
            json(res,409,{error:{code:error.code,message:"Все места, прошедшие проверку пригодности, уже поставлены в очередь."}});return;}
          json(res,200,{batch});contentWorker?.wake();return;
        }
        if(req.method==="GET"&&url.pathname==="/api/story-admin/content/identity-candidates") {
          const entries=[...url.searchParams];
          if(entries.some(([key,value])=>!["tier","category","q","queue","limit","offset"].includes(key)||(["limit","offset"].includes(key)&&!/^\d+$/.test(value)))||new Set(entries.map(([key])=>key)).size!==entries.length)throw failure("BAD_REQUEST");
          json(res,200,store.listIdentityCandidates({tier:url.searchParams.get("tier")??"all",category:url.searchParams.get("category")??"all",q:url.searchParams.get("q")??"",
            queue:url.searchParams.get("queue")??"all",limit:Number(url.searchParams.get("limit")??50),offset:Number(url.searchParams.get("offset")??0)}));return;
        }
        if(req.method==="POST"&&url.pathname==="/api/story-admin/content/identity-candidates/pilot") {
          if(!origin||req.headers.origin!==origin){json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const input=await body(req,4096);if(Object.keys(input).some(key=>!["requestKey","limit","mode"].includes(key)))throw failure("BAD_REQUEST");
          try{json(res,200,store.createIdentityPilot({requestKey:input.requestKey,limit:input.limit,mode:input.mode??"text-only",ttsProfile:localTts.defaultProfile}));}
          catch(error){if(error.code!=="NO_IDENTITY_CANDIDATES")throw error;
            json(res,409,{error:{code:error.code,message:"Нет кандидатов уровня «авто» без заданий. Пересчитайте оценку после обновления каталога."}});}
          return;
        }
        const batchItems=/^\/api\/story-admin\/content\/batches\/([a-f0-9-]+)\/items$/.exec(url.pathname);
        if(batchItems&&req.method==="GET"){
          const entries=[...url.searchParams];
          if(entries.some(([key,value])=>!["limit","offset","status","error"].includes(key)||(["limit","offset"].includes(key)&&!/^\d+$/.test(value)))||new Set(entries.map(([key])=>key)).size!==entries.length)throw failure("BAD_REQUEST");
          const page=store.listBatchItems(batchItems[1],{limit:Number(url.searchParams.get("limit")??50),offset:Number(url.searchParams.get("offset")??0),
            status:url.searchParams.get("status")??"all",error:url.searchParams.get("error")??"all"});
          json(res,page?200:404,page??{error:{code:"NOT_FOUND",message:"Batch not found."}});return;
        }
        const contentBatch=/^\/api\/story-admin\/content\/batches\/([a-f0-9-]+)(?:\/(pause|resume|cancel))?$/.exec(url.pathname);
        if(contentBatch&&req.method==="GET"&&!contentBatch[2]){const batch=store.getBatch(contentBatch[1]);json(res,batch?200:404,batch?{batch}:{error:{code:"NOT_FOUND",message:"Batch not found."}});return;}
        if(contentBatch&&req.method==="POST"&&contentBatch[2]){if(!origin||req.headers.origin!==origin){json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const state=contentBatch[2]==="pause"?"paused":contentBatch[2]==="resume"?"running":"cancelled";const batch=store.setBatchState(contentBatch[1],state);json(res,batch?200:404,batch?{batch}:{error:{code:"NOT_FOUND",message:"Batch not found."}});if(state==="running")contentWorker?.wake();return;}
        const prioritizeBatch=/^\/api\/story-admin\/content\/batches\/([a-f0-9-]+)\/priority$/.exec(url.pathname);
        if(prioritizeBatch&&req.method==="POST"){if(!origin||req.headers.origin!==origin){json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const input=await body(req,4096),batch=store.setBatchPriority(prioritizeBatch[1],input?.priority);json(res,batch?200:404,batch?{batch}:{error:{code:"NOT_FOUND",message:"Batch not found."}});contentWorker?.wake();return;}
        const retryContent=/^\/api\/story-admin\/content\/batches\/([a-f0-9-]+)\/items\/(osm:(?:node|way|relation):\d+)\/retry$/.exec(url.pathname);
        if(retryContent&&req.method==="POST"){if(!origin||req.headers.origin!==origin){json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const input=await body(req,1024),restartFrom=input.restartFrom??"auto";if(Object.keys(input).some(key=>key!=="restartFrom"))throw failure("BAD_REQUEST");
          const batch=store.retryBatchItem(retryContent[1],retryContent[2],{restartFrom});json(res,batch?200:404,batch?{batch}:{error:{code:"NOT_FOUND",message:"Batch item not found."}});contentWorker?.wake();return;}
        const contentPlace=/^\/api\/story-admin\/content\/places\/(osm:(?:node|way|relation):\d+)$/.exec(url.pathname);
        if(contentPlace&&req.method==="GET"){const place=store.getPlace(contentPlace[1]);json(res,place?200:404,place?{place}:{error:{code:"NOT_FOUND",message:"Place not found."}});return;}
        const approveContent=/^\/api\/story-admin\/content\/places\/(osm:(?:node|way|relation):\d+)\/approve$/.exec(url.pathname);
        if(approveContent&&req.method==="POST"){if(!origin||req.headers.origin!==origin){json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const input=await body(req,32768),place=store.approvePlaceText(approveContent[1],input?.story??null);
          if(place)for(const profileId of place.audioProfiles??[])await store.enqueueExternalAudio({sourceJobId:`place-text:${place.text.id}`,sourceRevision:0,story:{...place.text.story,address:place.address??place.name},profileId});
          json(res,place?200:404,place?{place}:{error:{code:"NOT_FOUND",message:"Place text not found."}});return;}
        const revoiceContent=/^\/api\/story-admin\/content\/places\/(osm:(?:node|way|relation):\d+)\/audio$/.exec(url.pathname);
        if(revoiceContent&&req.method==="POST"){if(!origin||req.headers.origin!==origin){json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const input=await body(req,4096),place=store.getPlace(revoiceContent[1]);
          if(!place?.text||place.text.verification!=="editorial"){json(res,404,{error:{code:"NOT_FOUND",message:"Approved place text not found."}});return;}
          const audioJob=await store.enqueueExternalAudio({sourceJobId:`place-text:${place.text.id}`,sourceRevision:0,story:{...place.text.story,address:place.address??place.name},profileId:input.profileId??localTts.defaultProfile});
          json(res,200,{place,audioJob});return;}
        const retryAudio=new RegExp(`^/api/story-admin/content/audio/(${UUID})/retry$`).exec(url.pathname);
        if(retryAudio&&req.method==="POST"){if(!origin||req.headers.origin!==origin){json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const audioJob=store.retryExternalAudio(retryAudio[1]);json(res,audioJob?200:404,audioJob?{audioJob}:{error:{code:"NOT_FOUND",message:"Failed audio job not found."}});return;}
        const walkRegenerateMatch=/^\/api\/story-admin\/walks\/([a-z0-9][a-z0-9-]{0,127})\/regenerate$/.exec(url.pathname);
        if(walkRegenerateMatch&&req.method==="POST") {
          if(url.search)throw failure("BAD_REQUEST");
          if(!origin||req.headers.origin!==origin||![undefined,"same-origin","none"].includes(req.headers["sec-fetch-site"])) {
            json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;
          }
          const input=await body(req,2048);
          if(Object.keys(input).some(key=>!["ttsProvider","ttsVoice"].includes(key)))throw failure("BAD_REQUEST");
          const selected=input.ttsProvider===undefined?"openai":input.ttsProvider;
          const options=ttsProviders.find(option=>option.id===selected);
          if(!options)throw failure("BAD_REQUEST");
          const voice=input.ttsVoice===undefined?options.defaultVoice:input.ttsVoice;
          if(!options.voices.some(option=>option.id===voice))throw failure("BAD_REQUEST");
          if(!speechProviders[selected]) {
            json(res,503,{error:{code:"TTS_UNAVAILABLE",message:"Selected speech provider unavailable."}});return;
          }
          const walk=store.regenerateWalkAdmin(walkRegenerateMatch[1],selected,voice);
          json(res,walk?200:404,walk?{walk:{...walk,ttsProviders}}:{error:{code:"NOT_FOUND",message:"Walk not found."}});
          if(walk)worker?.wake();
          return;
        }
        const walkMatch=/^\/api\/story-admin\/walks\/([a-z0-9][a-z0-9-]{0,127})(?:\/chapters\/([a-z0-9][a-z0-9-]{0,127})\/(edit|revoice))?$/.exec(url.pathname);
        if(walkMatch&&((req.method==="GET"&&!walkMatch[2])||(req.method==="POST"&&walkMatch[2]))) {
          if(url.search)throw failure("BAD_REQUEST");
          let walk=store.getWalkAdmin(walkMatch[1]);
          if(req.method==="POST") {
            if(!origin||req.headers.origin!==origin||![undefined,"same-origin","none"].includes(req.headers["sec-fetch-site"])) {
              json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;
            }
            const input=await body(req,walkMatch[3]==="edit"?65536:2048);
            if(!Number.isSafeInteger(input.revision)||input.revision<0||Object.keys(input).some(key=>!["revision",...(walkMatch[3]==="edit"?["draft"]:["ttsProvider","ttsVoice"])].includes(key)))throw failure("BAD_REQUEST");
            if(!walk||!walk.chapters.some(chapter=>chapter.id===walkMatch[2])) {
              json(res,404,{error:{code:"NOT_FOUND",message:"Walk chapter not found."}});return;
            }
            if(walkMatch[3]==="edit") store.saveWalkChapterAdmin(walkMatch[1],walkMatch[2],input.revision,input.draft);
            else {
              const selected=input.ttsProvider===undefined?"openai":input.ttsProvider;
              const options=ttsProviders.find(option=>option.id===selected);
              if(!options)throw failure("BAD_REQUEST");
              const voice=input.ttsVoice===undefined?options.defaultVoice:input.ttsVoice;
              if(!options.voices.some(option=>option.id===voice))throw failure("BAD_REQUEST");
              if(!speechProviders[selected]) {
                json(res,503,{error:{code:"TTS_UNAVAILABLE",message:"Selected speech provider unavailable."}});return;
              }
              store.revoiceWalkChapterAdmin(walkMatch[1],walkMatch[2],input.revision,selected,voice);
            }
            walk=store.getWalkAdmin(walkMatch[1]);
          }
          json(res,walk?200:404,walk?{walk:{...walk,ttsProviders}}:{error:{code:"NOT_FOUND",message:"Walk not found."}});
          if(req.method==="POST"&&walkMatch[3]==="revoice")worker?.wake();
          return;
        }
        if(req.method==="GET"&&url.pathname==="/api/story-admin/jobs") {
          const entries=[...url.searchParams];
          if(entries.some(([key,value])=>!["limit","offset","q","stage","relevance"].includes(key)||(["limit","offset"].includes(key)&&!/^\d+$/.test(value)))||new Set(entries.map(([key])=>key)).size!==entries.length)throw failure("BAD_REQUEST");
          const result=store.listAdmin({limit:Number(url.searchParams.get("limit")??50),offset:Number(url.searchParams.get("offset")??0),q:url.searchParams.get("q")??"",stage:url.searchParams.get("stage")??"",relevance:url.searchParams.get("relevance")??"active"});
          json(res,200,{jobs:result.jobs.map(job=>adminSummary(job,safeError)),hasMore:result.hasMore});return;
        }
        const match=new RegExp(`^/api/story-admin/jobs/(${UUID})(?:/(edit|approve|relevance|revoice|retry|regenerate|external-audio))?$`).exec(url.pathname);
        if(match&&((req.method==="GET"&&!match[2])||(req.method==="POST"&&match[2]))) {
          let job;
          if(req.method==="GET") {job=store.get(match[1]);if(job&&(job.kind??"address")!=="address")job=null;}
          else {
            if(!origin||req.headers.origin!==origin||![undefined,"same-origin","none"].includes(req.headers["sec-fetch-site"])) {
              json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;
            }
            const input=await body(req,match[2]==="edit"?32768:2048);
            const allowed=match[2]==="edit"?["revision","draft"]:match[2]==="relevance"?["revision","irrelevant"]:match[2]==="external-audio"?["revision","profileId"]:["revision","ttsProvider","ttsVoice"];
            if(!Number.isSafeInteger(input.revision)||input.revision<0||Object.keys(input).some(key=>!allowed.includes(key)))throw failure("BAD_REQUEST");
            if(match[2]==="relevance") {
              job=store.setRelevanceAdmin(match[1],input.revision,input.irrelevant);
            } else if(match[2]==="edit") {
              const draft=input.draft;
              if(!draft||typeof draft!=="object"||Array.isArray(draft)||Object.keys(draft).some(key=>!["title","paragraphs"].includes(key))||!Array.isArray(draft.paragraphs)||draft.paragraphs.some(p=>!p||typeof p!=="object"||Array.isArray(p)||Object.keys(p).some(key=>!["text","factIds"].includes(key))))throw failure("BAD_REQUEST");
              job=store.editAdmin(match[1],input.revision,draft);
            } else if(match[2]==="external-audio") {
              const source=store.get(match[1]);
              if(!source||source.revision!==input.revision){job=null;}
              else {const audioJob=await store.enqueueExternalAudio({sourceJobId:source.id,sourceRevision:source.revision,story:source.data?.story,profileId:input.profileId??localTts.defaultProfile});json(res,200,{job:adminDetail(source,Boolean(provider||yandexTts),safeError,ttsProviders,Boolean(provider)),audioJob});return;}
            } else {
              const selected=input.ttsProvider===undefined?"openai":input.ttsProvider;
              if(!["openai","yandex"].includes(selected))throw failure("BAD_REQUEST");
              const options=ttsProviders.find(option=>option.id===selected);
              const voice=input.ttsVoice===undefined?options.defaultVoice:input.ttsVoice;
              if(!options.voices.some(option=>option.id===voice))throw failure("BAD_REQUEST");
              if((match[2]==="regenerate"&&!provider)||(match[2]==="retry"&&!provider&&!store.get(match[1])?.data.story)){json(res,503,{error:{code:"PROVIDER_UNAVAILABLE",message:"Story provider unavailable."}});return;}
              if(!speechProviders[selected]){json(res,503,{error:{code:"TTS_UNAVAILABLE",message:"Selected speech provider unavailable."}});return;}
              job=match[2]==="revoice"?store.revoiceAdmin(match[1],input.revision,selected,voice):match[2]==="retry"?store.retryAdmin(match[1],input.revision,selected,voice):match[2]==="regenerate"?store.regenerateAdmin(match[1],input.revision,selected,voice):store.approveAdmin(match[1],input.revision,selected,voice);
            }
          }
          json(res,job?200:404,job?{job:adminDetail(job,Boolean(provider||yandexTts),safeError,ttsProviders,Boolean(provider))}:{error:{code:"NOT_FOUND",message:"Job not found."}});
          if(req.method==="POST"&&["approve","revoice","retry","regenerate"].includes(match[2]))worker?.wake();
          return;
        }
        json(res,404,{error:{code:"NOT_FOUND",message:"Admin endpoint not found."}});return;
      }
      if(req.method==="GET"&&url.pathname==="/api/story-service") {json(res,200,{enabled:Boolean(provider),version:1});return;}
      if(req.method==="GET"&&url.pathname==="/api/content/places") {
        const entries=[...url.searchParams],allowed=["limit","offset","q","status","lat","lon","radius"];
        if(entries.some(([key,value])=>!allowed.includes(key)||(["limit","offset"].includes(key)&&!/^\d+$/.test(value)))||new Set(entries.map(([key])=>key)).size!==entries.length)throw failure("BAD_REQUEST");
        const nearby=url.searchParams.has("lat")||url.searchParams.has("lon")||url.searchParams.has("radius");
        json(res,200,store.listPlaces({limit:Number(url.searchParams.get("limit")??50),offset:Number(url.searchParams.get("offset")??0),q:url.searchParams.get("q")??"",status:url.searchParams.get("status")??"ready",
          lat:nearby?Number(url.searchParams.get("lat")):null,lon:nearby?Number(url.searchParams.get("lon")):null,radius:nearby?Number(url.searchParams.get("radius")):null}));return;
      }
      const publicPlace=/^\/api\/content\/places\/(osm:(?:node|way|relation):\d+)$/.exec(url.pathname);
      if(req.method==="GET"&&publicPlace){const place=store.getPublishedPlace(publicPlace[1]);json(res,place?200:404,place?{place}:{error:{code:"NOT_FOUND",message:"Place text not found."}});return;}
      const publishedWalk=/^\/api\/story-walks\/([a-z0-9][a-z0-9-]{0,127})$/.exec(url.pathname);
      if(req.method==="GET"&&url.pathname==="/api/story-walks"){json(res,200,{walks:builtinRoutes.filter(route=>route.walk?.steps?.length).map(route=>({id:route.id,title:route.title,subtitle:route.subtitle,durationMin:route.duration_min}))});return;}
      const sharedWalk=new RegExp(`^/api/story-walks/shared/(${UUID})$`).exec(url.pathname);
      if(req.method==="GET"&&sharedWalk){
        const walk=accountStore?.getSharedWalk(sharedWalk[1]);
        if(!walk||walk.snapshotError){json(res,404,{error:{code:"NOT_FOUND",message:"Прогулка не найдена."}});return;}
        json(res,200,resolveWalkView(walk.snapshot,walk.revision,store));return;
      }
      const catalogView=/^\/api\/story-walks\/([a-z0-9][a-z0-9-]{0,127})\/view$/.exec(url.pathname);
      if(req.method==="GET"&&catalogView){const route=store.getPublishedWalk(catalogView[1]);json(res,route?200:404,route?catalogWalkView(route):{error:{code:"NOT_FOUND",message:"Прогулка не найдена."}});return;}
      if(req.method==="GET"&&publishedWalk) {
        const route=store.getPublishedWalk(publishedWalk[1]);
        json(res,route?200:404,route??{error:{code:"NOT_FOUND",message:"Walk not found."}});return;
      }
      if(req.method==="GET"&&url.pathname==="/api/story-place") {
        try {
          const entries=[...url.searchParams.entries()];
          if(new Set(entries.map(([key])=>key)).size!==entries.length)throw Object.assign(new Error(),{code:"PLACE_INVALID"});
          const input=Object.fromEntries(entries.map(([key,value])=>[key,["lat","lon"].includes(key)?(value.trim()?Number(value):NaN):value]));
          json(res,200,await resolvePlace(input));
        }catch(error){
          const messages={PLACE_INVALID:"Выберите дом в Москве или введите адрес.",PLACE_BUSY:"Поиск занят. Повторите через пару секунд.",PLACE_NOT_FOUND:"Не удалось определить дом. Уточните адрес вручную.",PLACE_UNAVAILABLE:"Поиск адреса временно недоступен. Адрес можно ввести вручную."};
          const code=Object.hasOwn(messages,error.code)?error.code:"PLACE_UNAVAILABLE";
          if(code==="PLACE_BUSY")res.setHeader("Retry-After","2");
          json(res,{PLACE_INVALID:400,PLACE_BUSY:429,PLACE_NOT_FOUND:404,PLACE_UNAVAILABLE:503}[code],{error:{code,message:messages[code]}});
        }
        return;
      }
      if(req.method==="POST") {
        if(req.headers.origin!==origin||![undefined,"same-origin","none"].includes(req.headers["sec-fetch-site"])) {json(res,403,{error:{message:"Откройте подготовку истории на сайте."}});return;}
        if(url.pathname==="/api/walk-plan") {
          try {json(res,200,await walkPlanner(await body(req,8192)));}
          catch(error) {
            const messages={WALK_INVALID:"Проверьте начало, остановки и параметры прогулки.",WALK_BUSY:"Планировщик занят. Повторите через пару секунд.",WALK_NOT_FOUND:"Не удалось построить пешеходную прогулку в выбранное время. Измените точки или длительность.",WALK_STOPS_NOT_FOUND:"Рядом со стартом недостаточно достопримечательностей в каталоге. Добавьте остановки вручную или выберите другое начало прогулки.",WALK_DISCOVERY_UNAVAILABLE:"Не удалось автоматически подобрать остановки. Попробуйте позже или добавьте остановки вручную.",WALK_UNAVAILABLE:"Пешеходный маршрутизатор временно недоступен. Попробуйте позже."};
            const code=error.code==="BAD_REQUEST"?"WALK_INVALID":Object.hasOwn(messages,error.code)?error.code:"WALK_UNAVAILABLE";
            if(code==="WALK_BUSY")res.setHeader("Retry-After","2");
            json(res,{WALK_INVALID:400,WALK_BUSY:429,WALK_NOT_FOUND:404,WALK_STOPS_NOT_FOUND:404,WALK_DISCOVERY_UNAVAILABLE:503,WALK_UNAVAILABLE:503}[code],{error:{code,message:messages[code]}});
          }
          return;
        }
        if(!provider) {json(res,503,{error:{message:"Подготовка историй пока недоступна."}});return;}
        const input=await body(req);
        if(url.pathname==="/api/story-jobs") {
          if(!session||!accountStore){json(res,401,{error:{code:"UNAUTHORIZED",message:"Войдите, чтобы подготовить историю."}});return;}
          if(Object.keys(input).some((key)=>!["address","idempotencyKey"].includes(key))||typeof input.idempotencyKey!=="string")throw failure("BAD_REQUEST");
          const address=normalizeAddress(input.address),key=addressKey(address),existing=store.getByKey?.(key)??null;
          const intent=accountStore.beginGeneration?accountStore.beginGeneration(session.user.id,input.idempotencyKey,"create",key,existing?0:1,Number(process.env.USER_DAILY_GENERATION_LIMIT??6)):{created:true,jobId:null};
          if(!accountStore.beginGeneration&&!existing)accountStore.reserveGeneration?.(session.user.id,input.idempotencyKey,1,Number(process.env.USER_DAILY_GENERATION_LIMIT??6));
          let job;try{job=intent.jobId?store.get(intent.jobId):store.createOrGet({key,address});if(!job)throw failure("CONFLICT");if(accountStore.completeGeneration)accountStore.completeGeneration(session.user.id,input.idempotencyKey,job.id);else accountStore.attachRequest(session.user.id,job.id,"create",input.idempotencyKey);}
          catch(error){if(!intent.jobId){if(accountStore.cancelGeneration)accountStore.cancelGeneration(session.user.id,input.idempotencyKey);else if(!existing)accountStore.releaseGeneration?.(session.user.id,input.idempotencyKey);}throw error;}
          json(res,200,publicJob(job));worker?.wake();return;
        }
        const retry=new RegExp(`^/api/story-jobs/(${UUID})/retry$`).exec(url.pathname);
        if(retry) {
          if(!session||!accountStore||!accountStore.ownsRequest(session.user.id,retry[1])){json(res,404,{error:{code:"NOT_FOUND",message:"Задание не найдено."}});return;}
          if(!Number.isInteger(input.revision)||Object.keys(input).some((key)=>key!=="revision"))throw failure("BAD_REQUEST");
          const quotaKey=`retry-${retry[1]}-${input.revision}`;accountStore.reserveGeneration?.(session.user.id,quotaKey,1,Number(process.env.USER_DAILY_GENERATION_LIMIT??6));
          let job;try{job=store.retry(retry[1],input.revision);}catch(error){accountStore.releaseGeneration?.(session.user.id,quotaKey);throw error;}
          if(!job){json(res,404,{error:{message:"Задание не найдено."}});return;}
          json(res,200,publicJob(job));worker?.wake();return;
        }
      }
      const match=new RegExp(`^/api/story-jobs/(${UUID})$`).exec(url.pathname);
      if(req.method==="GET"&&match) {
        const storedJob=store.get(match[1]);
        const job=storedJob&&(storedJob.kind??"address")!=="address"?null:storedJob;
        json(res,job?200:404,job?publicJob(job):{error:{message:"Задание не найдено."}});return;
      }
      const audio=/^\/api\/story-audio\/([a-f0-9]{64}\.mp3)$/.exec(url.pathname);
      if(["GET","HEAD"].includes(req.method)&&audio) {await sendFile(req,res,join(audioDirectory,audio[1]),"audio/mpeg",true);return;}
      // Local production preview only; deployed frontend remains in Nginx.
      if(staticDirectory&&["GET","HEAD"].includes(req.method)&&!url.pathname.startsWith("/api/")) {
        const root=resolve(staticDirectory);const relative=decodeURIComponent(url.pathname).replace(/^\/+/,"")||"index.html";
        let file=resolve(root,relative);
        if(!file.startsWith(root+sep)){json(res,404,{});return;}
        if(!extname(file)) file+=".html";
        const types={".html":"text/html; charset=utf-8",".js":"application/javascript",".css":"text/css",".json":"application/json",".txt":"text/plain",".svg":"image/svg+xml",".woff2":"font/woff2",".ico":"image/x-icon",".mp3":"audio/mpeg",".webmanifest":"application/manifest+json"};
        await sendFile(req,res,file,types[extname(file)]??"application/octet-stream");return;
      }
      json(res,404,{error:{message:"Страница не найдена."}});
    } catch(error) {
      if(res.headersSent||res.destroyed)return;
      const status=["QUEUE_FULL","DAILY_LIMIT","QUOTA_EXCEEDED","UPLOAD_BUSY"].includes(error.code)?429:error.code==="AUDIO_STORAGE_FULL"?507:["CONFLICT","RETRY_LIMIT","LEASE_LOST","CLAIM_EXPIRED","WORKER_BUSY"].includes(error.code)?409:
        error.code==="AUDIO_TOO_LARGE"?413:["BAD_AUDIO_TYPE","BAD_AUDIO","AUDIO_CHECKSUM","AUDIO_DURATION"].includes(error.code)?422:["INVALID_ADDRESS","BAD_REQUEST","INVALID_DRAFT"].includes(error.code)?400:500;
      if(status===500) logs?.captureException(error,{operation:"API request",context:{method:req.method,status}});
      json(res,status,{error:["BAD_REQUEST","INVALID_DRAFT"].includes(error.code)?{code:error.code,message:"Invalid request or draft."}:safeError(error)});
    }
  });
  server.requestTimeout=310000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  return {server,close:async()=>{await Promise.all([worker?.stop(),contentWorker?.stop(),ttsApiWorker?.stop()]);osmGeocoder?.close();await new Promise((done)=>server.close(done));server.closeAllConnections();await closeAuth();}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const directory=resolve(process.env.DATA_DIR??"backend/data");
  const localTts=loadLocalTtsConfig(process.env);
  const ttsApiClient=localTts.transport==="http"?createTtsApiClient({baseUrl:process.env.TTS_API_URL,token:process.env.TTS_API_TOKEN}):null;
  const store=createStore(join(directory,"jobs.sqlite"),{maxDaily:Number(process.env.MAX_DAILY_JOBS??6),maxActive:2,workerLeaseSecret:workerLeaseSecret({transport:localTts.transport}),normalizeExternalText:normalizeForSpeech,externalTtsProfiles:localTts.profiles});
  store.recoverInterrupted();
  store.recoverContentJobs();
  const provider=process.env.OPENAI_API_KEY&&process.env.OPENAI_BASE_URL?createProvider({apiKey:process.env.OPENAI_API_KEY,baseUrl:process.env.OPENAI_BASE_URL,model:process.env.STORY_MODEL,writerModel:process.env.WRITER_MODEL}):null;
  const yandexTts=process.env.YANDEX_TTS_API_KEY?createYandexTts({apiKey:process.env.YANDEX_TTS_API_KEY,voice:process.env.YANDEX_TTS_VOICE||"marina"}):null;
  const logs=createBackendLogger();
  const port=Number(process.env.PORT??4175);
  const appOrigin=process.env.APP_ORIGIN??`http://127.0.0.1:${port}`;
  const authRuntime=await createAuth({databasePath:join(directory,"auth.sqlite"),baseURL:appOrigin,secret:process.env.BETTER_AUTH_SECRET,production:process.env.NODE_ENV==="production"});
  const accountStore=createAccountStore(authRuntime.database);
  const osmGeocoder=openOsmGeocoder(join(directory,"osm-addresses.sqlite"));
  const app=createApp({store,provider,osmGeocoder,yandexTts,origin:appOrigin,audioDirectory:join(directory,"audio"),staticDirectory:process.env.STATIC_DIR,localTts,ttsApiClient,logs,auth:authRuntime.auth,authSecret:process.env.BETTER_AUTH_SECRET??"development-only-better-auth-secret-32",accountStore,closeAuth:authRuntime.close});
  app.server.listen(port,process.env.HOST??"127.0.0.1",()=>console.log(`Story service listening on ${port}; provider ${provider?"configured":"unavailable"}`));
  let stopping=false;
  for(const signal of ["SIGINT","SIGTERM"])process.on(signal,async()=>{if(stopping)return;stopping=true;await app.close();try {await logs?.close();} catch {console.error("Airouter logs delivery failed");}store.close();});
}

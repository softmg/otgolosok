import { createServer as httpServer } from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createStore } from "./store.mjs";
import { createProvider } from "./provider.mjs";
import { createYandexTts } from "./yandex-tts.mjs";
import { isTtsProvider, ttsVoiceOptions, validVoiceId } from "./tts-voices.mjs";
import { createElevenLabsTts, elevenLabsApi, elevenLabsApiKeys, listElevenLabsVoices } from "./elevenlabs-tts.mjs";
import { createAudioTagger } from "./audio-tags.mjs";
import { ELEVENLABS_PROFILE_ID, elevenLabsProfile, startSpeechAudioWorker } from "./speech-audio-worker.mjs";
import { normalizeAddress, addressKey, publicJob, failure } from "./domain.mjs";
import { errorMessages, safeError, startWorker } from "./pipeline.mjs";
import { createPlaceResolver } from "./places.mjs";
import { createWalkPlanner } from "./walks.mjs";
import { walkPlanErrorResponse } from "./walk-plan-errors.mjs";
import { createPromoWalkService, ensurePromoWalksUser } from "./promo-walks.mjs";
import { adminAuth, adminDetail, adminSummary } from "./admin.mjs";
import { validateWalkResearch, publicWalkResearch, walkResearchKey } from "./walk-research.mjs";
import { createBackendLogger } from "./logs.mjs";
import { ingestAudio, sweepAudioTemporaries } from "./audio-ingest.mjs";
import { startContentWorker } from "./content-pipeline.mjs";
import { createPlaceImageService, createWikimediaClient, placeImageUserAgent, startPlaceImageWorker } from "./place-images.mjs";
import { openOsmGeocoder } from "./osm-geocoder.mjs";
import { openFoodIndex, isCellLat as isFoodCellLat, isCellLon as isFoodCellLon } from "./food-places.mjs";
import { createAuth, authRequestHandler, authSession, sessionCsrfToken, validSessionCsrf, verifySessionPassword } from "./auth.mjs";
import { favoriteSummary } from "./favorite-summary.mjs";
import { createAccountStore } from "./account-store.mjs";
import { createWalkLaunchRoutes } from "./walk-launch-routes.mjs";
import { createTopWalks } from "./walk-top.mjs";
import { createReviewRateLimiter } from "./walk-reviews.mjs";
import { createWalkReviewRoutes } from "./walk-review-routes.mjs";
import { createPlaceFeedbackRoutes } from "./place-feedback-routes.mjs";
import { createWalkImprovementRoutes } from "./walk-improvement-routes.mjs";
import { resolveWalkView } from "./walk-view.mjs";
import { builtinRoutes } from "./builtin-routes.mjs";
import { catalogWalkView } from "./walk-catalog.mjs";
import { normalizeForSpeech } from "./text-normalizer.mjs";
import { loadLocalTtsConfig } from "./local-tts.mjs";
import { createTtsApiClient } from "./tts-api-client.mjs";
import { startTtsApiWorker } from "./tts-api-worker.mjs";
import { serializeCell } from "./map-cells.mjs";
import { sendCacheable, sendCacheableJson } from "./http-cache.mjs";
import { SHARE_NOT_FOUND_HTML, SHARE_PAGE_CSP, renderPlaceSharePage, shareUnavailableHtml, sharePathToPlaceId } from "./place-share.mjs";

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
// Digests keep the comparison constant-time regardless of the candidate length.
function sameSecret(expected,candidate) {
  if(typeof expected!=="string"||!expected||typeof candidate!=="string")return false;
  const digest=value=>createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected),digest(candidate));
}

// Lease tokens are HMACs, so a known fallback secret would let any worker forge them.
/** @param {{env?: NodeJS.ProcessEnv, transport?: string, randomSecret?: () => string}} [options] */
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

/** Paid generation units per user per rolling 24 hours; an invalid value stops startup instead of silently lifting the limit. */
export function parseUserDailyLimit(value) {
  if(value===undefined||value==="")return 6;
  if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1)throw new Error("USER_DAILY_GENERATION_LIMIT must be a positive integer");
  return Number(value);
}

/**
 * @typedef {object} CreateAppOptions
 * @property {ReturnType<typeof createStore>} store
 * @property {ReturnType<typeof createProvider> | null} [provider]
 * @property {ReturnType<typeof openOsmGeocoder> | null} [osmGeocoder]
 * @property {ReturnType<typeof openFoodIndex> | null} [foodIndex]
 * @property {ReturnType<typeof createYandexTts> | null} [yandexTts]
 * @property {ReturnType<typeof createElevenLabsTts> | null} [elevenLabsTts]
 * @property {string} origin
 * @property {string} [audioDirectory]
 * @property {string} [imageDirectory] DATA_DIR/place-images
 * @property {ReturnType<typeof createPlaceImageService> | null} [placeImages] null unless PLACE_IMAGE_SYNC=true
 * @property {string} [staticDirectory]
 * @property {boolean} [workerEnabled]
 * @property {ReturnType<typeof loadLocalTtsConfig>} [localTts]
 * @property {ReturnType<typeof createTtsApiClient> | null} [ttsApiClient]
 * @property {ReturnType<typeof createPlaceResolver>} [resolvePlace]
 * @property {ReturnType<typeof createWalkPlanner> | null} [planWalk]
 * @property {Function} [discoverResearch]
 * @property {Function} [planResearchWalk]
 * @property {string} [adminToken]
 * @property {boolean} [allowLegacyAdminToken]
 * @property {string} [workerToken]
 * @property {string} [promoWalksToken]
 * @property {ReturnType<typeof createBackendLogger>} [logs]
 * @property {typeof ingestAudio} [audioIngest]
 * @property {Awaited<ReturnType<typeof createAuth>>["auth"] | null} [auth]
 * @property {string} [authSecret]
 * @property {ReturnType<typeof createAccountStore> | null} [accountStore]
 * @property {() => void | Promise<void>} [closeAuth]
 * @property {number} [userDailyLimit]
 * @property {number} [shutdownGraceMs]
 * @property {ReturnType<typeof createReviewRateLimiter>} [reviewLimiter] review writes per account or client IP
 * @property {ReturnType<typeof createReviewRateLimiter>} [improvementLimiter] improvement request writes per account or client IP
 * @property {ReturnType<typeof createReviewRateLimiter>} [launchLimiter] walk launch reports per account or client IP
 * @property {ReturnType<typeof createReviewRateLimiter>} [launchWalkLimiter] counted launches of one walk per client IP
 */

/** @param {CreateAppOptions} options */
export function createApp({store,provider,osmGeocoder=null,foodIndex=null,yandexTts=null,elevenLabsTts=null,origin,audioDirectory,imageDirectory,placeImages=null,staticDirectory,workerEnabled=true,localTts=loadLocalTtsConfig({}),ttsApiClient=null,resolvePlace=createPlaceResolver(),planWalk=null,discoverResearch,planResearchWalk,adminToken=process.env.ADMIN_TOKEN,allowLegacyAdminToken,workerToken=process.env.WORKER_API_TOKEN,promoWalksToken=process.env.PROMO_WALKS_TOKEN,logs=null,audioIngest=ingestAudio,auth=null,authSecret="",accountStore=null,closeAuth=async()=>{},userDailyLimit=6,shutdownGraceMs=20000,reviewLimiter=createReviewRateLimiter(),improvementLimiter=createReviewRateLimiter(),launchLimiter=createReviewRateLimiter({limit:60}),launchWalkLimiter=createReviewRateLimiter({limit:30,windowMs:86_400_000})}) {
  const walkPlanner=planWalk??createWalkPlanner({candidateProvider:query=>store.listWalkCandidates?.(query)??[]});
  const speechProviders={openai:provider,yandex:yandexTts,elevenlabs:elevenLabsTts};
  const ttsProviders=[{id:"openai",label:"OpenAI",available:Boolean(provider),...ttsVoiceOptions("openai",provider?.voice)},
    {id:"yandex",label:"Яндекс SpeechKit",available:Boolean(yandexTts),...ttsVoiceOptions("yandex",yandexTts?.voice)},
    {id:"elevenlabs",label:"ElevenLabs (с аудиотегами)",available:Boolean(elevenLabsTts),...ttsVoiceOptions("elevenlabs",elevenLabsTts?.voice,elevenLabsTts?.voices??[])}];
  // Catalog texts are voiced through the queue: the local TTS profile, or ElevenLabs when it is configured.
  const audioProfiles=[{id:localTts.defaultProfile,label:localTts.engine==="f5"?"F5 (локальный TTS)":"Silero (локальный TTS)"},
    ...(elevenLabsTts?[{id:ELEVENLABS_PROFILE_ID,label:"ElevenLabs (с аудиотегами)"}]:[])];
  const worker=(provider||yandexTts)&&workerEnabled?startWorker({store,provider,speechProviders,audioDirectory,discoverResearch,planResearchWalk,logs}):null;
  const contentWorker=provider&&workerEnabled?startContentWorker({store,provider,logs,resolveLocation:osmGeocoder ? place=>osmGeocoder.resolve(place) : null,concurrency:Number(process.env.CONTENT_WORKER_CONCURRENCY??1),autoApprove:process.env.CONTENT_AUTO_APPROVE==="true",placeImages}):null;
  const placeImageWorker=workerEnabled&&placeImages?startPlaceImageWorker({service:placeImages,logs}):null;
  const ttsApiWorker=workerEnabled&&localTts.transport==="http"&&ttsApiClient?startTtsApiWorker({store,client:ttsApiClient,audioDirectory,profileId:localTts.defaultProfile,logs}):null;
  const elevenLabsWorker=workerEnabled&&elevenLabsTts?startSpeechAudioWorker({store,speechProvider:elevenLabsTts,profileId:ELEVENLABS_PROFILE_ID,audioDirectory,logs}):null;
  const authorizeAdmin=adminAuth(adminToken);
  const promoEnabled=typeof promoWalksToken==="string"&&promoWalksToken.length>0;
  if(promoEnabled&&promoWalksToken.length<32)throw new Error("PROMO_WALKS_TOKEN must contain at least 32 characters");
  const authorizePromo=adminAuth(promoEnabled?promoWalksToken:"");
  const promoWalks=promoEnabled&&accountStore?createPromoWalkService({accountStore,planWalk:walkPlanner,store,origin}):null;
  const reviews=createWalkReviewRoutes({store,accountStore,origin,authSecret,limiter:reviewLimiter,json,body});
  const placeFeedback=createPlaceFeedbackRoutes({store,accountStore,origin,authSecret,limiter:improvementLimiter,json,body});
  const improvements=createWalkImprovementRoutes({store,accountStore,origin,authSecret,limiter:improvementLimiter,json,body});
  const launches=createWalkLaunchRoutes({store,accountStore,authSecret,limiter:launchLimiter,walkLimiter:launchWalkLimiter,json,body});
  const topWalks=accountStore?createTopWalks({accountStore,store,builtinRoutes}):null;
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
        if(url.pathname==="/api/me/walks"&&req.method==="GET"){json(res,200,accountStore.listWalks(session.user.id,.../** @type {[number, string | null]} */ (Object.values(accountQuery()))));return;}
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
        if(ownWalkSharing&&req.method==="PUT"){
          const input=await body(req),keys=Object.keys(input);
          // Legacy {revision, enabled} from service-worker-cached clients; remove once old clients are gone.
          const legacy=keys.includes("enabled");
          if(keys.some(key=>!["revision","visibility","enabled"].includes(key))||legacy===keys.includes("visibility")||(legacy&&typeof input.enabled!=="boolean"))throw failure("BAD_REQUEST");
          const visibility=legacy?(input.enabled?"shared":"private"):input.visibility;
          const walk=accountStore.setWalkVisibility(session.user.id,ownWalkSharing[1],input.revision,visibility);
          json(res,walk?200:404,walk?{walk}:{error:{code:"NOT_FOUND",message:"Прогулка не найдена."}});return;
        }
        if(ownWalk&&req.method==="GET"){const walk=accountStore.getWalk(session.user.id,ownWalk[1]);json(res,walk?200:404,walk?{walk}:{error:{code:"NOT_FOUND",message:"Walk not found."}});return;}
        if(ownWalk&&req.method==="PATCH"){const walk=accountStore.updateWalk(session.user.id,ownWalk[1],await body(req,100000));json(res,walk?200:404,walk?{walk}:{error:{code:"NOT_FOUND",message:"Walk not found."}});return;}
        if(ownWalk&&req.method==="DELETE"){json(res,accountStore.deleteWalk(session.user.id,ownWalk[1])?200:404,{success:true});return;}
        if(url.pathname==="/api/me/requests"&&req.method==="GET"){json(res,200,accountStore.listRequests(session.user.id,.../** @type {[number, string | null]} */ (Object.values(accountQuery()))));return;}
        if(url.pathname==="/api/me/favorites"&&req.method==="GET"){const data=accountStore.listFavorites(session.user.id,.../** @type {[number, string | null]} */ (Object.values(accountQuery())));json(res,200,{...data,favorites:data.favorites.map(item=>favoriteSummary(item,{userId:session.user.id,accountStore,store,routes:builtinRoutes}))});return;}
        if(url.pathname==="/api/me/import"&&req.method==="POST"){json(res,200,{result:accountStore.importLocal(session.user.id,await body(req,110000))});return;}
        const favorite=/^\/api\/me\/favorites\/(story|walk)\/([a-zA-Z0-9-]{1,128})$/.exec(url.pathname);
        if(favorite&&req.method==="PUT"){accountStore.setFavorite(session.user.id,favorite[1],favorite[2]);json(res,200,{success:true});return;}
        if(favorite&&req.method==="DELETE"){accountStore.deleteFavorite(session.user.id,favorite[1],favorite[2]);json(res,200,{success:true});return;}
        if(await reviews.own(req,res,url,session))return;
        if(await improvements.own(req,res,url,session))return;
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
          json(res,200,{job:store.acceptExternalAudio(workerMatch[1],{workerId:effectiveWorkerId,generation,leaseToken,uploadId,uploadSha256:expected,artifact})});
          return;
        }
        json(res,405,{error:{code:"METHOD_NOT_ALLOWED",message:"Method not allowed."}});return;
      }
      // Token-authenticated service API for the YouTube Shorts worker; it has no
      // browser Origin, so it is dispatched before the same-origin POST gate.
      if(url.pathname==="/api/service/promo-walks") {
        if(!promoEnabled){json(res,404,{error:{message:"Страница не найдена."}});return;}
        const authorized=authorizePromo(req.headers.authorization);
        if(authorized===429){res.setHeader("Retry-After","60");json(res,429,{error:{code:"RATE_LIMITED",message:"Too many failed attempts."}});return;}
        if(authorized!==200){res.setHeader("WWW-Authenticate","Bearer");json(res,401,{error:{code:"UNAUTHORIZED",message:"Service authentication required."}});return;}
        if(req.method!=="POST"){res.setHeader("Allow","POST");json(res,405,{error:{code:"METHOD_NOT_ALLOWED",message:"Method not allowed."}});return;}
        if(url.search)throw failure("BAD_REQUEST");
        if(!promoWalks){json(res,503,{error:{code:"PROMO_WALKS_UNAVAILABLE",message:"Account storage is unavailable."}});return;}
        const result=await promoWalks.create(await body(req,8192));
        for(const [name,value] of Object.entries(result.headers))res.setHeader(name,value);
        json(res,result.status,result.body);return;
      }
      // Promo queue for otgolosok-shorts: same service token as promo walks.
      const promoService=new RegExp(`^/api/service/promo-queue/(?:claim|(${UUID})(/report)?)$`).exec(url.pathname);
      if(promoService) {
        if(!promoEnabled){json(res,404,{error:{message:"Страница не найдена."}});return;}
        const authorized=authorizePromo(req.headers.authorization);
        if(authorized===429){res.setHeader("Retry-After","60");json(res,429,{error:{code:"RATE_LIMITED",message:"Too many failed attempts."}});return;}
        if(authorized!==200){res.setHeader("WWW-Authenticate","Bearer");json(res,401,{error:{code:"UNAUTHORIZED",message:"Service authentication required."}});return;}
        if(url.search)throw failure("BAD_REQUEST");
        if(!accountStore){json(res,503,{error:{code:"UNAVAILABLE",message:"Account storage is unavailable."}});return;}
        const reading=promoService[1]&&!promoService[2];
        if(req.method!==(reading?"GET":"POST")){res.setHeader("Allow",reading?"GET":"POST");json(res,405,{error:{code:"METHOD_NOT_ALLOWED",message:"Method not allowed."}});return;}
        try {
          if(!promoService[1]) {
            const input=await body(req,1024);
            if(Object.keys(input).some(key=>key!=="count"))throw failure("BAD_REQUEST");
            json(res,200,{items:accountStore.claimPromo(input.count)});return;
          }
          const item=reading?accountStore.getPromo(promoService[1]):accountStore.reportPromo(promoService[1],await body(req,4096));
          json(res,item?200:404,item?{item}:{error:{code:"NOT_FOUND",message:"Promo item not found."}});return;
        } catch(error) {
          if(error.code==="CONFLICT"){json(res,409,{error:{code:"CONFLICT",message:error.message}});return;}
          throw error;
        }
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
              const intent=accountStore.beginGeneration(session.user.id,q.recoveryToken,"walk_research",walkResearchKey(request),0,userDailyLimit);
              if(intent.jobId&&intent.jobId!==job.id)throw failure("CONFLICT");
              accountStore.completeGeneration(session.user.id,q.recoveryToken,job.id);
            }
          }
        } else if(req.method==="POST"&&(!researchMatch[1]||researchMatch[2])) {
          if(!origin||req.headers.origin!==origin||![undefined,"same-origin","none"].includes(req.headers["sec-fetch-site"])) {json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          if(url.search)throw failure("BAD_REQUEST");
          // Research spends paid model and speech calls, so it is charged to a signed-in user.
          if(!auth){json(res,503,{error:{code:"AUTH_REQUIRED",message:errorMessages.AUTH_REQUIRED}});return;}
          const input=await body(req);
          if(researchMatch[2]) {
            if(!accountStore.ownsRequest(session.user.id,researchMatch[1])){json(res,404,{error:{code:"NOT_FOUND",message:"Walk research job not found."}});return;}
            if(Object.keys(input).length!==1||!Number.isSafeInteger(input.revision)||input.revision<0)throw failure("BAD_REQUEST");
            if(!provider){json(res,503,{error:{code:"PROVIDER_UNAVAILABLE",message:"Story provider unavailable."}});return;}
            // A repeated retry of the same revision was already charged; only a charge made by this request is refunded.
            const quotaKey=`walk-retry-${researchMatch[1]}-${input.revision}`,reserved=accountStore.reserveGeneration(session.user.id,quotaKey,3,userDailyLimit);
            try{job=store.retryWalkResearch(researchMatch[1],input.revision);}catch(error){if(reserved)accountStore.releaseGeneration(session.user.id,quotaKey);throw error;}
            if(!job&&reserved)accountStore.releaseGeneration(session.user.id,quotaKey);
          } else {
            const request=validateWalkResearch(input),existing=store.lookupWalkResearch(request,input.recoveryToken);
            const intent=accountStore.beginGeneration(session.user.id,input.recoveryToken,"walk_research",walkResearchKey(request),existing?0:3,userDailyLimit);
            try {job=intent.jobId?store.get(intent.jobId):store.createWalkResearch(input,{allowCreate:Boolean(provider)});if(job)accountStore.completeGeneration(session.user.id,input.recoveryToken,job.id);}
            catch(error) {
              if(!intent.jobId)accountStore.cancelGeneration(session.user.id,input.recoveryToken);
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
        if(await reviews.admin(req,res,url,roleAuthorized?session.user.id:null))return;
        if(await improvements.admin(req,res,url,roleAuthorized?session.user.id:null))return;
        if(await placeFeedback.admin(req,res,url))return;
        if(req.method==="GET"&&url.pathname==="/api/story-admin/walks/shared") {
          const entries=[...url.searchParams];
          if(entries.some(([key,value])=>!["limit","offset","q","author","mode","access","listing","promo"].includes(key)||(["limit","offset"].includes(key)&&!/^\d+$/.test(value)))||new Set(entries.map(([key])=>key)).size!==entries.length)throw failure("BAD_REQUEST");
          if(!accountStore){json(res,503,{error:{code:"UNAVAILABLE",message:"Хранилище прогулок недоступно."}});return;}
          json(res,200,accountStore.listSharedWalksAdmin({limit:Number(url.searchParams.get("limit")??25),offset:Number(url.searchParams.get("offset")??0),q:url.searchParams.get("q")??"",author:url.searchParams.get("author")??"",mode:url.searchParams.get("mode")??"all",access:url.searchParams.get("access")??"all",listing:url.searchParams.get("listing")??"all",promo:url.searchParams.get("promo")??"all"}));return;
        }
        const promoAdmin=new RegExp(`^/api/story-admin/promo-queue(?:/(${UUID})/(remove|up|requeue))?$`).exec(url.pathname);
        if(promoAdmin) {
          if(!accountStore){json(res,503,{error:{code:"UNAVAILABLE",message:"Хранилище прогулок недоступно."}});return;}
          if(url.search)throw failure("BAD_REQUEST");
          if(!promoAdmin[1]&&req.method==="GET"){json(res,200,accountStore.listPromoQueue());return;}
          if(req.method!=="POST"){res.setHeader("Allow",promoAdmin[1]?"POST":"GET, POST");json(res,405,{error:{code:"METHOD_NOT_ALLOWED",message:"Method not allowed."}});return;}
          const input=await body(req);
          try {
            if(!promoAdmin[1]) {
              if(Object.keys(input).some(key=>key!=="walkId"))throw failure("BAD_REQUEST");
              const item=accountStore.enqueuePromo(input.walkId);
              json(res,item?201:404,item?{item}:{error:{code:"NOT_FOUND",message:"Прогулка не найдена."}});return;
            }
            if(Object.keys(input).some(key=>key!=="revision"))throw failure("BAD_REQUEST");
            const [, id, action]=promoAdmin;
            if(action==="remove"){const removed=accountStore.removePromo(id,input.revision);json(res,removed?200:404,removed?{removed:true}:{error:{code:"NOT_FOUND",message:"Выпуск не найден."}});return;}
            const item=action==="up"?accountStore.movePromoUp(id,input.revision):accountStore.requeuePromo(id,input.revision);
            json(res,item?200:404,item?{item}:{error:{code:"NOT_FOUND",message:"Выпуск не найден."}});return;
          } catch(error) {
            if(error.code==="CONFLICT"){json(res,409,{error:{code:"CONFLICT",message:error.message}});return;}
            throw error;
          }
        }
        const walkListing=new RegExp(`^/api/story-admin/walks/shared/(${UUID})/listing$`).exec(url.pathname);
        if(walkListing) {
          if(req.method!=="POST"){res.setHeader("Allow","POST");json(res,405,{error:{code:"METHOD_NOT_ALLOWED",message:"Method not allowed."}});return;}
          if(!accountStore){json(res,503,{error:{code:"UNAVAILABLE",message:"Хранилище прогулок недоступно."}});return;}
          const input=await body(req);
          if(url.search||Object.keys(input).some(key=>!["action","revision"].includes(key)))throw failure("BAD_REQUEST");
          let walk;
          try{walk=accountStore.moderateWalkListing(walkListing[1],{action:input.action,revision:input.revision});}
          catch(error){if(error.code!=="CONFLICT")throw error;json(res,409,{error:{code:"CONFLICT",message:error.message}});return;}
          json(res,walk?200:404,walk?{walk}:{error:{code:"NOT_FOUND",message:"Прогулка не найдена."}});return;
        }
        if(req.method==="GET"&&url.pathname==="/api/story-admin/walks") {
          const entries=[...url.searchParams];
          if(entries.some(([key,value])=>!["limit","offset"].includes(key)||!/^\d+$/.test(value))||new Set(entries.map(([key])=>key)).size!==entries.length)throw failure("BAD_REQUEST");
          const page=store.listWalksAdmin({limit:Number(url.searchParams.get("limit")??50),offset:Number(url.searchParams.get("offset")??0)});
          // Launches live in the auth database; without it the column shows "нет данных", not zero.
          const launches=accountStore?.launchCounts("catalog",page.walks.map(walk=>walk.id));
          json(res,200,{...page,walks:page.walks.map(walk=>({...walk,launches:launches?.get(walk.id)??null}))});return;
        }
        if(req.method==="GET"&&url.pathname==="/api/story-admin/content/places") {
          const entries=[...url.searchParams];if(entries.some(([key,value])=>!["limit","offset","q","status"].includes(key)||(["limit","offset"].includes(key)&&!/^\d+$/.test(value))))throw failure("BAD_REQUEST");
          json(res,200,store.listPlaces({limit:Number(url.searchParams.get("limit")??50),offset:Number(url.searchParams.get("offset")??0),q:url.searchParams.get("q")??"",status:url.searchParams.get("status")??"all"}));return;
        }
        if(req.method==="GET"&&url.pathname==="/api/story-admin/content/batches") {if(url.search)throw failure("BAD_REQUEST");json(res,200,{batches:store.listBatches()});return;}
        if(req.method==="GET"&&url.pathname==="/api/story-admin/content/drafts") {
          const entries=[...url.searchParams];if(entries.some(([key,value])=>!["limit","offset","research"].includes(key)||(["limit","offset"].includes(key)&&!/^\d+$/.test(value))))throw failure("BAD_REQUEST");
          json(res,200,{...store.listDrafts({limit:Number(url.searchParams.get("limit")??50),offset:Number(url.searchParams.get("offset")??0),research:url.searchParams.get("research")??"all"}),researchAvailable:Boolean(provider?.searchSources),deepResearchAvailable:Boolean(provider?.deepResearchSources)});return;}
        if(req.method==="POST"&&url.pathname==="/api/story-admin/content/drafts/research") {
          if(!origin||req.headers.origin!==origin) {json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const input=await body(req,16384);
          if(!input||typeof input!=="object"||Array.isArray(input))throw failure("BAD_REQUEST");
          const mode=input.mode??"search";
          if(!["search","deep"].includes(mode))throw failure("BAD_REQUEST");
          if(mode==="deep"?!provider?.deepResearchSources:!provider?.searchSources){json(res,409,{error:{code:"SEARCH_DISABLED",message:"Поиск через Perplexity не настроен на сервере."}});return;}
          if(Object.keys(input??{}).some(key=>!["requestKey","limit","placeIds","mode"].includes(key)))throw failure("BAD_REQUEST");
          let result;
          try{result=store.researchDrafts({requestKey:input.requestKey,placeIds:input.placeIds??null,limit:input.limit??20,mode});}
          catch(error){if(error.code!=="NO_DRAFTS_TO_RESEARCH")throw error;
            json(res,409,{error:{code:error.code,message:"Нет черновиков, которые можно переисследовать: все уже проверены через Perplexity или стоят в очереди."}});return;}
          json(res,200,result);contentWorker?.wake();return;
        }
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
        if(req.method==="GET"&&url.pathname==="/api/story-admin/content/workers") {if(url.search)throw failure("BAD_REQUEST");json(res,200,{transport:localTts.transport,audioProfiles,workers:store.listWorkerCredentials(),heartbeats:store.listWorkerHeartbeats()});return;}
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
        const itemDetail=/^\/api\/story-admin\/content\/batches\/([a-f0-9-]+)\/items\/(osm:(?:node|way|relation):\d+)$/.exec(url.pathname);
        if(itemDetail&&req.method==="GET"){if(url.search)throw failure("BAD_REQUEST");const item=store.getBatchItemDetail(itemDetail[1],itemDetail[2]);
          json(res,item?200:404,item?{item}:{error:{code:"NOT_FOUND",message:"Batch item not found."}});return;}
        const retryContent=/^\/api\/story-admin\/content\/batches\/([a-f0-9-]+)\/items\/(osm:(?:node|way|relation):\d+)\/retry$/.exec(url.pathname);
        if(retryContent&&req.method==="POST"){if(!origin||req.headers.origin!==origin){json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const input=await body(req,1024),restartFrom=input.restartFrom??"auto";if(Object.keys(input).some(key=>key!=="restartFrom"))throw failure("BAD_REQUEST");
          const batch=store.retryBatchItem(retryContent[1],retryContent[2],{restartFrom});json(res,batch?200:404,batch?{batch}:{error:{code:"NOT_FOUND",message:"Batch item not found."}});contentWorker?.wake();return;}
        const contentPlace=/^\/api\/story-admin\/content\/places\/(osm:(?:node|way|relation):\d+)$/.exec(url.pathname);
        if(contentPlace&&req.method==="GET"){const place=store.getPlace(contentPlace[1]);json(res,place?200:404,place?{place}:{error:{code:"NOT_FOUND",message:"Place not found."}});return;}
        const approveContent=/^\/api\/story-admin\/content\/places\/(osm:(?:node|way|relation):\d+)\/approve$/.exec(url.pathname);
        if(approveContent&&req.method==="POST"){if(!origin||req.headers.origin!==origin){json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const input=await body(req,32768);
          // The photo is looked up before the place becomes visible; Wikimedia problems never block the approval.
          const draftPlace=placeImages?store.getPlace(approveContent[1]):null;
          if(draftPlace)await placeImages.ensure(draftPlace,{timeoutMs:15000}).catch(error=>logs?.captureException(error,{operation:"placeImages.approve",context:{placeId:draftPlace.id}}));
          const place=store.approvePlaceText(approveContent[1],input?.story??null);
          if(place)for(const profileId of place.audioProfiles??[])await store.enqueueExternalAudio({sourceJobId:`place-text:${place.text.id}`,sourceRevision:0,story:{...place.text.story,address:place.address??place.name},profileId});
          json(res,place?200:404,place?{place}:{error:{code:"NOT_FOUND",message:"Place text not found."}});return;}
        const revoiceContent=/^\/api\/story-admin\/content\/places\/(osm:(?:node|way|relation):\d+)\/audio$/.exec(url.pathname);
        if(revoiceContent&&req.method==="POST"){if(!origin||req.headers.origin!==origin){json(res,403,{error:{code:"FORBIDDEN",message:"Same-origin request required."}});return;}
          const input=await body(req,4096);
          if(Object.keys(input).some(key=>!["profileId","requestId"].includes(key)))throw failure("BAD_REQUEST");
          const place=store.getPlace(revoiceContent[1]);
          if(!place?.text||place.text.verification!=="editorial"){json(res,404,{error:{code:"NOT_FOUND",message:"Approved place text not found."}});return;}
          const profileId=input.profileId??localTts.defaultProfile;
          if(!audioProfiles.some(profile=>profile.id===profileId))throw failure("BAD_REQUEST");
          const deliberate=profileId===ELEVENLABS_PROFILE_ID;
          if(deliberate&&(typeof input.requestId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)))throw failure("BAD_REQUEST");
          if(!deliberate&&input.requestId!==undefined)throw failure("BAD_REQUEST");
          let audioJob;
          try{audioJob=await store.enqueueExternalAudio({sourceJobId:`place-text:${place.text.id}`,sourceRevision:0,story:{...place.text.story,address:place.address??place.name},profileId,
            ...(deliberate?{revoiceRequestId:input.requestId}:{})});}
          catch(error){if(error.code!=="CONFLICT")throw error;
            json(res,409,{error:{code:"CONFLICT",message:"Озвучка уже выполняется или утверждённый текст изменился. Дождитесь завершения задания и обновите место перед новой попыткой."}});return;}
          if(profileId===ELEVENLABS_PROFILE_ID)elevenLabsWorker?.wake();
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
              if(!isTtsProvider(selected))throw failure("BAD_REQUEST");
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
      const readMethod=req.method==="GET"||req.method==="HEAD";
      if(req.method==="GET"&&url.pathname==="/api/story-service") {json(res,200,{enabled:Boolean(provider),version:1});return;}
      if(req.method==="GET"&&url.pathname==="/api/content/places") {
        const entries=[...url.searchParams],allowed=["limit","offset","q","status","lat","lon","radius","west","south","east","north"];
        if(entries.some(([key,value])=>!allowed.includes(key)||(["limit","offset"].includes(key)&&!/^\d+$/.test(value)))||new Set(entries.map(([key])=>key)).size!==entries.length)throw failure("BAD_REQUEST");
        const boundKeys=["west","south","east","north"];
        const hasBounds=boundKeys.some(key=>url.searchParams.has(key));
        if(hasBounds&&boundKeys.some(key=>!url.searchParams.get(key)?.trim()))throw failure("BAD_REQUEST");
        const bounds=hasBounds?{west:Number(url.searchParams.get("west")),south:Number(url.searchParams.get("south")),east:Number(url.searchParams.get("east")),north:Number(url.searchParams.get("north"))}:null;
        const nearby=url.searchParams.has("lat")||url.searchParams.has("lon")||url.searchParams.has("radius");
        json(res,200,store.listPlaces({limit:Number(url.searchParams.get("limit")??50),offset:Number(url.searchParams.get("offset")??0),q:url.searchParams.get("q")??"",status:url.searchParams.get("status")??"ready",
          lat:nearby?Number(url.searchParams.get("lat")):null,lon:nearby?Number(url.searchParams.get("lon")):null,radius:nearby?Number(url.searchParams.get("radius")):null,bounds}));return;
      }
      const publicPlace=/^\/api\/content\/places\/(osm:(?:node|way|relation):\d+)$/.exec(url.pathname);
      if(readMethod&&publicPlace){const place=store.getPublishedPlace(publicPlace[1]);if(place)sendCacheableJson(req,res,JSON.stringify({place}));else json(res,404,{error:{code:"NOT_FOUND",message:"Place text not found."}});return;}
      // The shared link of a place: its preview tags for messengers, then the map (backend/place-share.mjs).
      if(readMethod&&url.pathname.startsWith("/place/")) {
        const placeId=sharePathToPlaceId(url.pathname);
        let page;
        // A person following the link gets a page, not the JSON error: the map retries on its own.
        try {page=placeId?renderPlaceSharePage({id:placeId,place:store.getPublishedPlace(placeId),origin}):{status:404,html:SHARE_NOT_FOUND_HTML};}
        catch(error) {logs?.captureException(error,{operation:"place share page",context:{placeId}});page={status:503,html:shareUnavailableHtml(/** @type {string} */ (placeId))};}
        if(page.status===200){sendCacheable(req,res,page.html,"text/html; charset=utf-8",{"Content-Security-Policy":SHARE_PAGE_CSP});return;}
        res.writeHead(page.status,{"Content-Type":"text/html; charset=utf-8","Cache-Control":page.status===503?"no-store":"no-cache","X-Content-Type-Options":"nosniff","Content-Security-Policy":SHARE_PAGE_CSP});
        res.end(req.method==="HEAD"?undefined:page.html);return;
      }
      // One URL per cell (no query, no "-0", no leading zeros), so every cell has exactly one cache key.
      if(readMethod&&url.pathname==="/api/content/map-cells") {
        if(req.url.includes("?"))throw failure("BAD_REQUEST");
        sendCacheableJson(req,res,JSON.stringify({version:1,cellSize:1,cells:store.listMapCells()}));return;
      }
      const mapCell=/^\/api\/content\/map-cells\/(-?(?:0|[1-9]\d{0,2}))\/(-?(?:0|[1-9]\d{0,2}))$/.exec(url.pathname);
      if(readMethod&&url.pathname.startsWith("/api/content/map-cells/")) {
        if(!mapCell||req.url.includes("?")||mapCell[1]==="-0"||mapCell[2]==="-0")throw failure("BAD_REQUEST");
        const {cell,points}=store.getMapCell(Number(mapCell[1]),Number(mapCell[2]));
        sendCacheableJson(req,res,serializeCell(cell,points));return;
      }
      if(readMethod&&(url.pathname==="/api/food/cells"||url.pathname.startsWith("/api/food/cells/"))) {
        const foodCell=/^\/api\/food\/cells\/(-?(?:0|[1-9]\d{0,3}))\/(-?(?:0|[1-9]\d{0,3}))$/.exec(url.pathname);
        if(req.url.includes("?")||(url.pathname!=="/api/food/cells"&&(!foodCell||foodCell[1]==="-0"||foodCell[2]==="-0"||!isFoodCellLat(Number(foodCell[1]))||!isFoodCellLon(Number(foodCell[2])))))throw failure("BAD_REQUEST");
        if(!foodIndex) { json(res,503,{error:"FOOD_INDEX_UNAVAILABLE"});return; }
        sendCacheableJson(req,res,foodCell?foodIndex.cell(Number(foodCell[1]),Number(foodCell[2])):foodIndex.manifest());return;
      }
      if(await reviews.public(req,res,url,session))return;
      if(await improvements.public(req,res,url,session))return;
      if(await placeFeedback.public(req,res,url,session))return;
      if(url.pathname==="/api/top-walks") {
        if(!["GET","HEAD"].includes(req.method)){res.setHeader("Allow","GET, HEAD");json(res,405,{error:{code:"METHOD_NOT_ALLOWED",message:"Method not allowed."}});return;}
        if(url.search)throw failure("BAD_REQUEST");
        if(!topWalks){json(res,503,{error:{code:"UNAVAILABLE",message:"Топ прогулок временно недоступен."}});return;}
        json(res,200,{walks:topWalks.list()});return;
      }
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
          // X-Real-IP is overwritten by nginx, as for Better Auth rate limiting.
          try {json(res,200,await walkPlanner(await body(req,8192),{client:String(req.headers["x-real-ip"]??req.socket.remoteAddress??"")}));}
          catch(error) {
            const planError=walkPlanErrorResponse(error);
            for(const [name,value] of Object.entries(planError.headers))res.setHeader(name,value);
            json(res,planError.status,planError.body);
          }
          return;
        }
        // A guest walk lives only in the browser; resolving it reads published
        // content synchronously and never queues research or narration.
        if(url.pathname==="/api/story-walks/resolve") {
          const input=await body(req,100000);
          if(Object.keys(input).some(key=>!["document","revision"].includes(key))||!Number.isSafeInteger(input.revision)||input.revision<0)throw failure("BAD_REQUEST");
          json(res,200,resolveWalkView(input.document,input.revision,store));return;
        }
        if(await launches(req,res,url,session))return;
        if(!provider) {json(res,503,{error:{message:"Подготовка историй пока недоступна."}});return;}
        // Story generation spends paid model and speech calls, so it is charged to a signed-in user.
        if(!auth||!accountStore){json(res,503,{error:{code:"AUTH_REQUIRED",message:errorMessages.AUTH_REQUIRED}});return;}
        const input=await body(req);
        if(url.pathname==="/api/story-jobs") {
          if(!session){json(res,401,{error:{code:"UNAUTHORIZED",message:"Войдите, чтобы подготовить историю."}});return;}
          if(Object.keys(input).some((key)=>!["address","idempotencyKey"].includes(key))||typeof input.idempotencyKey!=="string")throw failure("BAD_REQUEST");
          const address=normalizeAddress(input.address),key=addressKey(address),existing=store.getByKey?.(key)??null;
          const intent=accountStore.beginGeneration(session.user.id,input.idempotencyKey,"create",key,existing?0:1,userDailyLimit);
          let job;try{job=intent.jobId?store.get(intent.jobId):store.createOrGet({key,address});if(!job)throw failure("CONFLICT");accountStore.completeGeneration(session.user.id,input.idempotencyKey,job.id);}
          catch(error){if(!intent.jobId)accountStore.cancelGeneration(session.user.id,input.idempotencyKey);throw error;}
          json(res,200,publicJob(job));worker?.wake();return;
        }
        const retry=new RegExp(`^/api/story-jobs/(${UUID})/retry$`).exec(url.pathname);
        if(retry) {
          if(!session||!accountStore.ownsRequest(session.user.id,retry[1])){json(res,404,{error:{code:"NOT_FOUND",message:"Задание не найдено."}});return;}
          if(!Number.isInteger(input.revision)||Object.keys(input).some((key)=>key!=="revision"))throw failure("BAD_REQUEST");
          // A repeated retry of the same revision was already charged; only a charge made by this request is refunded.
          const quotaKey=`retry-${retry[1]}-${input.revision}`,reserved=accountStore.reserveGeneration(session.user.id,quotaKey,1,userDailyLimit);
          let job;try{job=store.retry(retry[1],input.revision);}catch(error){if(reserved)accountStore.releaseGeneration(session.user.id,quotaKey);throw error;}
          if(!job){if(reserved)accountStore.releaseGeneration(session.user.id,quotaKey);json(res,404,{error:{message:"Задание не найдено."}});return;}
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
      const placeImage=/^\/api\/place-images\/([a-f0-9]{64}\.jpg)$/.exec(url.pathname);
      if(["GET","HEAD"].includes(req.method)&&placeImage&&imageDirectory) {await sendFile(req,res,join(imageDirectory,placeImage[1]),"image/jpeg",true);return;}
      // Local production preview only; deployed frontend remains in Nginx.
      if(staticDirectory&&["GET","HEAD"].includes(req.method)&&!url.pathname.startsWith("/api/")) {
        const root=resolve(staticDirectory);const relative=decodeURIComponent(url.pathname).replace(/^\/+/,"")||"index.html";
        let file=resolve(root,relative);
        if(!file.startsWith(root+sep)){json(res,404,{});return;}
        if(!extname(file)) file+=".html";
        const types={".html":"text/html; charset=utf-8",".js":"application/javascript",".css":"text/css",".json":"application/json",".txt":"text/plain",".svg":"image/svg+xml",".woff2":"font/woff2",".ico":"image/x-icon",".png":"image/png",".mp3":"audio/mpeg",".webmanifest":"application/manifest+json"};
        await sendFile(req,res,file,types[extname(file)]??"application/octet-stream");return;
      }
      json(res,404,{error:{message:"Страница не найдена."}});
    } catch(error) {
      if(res.headersSent||res.destroyed)return;
      const status=["QUEUE_FULL","QUOTA_EXCEEDED","UPLOAD_BUSY"].includes(error.code)?429:error.code==="AUDIO_STORAGE_FULL"?507:["CONFLICT","RETRY_LIMIT","LEASE_LOST","CLAIM_EXPIRED","WORKER_BUSY","STORAGE_LIMIT"].includes(error.code)?409:
        error.code==="AUDIO_TOO_LARGE"?413:["BAD_AUDIO_TYPE","BAD_AUDIO","AUDIO_CHECKSUM","AUDIO_DURATION"].includes(error.code)?422:["INVALID_ADDRESS","BAD_REQUEST","INVALID_DRAFT"].includes(error.code)?400:500;
      if(error.code==="WALK_NOT_READY"){json(res,409,{error:{code:error.code,message:"Сначала постройте маршрут — черновик нельзя открыть всем."}});return;}
      if(status===500) logs?.captureException(error,{operation:"API request",context:{method:req.method,status}});
      // Account storage limits carry a user-facing message written by the account store.
      json(res,status,{error:["BAD_REQUEST","INVALID_DRAFT"].includes(error.code)?{code:error.code,message:"Invalid request or draft."}:error.code==="STORAGE_LIMIT"?{code:error.code,message:error.message}:safeError(error)});
    }
  });
  server.requestTimeout=310000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  // Stop accepting requests, let in-flight ones finish within the grace period,
  // then stop the workers (aborted jobs are requeued) and close the databases.
  const close=async()=>{
    const drained=new Promise(done=>server.close(()=>done()));
    server.closeIdleConnections();
    let timer;
    await Promise.race([drained,new Promise(done=>{timer=setTimeout(done,shutdownGraceMs);timer.unref?.();})]);
    clearTimeout(timer);server.closeAllConnections();await drained;
    await Promise.all([worker?.stop(),contentWorker?.stop(),ttsApiWorker?.stop(),elevenLabsWorker?.stop(),placeImageWorker?.stop()]);
    osmGeocoder?.close();foodIndex?.close();await closeAuth();
  };
  return {server,close};
}

/**
 * ElevenLabs speech needs its key and the text model (it adds the audio tags). The account's voices are read once at
 * startup; when that fails, only ELEVENLABS_VOICE_ID is offered.
 * @param {NodeJS.ProcessEnv} env @param {ReturnType<typeof createProvider> | null} provider @param {ReturnType<typeof createBackendLogger>} logs
 */
export async function loadElevenLabsTts(env,provider,logs,fetchImpl=fetch) {
  const apiKeys=elevenLabsApiKeys(env),apiKey=apiKeys[0]?.apiKey;
  if(!apiKey)return null;
  if(apiKeys.some(key=>key.voice!==null&&!validVoiceId(key.voice))){console.warn("ElevenLabs is disabled: ELEVENLABS_API_KEYS has a malformed voice id; use key:voiceId");return null;}
  if(!provider){console.warn("ElevenLabs is disabled: audio tags require OPENAI_API_KEY and OPENAI_BASE_URL");return null;}
  const baseUrl=elevenLabsApi(env.ELEVENLABS_BASE_URL?.trim()),proxyToken=env.ELEVENLABS_PROXY_TOKEN?.trim()||undefined;
  let voices=[];
  try {voices=await listElevenLabsVoices({apiKey,baseUrl,proxyToken,fetchImpl});}
  catch(error) {
    // A blocked region fails every synthesis too: offering the service would only produce failed jobs.
    if(error?.code==="TTS_REGION_BLOCKED"){console.warn("ElevenLabs is disabled: the API is not available from this server's country; set ELEVENLABS_BASE_URL to a proxy");return null;}
    console.warn(`ElevenLabs voices are unavailable (${error?.code??"error"})`);logs?.captureException(error,{operation:"listElevenLabsVoices"});
  }
  const voice=env.ELEVENLABS_VOICE_ID?.trim()||voices.find(item=>item.language==="ru")?.id||voices[0]?.id;
  if(!voice){console.warn("ElevenLabs is disabled: set ELEVENLABS_VOICE_ID");return null;}
  // A spare key of another account may lack the voice: it would fail only when the first key runs out of credits.
  for(const [index,key] of apiKeys.entries()) {
    if(!index)continue;
    const expected=key.voice??voice;
    try {if(!(await listElevenLabsVoices({apiKey:key.apiKey,baseUrl,proxyToken,fetchImpl})).some(item=>item.id===expected))console.warn(`ElevenLabs key #${index+1} does not see the voice ${expected}`);}
    catch(error) {console.warn(`ElevenLabs key #${index+1}: voices are unavailable (${error?.code??"error"})`);}
  }
  return createElevenLabsTts({apiKeys,voice,voices,tagNarration:createAudioTagger(provider),model:env.ELEVENLABS_MODEL?.trim()||undefined,baseUrl,proxyToken,fetchImpl});
}

export const EDITORIAL_PLACE_IMAGES=fileURLToPath(new URL("./place-images-editorial.json",import.meta.url));

/**
 * Mirrors the editorial photo catalog into the store on every start (a malformed catalog stops the start) and, only
 * with PLACE_IMAGE_SYNC=true, builds the Wikimedia photo service. Off by default: local test placeholders make
 * thousands of places "published" and would download their photos on a development machine.
 * @param {{env: NodeJS.ProcessEnv, store: ReturnType<typeof createStore>, directory: string, origin: string, logs?: any, fetchImpl?: typeof fetch, catalogPath?: string}} options
 */
export async function setupPlaceImages({env,store,directory,origin,logs=null,fetchImpl=fetch,catalogPath=EDITORIAL_PLACE_IMAGES}) {
  store.syncEditorialPlaceImages(JSON.parse(await readFile(catalogPath,"utf8")));
  if(env.PLACE_IMAGE_SYNC!=="true")return null;
  await mkdir(directory,{recursive:true});
  const client=createWikimediaClient({fetch:fetchImpl,userAgent:placeImageUserAgent(origin)});
  return createPlaceImageService({store,client,directory,logs});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const directory=resolve(process.env.DATA_DIR??"backend/data");
  const localTts=loadLocalTtsConfig(process.env);
  const userDailyLimit=parseUserDailyLimit(process.env.USER_DAILY_GENERATION_LIMIT);
  const ttsApiClient=localTts.transport==="http"?createTtsApiClient({baseUrl:process.env.TTS_API_URL,token:process.env.TTS_API_TOKEN}):null;
  const provider=process.env.OPENAI_API_KEY&&process.env.OPENAI_BASE_URL?createProvider({apiKey:process.env.OPENAI_API_KEY,baseUrl:process.env.OPENAI_BASE_URL,model:process.env.STORY_MODEL,writerModel:process.env.WRITER_MODEL,searchModel:process.env.RESEARCH_SEARCH_MODEL||null,deepResearchModel:process.env.RESEARCH_DEEP_MODEL||null}):null;
  const yandexTts=process.env.YANDEX_TTS_API_KEY?createYandexTts({apiKey:process.env.YANDEX_TTS_API_KEY,voice:process.env.YANDEX_TTS_VOICE||"marina"}):null;
  const logs=createBackendLogger();
  const elevenLabsTts=await loadElevenLabsTts(process.env,provider,logs);
  const store=createStore(join(directory,"jobs.sqlite"),{maxActive:2,workerLeaseSecret:workerLeaseSecret({transport:localTts.transport}),normalizeExternalText:normalizeForSpeech,
    externalTtsProfiles:{...localTts.profiles,...(elevenLabsTts?{[ELEVENLABS_PROFILE_ID]:elevenLabsProfile(elevenLabsTts.voice,elevenLabsTts.ttsModel)}:{})}});
  store.recoverInterrupted();
  store.recoverContentJobs();
  const port=Number(process.env.PORT??4175);
  const appOrigin=process.env.APP_ORIGIN??`http://127.0.0.1:${port}`;
  const authRuntime=await createAuth({databasePath:join(directory,"auth.sqlite"),baseURL:appOrigin,secret:process.env.BETTER_AUTH_SECRET,production:process.env.NODE_ENV==="production"});
  const accountStore=createAccountStore(authRuntime.accountDatabase);
  if(process.env.PROMO_WALKS_TOKEN)ensurePromoWalksUser(authRuntime.accountDatabase);
  const osmGeocoder=openOsmGeocoder(join(directory,"osm-addresses.sqlite"));
  const foodIndex=openFoodIndex(join(directory,"osm-food.sqlite"));
  const imageDirectory=join(directory,"place-images");
  const placeImages=await setupPlaceImages({env:process.env,store,directory:imageDirectory,origin:appOrigin,logs});
  try {const swept=await sweepAudioTemporaries(join(directory,"audio"));if(swept)console.log(`Removed ${swept} abandoned temporary audio files`);}
  catch(error) {logs?.captureException(error,{operation:"sweepAudioTemporaries"});}
  const app=createApp({store,provider,osmGeocoder,foodIndex,yandexTts,elevenLabsTts,origin:appOrigin,audioDirectory:join(directory,"audio"),imageDirectory,placeImages,staticDirectory:process.env.STATIC_DIR,localTts,ttsApiClient,logs,auth:authRuntime.auth,authSecret:process.env.BETTER_AUTH_SECRET??"development-only-better-auth-secret-32",accountStore,closeAuth:authRuntime.close,userDailyLimit});
  app.server.listen(port,process.env.HOST??"127.0.0.1",()=>console.log(`Story service listening on ${port}; provider ${provider?"configured":"unavailable"}`));
  let stopping=false;
  for(const signal of ["SIGINT","SIGTERM"])process.on(signal,async()=>{
    // A second signal means the operator does not want to wait for the drain.
    if(stopping){console.error("Forced shutdown");process.exit(1);}
    stopping=true;
    try {await app.close();} catch(error) {console.error("Graceful shutdown failed");logs?.captureException(error,{operation:"shutdown"});}
    try {await logs?.close();} catch {console.error("Airouter logs delivery failed");}
    store.close();process.exit(0);
  });
}

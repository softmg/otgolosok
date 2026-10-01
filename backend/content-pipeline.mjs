import { EDITORIAL_EVIDENCE_VERSION, failure, validateFacts } from "./domain.mjs";
import { validateSourceUrl, fetchSource } from "./safe-fetch.mjs";
import { withRetry } from "./retry.mjs";
import { sourceText } from "./source-text.mjs";
import { researchPrompt, factsPrompt, searchSourcesPrompt } from "./prompts.mjs";
import { requestStructured, usageTokens } from "./model-output.mjs";
import { writeStory } from "./story-writing.mjs";
import { errorMessages, SOURCE_RETRY } from "./pipeline.mjs";
import { restrictWeakIdentityEvidence } from "./identity-triage.mjs";
import { PROVIDER_OUTAGE_CODES } from "./provider.mjs";
import { openDataSource } from "./open-data.mjs";

/** Codes only this pipeline raises; the shared errorMessages cover the rest. The editor reads these in the batch list. */
const CONTENT_FAILURES = {
  SOURCE_EMPTY: "Источник открылся, но полезного текста о месте в нём не нашлось.",
  SOURCE_FAILED: "Источник не удалось прочитать.",
  PROVIDER_FAILED: "Сервис подготовки вернул ошибку. Можно повторить попытку.",
  PROVIDER_REJECTED: "Сервис подготовки отклонил запрос. Можно повторить попытку.",
  INVALID_MODEL_OUTPUT: "Ответ модели не удалось разобрать. Можно повторить попытку.",
  INVALID_DRAFT: "Черновик не прошёл проверку формата. Можно повторить попытку.",
  INTERRUPTED: "Подготовка прервана. Задание можно повторить.",
  PREPARATION_FAILED: "Не удалось подготовить текст. Можно повторить попытку.",
  IDENTITY_QUOTE_INVALID: "Модель подтвердила объект, но её цитата-подтверждение не совпала с текстом источника дословно. Проверьте источник вручную.",
  PLACE_UNCLEAR: "Источники не позволяют уверенно определить объект. Проверьте, о том ли месте найдены материалы.",
  IDENTITY_UNCONFIRMED: "Источники не называют объект так, как он подписан в OSM. Проверьте вручную, о том ли месте найдены материалы.",
  OSM_ADDRESS_LOOKUP_FAILED: "Не удалось прочитать адресные ориентиры OSM. Проверьте локальный адресный индекс перед повтором.",
  DEEP_RESEARCH_UNAVAILABLE: "Глубокое исследование не завершилось. Черновик сохранён. Новый запуск расходует квоту Deep Research.",
  DEEP_RESEARCH_INTERRUPTED: "Глубокое исследование было прервано. Автоматический повтор не запущен, чтобы повторно не расходовать квоту. Запустите его из черновика при необходимости.",
  PERPLEXITY_UNAVAILABLE: "Perplexity недоступен: вероятно, истекла сессия или закончилась квота. Черновик не изменён, повторите позже.",
};

/** The code drives filtering and routing, the message is what the editor reads, so a failure carries both. */
export function contentFailureMessage(code) {
  return errorMessages[code] ?? CONTENT_FAILURES[code] ?? CONTENT_FAILURES.PREPARATION_FAILED;
}

function placeContext(place, locationContext) {
  return {id:place.id,name:place.name,postalAddress:place.address,location:place.location,geometry:place.geometry,tags:place.tags,locationContext};
}

/** How the reviewer sees a place identified without a postal address: its OSM name and type. */
function placeLabel(place) {
  const tags=place.tags??{},type=["historic","tourism","leisure","memorial","artwork_type","amenity"].filter(key=>typeof tags[key]==="string").map(key=>`${key}=${tags[key]}`).join(", ");
  return type?`${place.name} (OSM: ${type})`:place.name;
}

/** Up to `limit` fetchable, distinct URLs of a search result, in its order; `seen` is shared to dedupe across searches. */
function sourcesFrom(result,{limit=5,seen=new Set(),origin=null}={}) {
  return (result.sources??result.citedUrls?.map(url=>({url}))??[]).flatMap(source=>{
    try{const url=validateSourceUrl(source.url).href;if(seen.has(url))return[];seen.add(url);return[{url,title:(source.title||new URL(url).hostname).slice(0,250),...(origin?{origin}:{})}];}catch{return[];}}).slice(0,limit);
}
const MAX_RESEARCH_SOURCES=8;

/** Draft re-research asks for Perplexity explicitly: without it the regular search would only repeat the current draft. */
export const PERPLEXITY_REQUIRED="perplexity_required";
export const DEEP_RESEARCH_REQUIRED="perplexity_deep_required";
// Leave time to fetch sources, extract facts and review the story after both search attempts.
const DEEP_CONTENT_TIMEOUT_MS=45*60*1000;

function invalidateEditorialCheckpoint(checkpoint) {
  const retained={...checkpoint};
  for(const key of ["evidence","draft","review","reviewRounds","draftCandidateRaw","editorialVersion","factsRejection"])delete retained[key];
  return retained;
}

const clip=(value,max)=>typeof value==="string"?value.trim().slice(0,max):null;

/** What the model answered when its facts were rejected: without it an editor cannot tell why the place stopped. Model output is untrusted, so only known fields are kept, clipped to the validateFacts limits. */
function factsRejection(code,value) {
  const facts=Array.isArray(value?.facts)?value.facts.slice(0,8).map(fact=>({claim:clip(fact?.claim,600),kind:clip(fact?.kind,40),subjectRelation:clip(fact?.subjectRelation,40),
    evidence:Array.isArray(fact?.evidence)?fact.evidence.slice(0,3).map(proof=>({sourceId:clip(proof?.sourceId,20),quote:clip(proof?.quote,500)})):[]})):[];
  return {code,addressConfirmed:value?.addressConfirmed===true,...(Object.hasOwn(value??{},"identityConfirmed")?{identityConfirmed:value.identityConfirmed===true}:{}),
    identityNote:clip(value?.identityNote,1000),placeName:clip(value?.placeName,160),resolvedAddress:clip(value?.resolvedAddress,200),facts};
}

/** One review round as the editor needs it later: the verdict, blocking issues and the claims the reviewer could not support. */
function reviewRound(round,review) {
  const unsupportedClaims=Array.isArray(review?.claims)?review.claims.filter(claim=>claim?.supported!==true).slice(0,20).map(claim=>({paragraph:Number.isInteger(claim?.paragraph)?claim.paragraph:null,text:clip(claim?.text,600)})):[];
  return {round,approved:review?.approved===true,issues:Array.isArray(review?.issues)?review.issues.slice(0,10).map(issue=>clip(String(issue),600)):[],unsupportedClaims};
}

/**
 * @param {any} job
 * @param {{store: ReturnType<typeof import("./store.mjs").createStore>,
 *   provider: {writerModel?: string, response: (prompt: string, options?: object) => Promise<any>,
 *     deepResearchModel?: string | null, deepResearchSources?: ((prompt: string, options?: {signal?: AbortSignal}) => Promise<{sources: {url: string, title?: string}[]}>) | null,
 *     searchModel?: string | null, searchSources?: ((prompt: string, options?: {signal?: AbortSignal}) => Promise<{sources: {url: string, title?: string}[]}>) | null},
 *   fetchPage?: (url: string, options?: {signal?: AbortSignal}) => Promise<any>, resolveLocation?: ((place: any) => any) | null,
 *   signal?: AbortSignal, timeoutMs?: number, autoApprove?: boolean, onSearchFailure?: (code: string) => void}} options
 */
export async function runContentJob(job,{store,provider,fetchPage=fetchSource,resolveLocation=null,signal,timeoutMs=job.checkpoint?.researchMode===DEEP_RESEARCH_REQUIRED?DEEP_CONTENT_TIMEOUT_MS:600000,autoApprove=false,onSearchFailure=()=>{}}) {
  const deadline=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);let checkpoint=job.checkpoint??{};
  const save=patch=>{checkpoint={...checkpoint,...patch};store.updateContentCheckpoint(job.id,checkpoint);};
  const call=async(prompt,options={})=>{const result=await provider.response(prompt,{...options,signal:deadline});const tokens=usageTokens(result.usage);if(tokens)save({usageTokens:Number(checkpoint.usageTokens??0)+tokens});return result;};
  try {
    if(resolveLocation && !checkpoint.locationContext) save({locationContext:resolveLocation(job.place)});
    const context=placeContext(job.place,checkpoint.locationContext);
    // A job moved to weak_identity after its evidence was saved must be re-checked under the stricter rules.
    const weakEvidenceMissing=job.identityPolicy==="weak_identity"&&checkpoint.evidence&&checkpoint.evidence.identityPolicy!=="weak_identity";
    if(checkpoint.evidence?.version!==EDITORIAL_EVIDENCE_VERSION||weakEvidenceMissing){checkpoint=invalidateEditorialCheckpoint(checkpoint);store.updateContentCheckpoint(job.id,checkpoint);}
    // Open-data records matched offline to this place (data.mos.ru) are sources like fetched pages, listed first.
    const openSources=(store.getOpenDataSources?.(job.place.id)??[]).map((item,index)=>openDataSource(item,`d${index+1}`));
    const openKey=source=>`${source.openData.datasetId}:${source.openData.recordId}`;
    // A job stopped before the import picks the record up on retry; facts and the story must be redone with it.
    if(checkpoint.sources&&openSources.some(source=>!checkpoint.sources.some(saved=>saved.openData&&openKey(saved)===openKey(source)))){
      checkpoint={...invalidateEditorialCheckpoint(checkpoint),sources:[...openSources,...checkpoint.sources.filter(saved=>!saved.openData)]};store.updateContentCheckpoint(job.id,checkpoint);}
    if(!checkpoint.research&&!checkpoint.sources){
      // Weakly identified places also get a search model's citations (Perplexity), ranked first. Only its URLs are used:
      // pages are fetched and quotes checked like any other source. Its failure never stops a regular job.
      const seen=new Set(),deep=checkpoint.researchMode===DEEP_RESEARCH_REQUIRED,required=deep||checkpoint.researchMode===PERPLEXITY_REQUIRED;let found=[],perplexity=null;
      // Saved before the regular search: a retry after its failure must not spend the scarce search quota again.
      if(checkpoint.perplexityResearch){({sources:found,perplexity}=checkpoint.perplexityResearch);for(const source of found)seen.add(source.url);}
      else if(deep){
        if(checkpoint.deepResearchStarted)throw failure("DEEP_RESEARCH_INTERRUPTED");
        if(!provider.deepResearchSources)throw failure("DEEP_RESEARCH_UNAVAILABLE");
        save({deepResearchStarted:true});
        try {
          found=sourcesFrom(await provider.deepResearchSources(`${searchSourcesPrompt(context)}\nПроведи глубокое исследование: сопоставь исторические названия, даты и авторов. Поставь в начало списка первоисточники с фактами именно об этом объекте.`,{signal:deadline}),{seen,origin:"perplexity",limit:MAX_RESEARCH_SOURCES});
          if(!found.length)throw failure("NO_SEARCH_EVIDENCE");
          perplexity={status:"ok",count:found.length,model:provider.deepResearchModel,mode:"deep"};
          save({perplexityResearch:{sources:found,perplexity}});
        } catch(error) {save({deepResearchFailure:error?.code??error?.name??"SEARCH_FAILED"});throw failure("DEEP_RESEARCH_UNAVAILABLE");}
      }
      else if(job.identityPolicy==="weak_identity"&&provider.searchSources){
        try{found=sourcesFrom(await provider.searchSources(searchSourcesPrompt(context),{signal:deadline}),{seen,origin:"perplexity"});perplexity={status:"ok",count:found.length,model:provider.searchModel};}
        catch(error){if(deadline.aborted)throw error;const code=error?.code??"SEARCH_FAILED";perplexity={status:"failed",code,count:0,model:provider.searchModel};onSearchFailure(code);}
        if(perplexity.status==="ok"&&!found.length)perplexity={...perplexity,status:"failed",code:"NO_SEARCH_EVIDENCE"};
        if(perplexity.status==="ok")save({perplexityResearch:{sources:found,perplexity}});
      }
      if(required&&perplexity?.status!=="ok")throw failure("PERPLEXITY_UNAVAILABLE");
      const research=deep?{sources:[]}:await call(researchPrompt(job.place.address,context),{search:true,timeoutMs:180000,maxTokens:3000});
      const sources=[...found,...sourcesFrom(research,{seen,origin:perplexity?"search":null})].slice(0,MAX_RESEARCH_SOURCES);
      if(!sources.length&&!openSources.length)throw failure("INSUFFICIENT_EVIDENCE");save({research:{sources,...(perplexity?{perplexity}:{})}});}
    if(checkpoint.perplexityResearch&&checkpoint.research){checkpoint={...checkpoint};delete checkpoint.perplexityResearch;store.updateContentCheckpoint(job.id,checkpoint);}
    if(!checkpoint.sources){const results=await Promise.allSettled(checkpoint.research.sources.map(async(source,index)=>{const page=await withRetry(()=>fetchPage(source.url,{signal:deadline}),SOURCE_RETRY(deadline));const text=await sourceText(page,{keywords:[job.place.name,job.place.address]});if(text.length<300)throw failure("SOURCE_EMPTY");return{id:`s${index+1}`,url:page.url,title:source.title,publisher:new URL(page.url).hostname.split(".").slice(-2).join("."),text};}));
      const sources=[...openSources,...results.filter(result=>result.status==="fulfilled").map(result=>result.value)];if(!sources.length)throw failure("SOURCE_ACCESS_FAILED");save({sources,sourceFailures:results.filter(result=>result.status==="rejected").map(result=>result.reason?.code??"SOURCE_FAILED")});}
    if(!checkpoint.evidence){
      // A rejection from an earlier attempt must not be mistaken for the outcome of this one.
      if(checkpoint.factsRejection){checkpoint={...checkpoint};delete checkpoint.factsRejection;store.updateContentCheckpoint(job.id,checkpoint);}
      const anchor=job.place.address;const facts=await requestStructured(provider,factsPrompt(anchor,checkpoint.sources,context),{signal:deadline,timeoutMs:150000,maxTokens:5500});
      const raw={...facts.value,addressConfirmed:facts.value.addressConfirmed===true,resolvedAddress:facts.value.resolvedAddress||job.place.address||job.place.name,placeName:facts.value.placeName||job.place.name};
      let evidence;
      try{evidence=validateFacts(raw,checkpoint.sources,{requireEditorialScope:true,identityMode:"place"});if(job.identityPolicy==="weak_identity")evidence=restrictWeakIdentityEvidence(evidence);}
      catch(error){if(error?.code)save({factsRejection:factsRejection(error.code,facts.value)});throw error;}
      save({evidence,editorialVersion:EDITORIAL_EVIDENCE_VERSION});}
    // Evidence saved before identityMode "place" has no addressConfirmed flag: it was validated against the address.
    const placeIdentified=checkpoint.evidence.addressConfirmed===false;
    if(!checkpoint.draft){const draft=await writeStory(checkpoint.evidence,{profile:job.profile,provider,address:placeIdentified?placeLabel(job.place):job.place.address??job.place.name,placeIdentified,signal:deadline,onCandidate:candidate=>save({draftCandidateRaw:candidate}),
      onReview:(review,round=1)=>save({review,reviewRounds:[...(round>1?checkpoint.reviewRounds??[]:[]),reviewRound(round,review)]})});save({draft});}
    const completed=store.completeContentJob(job.id,{story:checkpoint.draft,evidence:checkpoint.evidence,verification:"automatic",autoApprove,replaceDraft:[PERPLEXITY_REQUIRED,DEEP_RESEARCH_REQUIRED].includes(checkpoint.researchMode)});
    if(autoApprove&&completed.story.audioDisposition!=="not_applicable_short_text")for(const profileId of completed.audioProfiles)await store.enqueueExternalAudio({sourceJobId:`place-text:${completed.id}`,sourceRevision:0,
      story:{...completed.story,address:job.place.address??job.place.name},profileId,signal:deadline});
    return completed;
  } catch(error) {
    const code=["TimeoutError","AbortError"].includes(error?.name)?"TIMEOUT":error?.code??"PREPARATION_FAILED";
    const state=code==="INSUFFICIENT_EVIDENCE"?"insufficient_evidence":["REVIEW_REQUIRED","ADDRESS_UNCLEAR","PLACE_UNCLEAR","IDENTITY_QUOTE_INVALID","IDENTITY_UNCONFIRMED"].includes(code)?"review_required":"failed";
    return store.failContentJob(job.id,{code,message:contentFailureMessage(code)},state,{countAttempt:!PROVIDER_OUTAGE_CODES.has(code)});
  }
}

const OUTAGE_PAUSE_MS = 60000, OUTAGE_PAUSE_MAX_MS = 30*60000, SEARCH_REPORT_INTERVAL_MS = 30*60000;

/**
 * While the provider is unavailable (429, 5xx, rejected key, network/DNS) the worker stops claiming jobs, pausing
 * 1, 2, 4… up to 30 minutes, and then probes with a single job; one result from the provider resumes full concurrency.
 * A store error (e.g. SQLITE_BUSY while another process holds the write lock) is logged and retried on the next tick.
 */
export function startContentWorker(options) {
  let stopped=false,outages=0,pausedUntil=0;const running=new Set(),controller=new AbortController(),concurrency=Math.max(1,Math.min(32,Number(options.concurrency??1)||1)),now=options.now??Date.now;
  const settle=result=>{
    // Remote logs may go through the same unavailable provider, so the container log gets these events too.
    if(!PROVIDER_OUTAGE_CODES.has(result?.error?.code)){if(outages)console.warn(`Content provider is available again after ${outages} failed probe(s)`);outages=0;pausedUntil=0;return;}
    outages++;const pause=Math.min(OUTAGE_PAUSE_MAX_MS,OUTAGE_PAUSE_MS*2**(outages-1));pausedUntil=now()+pause;
    console.warn(`Content provider unavailable (${result.error.code}); queue paused for ${Math.round(pause/1000)} s`);
    if(outages===1)options.logs?.captureMessage("Content provider unavailable; queue paused","warn",{operation:"contentWorker",context:{code:result.error.code}});
  };
  // Every search failure goes to the container log; remote logs get one message per half hour, not one per job.
  let searchReportedAt=-Infinity;
  const onSearchFailure=code=>{console.warn(`Source search unavailable (${code})`);
    if(now()-searchReportedAt<SEARCH_REPORT_INTERVAL_MS)return;searchReportedAt=now();
    options.logs?.captureMessage("Perplexity search unavailable","warn",{operation:"contentWorker",context:{code}});};
  const wake=()=>{if(stopped||!options.provider||now()<pausedUntil)return;
    const limit=outages?1:concurrency;
    try{while(running.size<limit){const job=options.store.claimContentJob();if(!job)break;
      const task=runContentJob(job,{...options,onSearchFailure,signal:controller.signal}).then(settle,error=>options.logs?.captureException(error,{operation:"contentJob",context:{jobId:job.id}})).finally(()=>{running.delete(task);if(!stopped)queueMicrotask(wake);});running.add(task);}}
    catch(error){options.logs?.captureException(error,{operation:"contentWorker.claim"});if(!options.logs)console.error("Content worker could not claim a job",error?.code??error);}};
  const timer=setInterval(wake,2000);wake();return{wake,stop:async()=>{stopped=true;clearInterval(timer);controller.abort();await Promise.allSettled(running);}};
}


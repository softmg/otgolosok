import { EDITORIAL_EVIDENCE_VERSION, failure, validateFacts } from "./domain.mjs";
import { validateSourceUrl, fetchSource } from "./safe-fetch.mjs";
import { sourceText } from "./source-text.mjs";
import { researchPrompt, factsPrompt } from "./prompts.mjs";
import { requestStructured, usageTokens } from "./model-output.mjs";
import { writeStory } from "./story-writing.mjs";
import { errorMessages } from "./pipeline.mjs";
import { restrictWeakIdentityEvidence } from "./identity-triage.mjs";

/** Codes only this pipeline raises; the shared errorMessages cover the rest. The editor reads these in the batch list. */
const CONTENT_FAILURES = {
  SOURCE_EMPTY: "Источник открылся, но полезного текста о месте в нём не нашлось.",
  SOURCE_FAILED: "Источник не удалось прочитать.",
  PROVIDER_FAILED: "Сервис подготовки вернул ошибку. Можно повторить попытку.",
  INVALID_MODEL_OUTPUT: "Ответ модели не удалось разобрать. Можно повторить попытку.",
  INVALID_DRAFT: "Черновик не прошёл проверку формата. Можно повторить попытку.",
  INTERRUPTED: "Подготовка прервана. Задание можно повторить.",
  PREPARATION_FAILED: "Не удалось подготовить текст. Можно повторить попытку.",
  PLACE_UNCLEAR: "Источники не позволяют уверенно определить объект. Проверьте, о том ли месте найдены материалы.",
  IDENTITY_UNCONFIRMED: "Источники не называют объект так, как он подписан в OSM. Проверьте вручную, о том ли месте найдены материалы.",
  OSM_ADDRESS_LOOKUP_FAILED: "Не удалось прочитать адресные ориентиры OSM. Проверьте локальный адресный индекс перед повтором.",
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

function sourcesFrom(result) {
  const seen=new Set();
  return (result.sources??result.citedUrls?.map(url=>({url}))??[]).slice(0,5).flatMap(source=>{
    try{const url=validateSourceUrl(source.url).href;if(seen.has(url))return[];seen.add(url);return[{url,title:(source.title||new URL(url).hostname).slice(0,250)}];}catch{return[];}});
}

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

export async function runContentJob(job,{store,provider,fetchPage=fetchSource,resolveLocation=null,signal,timeoutMs=600000,autoApprove=false}) {
  const deadline=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);let checkpoint=job.checkpoint??{};
  const save=patch=>{checkpoint={...checkpoint,...patch};store.updateContentCheckpoint(job.id,checkpoint);};
  const call=async(prompt,options={})=>{const result=await provider.response(prompt,{...options,signal:deadline});const tokens=usageTokens(result.usage);if(tokens)save({usageTokens:Number(checkpoint.usageTokens??0)+tokens});return result;};
  try {
    if(resolveLocation && !checkpoint.locationContext) save({locationContext:resolveLocation(job.place)});
    const context=placeContext(job.place,checkpoint.locationContext);
    // A job moved to weak_identity after its evidence was saved must be re-checked under the stricter rules.
    const weakEvidenceMissing=job.identityPolicy==="weak_identity"&&checkpoint.evidence&&checkpoint.evidence.identityPolicy!=="weak_identity";
    if(checkpoint.evidence?.version!==EDITORIAL_EVIDENCE_VERSION||weakEvidenceMissing){checkpoint=invalidateEditorialCheckpoint(checkpoint);store.updateContentCheckpoint(job.id,checkpoint);}
    if(!checkpoint.research&&!checkpoint.sources){const research=await call(researchPrompt(job.place.address,context),{search:true,timeoutMs:180000,maxTokens:3000});const sources=sourcesFrom(research);if(!sources.length)throw failure("INSUFFICIENT_EVIDENCE");save({research:{sources}});}
    if(!checkpoint.sources){const results=await Promise.allSettled(checkpoint.research.sources.map(async(source,index)=>{const page=await fetchPage(source.url,{signal:deadline});const text=await sourceText(page,{keywords:[job.place.name,job.place.address]});if(text.length<300)throw failure("SOURCE_EMPTY");return{id:`s${index+1}`,url:page.url,title:source.title,publisher:new URL(page.url).hostname.split(".").slice(-2).join("."),text};}));
      const sources=results.filter(result=>result.status==="fulfilled").map(result=>result.value);if(!sources.length)throw failure("SOURCE_ACCESS_FAILED");save({sources,sourceFailures:results.filter(result=>result.status==="rejected").map(result=>result.reason?.code??"SOURCE_FAILED")});}
    if(!checkpoint.evidence){
      // A rejection from an earlier attempt must not be mistaken for the outcome of this one.
      if(checkpoint.factsRejection){checkpoint={...checkpoint};delete checkpoint.factsRejection;store.updateContentCheckpoint(job.id,checkpoint);}
      const anchor=job.place.address;const facts=await requestStructured(provider,factsPrompt(anchor,checkpoint.sources,context),{signal:deadline,timeoutMs:150000,maxTokens:5500});
      const raw={...facts.value,addressConfirmed:facts.value.addressConfirmed===true,resolvedAddress:facts.value.resolvedAddress||job.place.address||job.place.name,placeName:facts.value.placeName||job.place.name};
      let evidence;
      try{evidence=validateFacts(raw,checkpoint.sources,{requireEditorialScope:true,identityMode:"place"});if(job.identityPolicy==="weak_identity")evidence=restrictWeakIdentityEvidence(evidence,job.place);}
      catch(error){if(error?.code)save({factsRejection:factsRejection(error.code,facts.value)});throw error;}
      save({evidence,editorialVersion:EDITORIAL_EVIDENCE_VERSION});}
    // Evidence saved before identityMode "place" has no addressConfirmed flag: it was validated against the address.
    const placeIdentified=checkpoint.evidence.addressConfirmed===false;
    if(!checkpoint.draft){const draft=await writeStory(checkpoint.evidence,{profile:job.profile,provider,address:placeIdentified?placeLabel(job.place):job.place.address??job.place.name,placeIdentified,signal:deadline,onCandidate:candidate=>save({draftCandidateRaw:candidate}),
      onReview:(review,round=1)=>save({review,reviewRounds:[...(round>1?checkpoint.reviewRounds??[]:[]),reviewRound(round,review)]})});save({draft});}
    const completed=store.completeContentJob(job.id,{story:checkpoint.draft,evidence:checkpoint.evidence,verification:"automatic",autoApprove});
    if(autoApprove&&completed.story.audioDisposition!=="not_applicable_short_text")for(const profileId of completed.audioProfiles)await store.enqueueExternalAudio({sourceJobId:`place-text:${completed.id}`,sourceRevision:0,
      story:{...completed.story,address:job.place.address??job.place.name},profileId,signal:deadline});
    return completed;
  } catch(error) {
    const code=["TimeoutError","AbortError"].includes(error?.name)?"TIMEOUT":error?.code??"PREPARATION_FAILED";
    const state=code==="INSUFFICIENT_EVIDENCE"?"insufficient_evidence":["REVIEW_REQUIRED","ADDRESS_UNCLEAR","PLACE_UNCLEAR","IDENTITY_UNCONFIRMED"].includes(code)?"review_required":"failed";
    return store.failContentJob(job.id,{code,message:contentFailureMessage(code)},state);
  }
}

export function startContentWorker(options) {
  let stopped=false;const running=new Set(),controller=new AbortController(),concurrency=Math.max(1,Math.min(32,Number(options.concurrency??1)||1));
  const wake=()=>{if(stopped||!options.provider)return;while(running.size<concurrency){const job=options.store.claimContentJob();if(!job)break;
    const task=runContentJob(job,{...options,signal:controller.signal}).catch(error=>options.logs?.captureException(error,{operation:"contentJob",context:{jobId:job.id}})).finally(()=>{running.delete(task);if(!stopped)queueMicrotask(wake);});running.add(task);}};
  const timer=setInterval(wake,2000);wake();return{wake,stop:async()=>{stopped=true;clearInterval(timer);controller.abort();await Promise.allSettled(running);}};
}

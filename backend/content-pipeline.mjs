import { EDITORIAL_EVIDENCE_VERSION, failure, validateFacts } from "./domain.mjs";
import { validateSourceUrl, fetchSource } from "./safe-fetch.mjs";
import { sourceText } from "./source-text.mjs";
import { researchPrompt, factsPrompt } from "./prompts.mjs";
import { requestStructured, usageTokens } from "./model-output.mjs";
import { writeStory } from "./story-writing.mjs";
import { errorMessages } from "./pipeline.mjs";

/** Codes only this pipeline raises; the shared errorMessages cover the rest. The editor reads these in the batch list. */
const CONTENT_FAILURES = {
  SOURCE_EMPTY: "Источник открылся, но полезного текста о месте в нём не нашлось.",
  SOURCE_FAILED: "Источник не удалось прочитать.",
  PROVIDER_FAILED: "Сервис подготовки вернул ошибку. Можно повторить попытку.",
  INVALID_MODEL_OUTPUT: "Ответ модели не удалось разобрать. Можно повторить попытку.",
  INVALID_DRAFT: "Черновик не прошёл проверку формата. Можно повторить попытку.",
  INTERRUPTED: "Подготовка прервана. Задание можно повторить.",
  PREPARATION_FAILED: "Не удалось подготовить текст. Можно повторить попытку.",
  OSM_ADDRESS_LOOKUP_FAILED: "Не удалось прочитать адресные ориентиры OSM. Проверьте локальный адресный индекс перед повтором.",
};

/** The code drives filtering and routing, the message is what the editor reads, so a failure carries both. */
export function contentFailureMessage(code) {
  return errorMessages[code] ?? CONTENT_FAILURES[code] ?? CONTENT_FAILURES.PREPARATION_FAILED;
}

function placeContext(place, locationContext) {
  return {id:place.id,name:place.name,postalAddress:place.address,location:place.location,geometry:place.geometry,tags:place.tags,locationContext};
}

function sourcesFrom(result) {
  const seen=new Set();
  return (result.sources??result.citedUrls?.map(url=>({url}))??[]).slice(0,5).flatMap(source=>{
    try{const url=validateSourceUrl(source.url).href;if(seen.has(url))return[];seen.add(url);return[{url,title:(source.title||new URL(url).hostname).slice(0,250)}];}catch{return[];}});
}

function invalidateEditorialCheckpoint(checkpoint) {
  const retained={...checkpoint};
  for(const key of ["evidence","draft","review","draftCandidateRaw","editorialVersion"])delete retained[key];
  return retained;
}

export async function runContentJob(job,{store,provider,fetchPage=fetchSource,resolveLocation=null,signal,timeoutMs=600000,autoApprove=false}) {
  const deadline=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);let checkpoint=job.checkpoint??{};
  const save=patch=>{checkpoint={...checkpoint,...patch};store.updateContentCheckpoint(job.id,checkpoint);};
  const call=async(prompt,options={})=>{const result=await provider.response(prompt,{...options,signal:deadline});const tokens=usageTokens(result.usage);if(tokens)save({usageTokens:Number(checkpoint.usageTokens??0)+tokens});return result;};
  try {
    if(resolveLocation && !checkpoint.locationContext) save({locationContext:resolveLocation(job.place)});
    const context=placeContext(job.place,checkpoint.locationContext);
    if(checkpoint.evidence?.version!==EDITORIAL_EVIDENCE_VERSION){checkpoint=invalidateEditorialCheckpoint(checkpoint);store.updateContentCheckpoint(job.id,checkpoint);}
    if(!checkpoint.research&&!checkpoint.sources){const research=await call(researchPrompt(job.place.address,context),{search:true,timeoutMs:180000,maxTokens:3000});const sources=sourcesFrom(research);if(!sources.length)throw failure("INSUFFICIENT_EVIDENCE");save({research:{sources}});}
    if(!checkpoint.sources){const results=await Promise.allSettled(checkpoint.research.sources.map(async(source,index)=>{const page=await fetchPage(source.url,{signal:deadline});const text=await sourceText(page,{keywords:[job.place.name,job.place.address]});if(text.length<300)throw failure("SOURCE_EMPTY");return{id:`s${index+1}`,url:page.url,title:source.title,publisher:new URL(page.url).hostname.split(".").slice(-2).join("."),text};}));
      const sources=results.filter(result=>result.status==="fulfilled").map(result=>result.value);if(!sources.length)throw failure("SOURCE_ACCESS_FAILED");save({sources,sourceFailures:results.filter(result=>result.status==="rejected").map(result=>result.reason?.code??"SOURCE_FAILED")});}
    if(!checkpoint.evidence){const anchor=job.place.address;const facts=await requestStructured(provider,factsPrompt(anchor,checkpoint.sources,context),{signal:deadline,timeoutMs:150000,maxTokens:5500});
      const raw={...facts.value,addressConfirmed:facts.value.addressConfirmed===true,resolvedAddress:facts.value.resolvedAddress||job.place.address||job.place.name,placeName:facts.value.placeName||job.place.name};
      save({evidence:validateFacts(raw,checkpoint.sources,{requireEditorialScope:true}),editorialVersion:EDITORIAL_EVIDENCE_VERSION});}
    if(!checkpoint.draft){const draft=await writeStory(checkpoint.evidence,{profile:job.profile,provider,address:job.place.address??job.place.name,signal:deadline,onCandidate:candidate=>save({draftCandidateRaw:candidate}),onReview:review=>save({review})});save({draft});}
    const completed=store.completeContentJob(job.id,{story:checkpoint.draft,evidence:checkpoint.evidence,verification:"automatic",autoApprove});
    if(autoApprove&&completed.story.audioDisposition!=="not_applicable_short_text")for(const profileId of completed.audioProfiles)await store.enqueueExternalAudio({sourceJobId:`place-text:${completed.id}`,sourceRevision:0,
      story:{...completed.story,address:job.place.address??job.place.name},profileId,signal:deadline});
    return completed;
  } catch(error) {
    const code=["TimeoutError","AbortError"].includes(error?.name)?"TIMEOUT":error?.code??"PREPARATION_FAILED";
    const state=code==="INSUFFICIENT_EVIDENCE"?"insufficient_evidence":["REVIEW_REQUIRED","ADDRESS_UNCLEAR"].includes(code)?"review_required":"failed";
    return store.failContentJob(job.id,{code,message:contentFailureMessage(code)},state);
  }
}

export function startContentWorker(options) {
  let stopped=false;const running=new Set(),controller=new AbortController(),concurrency=Math.max(1,Math.min(32,Number(options.concurrency??1)||1));
  const wake=()=>{if(stopped||!options.provider)return;while(running.size<concurrency){const job=options.store.claimContentJob();if(!job)break;
    const task=runContentJob(job,{...options,signal:controller.signal}).catch(error=>options.logs?.captureException(error,{operation:"contentJob",context:{jobId:job.id}})).finally(()=>{running.delete(task);if(!stopped)queueMicrotask(wake);});running.add(task);}};
  const timer=setInterval(wake,2000);wake();return{wake,stop:async()=>{stopped=true;clearInterval(timer);controller.abort();await Promise.allSettled(running);}};
}

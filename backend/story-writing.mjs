import { failure } from "./domain.mjs";
import { draftPrompt, reviewPrompt } from "./prompts.mjs";
import { requestStructured } from "./model-output.mjs";

const limits = profile => profile === "description-v1" ? {minWords:20,maxWords:100,minParagraphs:1,maxParagraphs:3} : {minWords:100,maxWords:250,minParagraphs:2,maxParagraphs:6};

export function parseStoryText(text,{profile="story-v1"}={}) {
  if(typeof text!=="string")throw failure("INVALID_DRAFT","Writer returned no text.");
  const paragraphs=text.replace(/\r\n?/g,"\n").split(/\n\s*\n/u).map(value=>value.trim()).filter(Boolean);
  const wordCount=paragraphs.join(" ").split(/\s+/u).filter(Boolean).length,rule=limits(profile);
  if(paragraphs.length<rule.minParagraphs||paragraphs.length>rule.maxParagraphs)throw failure("INVALID_DRAFT",`Expected ${rule.minParagraphs}-${rule.maxParagraphs} paragraphs; got ${paragraphs.length}.`);
  if(paragraphs.some(value=>value.length>2000))throw failure("INVALID_DRAFT","A paragraph exceeds 2000 characters.");
  if(wordCount<rule.minWords||wordCount>rule.maxWords)throw failure("INVALID_DRAFT",`Expected ${rule.minWords}-${rule.maxWords} words; got ${wordCount}.`);
  return {paragraphs:paragraphs.map(value=>({text:value,factIds:[]})),wordCount};
}

function acceptReview(value,paragraphs,evidence) {
  if(typeof value?.approved!=="boolean"||!Array.isArray(value.issues)||!Array.isArray(value.paragraphFacts)||
      !Array.isArray(value.claims)||!value.checks||typeof value.checks!=="object")throw failure("INVALID_MODEL_OUTPUT");
  if(!value.approved||value.issues.length)throw Object.assign(failure("REVIEW_REQUIRED"),{issues:value.issues});
  if(value.checks.substantive!==true||value.checks.subjectAligned!==true||value.checks.audioClear!==true)throw failure("INVALID_MODEL_OUTPUT");
  const facts=new Map(evidence.facts.map(fact=>[fact.id,fact])),available=new Set(facts.keys()),byParagraph=new Map();
  for(const item of value.paragraphFacts){if(!Number.isInteger(item?.paragraph)||item.paragraph<1||item.paragraph>paragraphs.length||byParagraph.has(item.paragraph)||!Array.isArray(item.factIds)||!item.factIds.length||item.factIds.some(id=>!available.has(id)))throw failure("INVALID_MODEL_OUTPUT");byParagraph.set(item.paragraph,[...new Set(item.factIds)]);}
  if(byParagraph.size!==paragraphs.length||!value.claims.length)throw failure("INVALID_MODEL_OUTPUT");
  const claimCounts=new Map();
  for(const claim of value.claims){
    if(!Number.isInteger(claim?.paragraph)||claim.paragraph<1||claim.paragraph>paragraphs.length||typeof claim.text!=="string"||!claim.text.trim()||
        !paragraphs[claim.paragraph-1].text.includes(claim.text)||claim.supported!==true||!Array.isArray(claim.factIds)||!claim.factIds.length||
        claim.factIds.some(id=>!available.has(id))||(claim.address===true&&!claim.factIds.some(id=>facts.get(id)?.kind==="address")))throw failure("INVALID_MODEL_OUTPUT");
    claimCounts.set(claim.paragraph,(claimCounts.get(claim.paragraph)??0)+1);
  }
  if(paragraphs.some((_,index)=>!claimCounts.has(index+1)))throw failure("INVALID_MODEL_OUTPUT");
  return byParagraph;
}

function parseForRequestedProfile(text,requestedProfile) {
  try{return{parsed:parseStoryText(text,{profile:requestedProfile}),effectiveProfile:requestedProfile};}
  catch(error){const words=typeof text==="string"?text.trim().split(/\s+/u).filter(Boolean).length:0;
    if(requestedProfile==="story-v1"&&words>=20&&words<100)return{parsed:parseStoryText(text,{profile:"description-v1"}),effectiveProfile:"description-v1",downgradeReason:"insufficient_material_for_story"};
    throw error;}
}

export async function writeStory(evidence,{profile="story-v1",provider,address=evidence.resolvedAddress,signal,onCandidate=()=>{},onReview=()=>{}}={}) {
  let effectiveProfile=profile,downgradeReason,result=await provider.response(draftPrompt(evidence,effectiveProfile),{model:provider.writerModel,signal,timeoutMs:180000,maxTokens:3200});
  let parsed;
  try{({parsed,effectiveProfile,downgradeReason}=parseForRequestedProfile(result.text,profile));}
  catch(error){
    onCandidate({text:String(result.text??"").slice(0,32000),validationIssues:[{code:error.code,path:"text",actual:error.message}]});result=await provider.response(`${draftPrompt(evidence,profile)}\n\nПредыдущий текст не прошёл проверку: ${error.message}. Верни полный исправленный текст.`,{model:provider.writerModel,signal,timeoutMs:180000,maxTokens:3200});
    try{({parsed,effectiveProfile,downgradeReason}=parseForRequestedProfile(result.text,profile));}
    catch(repairError){onCandidate({text:String(result.text??"").slice(0,32000),validationIssues:[{code:repairError.code,path:"text",actual:repairError.message}]});throw repairError;}
  }
  onCandidate({text:result.text.slice(0,32000),validationIssues:[],...(downgradeReason?{downgradeReason}:{})});
  const draft={title:evidence.placeName,address:evidence.resolvedAddress,paragraphs:parsed.paragraphs,wordCount:parsed.wordCount,effectiveProfile};
  let review=await requestStructured(provider,reviewPrompt(address,{...draft,paragraphs:draft.paragraphs.map((p,index)=>({paragraph:index+1,text:p.text}))},evidence),{signal,timeoutMs:120000,maxTokens:1800});
  onReview(review.value,1);
  let links;
  try{links=acceptReview(review.value,draft.paragraphs,evidence);}
  catch(error){
    if(error.code!=="REVIEW_REQUIRED"||!error.issues?.length)throw error;
    result=await provider.response(`${draftPrompt(evidence,profile)}\n\nИсправь только блокирующие замечания редактора: ${JSON.stringify(error.issues)}. Отклонённый текст: ${JSON.stringify(result.text).slice(0,12000)}`,{model:provider.writerModel,signal,timeoutMs:180000,maxTokens:3200});
    try{({parsed,effectiveProfile,downgradeReason}=parseForRequestedProfile(result.text,profile));}
    catch(rewriteError){onCandidate({text:String(result.text??"").slice(0,32000),validationIssues:[{code:rewriteError.code,path:"text",actual:rewriteError.message}]});throw rewriteError;}
    onCandidate({text:result.text.slice(0,32000),validationIssues:[],...(downgradeReason?{downgradeReason}:{})});draft.paragraphs=parsed.paragraphs;draft.wordCount=parsed.wordCount;draft.effectiveProfile=effectiveProfile;
    review=await requestStructured(provider,reviewPrompt(address,{...draft,paragraphs:draft.paragraphs.map((p,index)=>({paragraph:index+1,text:p.text}))},evidence),{signal,timeoutMs:120000,maxTokens:1800});onReview(review.value,2);links=acceptReview(review.value,draft.paragraphs,evidence);
  }
  draft.paragraphs=draft.paragraphs.map((paragraph,index)=>({...paragraph,factIds:links.get(index+1)}));
  const used=new Set(draft.paragraphs.flatMap(paragraph=>paragraph.factIds));
  const usedSources=new Set(evidence.facts.filter(fact=>used.has(fact.id)).flatMap(fact=>fact.evidence.map(proof=>proof.sourceId)));
  return {...draft,...(downgradeReason?{downgradeReason}:{}),verification:"automatic",requestedProfile:profile,audioDisposition:effectiveProfile==="story-v1"?"eligible":"not_applicable_short_text",sources:evidence.sources.filter(source=>usedSources.has(source.id)).map(({id,url,title,publisher})=>({id,url,title,publisher})),facts:evidence.facts.filter(fact=>used.has(fact.id)).map(fact=>({id:fact.id,claim:fact.claim,sourceIds:fact.evidence.map(proof=>proof.sourceId)}))};
}

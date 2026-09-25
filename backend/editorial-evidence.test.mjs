import test from "node:test";
import assert from "node:assert/strict";
import { EDITORIAL_EVIDENCE_VERSION, validateFacts } from "./domain.mjs";

const quote="Памятник создал скульптор в 1980 году для этой городской площади.";
const sources=[{id:"s1",url:"https://ru.wikipedia.org/wiki/Test",title:"Википедия",publisher:"wikipedia.org",text:quote.repeat(6)},
  {id:"s2",url:"https://unused.example/page",title:"Не использован",publisher:"unused.example",text:"Другой источник с достаточным объёмом текста. ".repeat(8)}];
const base={addressConfirmed:true,identityNote:"Источник и координаты описывают выбранный памятник",placeName:"Памятник",resolvedAddress:"Москва, площадь Примерная",
  facts:[{claim:"Памятник создал скульптор в 1980 году.",kind:"content",subjectRelation:"object",contentReason:"Сообщает автора и время создания",topic:"place_history",scope:"site",location:"Памятник",distanceMeters:null,evidence:[{sourceId:"s1",quote}]}]};

test("new automatic evidence requires substantive content but permits Wikipedia alone",()=>{
  const evidence=validateFacts(base,sources,{requireEditorialScope:true});
  assert.equal(evidence.version,EDITORIAL_EVIDENCE_VERSION);
  assert.deepEqual(evidence.sources.map(source=>source.id),["s1"]);
  assert.equal(evidence.facts[0].kind,"content");
});

test("identity, address, category and duplicate claims cannot replace content",()=>{
  const facts=[
    {claim:"Это памятник.",kind:"identity",subjectRelation:"object"},
    {claim:"Москва, площадь Примерная.",kind:"address",subjectRelation:"object"},
    {claim:"Это памятник.",kind:"identity",subjectRelation:"object"},
  ].map((fact,index)=>({...fact,topic:"place_history",scope:"site",location:"Памятник",distanceMeters:null,evidence:[{sourceId:"s1",quote}],interesting:index===0}));
  assert.throws(()=>validateFacts({...base,facts},sources,{requireEditorialScope:true}),{code:"INSUFFICIENT_EVIDENCE"});
});

test("address evidence belongs to the object and malformed content is discarded",()=>{
  const address={claim:"Памятник находится на площади.",kind:"address",subjectRelation:"nearby",topic:"place_history",scope:"site",location:"Памятник",distanceMeters:null,evidence:[{sourceId:"s1",quote}]};
  const malformed={...base.facts[0],contentReason:""};
  assert.throws(()=>validateFacts({...base,facts:[address,malformed]},sources,{requireEditorialScope:true}),{code:"INSUFFICIENT_EVIDENCE"});
});

test("legacy editorial evidence remains readable",()=>{
  const evidence=validateFacts({...base,facts:[{claim:"Старый факт",evidence:[{sourceId:"s1",quote}]}]},sources);
  assert.equal(evidence.facts.length,1);
  assert.equal(evidence.facts[0].kind,undefined);
});

const placeFact=(kind,subjectRelation="object")=>({claim:`Факт вида ${kind} об объекте.`,kind,subjectRelation,...(kind==="content"?{contentReason:"Сообщает автора и время создания"}:{}),
  topic:"place_history",scope:"site",location:"Памятник",distanceMeters:null,evidence:[{sourceId:"s1",quote}]});
const content=placeFact("content"),identity=placeFact("identity"),address=placeFact("address"),neighbourIdentity=placeFact("identity","site_context");

// An OSM place is identified by name, type and location; the user-entered address pipeline keeps the address as its identity.
for(const [name,input,options,expected] of [
  ["address mode still requires the address",{addressConfirmed:false,identityConfirmed:true,facts:[identity,content]},{identityMode:"address"},{code:"ADDRESS_UNCLEAR"}],
  ["address mode ignores identityConfirmed",{addressConfirmed:true,facts:[content]},{identityMode:"address"},["content"]],
  ["place without an address keeps identity and drops address facts",{addressConfirmed:false,identityConfirmed:true,facts:[identity,address,content]},{identityMode:"place"},["identity","content"]],
  ["place with a confirmed address keeps address facts",{addressConfirmed:true,identityConfirmed:true,facts:[identity,address,content]},{identityMode:"place"},["identity","address","content"]],
  ["confirmed address anchors a place without an identity fact",{addressConfirmed:true,identityConfirmed:true,facts:[content]},{identityMode:"place"},["content"]],
  ["unconfirmed identity stops even with an address",{addressConfirmed:true,identityConfirmed:false,facts:[identity,content]},{identityMode:"place"},{code:"PLACE_UNCLEAR"}],
  ["missing identityConfirmed is not a confirmation",{addressConfirmed:true,facts:[identity,content]},{identityMode:"place"},{code:"PLACE_UNCLEAR"}],
  ["no address and no identity fact about the object",{addressConfirmed:false,identityConfirmed:true,facts:[content]},{identityMode:"place"},{code:"PLACE_UNCLEAR"}],
  ["an identity fact about the site does not identify the object",{addressConfirmed:false,identityConfirmed:true,facts:[neighbourIdentity,content]},{identityMode:"place"},{code:"PLACE_UNCLEAR"}],
]) test(`identityMode: ${name}`,()=>{
  const run=()=>validateFacts({...base,...input},sources,{requireEditorialScope:true,...options});
  if(!Array.isArray(expected)){assert.throws(run,expected);return;}
  const evidence=run();
  assert.deepEqual(evidence.facts.map(fact=>fact.kind),expected);
  if(options.identityMode==="place")assert.equal(evidence.addressConfirmed,input.addressConfirmed);
  else assert.equal(Object.hasOwn(evidence,"addressConfirmed"),false);
});

test("identityMode place needs classified facts and rejects unknown modes",()=>{
  assert.throws(()=>validateFacts({...base,identityConfirmed:true},sources,{identityMode:"place"}),TypeError);
  assert.throws(()=>validateFacts(base,sources,{requireEditorialScope:true,identityMode:"name"}),TypeError);
});

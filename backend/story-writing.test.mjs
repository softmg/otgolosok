import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStoryText, postalAddressIn, writeStory } from './story-writing.mjs';

const words=count=>Array.from({length:count},(_,index)=>`слово${index}`).join(' ');
test('plain story parser enforces profile boundaries',()=>{assert.equal(parseStoryText(`${words(50)}\n\n${words(50)}`).wordCount,100);assert.throws(()=>parseStoryText(words(99)),{code:'INVALID_DRAFT'});assert.equal(parseStoryText(words(20),{profile:'description-v1'}).wordCount,20);assert.throws(()=>parseStoryText(words(101),{profile:'description-v1'}),{code:'INVALID_DRAFT'});});

test('postal address detector finds house numbers but keeps places named in words',()=>{
  for(const [text,expected] of [
    ['Дом стоит на улице Примерной, 1, у сквера.','улице Примерной, 1'],
    ['Особняк на Тверском бульваре, 26а построен заново.','бульваре, 26а'],
    ['Музей на Пушкинской площади, 2/1 открыт давно.','площади, 2/1'],
    ['Здание по адресу Никольская улица известно всем.','по адресу'],
    ['Во владении 7 стояли конюшни.','владении 7'],
    ['Строение 2 занимает библиотека.','Строение 2'],
    ['Особняк, д. 5, перестроили.','д. 5'],
    ['Памятник стоит в парке Горького у Москвы-реки.',null],
    ['На Красной площади, 9 мая 1945 года прошёл парад.',null],
    ['Дом 1910 года постройки сохранил фасад.',null],
    ['На этой площади, 2 года спустя, открыли сквер.',null],
    ['Улица Покровка, 12 этажей нового корпуса не появилось.',null],
    ['С 1905 года здесь работала школа.',null],
    ['Фабрика выпускала 300 тысяч изделий.',null],
    ['Дом стоит на Тверской улице.',null],
  ])assert.equal(postalAddressIn(text),expected,text);
});

test('a draft naming a postal address is sent back to the writer',()=>{
  assert.throws(()=>parseStoryText(`Дом стоит на улице Примерной, 1. ${words(20)}`,{profile:'description-v1'}),{code:'INVALID_DRAFT',message:/улице Примерной, 1/});
});

const evidence={placeName:'Дом',resolvedAddress:'Москва, улица Примерная, 1',facts:[
  {id:'f1',claim:'Дом построен в 1900 году.',kind:'content',subjectRelation:'object',contentReason:'Год постройки',evidence:[{sourceId:'s1',quote:'Дом построен в 1900 году.'}]},
  {id:'f2',claim:'Дом находится на улице Примерной, 1.',kind:'address',subjectRelation:'object',evidence:[{sourceId:'s1',quote:'улица Примерная, 1'}]},
],sources:[{id:'s1',url:'https://one.example',title:'Источник',publisher:'one.example'},{id:'s2',url:'https://unused.example',title:'Лишний',publisher:'unused.example'}]};
const checked=(text,{ids=['f1']}={})=>({value:{approved:true,issues:[],checks:{substantive:true,subjectAligned:true,audioClear:true},paragraphFacts:[{paragraph:1,factIds:ids}],claims:[{paragraph:1,text,factIds:ids,supported:true}]}});

test('review rejects duplicate paragraph mappings',async()=>{
  const text=words(20),responses=[{text},{value:{approved:true,issues:[],checks:{substantive:true,subjectAligned:true,audioClear:true},paragraphFacts:[{paragraph:1,factIds:['f1']},{paragraph:1,factIds:['f1']}],claims:[{paragraph:1,text:'слово0',factIds:['f1'],supported:true,address:false}]}}];
  await assert.rejects(writeStory(evidence,{provider:{writerModel:'writer',response:async()=>responses.shift()}}),{code:'INVALID_MODEL_OUTPUT'});
});

test('the writer gets no address facts and an address draft is repaired before review',async()=>{
  const prompts=[],responses=[{text:`Дом стоит на улице Примерной, 1. ${words(20)}`},{text:words(20)},checked('слово0')];
  const result=await writeStory(evidence,{provider:{writerModel:'writer',response:async prompt=>{prompts.push(prompt);return responses.shift();}}});
  assert.equal(result.paragraphs[0].text,words(20));
  assert.doesNotMatch(prompts[0],/Примерной, 1/);
  assert.match(prompts[1],/Remove the postal address «улице Примерной, 1»/);
});

test('editor rewrite may become a short description and publishes only used sources',async()=>{
  const long=`${words(50)}\n\n${words(50)}`,short=words(20),responses=[{text:long},{value:{approved:false,issues:['Слишком сложно для слуха'],checks:{substantive:true,subjectAligned:true,audioClear:false},paragraphFacts:[],claims:[]}},{text:short},checked('слово0')];
  const result=await writeStory(evidence,{provider:{writerModel:'writer',response:async()=>responses.shift()}});
  assert.equal(result.effectiveProfile,'description-v1');
  assert.equal(result.downgradeReason,'insufficient_material_for_story');
  assert.deepEqual(result.sources.map(source=>source.id),['s1']);
});

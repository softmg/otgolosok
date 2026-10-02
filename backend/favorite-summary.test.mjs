import test from 'node:test';
import assert from 'node:assert/strict';
import { favoriteSummary } from './favorite-summary.mjs';
test('favorites resolve owned walks and public stories without exposing private snapshots', () => {
  const context={userId:'user',accountStore:{getWalk:(user,id)=>id==='own'?{id,title:'Мой маршрут',snapshot:{secret:true}}:null},store:{get:()=>null},routes:[{id:'catalog',title:'Каталог'}]};
  assert.equal(favoriteSummary({type:'walk',id:'own'},context).href,'/walk?id=own');
  assert.equal('snapshot' in favoriteSummary({type:'walk',id:'own'},context),false);
  assert.equal(favoriteSummary({type:'walk',id:'other'},context).href,null);
  assert.equal(favoriteSummary({type:'walk',id:'catalog'},context).href,'/walk?catalog=catalog');
  assert.equal(favoriteSummary({type:'story',id:'gone'},context).href,null);
});
test('a favorite story opens on the map', () => {
  const job={id:'11111111-1111-4111-8111-111111111111',address:'Арбат, 10',data:{story:{title:'Дом на Арбате'}}};
  const context={userId:'user',accountStore:{getWalk:()=>null},store:{get:id=>id===job.id?job:null},routes:[]};
  assert.deepEqual(favoriteSummary({type:'story',id:job.id},context),{type:'story',id:job.id,title:'Дом на Арбате',href:`/?job=${job.id}`});
});

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

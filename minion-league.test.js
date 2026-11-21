const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const World = require('./game-world');
const Policy = require('./public/minion-policy');
const Decisions = require('./public/minion-decisions');
const { Pool, LeagueEnvironment } = require('./scripts/minion-league-env');
function model() {
  return { format:Policy.VERSION, rulesVersion:'minion-v1-collection-1', inputSize:1072, hiddenSize:1, featureVersion:'minion-bush-memory/10',
    characters:['alex','bastion','darius','mira'], events:Policy.EVENTS, decisionMode:'learned/1', decisionIntervalTicks:6,
    init:{map:World.MAP,cfg:World.CFG,characters:World.CHARACTERS},
    weights:{hiddenW:[Array(1072).fill(0)],hiddenB:[0],typeW:Policy.EVENTS.map(()=>[0]),typeB:Policy.EVENTS.map(()=>0),pointW:Array.from({length:20},()=>[0]),pointB:Array(20).fill(0)},
    tacticalPolicy:{version:Decisions.VERSION,inputSize:96,contextSize:1072,hiddenSize:1,weights:{hiddenW:[Array(96).fill(0)],hiddenB:[0],contextW:[Array(1072).fill(0)],outputW:[1],outputB:0}} };
}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'axegozen-league-test-'));
const file=path.join(dir,'model.json'), newer=path.join(dir,'new.json');fs.writeFileSync(file,JSON.stringify(model()));
const config={latest:file,history:[file]};
test.after(()=>{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});
test('opponent categories follow exact configured proportions, rotate characters and sides',()=>{
  const pool=new Pool(config),counts={latest:0,history:0,algorithm:0},coverage=new Set(),algorithmCharacters=new Set();
  for(let i=0;i<100;i++){const f=pool.draw(model().characters);counts[f.category]++;coverage.add(f.character+f.slot);if(f.category==='algorithm')algorithmCharacters.add(f.opponentCharacter);}
  assert.deepEqual(counts,{latest:40,history:30,algorithm:30});assert.equal(coverage.size,8);
  assert.equal(algorithmCharacters.size,World.CHARACTERS.length);
  assert.throws(()=>new Pool({...config,weights:{latest:0,history:1,algorithm:1}}));
});
test('refresh freezes opponents in active matches while new matches use the new snapshot',()=>{
  const pool=new Pool(config),env=new LeagueEnvironment(model(),pool);env.reset();
  const original=env.fixture.entry;const next=model();next.tacticalPolicy.weights.outputB=2;fs.writeFileSync(newer,JSON.stringify(next));
  pool.update({latest:newer,history:[file]});assert.equal(env.fixture.entry,original);
  const draws=Array.from({length:10},()=>pool.draw(model().characters));assert.ok(draws.some(f=>f.category==='latest'&&f.entry.file===newer));
});
test('full-match candidates retain towers and the reindeer, with full context and no encounter gate',()=>{
  const env=new LeagueEnvironment(model(),new Pool(config));env.reset();
  for(let i=0;i<160;i++)env.game.tick();env.state=env.game.observe('league-learner');const observation=env.observation();
  assert.equal(observation.x.length,1072);assert.ok(observation.decisionX.every(x=>x.length===96&&x.every(Number.isFinite)));
  assert.ok(env.choices.some(c=>c.action.event==='chase'&&c.action.data.id.startsWith('t1-')));
  assert.ok(env.choices.some(c=>c.action.event==='chase'&&c.x[85]===1));
  assert.ok(env.choices.some(c=>c.action.event==='recall'));assert.ok(env.choices.length<=128);
});
test('unnecessary and repeated recall inputs remain legal but have measured training costs',()=>{
  const env=new LeagueEnvironment(model(),new Pool(config));env.reset();
  let i=env.choices.findIndex(c=>c.action.event==='recall');const first=env.step(i,false);
  assert.equal(env.metrics.unnecessaryRecalls,1);assert.ok(first.reward<-.2);
  i=env.choices.findIndex(c=>c.action.event==='recall');env.step(i,false);assert.equal(env.metrics.repeatRecalls,1);
  assert.equal(env.game.state.players['league-learner'].recall,0); // Repeating the player's recall input toggles the channel off.
});
test('time limits truncate with no winner; player death does not end a match',()=>{
  const env=new LeagueEnvironment(model(),new Pool(config),{maxSeconds:1});env.reset();
  const p=env.game.state.players['league-learner'];p.dead=true;p.respawn=5;
  let r;for(let i=0;i<6;i++){r=env.step(0,false);if(r.episode)break;}
  assert.equal(r.terminal,false);assert.equal(r.truncated,true);assert.equal(r.episode.winner,null);assert.equal(r.episode.reason,'time-limit');
});
test('real tower destruction ends the full match and produces the correct side-relative winner',()=>{
  const env=new LeagueEnvironment(model(),new Pool(config),{maxSeconds:5});env.reset();
  const p=env.game.state.players['league-learner'],towers=Object.values(env.game.state.towers).filter(t=>t.slot!==p.slot),last=towers.pop();
  towers.forEach(t=>{t.dead=true;t.hp=0;});last.hp=1;p.x=last.x-2.2;p.z=last.z;
  env.state=env.game.observe(p.id);env.observation();let r;
  for(let i=0;i<20;i++){
    const index=env.choices.findIndex(c=>c.action.event==='chase'&&c.action.data.id===last.id);
    r=env.step(index<0?0:index,false);if(r.episode)break;
  }
  assert.equal(r.terminal,true);assert.equal(r.episode.reason,'tower-destruction');assert.equal(r.episode.winner,1);assert.equal(r.episode.towers,1);
});
test('global observations condition candidate scores and malformed context weights are rejected',()=>{
  const m=model(),p=m.tacticalPolicy;p.weights.contextW[0][0]=1;p.weights.hiddenW[0][0]=1;
  const c=Array(96).fill(0),x=Array(1072).fill(0);x[0]=1;
  assert.notEqual(Decisions.score(p,c,Decisions.context(p,x)),Decisions.score(p,c,Decisions.context(p,x.map(()=>0))));
  p.weights.contextW[0][0]=NaN;assert.throws(()=>Policy.validate(m));
});
test('controller decision cadence survives match resets and keeps ordinary input handling',()=>{
  const m=model(),env=new LeagueEnvironment(m,new Pool(config));env.reset();const control=Policy.controller(m,{actorId:'league-learner',slot:0});
  const state=env.state;const first=control(state);assert.ok(first.length);
  assert.deepEqual(control({...state,tick:state.tick+3}),[]);control.reset();assert.ok(control(state).length);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const World = require('./game-world');
const Policy = require('./public/minion-policy');
const Decisions = require('./public/minion-decisions');
const { Pool, LeagueEnvironment, REWARDS,territoryFraction,economicWeight,energyCap } = require('./scripts/minion-league-env');
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
  const m=model();m.tacticalPolicy.inferenceTemperature=0;
  const env=new LeagueEnvironment(m,new Pool(config));env.reset();const control=Policy.controller(m,{actorId:'league-learner',slot:0});
  const state=env.state;const first=control(state);assert.ok(first.length);
  assert.deepEqual(control({...state,tick:state.tick+3}),[]);control.reset();assert.ok(control(state).length);
});

function warmEnvironment() {
  const env=new LeagueEnvironment(model(),new Pool(config));env.reset();
  for(let i=0;i<180;i++)env.game.tick();env.state=env.game.observe('league-learner');env.observation();return env;
}
function choose(env,event) {return env.choices.findIndex(c=>c.action.event===event);}
test('standing at spawn costs every second, even with a distant stale target',()=>{
  const env=warmEnvironment(),p=env.game.state.players['league-learner'];
  p.target=Object.values(env.game.state.towers).find(t=>t.slot!==p.slot).id;
  // Simulate an order which cannot currently make progress; targeting alone must not exempt idling.
  p.stun=0;env.state=env.game.observe(p.id);env.observation();
  const originalTick=env.game.tick;env.game.tick=()=>{p.dest=null;p.keys=null;const x=p.x,z=p.z;originalTick();p.x=x;p.z=z;};
  env.step(choose(env,'noop'),false);
  assert.ok(env.metrics.rewardComponents.idle<0);assert.ok(env.metrics.rewardComponents.spawnLoiter<0);
  assert.ok(env.metrics.rewardComponents.idle+env.metrics.rewardComponents.spawnLoiter<=-.039);
});
test('walking circles near spawn still costs time, while actual healing is exempt',()=>{
  const env=warmEnvironment();env.step(choose(env,'steer'),false);
  assert.ok(env.metrics.rewardComponents.spawnLoiter<0);
  const healing=warmEnvironment(),p=healing.game.state.players['league-learner'];p.hp=p.cfg.maxHp*.5;
  healing.state=healing.game.observe(p.id);healing.observation();healing.step(choose(healing,'noop'),false);
  assert.equal(healing.metrics.rewardComponents.spawnLoiter,0);assert.equal(healing.metrics.rewardComponents.idle,0);
});
test('an empty attack has the stronger cost and a normal small-monster kill earns its own reward',()=>{
  const empty=warmEnvironment();empty.step(choose(empty,'q'),false);
  assert.equal(empty.metrics.rewardComponents.emptySkill,REWARDS.emptySkill);assert.ok(REWARDS.emptySkill<=-.25);
  const farm=warmEnvironment(),p=farm.game.state.players['league-learner'];
  const monster=Object.values(farm.game.state.monsters).find(m=>!m.large);
  monster.hp=1;p.x=monster.x+1.8;p.z=monster.z;p.target=null;p.keys=null;p.dest=null;
  farm.state=farm.game.observe(p.id);farm.observation();
  const attack=farm.choices.findIndex(c=>c.action.event==='q'&&c.action.data?.x===farm.state.monsters.find(m=>m.id===monster.id).x);
  farm.step(attack,false);
  assert.equal(farm.metrics.smallKills,1);assert.equal(farm.metrics.rewardComponents.smallMonster,.8);
  assert.ok(farm.metrics.rewardComponents.energy>=.08);assert.equal(farm.metrics.rewardComponents.idle,0);
});

test('using a movement skill without an enemy in range is not an empty attack',()=>{
  const env=warmEnvironment(),p=env.game.state.players['league-learner'];env.game.input(p.id,'dash');
  env.state=env.game.observe(p.id);env.observation();
  const leap=env.choices.findIndex(c=>c.action.event==='leap');assert.ok(leap>=0);
  env.step(leap,false);assert.equal(env.metrics.emptySkills,0);
});

test('temperature zero is greedy, positive temperatures sample stably and do not drop legal low-ranked actions',()=>{
  assert.equal(Decisions.select([1,2,3],0,.01),2);
  assert.equal(Decisions.select([10000,10000],.5,0),0);assert.equal(Decisions.select([10000,10000],.5,.99),1);
  const count=t=>Array.from({length:10000},(_,i)=>Decisions.select([0,1],t,(i+.5)/10000)).filter(i=>i===0).length;
  assert.ok(count(.5)>count(.1));assert.ok(count(1)>count(.5));
  for(const t of [-1,NaN,Infinity])assert.throws(()=>Decisions.select([0,1],t,.2));
  const m=model();m.tacticalPolicy.inferenceTemperature=-1;assert.throws(()=>Policy.validate(m));
});
test('seeded sampling repeats exactly across controller resets and produces varied player inputs',()=>{
  const m=model(),env=new LeagueEnvironment(m,new Pool(config));env.reset();
  const control=Policy.controller(m,{actorId:'league-learner',slot:0,seed:123});
  const run=()=>Array.from({length:40},(_,i)=>control({...env.state,tick:i*6}));
  const first=run();control.reset();assert.deepEqual(run(),first);
  assert.ok(new Set(first.map(c=>JSON.stringify(c))).size>3);
});

test('farm starts are valid terrain and normal chase can farm for every character and side',()=>{
  for(const character of model().characters)for(const slot of [0,1]){
    const env=new LeagueEnvironment(model(),new Pool(config),{maxSeconds:30});env.reset({character,slot,scenario:'farm-start'});
    const p=env.game.state.players['league-learner'];
    assert.ok(World.MAP.obst.every(o=>Math.hypot(o.x-p.x,o.z-p.z)>=o.r+p.cfg.radius-1e-6),character+'/'+slot);
    assert.equal(env.elapsed,0);const own=env.state.control.find(z=>z.slot===slot);
    const target=env.state.monsters.filter(m=>!m.large&&(slot?m.z-m.x:m.x-m.z)<own.boundary).sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0];
    for(let i=0;i<150&&!env.metrics.smallKills;i++){
      const idx=env.choices.findIndex(c=>c.action.event==='chase'&&c.action.data.id===target.id);env.step(idx<0?choose(env,'noop'):idx,false);
    }
    assert.ok(env.metrics.ownSmallKills>=1,character+'/'+slot);assert.ok(env.metrics.rewardComponents.smallMonsterDamage>0);
  }
});
test('nine-percent push starts preserve actual territory rules and expose attackable towers on both sides',()=>{
  for(const character of model().characters)for(const slot of [0,1]){
    const env=new LeagueEnvironment(model(),new Pool(config),{maxSeconds:15});env.reset({slot,character,scenario:'push-9'});
    assert.ok(Math.abs(territoryFraction(env.state.control.find(z=>z.slot!==slot))-.09)<1e-9);
    const p=env.game.state.players['league-learner'];
    const tower=env.state.towers.filter(t=>t.slot!==slot&&!t.dead).sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0];
    for(let i=0;i<40&&!env.metrics.towerDamage;i++){
      const idx=env.choices.findIndex(c=>c.action.event==='chase'&&c.action.data.id===tower.id);env.step(idx,false);
    }
    assert.ok(env.metrics.towerDamage>0);assert.equal(env.metrics.smallKills,0);
  }
});
test('dense farm credit is capped per monster life even when it regenerates',()=>{
  const env=warmEnvironment(),monster=Object.values(env.game.state.monsters).find(m=>!m.large),p=env.game.state.players['league-learner'];
  p.x=monster.x+1.8;p.z=monster.z;p.target=null;p.keys=null;p.dest=null;
  for(let i=0;i<8;i++){
    monster.hp=monster.maxHp;p.qCd=0;p.atkCd=100;
    env.state=env.game.observe(p.id);env.observation();
    const idx=env.choices.findIndex(c=>c.action.event==='q'&&c.action.data?.x===env.state.monsters.find(m=>m.id===monster.id)?.x);
    env.step(idx,false);
  }
  assert.ok(env.metrics.smallDamage>monster.maxHp);
  assert.ok(env.metrics.rewardComponents.smallMonsterDamage<=monster.maxHp*REWARDS.smallMonsterDamage+1e-8);
  assert.equal(env.metrics.smallKills,0);
});

test('economy rewards stop at the real territory cap while tower destruction still pays',()=>{
  assert.equal(energyCap(),280);assert.equal(economicWeight(0),1);assert.equal(economicWeight(280),0);
  const farm=new LeagueEnvironment(model(),new Pool(config));farm.reset({scenario:'push-9'});
  const p=farm.game.state.players['league-learner'],monster=Object.values(farm.game.state.monsters).find(m=>!m.large);
  monster.hp=1;p.x=monster.x+1.8;p.z=monster.z;farm.state=farm.game.observe(p.id);farm.observation();
  const q=farm.choices.findIndex(c=>c.action.event==='q'&&c.action.data?.x===farm.state.monsters.find(m=>m.id===monster.id).x);farm.step(q,false);
  assert.equal(farm.metrics.smallKills,1);assert.equal(farm.metrics.usefulEnergy,0);
  for(const key of ['smallMonster','smallMonsterDamage','energy'])assert.equal(farm.metrics.rewardComponents[key],0);
  const push=new LeagueEnvironment(model(),new Pool(config));push.reset({scenario:'push-9'});
  const actor=push.game.state.players['league-learner'],tower=Object.values(push.game.state.towers).filter(t=>t.slot!==actor.slot).sort((a,b)=>Math.hypot(a.x-actor.x,a.z-actor.z)-Math.hypot(b.x-actor.x,b.z-actor.z))[0];
  tower.hp=1;actor.x=tower.x-2.2;actor.z=tower.z;push.state=push.game.observe(actor.id);push.observation();
  const target=push.state.towers.find(t=>t.id===tower.id);
  const hit=push.choices.findIndex(c=>c.action.event==='q'&&c.action.data?.x===target.x&&c.action.data?.z===target.z);const r=push.step(hit,false);
  assert.equal(push.metrics.towers,1);assert.equal(push.metrics.usefulEnergy,0);assert.ok(r.reward>REWARDS.tower-.5);
});

test('live policy conditions on the same refreshed decision history as training',()=>{
  const m=model(),env=new LeagueEnvironment(m,new Pool(config));env.reset();
  const memory={leagueSignals:{tick:-1,hp:200,recall:0,damagedAt:-100,cancelledAt:-100}};
  env.state.players.find(p=>p.id==='league-learner').hp=150;
  const expectedMemory=structuredClone(memory);
  const base=Policy.decide({...m,tacticalPolicy:null},env.state,'league-learner',expectedMemory,.3,.4,.5);
  const choices=Decisions.candidates(m,env.state,'league-learner',base,expectedMemory);
  const expected=Policy.features(env.state,'league-learner',m.init,expectedMemory,m.featureVersion);
  let actual;
  // Context is closed over internally, so capture the lazy observation supplied to choose.
  const originalChoose=Decisions.choose;
  Decisions.choose=(model,state,actor,action,mem,observation,draw)=>{
    Decisions.candidates(model,state,actor,action,mem);actual=observation();
    return originalChoose(model,state,actor,action,mem,observation,draw);
  };
  try{Policy.decide(m,env.state,'league-learner',memory,.3,.4,.5,.6);}finally{Decisions.choose=originalChoose;}
  assert.ok(choices.length>1);assert.deepEqual(Array.from(actual),Array.from(expected));
  assert.equal(memory.leagueSignals.hp,150);assert.equal(memory.leagueSignals.damagedAt,env.state.time);
});

test('simulation snapshots reproduce input outcomes, clocks, camps and cooldowns exactly',()=>{
  const env=warmEnvironment(),saved=env.snapshot(),idx=env.choices.findIndex(c=>c.action.event==='c');
  const run=()=>{env.step(idx,false);for(let i=0;i<90;i++)env.game.tick();return env.game.observe('league-learner');};
  const first=run();env.restore(saved);assert.deepEqual(run(),first);
  env.restore(saved);const action=env.choices.findIndex(c=>c.action.event==='move');
  const value=env.lookahead(action,2);env.restore(saved);assert.equal(env.lookahead(action,2),value);
});

test('learned composed skills retain the selected target and use normal cooldowns',()=>{
  const m=model();m.tacticalPolicy.actionProtocol='composed-inputs/14';
  const env=new LeagueEnvironment(m,new Pool(config));env.reset({character:'alex',scenario:'farm-start'});
  const target=env.state.monsters.filter(t=>!t.large).sort((a,b)=>Math.hypot(a.x-env.state.players[0].x,a.z-env.state.players[0].z)-Math.hypot(b.x-env.state.players[0].x,b.z-env.state.players[0].z))[0];
  const i=env.choices.findIndex(c=>c.action.event==='q'&&c.action.inputs?.some(a=>a.event==='chase'&&a.data.id===target.id));
  assert.ok(i>=0);env.step(i,false);
  const p=env.game.state.players['league-learner'];assert.equal(p.target,target.id);assert.ok(p.qCd>0);assert.ok(env.metrics.smallDamage>=23);
  const leap=env.choices.findIndex(c=>c.action.event==='leap'&&c.action.inputs?.[0].event==='dash');
  assert.ok(leap>=0);env.step(leap,false);assert.ok(p.eCd>0);assert.ok(p.leap);
  assert.ok(!env.choices.some(c=>c.action.event==='leap'&&c.action.inputs));
});

test('policy rollouts include the aftermath of a kill and replay identically',()=>{
  const env=warmEnvironment(),p=env.game.state.players['league-learner'];
  const monster=Object.values(env.game.state.monsters).find(m=>!m.large);
  monster.hp=1;p.x=monster.x+1.8;p.z=monster.z;p.target=null;p.keys=null;p.dest=null;
  env.state=env.game.observe(p.id);env.observation();
  const target=env.state.monsters.find(m=>m.id===monster.id);
  const q=env.choices.findIndex(c=>c.action.event==='q'&&c.action.data?.x===target.x&&c.action.data?.z===target.z);
  const saved=env.snapshot(),value=env.lookahead(q,2,{followPolicyAfter:.2}),after=env.game.observe(p.id);
  assert.equal(env.metrics.smallKills,1);assert.ok(env.elapsed-saved.data.elapsed>=1.99);
  env.restore(saved);assert.equal(env.lookahead(q,2,{followPolicyAfter:.2}),value);
  assert.deepEqual(env.game.observe(p.id),after);
});

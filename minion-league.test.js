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
  assert.ok(!env.choices.some(c=>c.action.event==='recall'));assert.ok(env.choices.length<=128);
});
test('recall is unavailable while healthy at spawn, including the base proposal',()=>{
  const env=new LeagueEnvironment(model(),new Pool(config));env.reset();
  const choices=Decisions.candidates(env.model,env.state,'league-learner',{event:'recall'},env.memory);
  assert.ok(!choices.some(c=>c.action.event==='recall'));
});
function recallEnvironment() {
  const env=new LeagueEnvironment(model(),new Pool(config));env.reset({slot:0,character:'alex'});
  Object.assign(env.game.state.players['league-learner'],{x:0,z:8,hp:80});
  env.memory={};env.state=env.game.observe('league-learner');env.observation();return env;
}

test('recall completes without repeated inputs or unrelated movement cancelling it',()=>{
  const env=recallEnvironment();
  env.step(env.choices.findIndex(c=>c.action.event==='recall'),false);
  assert.equal(env.metrics.recallStarts,1);
  for(let i=0;i<16;i++){
    if(env.state.players.find(p=>p.id==='league-learner').recall>0){
      assert.equal(env.choices.length,1);assert.equal(env.choices[0].action.event,'noop');
      const choices=Decisions.candidates(env.model,env.state,'league-learner',{event:'recall'},env.memory);
      assert.equal(choices[0].action.event,'noop');
    }
    env.step(0,false);
  }
  const p=env.game.state.players['league-learner'];
  assert.deepEqual({x:p.x,z:p.z},World.MAP.spawns[0]);
  assert.equal(env.metrics.repeatRecalls,0);assert.equal(env.metrics.recallStarts,1);
  assert.ok(!env.choices.some(c=>c.action.event==='recall'));
});

test('an approaching enemy allows recall cancellation and delays retry after the danger leaves',()=>{
  const env=recallEnvironment();env.step(env.choices.findIndex(c=>c.action.event==='recall'),false);
  const p=env.game.state.players['league-learner'],enemy=env.game.state.players['league-opponent'];
  Object.assign(enemy,{x:p.x+2,z:p.z});env.state=env.game.observe(p.id);env.observation();
  assert.ok(env.choices.some(c=>c.action.event==='move'));assert.ok(!env.choices.some(c=>c.action.event==='recall'));
  env.game.input(p.id,'move',{x:p.x,z:p.z});Object.assign(enemy,World.MAP.spawns[1]);
  env.state=env.game.observe(p.id);env.observation();assert.ok(!env.choices.some(c=>c.action.event==='recall'));
  for(let i=0;i<World.TICK*3+1;i++)env.game.tick();
  env.state=env.game.observe(p.id);env.observation();assert.ok(env.choices.some(c=>c.action.event==='recall'));
});

test('recall excludes high HP, home proximity, tower fire and recent damage without changing model features',()=>{
  const env=recallEnvironment(),p=env.state.players.find(p=>p.id==='league-learner');
  const noRecall=()=>assert.ok(!Decisions.candidates(env.model,env.state,p.id,{event:'recall'},env.memory).some(c=>c.action.event==='recall'));
  p.hp=p.maxHp;noRecall();p.hp=100;
  Object.assign(p,World.MAP.spawns[0]);noRecall();Object.assign(p,{x:0,z:8});
  env.state.towers.push({id:'threat',slot:1,x:0,z:13});noRecall();env.state.towers.pop();
  env.state.time+=.2;p.hp=90;noRecall();
  const withoutControl={...env.memory};delete withoutControl.recallControl;
  assert.deepEqual(Policy.features(env.state,p.id,env.model.init,env.memory,env.model.featureVersion),Policy.features(env.state,p.id,env.model.init,withoutControl,env.model.featureVersion));
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
  assert.equal(r.episode.directTowers,1);assert.ok(r.episode.directTowerDamage>0);assert.equal(r.episode.summonTowerDamage,0);
});

test('tower damage from an autonomous summon is recorded separately from its owner',()=>{
  const env=recallEnvironment(),p=env.game.state.players['league-learner'];
  const tower=Object.values(env.game.state.towers).find(t=>t.slot!==p.slot);tower.hp=1;
  env.game.input(p.id,'c');
  const robot=Object.values(env.game.state.robots).find(r=>r.owner===p.id);
  Object.assign(robot,{x:tower.x-1.8,z:tower.z,atkCd:0,target:tower.id});
  env.state=env.game.observe(p.id);env.observation();
  for(let i=0;i<10&&!tower.dead;i++)env.step(env.choices.findIndex(c=>c.action.event==='noop'),false);
  assert.equal(tower.dead,true);assert.equal(env.metrics.directTowerDamage,0);assert.equal(env.metrics.directTowers,0);
  assert.ok(env.metrics.summonTowerDamage>0);assert.equal(env.metrics.summonTowers,1);
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
test('model chase orders navigate around a wall and reach a distant monster for all characters',()=>{
  for(const character of World.CHARACTERS.map(c=>c.id)){
    const m=model();m.characters=World.CHARACTERS.map(c=>c.id);
    const env=new LeagueEnvironment(m,new Pool(config));env.reset({slot:0,character});
    while(env.game.observe('league-learner').time<5.2)env.game.tick();
    env.game.state.environment.totals=[280,280];
    const p=env.game.state.players['league-learner'];Object.assign(p,{x:-26,z:0,hp:p.cfg.maxHp,target:null,dest:null,keys:null});
    const monster=Object.values(env.game.state.monsters).find(m=>!m.large&&m.x>0&&m.z===0);
    env.game.input(p.id,'chase',{id:monster.id});
    for(let i=0;i<World.TICK*25&&!monster.dead&&!p.dead;i++)env.game.tick();
    assert.equal(monster.dead,true,JSON.stringify({character,x:p.x,z:p.z,hp:p.hp,monster:{x:monster.x,z:monster.z,hp:monster.hp},path:p.path}));assert.equal(p.dead,false,character);
  }
});
test('a model can leave wall contact after a charge and continue its siege order',()=>{
  const m=model(),env=new LeagueEnvironment(m,new Pool(config));env.reset({slot:1,character:'darius'});
  env.game.state.environment.totals=[280,280];
  const p=env.game.state.players['league-learner'];Object.assign(p,{x:17.52,z:6.44,hp:300,target:null,dest:null,keys:null});
  for(const id of Object.keys(env.game.state.monsters))delete env.game.state.monsters[id];
  for(const camp of env.game.state.camps)camp.timer=1000;
  const tower=env.game.state.towers['t0-1'];
  env.game.input(p.id,'chase',{id:tower.id});
  for(let i=0;i<World.TICK*2;i++)env.game.tick();
  assert.ok(Math.hypot(p.x-17.52,p.z-6.44)>2);
  for(let i=0;i<World.TICK*25&&!tower.dead&&!p.dead;i++)env.game.tick();
  assert.equal(tower.dead,true);assert.equal(p.dead,false);
});
test('model movement completes on arrival so a healed actor is no longer marked as returning home',()=>{
  const env=recallEnvironment(),p=env.game.state.players['league-learner'],home=World.MAP.spawns[p.slot];
  Object.assign(p,{x:home.x+1,z:home.z,hp:100});env.game.input(p.id,'move',home);
  for(let i=0;i<World.TICK*2;i++)env.game.tick();
  assert.equal(p.dest,null);assert.deepEqual(p.path,[]);assert.equal(p.hp,p.cfg.maxHp);
});
test('teacher student uses known public camp movement goals before monsters spawn',()=>{
  const m=model();m.tacticalPolicy.camps=[{id:'monster-1',x:-23,z:7}];m.tacticalPolicy.baseProposal=false;
  delete m.tacticalPolicy.contextSize;delete m.tacticalPolicy.weights.contextW;
  const env=new LeagueEnvironment(m,new Pool(config));env.reset({slot:0});
  assert.ok(env.choices.some(c=>c.action.event==='move'&&c.action.data.x===-23&&c.action.data.z===7));
  env.state.monsters.push({id:'monster-1',x:-23,z:7,slot:2,hp:100,maxHp:100});env.observation();
  assert.ok(env.choices.some(c=>c.action.event==='chase'&&c.action.data.id==='monster-1'));
  // A candidate-only student must not depend on the old actor's proposed input.
  m.weights.hiddenW=null;
  assert.doesNotThrow(()=>Policy.decide(m,env.state,'league-learner',{}));
});
test('offline teacher query restores game, observations and controller memory exactly',()=>{
  const env=recallEnvironment(),saved=env.snapshot();
  const label=require('./scripts/collect-minion-dagger').queryTeacher(env,[]);
  assert.ok(label.index>=0&&label.index<env.choices.length);
  assert.deepEqual(env.snapshot(),saved);
});
test('student features remember public friendly camp kills without changing legacy observations',()=>{
  const m=model();m.tacticalPolicy.inputSize=128;m.tacticalPolicy.featureVersion='minion-student-state/23';
  m.tacticalPolicy.weights.hiddenW=[Array(128).fill(0)];
  m.tacticalPolicy.camps=[-23,23].flatMap((x,i)=>[-7,0,7].map((z,j)=>({id:`monster-${1+i*3+j}`,x,z})));
  const env=new LeagueEnvironment(m,new Pool(config));env.reset({slot:0});
  const memory={},id='monster-1';
  Policy.updateMemory(memory,env.state,'league-learner',[{event:'kill',data:{time:1,attacker:{slot:0},victim:{id,kind:'monster'}}}],m.featureVersion,m.init);
  Policy.updateMemory(memory,env.state,'league-learner',[{event:'kill',data:{time:1,attacker:{slot:1},victim:{id:'monster-2',kind:'monster'}}}],m.featureVersion,m.init);
  const choices=Decisions.candidates(m,env.state,'league-learner',{event:'noop'},memory);
  const camp=choices.find(c=>c.action.event==='move'&&c.action.data.x===-23&&c.action.data.z===-7);
  assert.equal(camp.x[96],1);assert.equal(camp.x[97],0);assert.equal(camp.x[102],1/3);assert.equal(camp.x[104],1);
  const plain={...memory};delete plain.student;
  assert.deepEqual(Policy.features(env.state,'league-learner',m.init,memory,m.featureVersion),Policy.features(env.state,'league-learner',m.init,plain,m.featureVersion));
});
test('teacher skill capture excludes rejected casts',()=>{
  const p={qCd:0,cCd:0,eCd:0,aiming:false,target:'enemy',commands:{c(){},q(){p.qCd=5;},dash(){p.aiming=true;}}},skills=[];
  require('./scripts/collect-minion-teacher').captureSkills(p,skills);
  p.commands.c();p.commands.q({x:1,z:2});p.commands.dash();
  assert.deepEqual(skills.map(s=>s.event),['q','dash']);
});
test('student compound inputs preserve the CPU C then Q order and execute both skills',()=>{
  const m=model();m.tacticalPolicy.inputSize=128;m.tacticalPolicy.featureVersion='minion-student-state/24';
  m.tacticalPolicy.weights.hiddenW=[Array(128).fill(0)];m.tacticalPolicy.camps=[-23,23].flatMap((x,i)=>[-7,0,7].map((z,j)=>({id:`monster-${1+i*3+j}`,x,z})));
  const env=new LeagueEnvironment(m,new Pool(config));env.reset({slot:0,character:'darius'});
  const p=env.game.state.players['league-learner'],enemy=env.game.state.players['league-opponent'];
  Object.assign(p,{x:0,z:8,hp:300,qCd:0,cCd:0});Object.assign(enemy,{x:1.5,z:8});
  env.state=env.game.observe(p.id);env.observation();
  const skills=[{event:'c',target:enemy.id,data:{x:enemy.x,z:enemy.z}},{event:'q',target:enemy.id,data:{x:enemy.x,z:enemy.z}}];
  const label=require('./scripts/collect-minion-teacher').teacherChoice(env.choices,env.state,p.id,{...p,target:enemy.id},skills);
  const action=env.choices[label.index].action;
  assert.deepEqual(action.inputs.map(i=>i.event),['steer','chase','c','q']);
  assert.equal(env.choices[label.index].x[123],1);assert.equal(env.choices[label.index].x[124],1);
  for(const c of Policy.commands(m,env.state,p.id,action))env.game.input(p.id,c.event,c.data);
  assert.ok(p.cCd>0&&p.qCd>0);assert.equal(p.grabbing,enemy.id);
});
function choose(env,event) {return env.choices.findIndex(c=>c.action.event===event);}

test('tactical curriculum covers both sides and all characters without changing the action selector',()=>{
  const m=model();m.characters=World.CHARACTERS.map(c=>c.id);
  for(const scenario of ['retreat-duel','finish-duel'])for(const slot of [0,1])for(const character of m.characters){
    const env=new LeagueEnvironment(m,new Pool(config));env.reset({scenario,slot,character});
    const p=env.state.players.find(p=>p.id==='league-learner'),enemy=env.state.players.find(p=>p.id==='league-opponent');
    assert.ok(enemy.vis && !enemy.dead,`${scenario}/${slot}/${character}`);
    if(scenario==='retreat-duel'){
      assert.ok(p.hp/p.maxHp>=.19&&p.hp/p.maxHp<=.46);
      assert.equal(p.inputs.target,enemy.id);
      assert.ok(env.choices.some(c=>c.action.inputs?.some(i=>i.event==='dash')));
    }else{
      assert.ok(enemy.hp>0&&enemy.hp<=World.configFor(character).atkDmg);
    }
    assert.ok(env.choices.some(c=>c.action.event==='chase'&&c.action.data.id===enemy.id));
    assert.ok(env.choices.some(c=>c.action.event==='move'&&c.x[46]===1));
  }
  assert.throws(()=>new LeagueEnvironment(m,new Pool(config),{retreatStartFraction:.6,finishStartFraction:.5}));
});

test('critical health values leaving threats; healthy actors value finishing and tower progress',()=>{
  const env=new LeagueEnvironment(model(),new Pool(config));env.reset({scenario:'retreat-duel',slot:0,character:'alex'});
  const p=env.state.players.find(p=>p.id==='league-learner'),enemy=env.state.players.find(p=>p.id==='league-opponent');
  p.hp=p.maxHp*.1;
  enemy.hp=100000;env.state.towers=[];env.state.robots=[];
  const dangerous=env.potential();enemy.x=25;enemy.z=-25;
  assert.ok(env.potential()>dangerous);
  const injured=env.potential();p.hp=p.maxHp;assert.ok(env.potential()>injured);
  enemy.x=p.x+4;enemy.z=p.z;enemy.hp=enemy.maxHp;
  const healthyEnemy=env.potential();enemy.hp=1;assert.ok(env.potential()>healthyEnemy);
  enemy.dead=true;
  env.state.monsters=[];
  env.state.towers=[{id:'target',slot:1,x:12,z:8,hp:100}];
  const far=env.potential();p.x=6;assert.ok(env.potential()>far);
});

test('temporary damage and healing do not change objective potential outside critical HP',()=>{
  const env=recallEnvironment(),p=env.state.players.find(p=>p.id==='league-learner');
  p.hp=p.maxHp;const full=env.potential();
  for(const hp of [.95,.8,.6,.3]){p.hp=p.maxHp*hp;assert.equal(env.potential(),full);}
  assert.ok(Math.abs(REWARDS.damageReceived)*p.maxHp<.05);
  assert.ok(Math.abs(REWARDS.zoneDamage)*p.maxHp<.05);
  assert.equal(REWARDS.death,-6);
});

test('recall is excluded within 25 of spawn unless a visible enemy blocks the return corridor',()=>{
  for(const slot of [0,1]){
    const env=recallEnvironment(),p=env.state.players.find(p=>p.id==='league-learner'),home=World.MAP.spawns[slot];
    p.slot=slot;p.safe=false;env.state.towers=[];env.state.robots=[];
    env.state.players=[p];
    const canRecall=()=>Decisions.candidates(env.model,env.state,p.id,{event:'recall'},{}).some(c=>c.action.event==='recall');
    const direction=slot?-1:1;
    const place=d=>Object.assign(p,{x:home.x+direction*d,z:home.z});
    for(const d of [10,24.99,25]){place(d);assert.equal(canRecall(),false,`${slot}/${d}`);}
    place(25.01);assert.equal(canRecall(),true);
    place(25);
    const blocker={id:'blocker',slot:1-slot,character:'alex',hp:100,vis:true,x:home.x+direction*12.5,z:home.z};
    env.state.players.push(blocker);assert.equal(canRecall(),true);
    blocker.dead=true;assert.equal(canRecall(),false);blocker.dead=false;
    blocker.vis=false;assert.equal(canRecall(),false);blocker.vis=true;
    blocker.slot=slot;assert.equal(canRecall(),false);blocker.slot=1-slot;
    blocker.x=home.x+direction*27;assert.equal(canRecall(),false); // Behind the actor.
    blocker.x=home.x-direction*2;assert.equal(canRecall(),false); // Beyond spawn.
    blocker.x=home.x+direction*12.5;blocker.z=home.z+10;assert.equal(canRecall(),false);
    blocker.z=home.z;env.state.players.pop();env.state.robots.push(blocker);assert.equal(canRecall(),true);
    env.state.robots=[];place(26);p.hp=p.maxHp*.8;assert.equal(canRecall(),false);
  }
});

test('learned retreat mobility cancels an existing chase through ordinary inputs',()=>{
  const m=model();m.tacticalPolicy.inferenceTemperature=0;
  const env=new LeagueEnvironment(m,new Pool(config));env.reset({scenario:'retreat-duel',character:'mira',slot:0});
  // Reward a home-directed E in the test policy, rather than forcing a runtime rule.
  const w=m.tacticalPolicy.weights;w.hiddenW[0][37]=1;w.hiddenW[0][46]=1;w.hiddenB[0]=-1.5;
  const action=Policy.decide(m,env.state,'league-learner',env.memory);
  assert.equal(action.event,'dash');assert.ok(action.inputs);
  for(const c of Policy.commands(m,env.state,'league-learner',action))env.game.input('league-learner',c.event,c.data);
  const p=env.game.state.players['league-learner'];
  assert.equal(p.target,null);assert.deepEqual(p.dest,World.MAP.spawns[0]);assert.ok(p.speedBoost>0);
});
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
  assert.equal(farm.metrics.smallKills,1);assert.equal(farm.metrics.rewardComponents.smallMonster,REWARDS.smallMonster);
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
  assert.ok(farm.metrics.directSmallDamage>0);assert.equal(farm.metrics.summonSmallDamage,0);
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

test('assigned training characters and sides survive short and long episode resets',()=>{
  const m=model();m.characters=[...m.characters.filter(c=>c!=='lucia'),'lucia'];
  const pool=new Pool(config);
  const envs=m.characters.flatMap(character=>[0,1].map(slot=>new LeagueEnvironment(m,pool,{learnerCharacter:character,learnerSlot:slot})));
  for(let round=0;round<4;round++)for(let i=0;i<envs.length;i++){
    envs[i].reset();const learner=envs[i].state.players.find(p=>p.id==='league-learner');
    assert.equal(learner.character,m.characters[Math.floor(i/2)]);assert.equal(learner.slot,i%2);
  }
});

test('league protocol exposes current public rules for matching training and inference',()=>{
  const result=require('node:child_process').spawnSync(process.execPath,[require.resolve('./scripts/minion-league-env')],{
    input:'{"op":"rules"}\n{"op":"close"}\n',encoding:'utf8'});
  assert.equal(result.status,0);
  const rules=JSON.parse(result.stdout.split('\n')[0]);
  assert.deepEqual(rules.cfg,JSON.parse(JSON.stringify(World.CFG)));
  assert.deepEqual(rules.map,JSON.parse(JSON.stringify(World.MAP)));assert.equal(rules.tick,World.TICK);
});

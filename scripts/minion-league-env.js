'use strict';
const readline = require('node:readline');
const crypto = require('node:crypto');
const World = require('../game-world');
const Policy = require('../public/minion-policy');
const Decisions = require('../public/minion-decisions');
const { readJSON } = require('./minion-input');
const init = model => ({ ...model.init, map: World.MAP, cfg: World.CFG, characters: World.CHARACTERS });
const load = file => { const model = Policy.validate(readJSON(file)); return { file, model: { ...model, init: init(model) }, sha256: crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex') }; };
const REWARD_VERSION = 'league-objective-first/20';
const REWARDS = Object.freeze({ win: 30, loss: -30, tower: 2, towerDamage: .008, large: 4, smallMonster: 2.4, energy: .01, kill: 2, death: -6, zoneDamage:-.0001,
  damageReceived: -.0001, emptySkill: -.25, invalidSkill: -.05, unnecessaryRecall: -.25, repeatRecall: -.04, interruptedRecall: -.15,
  spawnLoiterPerSecond: -.1, idlePerSecond: -.1, attackedFarmPerSecond: -.03, ignoredBossPerSecond: -.025, timePerSecond: -.01,
  smallMonsterDamage: .003, farmPotential: 1, farmDamagePotential: .15, towerPotential: 3,
  dangerPotential: .25, finishPotential: 1.5, heroDamage: .012 });
const inControl = (p,slot,zone) => !!zone && (slot ? p.z-p.x : p.x-p.z) < zone.boundary;
const territoryFraction = zone => Math.max(0,Math.min(1,1+(zone?.boundary || 0)/(2*World.MAP.half))) ** 2;
const energyCap=()=>-World.CONTROL_BOUNDARY_MIN/World.CFG.energyShrink;
const economicWeight=energy=>energy>=energyCap()?0:.25+.75*Math.max(0,1-energy/energyCap());
function validateOptions(options) {
  if (!Number.isFinite(options.maxSeconds) || options.maxSeconds < 1 || options.maxSeconds > 86400) throw Error('maxSeconds must be 1..86400');
  if (!Number.isInteger(options.intervalTicks) || options.intervalTicks < 3 || options.intervalTicks > 9) throw Error('intervalTicks must be 3..9');
  const fractions = ['farmStartFraction','pushStartFraction','retreatStartFraction','finishStartFraction'].map(k => options[k] ?? 0);
  if (!fractions.every(v=>Number.isFinite(v)&&v>=0&&v<=1)||fractions.reduce((a,b)=>a+b,0)>1) throw Error('Invalid strategic start fractions');
}
class Pool {
  constructor(config) { this.counter = 0; this.categoryCounters = {latest:0,history:0,algorithm:0}; this.cache = new Map(); this.update(config); }
  update(config) {
    const weights = config.weights || { latest: 4, history: 3, algorithm: 3 };
    if (['latest','history','algorithm'].some(k => !Number.isInteger(weights[k]) || weights[k] < 1 || weights[k] > 20)) throw Error('Each opponent weight must be 1..20');
    if (!config.history?.length || !config.latest) throw Error('Latest and historical models are required');
    this.sequence = [];
    for (let i = 0; i < Math.max(...Object.values(weights)); i++) for (const k of ['latest','history','algorithm']) if (i < weights[k]) this.sequence.push(k);
    this.config = { ...config, weights }; this.latest = this.get(config.latest); this.history = config.history.map(f => this.get(f));
    const retained = new Set([config.latest,...config.history]);
    for (const file of this.cache.keys()) if (!retained.has(file)) this.cache.delete(file);
  }
  get(file) { if (!this.cache.has(file)) this.cache.set(file, load(file)); return this.cache.get(file); }
  draw(characters) {
    const index = this.counter++, category = this.sequence[index % this.sequence.length];
    const rotation = this.categoryCounters[category]++;
    const entry = category === 'algorithm' ? null : category === 'latest' ? this.latest : this.history[Math.floor(index / this.sequence.length) % this.history.length];
    const opponentCharacters = entry?.model.characters || World.CHARACTERS.map(c => c.id);
    const row = Math.floor(rotation / characters.length), column = rotation % characters.length;
    return { index, category, entry, slot: (row % opponentCharacters.length + Math.floor(row / opponentCharacters.length)) % 2, character: characters[column],
      opponentCharacter: opponentCharacters[(row + column) % opponentCharacters.length] };
  }
}
class LeagueEnvironment {
  constructor(model, pool, options = {}) {
    this.model = { ...model, init: init(model) }; this.pool = pool; this.options = { maxSeconds: 600, intervalTicks: 6, seed: 17, ...options };
    validateOptions(this.options); this.seed = this.options.seed >>> 0; this.episode = 0;
  }
  random() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }
  reset(forced = {}) {
    this.fixture = this.pool.draw(this.model.characters); this.episode++; this.elapsed = 0; this.memory = {}; this.cues = []; this.combat = [];
    if(this.options.learnerCharacter)this.fixture.character=this.options.learnerCharacter;
    if(this.options.learnerSlot!==undefined)this.fixture.slot=this.options.learnerSlot;
    Object.assign(this.fixture,forced);
    if (!this.model.characters.includes(this.fixture.character) || ![0,1].includes(this.fixture.slot)) throw Error('Invalid forced fixture');
    const draw=this.random();
    let remaining = draw, scenario = 'match';
    for (const [key, name] of [['farmStartFraction','farm-start'],['pushStartFraction','push-9'],['retreatStartFraction','retreat-duel'],['finishStartFraction','finish-duel']]) {
      remaining -= this.options[key] || 0;
      if (remaining < 0) { scenario = name; break; }
    }
    this.scenario=forced.scenario || scenario;
    if (!['match','farm-start','farm-spawn','push-9','push-spawn-9','retreat-duel','finish-duel'].includes(this.scenario)) throw Error('Invalid strategic scenario');
    this.farmDamageCredit=new Map();
    this.lastHeroHit = -100; this.lastBossHit = -100; this.spawnGraceUntil = 5; this.totalReward = 0; const f = this.fixture;
    this.metrics = { scenario:this.scenario, opponent: f.category, opponentFile: f.entry?.file || null, opponentSha256: f.entry?.sha256 || null,
      character: f.character, opponentCharacter: f.opponentCharacter, slot: f.slot, kills: 0, deaths: 0, towers: 0, towersLost: 0,
      towerDamage: 0, directTowerDamage:0, summonTowerDamage:0, directTowers:0, summonTowers:0, forwardSeconds:0,
      energy: 0, usefulEnergy:0, smallKills: 0, directSmallKills:0, summonSmallKills:0, directSmallDamage:0, summonSmallDamage:0, ownSmallKills:0, enemySmallKills:0, smallDamage:0, enemyZoneSeconds:0, largeKills: 0, largeLosses: 0, recallStarts: 0, repeatRecalls: 0, unnecessaryRecalls: 0,
      interruptedRecalls: 0, emptySkills: 0, invalidSkills: 0, spawnLoiterSeconds: 0, idleSeconds: 0, fieldIdleSeconds: 0, attackedFarmSeconds: 0, ignoredBossSeconds: 0,
      rewardComponents: { smallMonster: 0, smallMonsterDamage:0, energy: 0, emptySkill: 0, invalidSkill: 0, spawnLoiter: 0, idle: 0 } };
    const learner = () => [];
    learner.externalInputs=true;learner.autoNavigation=this.model.decisionMode==='learned/1';this.learnerController=learner;
    learner.observe = e => this.cues.push(e);
    learner.observeState = state => { Policy.updateMemory(this.memory, state, 'league-learner', this.cues, this.model.featureVersion, this.model.init); this.cues = []; };
    this.game = World.createMatch(false, false, { teamSizes: [1,1], onCombat: e => this.combat.push(e) });
    for (let slot = 0; slot < 2; slot++) {
      const ours = slot === f.slot, id = ours ? 'league-learner' : 'league-opponent';
      const controller = ours ? learner : f.entry ? Policy.controller(f.entry.model, { slot, actorId: id, seed: this.seed ^ 104729 }) : null;
      this.game.connect({ id, on() {}, emit() {}, disconnect() {} }, { team: slot, member: 0, bot: true, controller, character: ours ? f.character : f.opponentCharacter });
    }
    if(this.scenario!=='match'){
      while(this.game.observe('league-learner').time<5.2)this.game.tick();
      const p=this.game.state.players['league-learner'];
      if(this.scenario==='farm-start'){
        const own=this.game.observe(p.id).control.find(z=>z.slot===p.slot);
        const camps=Object.values(this.game.state.monsters).filter(m=>!m.large&&inControl(m,p.slot,own));
        const camp=camps[Math.floor(this.random()*camps.length)];
        if(!camp)throw Error('Missing farm start');
        const angle=this.random()*Math.PI*2,distance=p.cfg.atkRange+1.5;
        const blocks=[...World.MAP.obst,...Object.values(this.game.state.towers).filter(t=>!t.dead).map(t=>({...t,r:World.CFG.tower.radius}))];
        let position=null;
        for(let i=0;i<16;i++){
          const a=angle+i*Math.PI/8,to={x:camp.x+Math.sin(a)*distance,z:camp.z+Math.cos(a)*distance};
          if(World.validLanding(camp,to,{range:distance+.01,radius:p.cfg.radius,half:World.MAP.half,blocks,safe:{...World.MAP.spawns[1-p.slot],r:World.CFG.safeRadius}})){position=to;break;}
        }
        if(!position)throw Error('No valid farm start position');
        Object.assign(p,{...position,target:null,keys:null,dest:null});
      }else if(this.scenario.startsWith('push-')){
        this.game.state.environment.totals[p.slot]=energyCap();p.energy=energyCap();
        const tower=Object.values(this.game.state.towers).filter(t=>t.slot!==p.slot&&!t.dead).sort((a,b)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z))[0];
        const length=Math.hypot(tower.x,tower.z),distance=p.cfg.atkRange+World.CFG.tower.radius+2;
        if(this.scenario==='push-9')Object.assign(p,{x:tower.x-tower.x/length*distance,z:tower.z-tower.z/length*distance,target:null,keys:null,dest:null});
      }else if(['retreat-duel','finish-duel'].includes(this.scenario)){
        const enemy=this.game.state.players['league-opponent'],sign=p.slot?-1:1;
        this.game.state.environment.totals=[100,100];
        const clear={target:null,keys:null,dest:null,recall:0};
        Object.assign(p,clear,{x:0,z:8*sign,hp:p.cfg.maxHp*(this.scenario==='retreat-duel'?.2+this.random()*.25:1)});
        const d=p.cfg.atkRange+.5+this.random();
        Object.assign(enemy,clear,{x:sign*d*Math.SQRT1_2,z:sign*(8-d*Math.SQRT1_2),hp:this.scenario==='finish-duel'?p.cfg.atkDmg*(.25+this.random()*.5):enemy.cfg.maxHp*.8});
        this.game.input(enemy.id,'chase',{id:p.id});
        if(this.scenario==='retreat-duel')this.game.input(p.id,'chase',{id:enemy.id});
      }
      this.memory={};this.cues=[];this.combat=[];
    }
    this.state = this.game.observe('league-learner');this.startedAt=this.state.time;
    this.startedLow = this.state.players.find(p=>p.id==='league-learner').hp < this.game.state.players['league-learner'].cfg.maxHp*.5;
    this.metrics.recovered = false;
    this.previousPotential = this.potential(); return this.observation();
  }
  potential() {
    const p = this.state.players.find(p => p.id === 'league-learner'); if (p.dead) return 0;
    const towers = this.state.towers.filter(t => !t.dead && t.slot !== p.slot);
    const own=this.state.control.find(z=>z.slot===p.slot);
    const farm=this.state.monsters.filter(m=>!m.large&&!m.dead&&inControl(m,p.slot,own));
    const farmPhi=farm.reduce((best,m)=>Math.max(best,REWARDS.farmPotential*Math.max(0,1-Math.hypot(m.x-p.x,m.z-p.z)/60)+REWARDS.farmDamagePotential*(1-m.hp/m.maxHp)),0);
    const towerPhi=towers.length ? REWARDS.towerPotential * Math.max(0, 1 - Math.min(...towers.map(t => Math.hypot(t.x-p.x,t.z-p.z))) / 90) : 0;
    const hp=p.hp/p.maxHp, critical=Math.max(0,1-hp/.3);
    const enemies=this.state.players.filter(e=>e.slot!==p.slot&&e.vis&&!e.dead&&Number.isFinite(e.x));
    const threats=[...enemies,...this.state.robots.filter(e=>e.slot!==p.slot&&!e.dead),...towers];
    const danger=threats.reduce((risk,e)=>Math.max(risk,Math.max(0,1-Math.hypot(e.x-p.x,e.z-p.z)/12)),0);
    const finish=enemies.reduce((best,e)=>Math.max(best,Math.min(1,World.configFor(p.character).atkDmg/Math.max(1,e.hp))*Math.max(0,1-Math.hypot(e.x-p.x,e.z-p.z)/24)),0);
    // Discounted potential differences pay for progress, never for toggling orders.
    return (1-critical)*(towerPhi+farmPhi*economicWeight(own?.energy||0)+REWARDS.finishPotential*finish)
      -REWARDS.dangerPotential*critical**2*danger;
  }
  observation() {
    const actor = 'league-learner';
    Policy.updateMemory(this.memory, this.state, actor, this.cues, this.model.featureVersion, this.model.init); this.cues = [];
    const base = this.model.tacticalPolicy?.baseProposal===false?{event:'noop'}:Policy.decide({ ...this.model, tacticalPolicy: null }, this.state, actor, this.memory, this.random(), this.random(), this.random());
    this.choices = Decisions.candidates(this.model, this.state, actor, base, this.memory);
    return { x: Array.from(Policy.features(this.state, actor, this.model.init, this.memory, this.model.featureVersion)), decisionX: this.choices.map(c => c.x) };
  }
  step(index, autoReset = true, settings = {}) {
    if (!Number.isInteger(index) || index < 0 || index >= this.choices.length) throw Error('Invalid league action');
    const beforeState=this.state,action = this.choices[index].action, before = this.state.players.find(p => p.id === 'league-learner');
    const home = World.MAP.spawns[before.slot], homeD = Math.hypot(home.x-before.x,home.z-before.z), hp = before.hp / before.maxHp;
    const dt = this.options.intervalTicks / World.TICK, cfg = World.configFor(before.character);
    const ownEconomy=beforeState.control.find(z=>z.slot===before.slot)?.energy||0;
    const opposingEconomy=beforeState.control.find(z=>z.slot!==before.slot)?.energy||0;
    const farmWeight=economicWeight(ownEconomy);
    let reward = REWARDS.timePerSecond * dt;
    const addReward = (key, amount) => { reward += amount; this.metrics.rewardComponents[key] += amount; };
    if (action.event === 'recall' && !before.dead && !before.stun) {
      if (before.recall > 0) { this.metrics.repeatRecalls++; reward += REWARDS.repeatRecall; }
      else { this.metrics.recallStarts++; if (hp >= .97 || homeD <= World.CFG.safeRadius + 2) { this.metrics.unnecessaryRecalls++; reward += REWARDS.unnecessaryRecall; } }
    }
    // Mobility skills can be useful without hitting anyone, including Alex's leap.
    const offensive = action.event === 'q' || action.event === 'c' && ['mira','darius'].includes(before.character);
    const range = action.event === 'q' ? cfg.qRange : action.event === 'leap' ? cfg.leapRange : before.character === 'mira' ? cfg.magicRange : cfg.cRange;
    const visibleTargets = [...this.state.players.filter(p => p.vis), ...this.state.robots, ...this.state.monsters, ...this.state.towers];
    const canHit = visibleTargets.some(p => p.slot !== before.slot && !p.dead && Number.isFinite(p.x) && Math.hypot(p.x-before.x,p.z-before.z) <= range + (p.radius || 1.5));
    const believed = Object.values(this.memory.perception?.enemies || {}).some(e => e.belief?.confidence > 0 && Math.hypot(e.belief.x-before.x,e.belief.z-before.z) <= range + 3);
    const cooldown = action.event === 'q' ? 'qCd' : action.event === 'c' ? 'cCd' : 'eCd';
    this.combat = [];
    for (const c of Policy.commands(this.model, this.state, 'league-learner', action)) this.game.input('league-learner', c.event, c.data);
    if (offensive && !before.dead && !before.stun) {
      if (this.game.state.players['league-learner'][cooldown] <= before[cooldown]) { this.metrics.invalidSkills++; addReward('invalidSkill',REWARDS.invalidSkill); }
      else if (!canHit && !believed) { this.metrics.emptySkills++; addReward('emptySkill',REWARDS.emptySkill); }
    }
    for (let i = 0; i < this.options.intervalTicks && this.state.phase === 'playing'; i++) { this.game.tick(); this.state = this.game.observe('league-learner'); }
    this.elapsed = this.state.time-this.startedAt;
    let directDealt = 0, received = 0;
    for (const e of this.combat) {
      const ours = e.slot === before.slot, owned = e.source === 'league-learner' || e.owner === 'league-learner';
      if (e.kind === 'damage') {
        if (e.source === 'league-learner') directDealt += e.amount;
        if (owned && e.targetKind === 'player' && e.targetSlot !== before.slot) reward += e.amount * REWARDS.heroDamage;
        if(owned&&e.targetKind==='monster'&&!e.large){
          this.metrics[e.source==='league-learner'?'directSmallDamage':'summonSmallDamage']+=e.amount;
          const monster=beforeState.monsters.find(m=>m.id===e.target);
          const credit=this.farmDamageCredit.get(e.target)||{paid:0,maxHp:monster?.maxHp||100};
          const amount=Math.min(e.amount,Math.max(0,credit.maxHp-credit.paid));credit.paid+=amount;this.farmDamageCredit.set(e.target,credit);
          this.metrics.smallDamage+=e.amount;addReward('smallMonsterDamage',amount*REWARDS.smallMonsterDamage*farmWeight);
        }
        if (e.target === 'league-learner') { received += e.amount; reward += e.amount * REWARDS.damageReceived; if (e.source === 'league-opponent' || e.owner === 'league-opponent') this.lastHeroHit = this.elapsed; }
        if(e.target==='league-learner'&&e.zone)reward+=e.amount*REWARDS.zoneDamage;
        if (e.targetKind === 'tower') {
          reward += e.amount * REWARDS.towerDamage * (ours ? 1 : -1);
          if (ours) {
            this.metrics.towerDamage += e.amount;
            if(e.source==='league-learner')this.metrics.directTowerDamage+=e.amount;
            else if(e.owner==='league-learner')this.metrics.summonTowerDamage+=e.amount;
          }
        }
        if (e.large && !ours && e.slot !== 2) this.lastBossHit = this.elapsed;
      } else if (e.targetKind === 'tower') {
        this.metrics[ours ? 'towers' : 'towersLost']++; reward += REWARDS.tower * (ours ? 1 : -1);
        if(e.source==='league-learner')this.metrics.directTowers++;
        else if(e.owner==='league-learner')this.metrics.summonTowers++;
      }
      else if (e.targetKind === 'monster' && e.large && e.slot !== 2) {
        this.metrics[ours ? 'largeKills' : 'largeLosses']++;
        const contested=this.elapsed-this.lastBossHit<3;
        reward += REWARDS.large*(ours?Math.max(farmWeight,contested?economicWeight(opposingEconomy)*.5:0):-economicWeight(opposingEconomy));
      }
      else if (e.targetKind === 'monster' && !e.large) {
        if(owned){
          this.metrics.smallKills++;addReward('smallMonster',REWARDS.smallMonster*farmWeight);
          this.metrics[e.source==='league-learner'?'directSmallKills':'summonSmallKills']++;
          const monster=beforeState.monsters.find(m=>m.id===e.target),own=beforeState.control.find(z=>z.slot===before.slot),enemy=beforeState.control.find(z=>z.slot!==before.slot);
          if(monster&&inControl(monster,before.slot,own))this.metrics.ownSmallKills++;
          if(monster&&inControl(monster,1-before.slot,enemy))this.metrics.enemySmallKills++;
        }
        this.farmDamageCredit.delete(e.target);
      }
      else if (e.targetKind === 'player') { this.metrics[e.targetSlot === before.slot ? 'deaths' : 'kills']++; reward += e.targetSlot === before.slot ? REWARDS.death : REWARDS.kill; }
    }
    const after = this.state.players.find(p => p.id === 'league-learner'), energy = Math.max(0, after.energy - before.energy);
    if(this.startedLow&&!this.metrics.deaths&&!after.dead&&after.hp>=after.maxHp*.8)this.metrics.recovered=true;
    if(!after.dead&&inControl(after,1-after.slot,this.state.control.find(z=>z.slot!==after.slot)))this.metrics.enemyZoneSeconds+=dt;
    if(!after.dead&&(after.slot?after.z-after.x:after.x-after.z)>0)this.metrics.forwardSeconds+=dt;
    const afterEconomy=this.state.control.find(z=>z.slot===before.slot)?.energy||0;
    const usefulEnergy=Math.max(0,Math.min(energyCap(),afterEconomy)-Math.min(energyCap(),ownEconomy));
    this.metrics.energy += energy;this.metrics.usefulEnergy+=usefulEnergy;addReward('energy',usefulEnergy * REWARDS.energy);
    if (before.recall > 0 && !after.recall && received > 0) { this.metrics.interruptedRecalls++; reward += REWARDS.interruptedRecall; }
    const target = [...this.state.monsters,...this.state.players,...this.state.towers,...this.state.robots].find(t => t.id === after.inputs?.target && !t.dead);
    const moving = Math.hypot(after.x-before.x,after.z-before.z) > .03;
    // Only real recovery or combat exempts inactivity. A stale target or distant summon damage does not.
    const recovering = after.hp > before.hp + .01 || after.recall > 0 && hp < .9 && homeD > World.CFG.safeRadius + 2;
    const targetRadius = target?.radius || (target?.large ? 1.5 : target?.slot === 2 ? .65 : this.state.towers.some(t => t.id === target?.id) ? World.CFG.tower.radius : 0);
    const inAttackRange = target && Number.isFinite(target.x) && Math.hypot(target.x-after.x,target.z-after.z) <= cfg.atkRange + targetRadius + .1;
    const engaged = directDealt > 0 || inAttackRange && this.game.state.players['league-learner'].atkCd > 0;
    if (before.dead && !after.dead) this.spawnGraceUntil = this.elapsed + 3;
    const free = !after.dead && !after.stun && !after.air && !after.charging && !after.warping && !after.grabbing && !after.grabbed && !after.flying;
    if (free && this.elapsed > this.spawnGraceUntil) {
      if (!recovering && !engaged && Math.hypot(after.x-home.x,after.z-home.z) < 8) { this.metrics.spawnLoiterSeconds += dt; addReward('spawnLoiter',dt * REWARDS.spawnLoiterPerSecond); }
      if (!recovering && !engaged && !moving) { this.metrics.idleSeconds += dt; if (Math.hypot(after.x-home.x,after.z-home.z) >= 8) this.metrics.fieldIdleSeconds += dt; addReward('idle',dt * REWARDS.idlePerSecond); }
      if (target?.slot === 2 && this.elapsed - this.lastHeroHit < 1) { this.metrics.attackedFarmSeconds += dt; reward += dt * REWARDS.attackedFarmPerSecond; }
      const boss = this.state.monsters.find(m => m.large && !m.dead);
      if (boss && (farmWeight>0||economicWeight(opposingEconomy)>0) && boss.hp / boss.maxHp < .25 && Math.hypot(boss.x-after.x,boss.z-after.z) < 16 && this.elapsed-this.lastBossHit < 2 && target?.id !== boss.id) { this.metrics.ignoredBossSeconds += dt; reward += dt * REWARDS.ignoredBossPerSecond; }
    }
    const terminal = this.state.phase === 'finished', truncated = !terminal && this.elapsed >= this.options.maxSeconds;
    const phi = terminal ? 0 : this.potential(); reward += (this.options.gamma ?? .999) * phi - this.previousPotential; this.previousPotential = phi;
    if (terminal) reward += this.state.winner === before.slot ? REWARDS.win : REWARDS.loss;
    this.totalReward += reward;
    const bootstrap = settings.skipObservation?null:this.observation(), result = { reward, terminal, truncated, bootstrap, observation: bootstrap };
    if (terminal || truncated) {
      result.episode = { ...this.metrics, seconds: this.elapsed, return: this.totalReward, winner: terminal ? Number(this.state.winner === before.slot) : null,
        reason: terminal ? 'tower-destruction' : 'time-limit', truncated };
      if (autoReset) result.observation = this.reset();
    }
    return result;
  }
  snapshot() {
    const keys=['elapsed','memory','cues','lastHeroHit','lastBossHit','spawnGraceUntil','totalReward','metrics','farmDamageCredit','startedAt','previousPotential','seed','choices'];
    return {game:this.game.snapshot(),data:structuredClone(Object.fromEntries(keys.map(k=>[k,this[k]])))};
  }
  restore(snapshot) {
    this.game.restore(snapshot.game);Object.assign(this,structuredClone(snapshot.data));this.combat=[];this.state=this.game.observe('league-learner');
  }
  lookahead(index,seconds=12,settings={}) {
    if(settings.followPolicyAfter!==undefined){
      const delay=settings.followPolicyAfter;
      if(!Number.isFinite(delay)||delay<0||delay>seconds)throw Error('Invalid rollout policy delay');
      const action=this.choices[index].action,start=this.elapsed;let total=0,discount=1;
      for(let i=0;i<Math.ceil(seconds*World.TICK/this.options.intervalTicks);i++){
        let chosen;
        if(i===0)chosen=action;
        else if(this.elapsed-start<delay)chosen=action.event==='steer'?action:{event:'noop'};
        else{
          const observation=this.observation(),p=this.model.tacticalPolicy,context=Decisions.context(p,observation.x);
          const next=Decisions.select(this.choices.map(c=>Decisions.score(p,c.x,context)),Decisions.temperature(p),this.random());
          chosen=this.choices[next].action;
        }
        this.choices=[{action:chosen}];const r=this.step(0,false,{skipObservation:true});
        total+=discount*r.reward;discount*=this.options.gamma??.9997;
        if(r.terminal||r.truncated||this.game.state.players['league-learner'].dead)break;
      }
      return total;
    }
    const action=this.choices[index].action,goal=action.event==='chase'?action.data.id:null;
    const startKills=this.metrics.smallKills+this.metrics.kills+this.metrics.towers+this.metrics.largeKills;
    const noop={action:{event:'noop'}};let total=0,discount=1;
    const observer=this.learnerController.observeState,events=this.learnerController.observe;
    this.learnerController.observeState=null;this.learnerController.observe=null;
    try{
      for(let i=0;i<Math.ceil(seconds*World.TICK/this.options.intervalTicks);i++){
        const chosen=i===0?action:action.event==='steer'?action:noop.action;
        this.choices=[{action:chosen}];const r=this.step(0,false,{skipObservation:true});
        total+=discount*r.reward;discount*=this.options.gamma??.9997;
        const p=this.game.state.players['league-learner'];
        const complete=this.metrics.smallKills+this.metrics.kills+this.metrics.towers+this.metrics.largeKills>startKills;
        if(r.terminal||r.truncated||p.dead||complete)break;
        if(goal&&!this.state.players.concat(this.state.monsters,this.state.towers,this.state.robots).some(t=>t.id===goal&&!t.dead))break;
        if(action.event==='move'&&Math.hypot(p.x-action.data.x,p.z-action.data.z)<.8)break;
      }
    }finally{this.learnerController.observeState=observer;this.learnerController.observe=events;}
    return total;
  }
}
async function serve() {
  let pool, environments = [];
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      const q = JSON.parse(line); let response;
      if(q.op==='rules'){
        response={cfg:World.CFG,map:World.MAP,characters:World.CHARACTERS,tick:World.TICK};
      } else if (q.op === 'init') {
        if (!Number.isInteger(q.envs) || q.envs < 1 || q.envs > 16) throw Error('envs must be 1..16');
        pool = new Pool(q.pool); const model = load(q.model).model;
        if(q.balancedCharacters&&q.envs%model.characters.length)throw Error('envs must be a multiple of the number of characters');
        environments = Array.from({length:q.envs},(_,i) => new LeagueEnvironment(model,pool,{...q.options,seed:q.options.seed+i*997,
          ...(q.balancedCharacters?{learnerCharacter:model.characters[i%model.characters.length],learnerSlot:Math.floor(i/model.characters.length)%2}:{})}));
        response = { observations: environments.map(e => e.reset()), rewards: REWARDS, rewardProfile: REWARD_VERSION };
      } else if (q.op === 'step') {
        if (q.actions?.length !== environments.length) throw Error('Invalid action batch');
        response = { results: environments.map((e,i) => e.step(q.actions[i])) };
      } else if (q.op === 'refresh') {
        pool.update(q.pool); const model = load(q.model).model;
        for (const env of environments) env.model = model;
        response = { observations: environments.map(e => e.observation()) };
      } else if (q.op === 'evaluate') {
        const entry = load(q.model), evaluationPool = new Pool(q.pool); const episodes = [], offset = q.offset || 0;
        for (let i=0;i<offset;i++) evaluationPool.draw(entry.model.characters);
        for (let i = 0; i < q.episodes; i++) {
          const index=i+offset,env = new LeagueEnvironment(entry.model,evaluationPool,{...q.options,seed:q.options.seed+index*997});
          const forced={character:entry.model.characters[index%entry.model.characters.length],slot:Math.floor(index/entry.model.characters.length)%2,scenario:q.scenarios?.[index%q.scenarios.length]||'match'};
          if(q.algorithmOnly)Object.assign(forced,{category:'algorithm',entry:null,opponentCharacter:World.CHARACTERS[Math.floor(index/(entry.model.characters.length*2))%World.CHARACTERS.length].id});
          let observation = env.reset(forced);
          let rng=(q.options.seed+index*997 ^ 12345)>>>0;
          for (;;) {
            const conditioning = Decisions.context(entry.model.tacticalPolicy, observation.x);
            rng=(Math.imul(rng,1664525)+1013904223)>>>0;
            const best=Decisions.select(env.choices.map(c=>Decisions.score(entry.model.tacticalPolicy,c.x,conditioning)),Decisions.temperature(entry.model.tacticalPolicy,q.temperature),rng/4294967296);
            const r = env.step(best,false); if (r.episode) { episodes.push(r.episode); break; } observation = r.observation;
          }
        }
        response = { episodes };
      } else if (q.op === 'close') { process.stdout.write('{"closed":true}\n'); process.stdin.destroy(); return; }
      else throw Error('Unknown league operation');
      process.stdout.write(JSON.stringify(response)+'\n');
    } catch (e) { process.stdout.write(JSON.stringify({error:e.stack})+'\n'); }
  }
}
if (require.main === module) serve();
module.exports = { Pool, LeagueEnvironment, REWARDS, REWARD_VERSION, validateOptions, territoryFraction, economicWeight, energyCap };

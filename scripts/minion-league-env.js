'use strict';
const readline = require('node:readline');
const crypto = require('node:crypto');
const World = require('../game-world');
const Policy = require('../public/minion-policy');
const Decisions = require('../public/minion-decisions');
const { readJSON } = require('./minion-input');
const init = model => ({ ...model.init, map: World.MAP, cfg: World.CFG, characters: World.CHARACTERS });
const load = file => { const model = Policy.validate(readJSON(file)); return { file, model: { ...model, init: init(model) }, sha256: crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex') }; };
const REWARD_VERSION = 'league-activity/13';
const REWARDS = Object.freeze({ win: 30, loss: -30, tower: 5, towerDamage: .008, large: 4, smallMonster: .8, energy: .01, kill: 2, death: -3,
  damageReceived: -.002, emptySkill: -.25, invalidSkill: -.05, unnecessaryRecall: -.25, repeatRecall: -.04, interruptedRecall: -.15,
  spawnLoiterPerSecond: -.1, idlePerSecond: -.1, attackedFarmPerSecond: -.03, ignoredBossPerSecond: -.025, timePerSecond: -.01 });
function validateOptions(options) {
  if (!Number.isFinite(options.maxSeconds) || options.maxSeconds < 1 || options.maxSeconds > 86400) throw Error('maxSeconds must be 1..86400');
  if (!Number.isInteger(options.intervalTicks) || options.intervalTicks < 3 || options.intervalTicks > 9) throw Error('intervalTicks must be 3..9');
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
    Object.assign(this.fixture,forced);
    if (!this.model.characters.includes(this.fixture.character) || ![0,1].includes(this.fixture.slot)) throw Error('Invalid forced fixture');
    this.lastHeroHit = -100; this.lastBossHit = -100; this.spawnGraceUntil = 5; this.totalReward = 0; const f = this.fixture;
    this.metrics = { opponent: f.category, opponentFile: f.entry?.file || null, opponentSha256: f.entry?.sha256 || null,
      character: f.character, opponentCharacter: f.opponentCharacter, slot: f.slot, kills: 0, deaths: 0, towers: 0, towersLost: 0,
      towerDamage: 0, energy: 0, smallKills: 0, largeKills: 0, largeLosses: 0, recallStarts: 0, repeatRecalls: 0, unnecessaryRecalls: 0,
      interruptedRecalls: 0, emptySkills: 0, invalidSkills: 0, spawnLoiterSeconds: 0, idleSeconds: 0, fieldIdleSeconds: 0, attackedFarmSeconds: 0, ignoredBossSeconds: 0,
      rewardComponents: { smallMonster: 0, energy: 0, emptySkill: 0, invalidSkill: 0, spawnLoiter: 0, idle: 0 } };
    const learner = () => [];
    learner.observe = e => this.cues.push(e);
    learner.observeState = state => { Policy.updateMemory(this.memory, state, 'league-learner', this.cues, this.model.featureVersion, this.model.init); this.cues = []; };
    this.game = World.createMatch(false, false, { teamSizes: [1,1], onCombat: e => this.combat.push(e) });
    for (let slot = 0; slot < 2; slot++) {
      const ours = slot === f.slot, id = ours ? 'league-learner' : 'league-opponent';
      const controller = ours ? learner : f.entry ? Policy.controller(f.entry.model, { slot, actorId: id, seed: this.seed ^ 104729 }) : null;
      this.game.connect({ id, on() {}, emit() {}, disconnect() {} }, { team: slot, member: 0, bot: true, controller, character: ours ? f.character : f.opponentCharacter });
    }
    this.state = this.game.observe('league-learner'); this.previousPotential = this.potential(); return this.observation();
  }
  potential() {
    const p = this.state.players.find(p => p.id === 'league-learner'); if (p.dead) return 0;
    const towers = this.state.towers.filter(t => !t.dead && t.slot !== p.slot);
    return towers.length ? .3 * (p.hp / p.maxHp) ** 2 * Math.max(0, 1 - Math.min(...towers.map(t => Math.hypot(t.x-p.x,t.z-p.z))) / 90) : 0;
  }
  observation() {
    const actor = 'league-learner';
    Policy.updateMemory(this.memory, this.state, actor, this.cues, this.model.featureVersion, this.model.init); this.cues = [];
    const base = Policy.decide({ ...this.model, tacticalPolicy: null }, this.state, actor, this.memory, this.random(), this.random(), this.random());
    this.choices = Decisions.candidates(this.model, this.state, actor, base, this.memory);
    return { x: Array.from(Policy.features(this.state, actor, this.model.init, this.memory, this.model.featureVersion)), decisionX: this.choices.map(c => c.x) };
  }
  step(index, autoReset = true) {
    if (!Number.isInteger(index) || index < 0 || index >= this.choices.length) throw Error('Invalid league action');
    const action = this.choices[index].action, before = this.state.players.find(p => p.id === 'league-learner');
    const home = World.MAP.spawns[before.slot], homeD = Math.hypot(home.x-before.x,home.z-before.z), hp = before.hp / before.maxHp;
    const dt = this.options.intervalTicks / World.TICK, cfg = World.configFor(before.character);
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
    this.elapsed = this.state.time;
    let directDealt = 0, received = 0;
    for (const e of this.combat) {
      const ours = e.slot === before.slot, owned = e.source === 'league-learner' || e.owner === 'league-learner';
      if (e.kind === 'damage') {
        if (e.source === 'league-learner') directDealt += e.amount;
        if (e.target === 'league-learner') { received += e.amount; reward += e.amount * REWARDS.damageReceived; if (e.source === 'league-opponent' || e.owner === 'league-opponent') this.lastHeroHit = this.elapsed; }
        if (e.targetKind === 'tower') { reward += e.amount * REWARDS.towerDamage * (ours ? 1 : -1); if (ours) this.metrics.towerDamage += e.amount; }
        if (e.large && !ours && e.slot !== 2) this.lastBossHit = this.elapsed;
      } else if (e.targetKind === 'tower') { this.metrics[ours ? 'towers' : 'towersLost']++; reward += REWARDS.tower * (ours ? 1 : -1); }
      else if (e.targetKind === 'monster' && e.large && e.slot !== 2) { this.metrics[ours ? 'largeKills' : 'largeLosses']++; reward += REWARDS.large * (ours ? 1 : -1); }
      else if (e.targetKind === 'monster' && !e.large && owned) { this.metrics.smallKills++; addReward('smallMonster',REWARDS.smallMonster); }
      else if (e.targetKind === 'player') { this.metrics[e.targetSlot === before.slot ? 'deaths' : 'kills']++; reward += e.targetSlot === before.slot ? REWARDS.death : REWARDS.kill; }
    }
    const after = this.state.players.find(p => p.id === 'league-learner'), energy = Math.max(0, after.energy - before.energy);
    this.metrics.energy += energy; addReward('energy',energy * REWARDS.energy);
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
      if (boss && boss.hp / boss.maxHp < .25 && Math.hypot(boss.x-after.x,boss.z-after.z) < 16 && this.elapsed-this.lastBossHit < 2 && target?.id !== boss.id) { this.metrics.ignoredBossSeconds += dt; reward += dt * REWARDS.ignoredBossPerSecond; }
    }
    const terminal = this.state.phase === 'finished', truncated = !terminal && this.elapsed >= this.options.maxSeconds;
    const phi = terminal ? 0 : this.potential(); reward += (this.options.gamma ?? .999) * phi - this.previousPotential; this.previousPotential = phi;
    if (terminal) reward += this.state.winner === before.slot ? REWARDS.win : REWARDS.loss;
    this.totalReward += reward;
    const bootstrap = this.observation(), result = { reward, terminal, truncated, bootstrap, observation: bootstrap };
    if (terminal || truncated) {
      result.episode = { ...this.metrics, seconds: this.elapsed, return: this.totalReward, winner: terminal ? Number(this.state.winner === before.slot) : null,
        reason: terminal ? 'tower-destruction' : 'time-limit', truncated };
      if (autoReset) result.observation = this.reset();
    }
    return result;
  }
}
async function serve() {
  let pool, environments = [];
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try {
      const q = JSON.parse(line); let response;
      if (q.op === 'init') {
        if (!Number.isInteger(q.envs) || q.envs < 1 || q.envs > 16) throw Error('envs must be 1..16');
        pool = new Pool(q.pool); const model = load(q.model).model;
        environments = Array.from({length:q.envs},(_,i) => new LeagueEnvironment(model,pool,{...q.options,seed:q.options.seed+i*997}));
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
          let observation = env.reset({character:entry.model.characters[index%entry.model.characters.length],slot:Math.floor(index/entry.model.characters.length)%2});
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
module.exports = { Pool, LeagueEnvironment, REWARDS, REWARD_VERSION, validateOptions };

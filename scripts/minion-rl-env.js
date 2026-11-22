const readline = require('node:readline');
const World = require('../game-world');
const Policy = require('../public/minion-policy');
const Decisions = require('../public/minion-decisions');
const { readJSON } = require('./minion-input');

const REWARDS = Object.freeze({ win: 20, loss: -20, tower: 3, kill: 1.5, death: -2.5,
  heroDamage: 0.002, towerDamage: 0.004, damageReceived: -0.002, zoneDamage: -0.004, energy: 0.08,
  emptyAttack: -0.06, rejectedAttack: -0.02, time: -0.0005, retreatTask: 3 });
const DEFENSE_REWARDS = Object.freeze({ towerDamage: -0.012, interceptDamage: 0.006, success: 3 });
const SHAPING = Object.freeze({ base: 0.8, health: 1.5, danger: 0.8, farmDistance: 0.25, farmDamage: 0.2, defenseDistance: 0.8 });
const SURVIVAL = Object.freeze({ death: -8, damageReceived: -.004, criticalDamage: -.02, energy: .02, recovery: 6, health: 3, danger: 2.5, safeDistance: 2 });
const runtimeInit = model => ({ ...model.init, cfg: World.CFG, map: World.MAP, characters: World.CHARACTERS });

function potential(state, actor, init = { cfg: World.CFG, map: World.MAP, characters: World.CHARACTERS }, memory = {}, survival = false, decisions = false) {
  const me = state.players.find(p => p.id === actor);
  if (me.dead) return 0;
  const ratio = me.hp / me.maxHp;
  const boundary = state.control.find(c => c.slot === 1 - me.slot).boundary;
  const inEnemy = (me.slot === 1 ? me.x - me.z : me.z - me.x) < boundary;
  const enemies = [...state.players.filter(p => p.id !== actor && p.vis), ...state.robots, ...state.towers]
    .filter(e => e.slot !== me.slot && !e.dead && Number.isFinite(e.x));
  const near = enemies.reduce((risk, e) => Math.max(risk, Math.max(0, 1 - Math.hypot(me.x - e.x, me.z - e.z) / 10)), 0);
  const danger = Math.min(1, (inEnemy ? 0.7 : 0) + near);
  const own = state.control.find(c => c.slot === me.slot);
  const farm = (state.monsters || []).filter(m => !m.large && !m.dead
    && own && (me.slot === 1 ? m.z - m.x : m.x - m.z) < own.boundary)
    .reduce((best, m) => Math.max(best, SHAPING.farmDistance * Math.max(0, 1 - Math.hypot(m.x - me.x, m.z - me.z) / 40)
      + SHAPING.farmDamage * (1 - m.hp / m.maxHp)), 0);
  // Potential differences reward progress, without paying repeatedly for damage/healing cycles.
  const threat = Policy.defenseContext(state, actor, init, memory);
  const destination = threat?.attacker || threat?.tower;
  const defense = destination ? SHAPING.defenseDistance * Math.max(0, 1 - Math.hypot(destination.x - me.x, destination.z - me.z) / 40) : 0;
  const safeDistance = own ? Math.max(0, (me.slot === 1 ? me.z - me.x : me.x - me.z) - own.boundary) / Math.SQRT2 : 0;
  const hero = state.players.find(p => p.slot !== me.slot && p.vis && !p.dead && Number.isFinite(p.x));
  const finishing = decisions && hero ? .75 * ratio ** 2 * Math.min(1, World.configFor(me.character).atkDmg / Math.max(1, hero.hp)) * Math.max(0, 1 - Math.hypot(hero.x - me.x, hero.z - me.z) / 20) : 0;
  return SHAPING.base + (survival ? SURVIVAL.health : SHAPING.health) * ratio - (survival ? SURVIVAL.danger : SHAPING.danger) * (1 - ratio) ** 2 * danger
    + ratio ** 2 * (farm + defense) - (survival ? SURVIVAL.safeDistance * (1 - ratio) ** 2 * Math.min(1, safeDistance / 20) : 0) + finishing;
}

function emptyAttack(state, actor, cfg, memory = {}) {
  const me = state.players.find(p => p.id === actor);
  // Blind casts at a recently seen enemy remain valid training choices.
  const seen = memory.lastSeen?.opponent;
  const candidates = [...state.players.filter(p => p.id !== actor && p.vis), ...state.robots, ...state.towers, ...(state.monsters || [])];
  if (seen && state.time - seen.seenAt <= 2) candidates.push(seen);
  return !candidates.some(e => e.slot !== me.slot && !e.dead && Number.isFinite(e.x)
    && Math.hypot(e.x - me.x, e.z - me.z) <= cfg.qRange + (e.radius || 1) + .5);
}

class Environment {
  constructor(model, options = {}) {
    this.model = { ...model, init: runtimeInit(model), reinforcementLearning: { ...model.reinforcementLearning, algorithm: 'PPO' } };
    this.options = { gamma: 0.995, maxSeconds: 120, retreatFraction: 0.25, farmFraction: 0.2, defenseFraction: 0.3, seed: 17, ...options };
    this.survival = this.options.rewardProfile === 'survival/1';
    this.decisions = !!this.options.decisionTraining || !!model.tacticalPolicy;
    if (this.options.rewardProfile && !this.survival) throw Error('Invalid reward profile');
    this.seed = this.options.seed >>> 0; this.episode = 0;
  }
  random() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }
  reset(forcedScenario = null, forcedCharacter = null) {
    this.episode++; this.memory = {}; this.cues = []; this.combat = []; this.return = 0; this.elapsed = 0;
    const scenarioDraw = this.random();
    this.scenario = forcedScenario || (this.decisions && scenarioDraw < (this.options.decisionFraction ?? .7)
      ? ['duel-retreat', 'duel-retreat-chase', 'finish-static', 'finish-flee'][Math.floor(this.random() * 4)]
      : this.decisions ? (this.random() < .5 ? 'farm' : 'match') : scenarioDraw < this.options.retreatFraction ? 'retreat'
      : scenarioDraw < this.options.retreatFraction + this.options.farmFraction ? 'farm'
      : scenarioDraw < this.options.retreatFraction + this.options.farmFraction + this.options.defenseFraction ? 'defense'
      : scenarioDraw < this.options.retreatFraction + this.options.farmFraction + this.options.defenseFraction + (this.options.bushFraction || 0) ? ['bush-entry', 'bush-attack', 'bush-empty', 'bush-exit'][Math.floor(this.random() * 4)] : 'match');
    if (!forcedScenario && this.scenario === 'retreat' && this.random() < 0.25) this.scenario = 'retreat-hard';
    if (this.options.focusCharacter && !this.model.characters.includes(this.options.focusCharacter)) throw Error('Unsupported focus character');
    const character = forcedCharacter || (this.options.focusCharacter && this.random() < .6 ? this.options.focusCharacter : this.model.characters[Math.floor(this.random() * this.model.characters.length)]);
    this.character = character;
    this.opponentCharacter = World.CHARACTERS[Math.floor(this.random() * World.CHARACTERS.length)].id;
    if (this.scenario === 'defense') this.opponentCharacter = this.random() < .5 ? 'alex' : 'mira';
    if (this.scenario.startsWith('finish-') || this.scenario.startsWith('duel-')) this.opponentCharacter = 'alex';
    if (this.scenario.startsWith('bush-')) this.opponentCharacter = 'mira';
    this.metrics = { scenario: this.scenario, character, opponent: this.opponentCharacter, deaths: 0, kills: 0,
      damageDealt: 0, damageReceived: 0, zoneDamage: 0, towersDestroyed: 0, towersLost: 0, recovery: false, lowHp: false, commands: 0,
      lowHpChaseCommands: 0, lowHpStepsTowardHome: 0, lowHpStepsAwayFromHome: 0, attackAttempts: 0, emptyAttacks: 0, rejectedAttacks: 0,
      ownTowerDamage: 0, defenseDamage: 0, defenseStopped: false, firstDefenseHitSeconds: null,
      unproductiveSeconds: 0, largeKills: 0, largeLosses: 0, largeFocusSeconds: null,
      bushInvestigated: false, bushBeliefAtStart: false, bushHiddenDamage: 0, firstBushHitSeconds: null };
    const hooks = {};
    const idle = () => [];
    idle.autoNavigation = this.model.decisionMode === 'learned/1';
    idle.observe = event => this.cues.push(event);
    idle.observeState = state => { Policy.updateMemory(this.memory, state, 'cpu-player', this.cues, this.model.featureVersion, this.model.init); this.cues = []; };
    this.game = World.createMatch(false, true, { policy: idle, opponent: this.scenario !== 'defense' && !this.scenario.startsWith('large-') && !this.scenario.startsWith('bush-') && !this.scenario.startsWith('finish-'), onCombat: event => this.combat.push(event) });
    this.game.connect({ id: 'opponent', on(e, fn) { hooks[e] = fn; }, emit() {}, disconnect() {} });
    hooks.selectCpuCharacter({ id: character }); hooks.selectCharacter({ id: this.opponentCharacter }); hooks.confirmCharacter();
    const p = this.game.state.players['cpu-player'], enemy = this.game.state.players.opponent;
    if (this.scenario.startsWith('finish-')) {
      while (this.game.observe(p.id).time < 5.2) this.game.tick();
      this.game.state.environment.totals = [200, 200];
      const angle = -Math.PI / 4 + (this.random() - .5) * .4, d = p.cfg.atkRange + .5 + this.random() * 1.2;
      Object.assign(p, { x: 0, z: 8, hp: p.cfg.maxHp, target: null, dest: null, keys: null, qCd: 0, eCd: 0, cCd: 0 });
      Object.assign(enemy, { x: Math.sin(angle) * d, z: 8 + Math.cos(angle) * d, hp: p.cfg.atkDmg * (.2 + this.random() * .35), target: null, dest: null, keys: null });
      hooks.c({ x: 2.8, z: 8 });
      const summon = Object.values(this.game.state.robots).find(r => r.slot === 0);
      if (summon) Object.assign(summon, { x: 2.8, z: 8, stun: 100, life: 100 });
      this.memory = {}; this.cues = []; this.combat = [];
      this.game.tick();
    } else if (this.scenario.startsWith('bush-')) {
      while (this.game.observe(p.id).time < 5.2) this.game.tick();
      const bush = World.MAP.bushes[4]; this.bush = bush;
      Object.assign(p, { x: bush.x + 4.5 + this.random() * 2, z: bush.z - 1.5 + this.random() * 2.5, hp: p.cfg.maxHp, keys: null, target: null, dest: null });
      Object.assign(enemy, { x: bush.x + bush.r + .3 + this.random() * .5, z: bush.z + (this.random() - .5) * .6,
        hp: enemy.cfg.maxHp * (.55 + this.random() * .25), keys: null, target: null, dest: null });
      this.memory = {}; this.cues = []; this.combat = [];
      if (this.scenario === 'bush-attack') Object.assign(enemy, { x: bush.x + (this.random() - .5) * 1.8, z: bush.z + (this.random() - .5) * 1.8 });
      if (this.scenario === 'bush-empty') Object.assign(enemy, { x: World.MAP.bushes[5].x, z: World.MAP.bushes[5].z });
      this.game.tick();
      if (['bush-entry', 'bush-exit'].includes(this.scenario)) {
        this.game.input(enemy.id, 'move', { x: bush.x, z: bush.z });
        for (let i = 0; i < 15 && this.game.observe(p.id).players.find(e => e.id === enemy.id).vis; i++) this.game.tick();
        this.game.input(enemy.id, 'move', { x: enemy.x, z: enemy.z });
      }
      if (this.scenario === 'bush-attack') this.game.input(enemy.id, 'q', { x: p.x, z: p.z });
      if (this.scenario === 'bush-exit') {
        this.game.input(enemy.id, 'move', { x: bush.x + bush.r + 2, z: bush.z });
        for (let i = 0; i < 20 && !this.game.observe(p.id).players.find(e => e.id === enemy.id).vis; i++) this.game.tick();
        this.game.input(enemy.id, 'move', { x: enemy.x, z: enemy.z });
      }
      this.combat = [];
    } else if (this.scenario.startsWith('retreat') || this.scenario.startsWith('duel-retreat')) {
      Object.assign(p, { x: -3 - this.random() * 2, z: 1 + this.random() * 2, hp: p.cfg.maxHp * (0.2 + this.random() * 0.2) });
      const distance = this.scenario === 'retreat-hard' ? 2 : 4;
      Object.assign(enemy, { x: p.x - distance - this.random(), z: p.z + 2 + this.random(), hp: enemy.cfg.maxHp * (0.6 + this.random() * 0.4) });
    } else if (this.scenario.startsWith('large-')) {
      while (this.game.observe('cpu-player').time < 5.2) this.game.tick();
      const boss = Object.values(this.game.state.monsters).find(m => m.large);
      boss.hp = this.scenario === 'large-contest' ? 60 + this.random() * 60 : 15 + this.random() * 65;
      Object.assign(p, { x: this.scenario === 'large-contest' ? 12 : 5, z: this.scenario === 'large-contest' ? 2 : 4, hp: p.cfg.maxHp, keys: null, target: null, dest: null });
      if (this.scenario === 'large-contest') {
        Object.assign(enemy, { x: -enemy.cfg.atkRange - boss.radius + .3, z: boss.z, keys: null, target: null, dest: null });
        this.game.input('opponent', 'chase', { id: boss.id });
      }
      this.combat = []; this.memory = {}; this.cues = [];
    } else if (this.scenario === 'defense') {
      const tower = this.game.state.towers[`t1-${1 + Math.floor(this.random() * 3)}`];
      this.defenseTower = tower.id;
      const length = Math.hypot(tower.x, tower.z), range = enemy.cfg.atkRange + tower.radius - .3;
      Object.assign(enemy, { x: tower.x - tower.x / length * range, z: tower.z - tower.z / length * range });
      Object.assign(p, { x: 22 + this.random() * 2, z: -6 - this.random() * 4 });
      this.game.input('opponent', 'chase', { id: tower.id });
    } else if (this.scenario === 'farm') {
      // Only the training reset changes. The policy still uses ordinary player inputs.
      while (this.game.observe('cpu-player').time < 5.2) this.game.tick();
      const camp = this.game.state.camps.filter(c => !c.large && c.x > 0)[Math.floor(this.random() * 3)];
      Object.assign(p, { x: camp.x - 3 - this.random() * 2, z: camp.z - 3, hp: p.cfg.maxHp });
      this.combat = []; this.memory = {}; this.cues = [];
    } else {
      p.x += (this.random() - 0.5) * 2; p.z += (this.random() - 0.5) * 2;
      enemy.x += (this.random() - 0.5) * 2; enemy.z += (this.random() - 0.5) * 2;
    }
    if (this.survival && (this.scenario.startsWith('retreat') || this.scenario.startsWith('duel-retreat'))) {
      if (this.scenario.endsWith('chase') || this.random() < .5) this.game.input(p.id, 'chase', { id: enemy.id });
      else {
        const dx = enemy.x - p.x, dz = enemy.z - p.z, length = Math.hypot(dx, dz) || 1;
        this.game.input(p.id, 'steer', { x: dx / length, z: dz / length });
      }
    }
    this.state = this.game.observe('cpu-player');
    this.startedAt = this.state.time;
    Policy.updateMemory(this.memory, this.state, p.id, this.cues, this.model.featureVersion, this.model.init); this.cues = [];
    this.metrics.bushBeliefAtStart = Object.values(this.memory.perception?.enemies || {}).some(r => r.belief?.confidence > 0);
    this.previousEnergy = p.energy; this.previousPotential = potential(this.state, p.id, this.model.init, this.memory, this.survival, this.decisions);
    this.metrics.lowHp = p.hp / p.cfg.maxHp <= 0.4;
    return this.observation();
  }
  observation() {
    const state = this.state, actor = 'cpu-player', me = state.players.find(p => p.id === actor);
    Policy.updateMemory(this.memory, state, actor, this.cues, this.model.featureVersion, this.model.init); this.cues = [];
    if (this.decisions) {
      const base = Policy.decide({ ...this.model, tacticalPolicy: null }, state, actor, this.memory, this.random(), this.random(), this.random());
      this.decisionChoices = Decisions.candidates(this.model, state, actor, base);
      return { decisionX: this.decisionChoices.map(c => c.x) };
    }
    const threat = Policy.defenseContext(state, actor, this.model.init, this.memory), enemy = threat?.attacker;
    const lesson = this.scenario === 'defense' && me.hp / me.maxHp > .55 && enemy?.id === 'opponent'
      ? [1, (enemy.x - me.x) * (me.slot === 1 ? -1 : 1) / 60, (enemy.z - me.z) * (me.slot === 1 ? -1 : 1) / 60] : [0, 0, 0];
    return { x: Array.from(Policy.features(state, actor, this.model.init, this.memory, this.model.featureVersion)), lesson,
      mask: Policy.actionMask(this.model, state, actor, true),
      coordinates: Policy.EVENTS.map(event => (event === 'steer' && !this.model.weights.directionW) || ['move', 'chase', 'q', 'leap'].includes(event)
        || (event === 'dash' && ['lucia', 'darius'].includes(me.character)) || (event === 'c' && me.character !== 'lucia') ? 1 : 0) };
  }
  stepDecision(index, autoReset = true) {
    if (!Number.isInteger(index) || index < 0 || index >= this.decisionChoices.length) throw Error('Invalid decision candidate');
    const command = this.decisionChoices[index].action, label = Policy.label(command, this.state, 'cpu-player');
    return this.step({ type: label.type, latent: label.xy.map(v => Math.atanh(Math.max(-.999999, Math.min(.999999, v)))), cancelOrder: command.cancelChase ? 1 : 0 }, autoReset, command);
  }
  step(action, autoReset = true, policyAction = null) {
    if (!Number.isInteger(action.type) || action.type < 0 || action.type >= Policy.EVENTS.length || !Array.isArray(action.latent) || action.latent.length !== 2 || !action.latent.every(Number.isFinite)) throw Error('Invalid RL action');
    const mask = Policy.actionMask(this.model, this.state, 'cpu-player', true);
    if (action.direction !== undefined && (!Number.isInteger(action.direction) || action.direction < 0 || action.direction >= 9)) throw Error('Invalid steering direction');
    const point = action.type === 1 && action.direction !== undefined ? Policy.DIRECTIONS[action.direction] : action.latent.map(Math.tanh);
    const command = policyAction || (mask[action.type] ? Policy.decode(this.model, this.state, 'cpu-player', action.type, point) : { event: 'noop' });
    if (action.cancelOrder !== undefined && action.cancelOrder !== 0 && action.cancelOrder !== 1) throw Error('Invalid chase order');
    if (command.event === 'steer' && this.model.weights.orderW) command.cancelChase = Math.hypot(...point) < .01 || action.cancelOrder === 1;
    const before = this.state.players.find(p => p.id === 'cpu-player'), home = World.MAP.spawns[1];
    const low = !before.dead && before.hp / before.maxHp <= 0.4;
    const beforeDistance = Math.hypot(before.x - home.x, before.z - home.z);
    const defenseThreat = Policy.defenseContext(this.state, 'cpu-player', this.model.init, this.memory);
    const enemyWasHidden = !this.state.players.find(p => p.id === 'opponent')?.vis;
    const inputs = Policy.commands(this.model, this.state, 'cpu-player', command);
    if (low && inputs.some(i => i.event === 'chase')) this.metrics.lowHpChaseCommands++;
    const qAttempt = inputs.some(i => i.event === 'q'), leapAttempt = inputs.some(i => i.event === 'leap');
    const attack = qAttempt || leapAttempt;
    const noTarget = qAttempt && emptyAttack(this.state, 'cpu-player', this.game.state.players['cpu-player'].cfg, this.memory);
    if (this.metrics.largeFocusSeconds === null && (command.objectiveGoal?.kind === 'large' || inputs.some(i => i.event === 'chase' && i.data?.id === 'monster-0'))) this.metrics.largeFocusSeconds = this.elapsed;
    if (attack) this.metrics.attackAttempts++;
    for (const input of inputs) { this.game.input('cpu-player', input.event, input.data); this.metrics.commands++; }
    const current = this.game.state.players['cpu-player'];
    const accepted = qAttempt ? current.qCd > 0 : leapAttempt ? current.eCd > 0 : false;
    let attackReward = 0;
    if (attack && !accepted) { this.metrics.rejectedAttacks++; attackReward = REWARDS.rejectedAttack; }
    else if (noTarget) { this.metrics.emptyAttacks++; attackReward = REWARDS.emptyAttack; }
    if (this.scenario === 'defense') {
      const enemy = this.game.state.players.opponent;
      const retreat = this.metrics.defenseDamage > 0 && enemy.hp / enemy.cfg.maxHp < .4;
      this.game.input('opponent', retreat ? 'move' : 'chase', retreat ? World.MAP.spawns[0] : { id: this.defenseTower });
    }
    if (this.scenario === 'finish-flee') {
      const e = this.game.state.players.opponent;
      this.game.input(e.id, 'move', this.elapsed % 1 < .4 ? World.MAP.spawns[0] : { x: e.x, z: e.z });
    }
    for (let i = 0; i < 3 && this.game.observe('cpu-player').phase === 'playing'; i++) this.game.tick();
    this.state = this.game.observe('cpu-player'); this.elapsed = this.state.time - this.startedAt;
    let reward = REWARDS.time + attackReward, usefulDamage = 0;
    for (const event of this.combat) {
      const contributed = event.source === 'cpu-player' || event.owner === 'cpu-player';
      if (event.kind === 'damage') {
        if (contributed) usefulDamage += event.amount;
        if (event.slot === 1 && event.targetKind === 'player' && contributed) {
          this.metrics.damageDealt += event.amount; reward += event.amount * REWARDS.heroDamage;
          if (this.scenario.startsWith('bush-') && event.target === 'opponent') {
            if (enemyWasHidden) this.metrics.bushHiddenDamage += event.amount;
            if (this.metrics.firstBushHitSeconds === null) { this.metrics.firstBushHitSeconds = this.elapsed; reward += 1; }
            reward += .01 * event.amount;
          }
          if (defenseThreat?.attacker?.id === 'opponent') {
            this.metrics.defenseDamage += event.amount; reward += event.amount * DEFENSE_REWARDS.interceptDamage;
            this.metrics.firstDefenseHitSeconds ??= this.elapsed;
          }
        }
        if (event.slot === 1 && event.targetKind === 'tower' && contributed) reward += event.amount * REWARDS.towerDamage;
        if (event.targetSlot === 1 && event.targetKind === 'tower') { this.metrics.ownTowerDamage += event.amount; reward += event.amount * DEFENSE_REWARDS.towerDamage; }
        if (event.targetSlot === 1 && event.targetKind === 'player') {
          this.metrics.damageReceived += event.amount; reward += event.amount * (this.survival ? low ? SURVIVAL.criticalDamage : SURVIVAL.damageReceived : REWARDS.damageReceived);
          if (event.zone) { this.metrics.zoneDamage += event.amount; reward += event.amount * REWARDS.zoneDamage; }
        }
      } else if (event.targetKind === 'monster' && event.large) {
        if (contributed) this.metrics.largeKills++;
        else if (event.slot === 0) this.metrics.largeLosses++;
      } else if (event.targetKind === 'player') {
        if (event.targetSlot === 1) { this.metrics.deaths++; reward += this.survival ? SURVIVAL.death : REWARDS.death; }
        else if (event.slot === 1 && contributed) { this.metrics.kills++; reward += REWARDS.kill; }
      } else if (event.targetKind === 'tower') {
        if (event.targetSlot === 1) { this.metrics.towersLost++; reward -= REWARDS.tower; }
        else if (event.slot === 1) { this.metrics.towersDestroyed++; reward += REWARDS.tower; }
      }
    }
    this.combat = [];
    const p = this.game.state.players['cpu-player'];
    const after = this.state.players.find(e => e.id === p.id);
    if (this.scenario.startsWith('bush-') && !this.metrics.bushInvestigated && Math.hypot(p.x - this.bush.x, p.z - this.bush.z) < this.bush.r) {
      this.metrics.bushInvestigated = true;
      reward += ['bush-empty', 'bush-exit'].includes(this.scenario) ? -.5 : .5;
    }
    const target = [...this.state.players, ...this.state.monsters, ...this.state.robots, ...this.state.towers].find(e => e.id === after.inputs?.target && !e.dead && Number.isFinite(e.x));
    const inAttackRange = target && Math.hypot(p.x - target.x, p.z - target.z) <= p.cfg.atkRange + (target.slot === 2 ? target.large ? 1.5 : .65 : 0) + .1;
    const moving = Math.hypot(p.x - before.x, p.z - before.z) > .03;
    const ownBoundary = this.state.control.find(c => c.slot === p.slot).boundary;
    const healing = p.hp / p.cfg.maxHp < .95 && (p.slot === 1 ? p.z - p.x : p.x - p.z) < ownBoundary;
    if (!p.dead && !after.stun && !after.air && !after.warping && !after.charging && !after.grabbing && !after.grabbed && !after.flying
      && !after.recall && !healing && !moving && !inAttackRange && !usefulDamage && !(command.objectiveGoal?.kind === 'camp' && this.state.time < 5)) this.metrics.unproductiveSeconds += .1;
    if (low && !p.dead) {
      const progress = beforeDistance - Math.hypot(p.x - home.x, p.z - home.z);
      if (progress > 0.02) this.metrics.lowHpStepsTowardHome++;
      if (progress < -0.02) this.metrics.lowHpStepsAwayFromHome++;
    }
    reward += Math.max(0, p.energy - this.previousEnergy) * (this.survival ? SURVIVAL.energy : REWARDS.energy); this.previousEnergy = p.energy;
    if (!p.dead && p.hp / p.cfg.maxHp <= 0.4) this.metrics.lowHp = true;
    const homeBoundary = this.state.control.find(c => c.slot === p.slot).boundary;
    const ownTerritory = (p.slot === 1 ? p.z - p.x : p.x - p.z) < homeBoundary;
    if (this.metrics.lowHp && this.metrics.deaths === 0 && !p.dead && ownTerritory && p.hp / p.cfg.maxHp >= 0.65 && !this.metrics.recovery) {
      this.metrics.recovery = true; this.metrics.recoverySeconds = this.elapsed;
      if (this.survival) reward += SURVIVAL.recovery;
    }
    const matchFinished = this.state.phase === 'finished';
    const retreatTaskFinished = (this.scenario.startsWith('retreat') || this.scenario.startsWith('duel-retreat')) && (this.metrics.recovery || this.metrics.deaths > 0);
    const enemy = this.game.state.players.opponent, tower = this.game.state.towers[this.defenseTower];
    if (this.scenario === 'defense' && tower && !tower.dead && this.metrics.defenseDamage >= 20
      && (enemy.dead || Math.hypot(enemy.x - tower.x, enemy.z - tower.z) > enemy.cfg.atkRange + tower.radius + 2)) this.metrics.defenseStopped = true;
    const defenseTaskFinished = this.scenario === 'defense' && (this.metrics.defenseStopped || enemy.dead || tower.dead || p.dead || this.elapsed >= 18);
    const largeTaskFinished = this.scenario.startsWith('large-') && (this.metrics.largeKills > 0 || this.metrics.largeLosses > 0 || p.dead || this.elapsed >= 18);
    const bushTaskFinished = this.scenario.startsWith('bush-') && (enemy.dead || p.dead || this.elapsed >= 12);
    const finishTaskFinished = this.scenario.startsWith('finish-') && (this.metrics.kills > 0 || enemy.dead || p.dead || this.elapsed >= 6);
    const terminal = matchFinished || retreatTaskFinished || defenseTaskFinished || largeTaskFinished || bushTaskFinished || finishTaskFinished;
    const truncated = !terminal && this.elapsed >= this.options.maxSeconds;
    const phi = terminal ? 0 : potential(this.state, p.id, this.model.init, this.memory, this.survival, this.decisions);
    reward += this.options.gamma * phi - this.previousPotential; this.previousPotential = phi;
    if (matchFinished) reward += this.state.winner === 1 ? REWARDS.win : REWARDS.loss;
    else if (retreatTaskFinished && this.metrics.recovery) reward += REWARDS.retreatTask;
    else if (defenseTaskFinished && this.metrics.defenseStopped) reward += DEFENSE_REWARDS.success;
    if (this.decisions && finishTaskFinished && this.metrics.kills > 0) reward += 8;
    this.return += reward;
    const bootstrap = this.observation();
    const result = { reward, terminal, truncated, bootstrap, observation: bootstrap };
    if (terminal || truncated) {
      result.episode = { ...this.metrics, episode: this.episode, seconds: this.elapsed, energy: p.energy, return: this.return, winner: matchFinished ? this.state.winner : null, truncated,
        reason: matchFinished ? 'match-finished' : retreatTaskFinished ? this.metrics.recovery ? 'retreat-recovered' : 'retreat-death'
          : defenseTaskFinished ? this.metrics.defenseStopped ? 'defense-stopped' : 'defense-failed'
          : largeTaskFinished ? this.metrics.largeKills ? 'large-secured' : 'large-missed' : bushTaskFinished ? 'bush-diagnostic'
          : finishTaskFinished ? this.metrics.kills ? 'finish-success' : 'finish-missed' : 'timeout' };
      if (autoReset) result.observation = this.reset();
    }
    return result;
  }
}

function evaluate(model, options) {
  const episodes = [];
  const characters = options.characters || model.characters;
  if (!characters.length || characters.some(id => !model.characters.includes(id))) throw Error('Evaluation character is not supported by the model');
  for (let i = 0; i < options.episodes; i++) {
    const env = new Environment(model, { ...options, seed: options.seed + i * 137 });
    const scenarios = options.scenarios || ['match', 'retreat', 'retreat-hard', 'defense'];
    if (!scenarios.length || scenarios.some(s => !['match', 'retreat', 'retreat-hard', 'retreat-chase', 'defense', 'farm', 'large-finish', 'large-contest', 'bush-entry', 'bush-attack', 'bush-empty', 'bush-exit', 'duel-retreat', 'duel-retreat-chase', 'finish-static', 'finish-flee'].includes(s))) throw Error('Invalid evaluation scenarios');
    env.reset(scenarios[i % scenarios.length], characters[Math.floor(i / scenarios.length) % characters.length]);
    let seed = 17;
    const evaluatedModel = { ...model, init: runtimeInit(model) };
    // 同じ可視情報・履歴を使い、公開モデルと同じ確率的な操作選択を評価する。
    let result;
    for (;;) {
      const actor = 'cpu-player';
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const draw = seed / 4294967296;
      let directionDraw = null;
      if (model.weights.directionW) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; directionDraw = seed / 4294967296; }
      let orderDraw = null;
      if (model.weights.orderW) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; orderDraw = seed / 4294967296; }
      const action = Policy.decide(evaluatedModel, env.state, actor, env.memory, draw, directionDraw, orderDraw);
      const target = Policy.label(action, env.state, actor);
      const latent = target.xy.map(n => Math.atanh(Math.max(-0.999999, Math.min(0.999999, n))));
      const direction = action.event === 'steer' && model.weights.directionW ? Policy.DIRECTIONS.findIndex(d => Math.abs(d[0] - target.xy[0]) < 1e-6 && Math.abs(d[1] - target.xy[1]) < 1e-6) : undefined;
      result = env.step({ type: target.type, latent, direction, cancelOrder: action.cancelChase ? 1 : 0 }, false, action);
      if (result.episode) { episodes.push(result.episode); break; }
    }
  }
  return { episodes, characters, protocol: options.rewardProfile === 'survival/1' ? 'survival/1' : 'balanced-tactics/4',
    rewardConfig: { ...REWARDS, defense: DEFENSE_REWARDS, ...(options.rewardProfile === 'survival/1' ? { survival: SURVIVAL } : {}) },
    potentialConfig: options.rewardProfile === 'survival/1' ? { ...SHAPING, health: SURVIVAL.health, danger: SURVIVAL.danger, safeDistance: SURVIVAL.safeDistance } : SHAPING,
    limitation: 'small fixed-seed diagnostic, not a guarantee of improvement' };
}

async function serve() {
  let environments = [];
  const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of reader) {
    try {
      const request = JSON.parse(line);
      if (request.op === 'init') {
        const model = Policy.validate(readJSON(request.model));
        if (!Number.isInteger(request.envs) || request.envs < 1 || request.envs > 32) throw Error('envs must be 1..32');
        environments = Array.from({ length: request.envs }, (_, i) => new Environment(model, { ...request.options, seed: request.options.seed + i * 997 }));
        process.stdout.write(JSON.stringify({ observations: environments.map(e => e.reset()), init: runtimeInit(model), rewards: { ...REWARDS, defense: DEFENSE_REWARDS, survival: request.options.rewardProfile === 'survival/1' ? SURVIVAL : null }, shaping: SHAPING }) + '\n');
      } else if (request.op === 'step') {
        if (request.actions.length !== environments.length) throw Error('Invalid action batch');
        process.stdout.write(JSON.stringify({ results: environments.map((e, i) => e.step(request.actions[i])) }) + '\n');
      } else if (request.op === 'decision-step') {
        if (!Array.isArray(request.actions) || request.actions.length !== environments.length) throw Error('Invalid decision batch');
        process.stdout.write(JSON.stringify({ results: environments.map((e, i) => e.stepDecision(request.actions[i])) }) + '\n');
      } else if (request.op === 'evaluate') {
        process.stdout.write(JSON.stringify(evaluate(Policy.validate(readJSON(request.model)), request.options)) + '\n');
      } else if (request.op === 'close') { process.stdout.write('{"closed":true}\n'); reader.close(); process.stdin.destroy(); return; }
      else throw Error('Unknown request');
    } catch (error) { process.stdout.write(JSON.stringify({ error: error.stack }) + '\n'); }
  }
}

if (require.main === module) serve().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { Environment, potential, emptyAttack, REWARDS, SHAPING, runtimeInit, evaluate };

const readline = require('node:readline');
const World = require('../game-world');
const Policy = require('../public/minion-policy');
const { readJSON } = require('./minion-input');

const REWARDS = Object.freeze({ win: 20, loss: -20, tower: 3, kill: 1.5, death: -2.5,
  heroDamage: 0.002, towerDamage: 0.004, damageReceived: -0.002, zoneDamage: -0.004, energy: 0.08,
  emptyAttack: -0.06, rejectedAttack: -0.02, time: -0.0005, retreatTask: 3 });
const DEFENSE_REWARDS = Object.freeze({ towerDamage: -0.012, interceptDamage: 0.006, success: 3 });
const SHAPING = Object.freeze({ base: 0.8, health: 1.5, danger: 0.8, farmDistance: 0.25, farmDamage: 0.2, defenseDistance: 0.8 });
const runtimeInit = model => ({ ...model.init, cfg: World.CFG, map: World.MAP, characters: World.CHARACTERS });

function potential(state, actor, init = { cfg: World.CFG, map: World.MAP, characters: World.CHARACTERS }, memory = {}) {
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
  return SHAPING.base + SHAPING.health * ratio - SHAPING.danger * (1 - ratio) ** 2 * danger + ratio ** 2 * (farm + defense);
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
    this.model = { ...model, init: runtimeInit(model), reinforcementLearning: { algorithm: 'PPO' } };
    this.options = { gamma: 0.995, maxSeconds: 120, retreatFraction: 0.25, farmFraction: 0.2, defenseFraction: 0.3, seed: 17, ...options };
    this.seed = this.options.seed >>> 0; this.episode = 0;
  }
  random() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }
  reset(forcedScenario = null, forcedCharacter = null) {
    this.episode++; this.memory = {}; this.cues = []; this.combat = []; this.return = 0; this.elapsed = 0;
    const scenarioDraw = this.random();
    this.scenario = forcedScenario || (scenarioDraw < this.options.retreatFraction ? 'retreat'
      : scenarioDraw < this.options.retreatFraction + this.options.farmFraction ? 'farm'
      : scenarioDraw < this.options.retreatFraction + this.options.farmFraction + this.options.defenseFraction ? 'defense' : 'match');
    if (!forcedScenario && this.scenario === 'retreat' && this.random() < 0.25) this.scenario = 'retreat-hard';
    const character = forcedCharacter || this.model.characters[Math.floor(this.random() * this.model.characters.length)];
    this.character = character;
    this.opponentCharacter = World.CHARACTERS[Math.floor(this.random() * World.CHARACTERS.length)].id;
    if (this.scenario === 'defense') this.opponentCharacter = this.random() < .5 ? 'alex' : 'mira';
    this.metrics = { scenario: this.scenario, character, opponent: this.opponentCharacter, deaths: 0, kills: 0,
      damageDealt: 0, damageReceived: 0, zoneDamage: 0, towersDestroyed: 0, towersLost: 0, recovery: false, lowHp: false, commands: 0,
      lowHpChaseCommands: 0, lowHpStepsTowardHome: 0, lowHpStepsAwayFromHome: 0, attackAttempts: 0, emptyAttacks: 0, rejectedAttacks: 0,
      ownTowerDamage: 0, defenseDamage: 0, defenseStopped: false, firstDefenseHitSeconds: null };
    const hooks = {};
    const idle = () => [];
    idle.observe = event => this.cues.push(event);
    idle.observeState = state => { Policy.updateMemory(this.memory, state, 'cpu-player', this.cues, this.model.featureVersion); this.cues = []; };
    this.game = World.createMatch(false, true, { policy: idle, opponent: this.scenario !== 'defense', onCombat: event => this.combat.push(event) });
    this.game.connect({ id: 'opponent', on(e, fn) { hooks[e] = fn; }, emit() {}, disconnect() {} });
    hooks.selectCpuCharacter({ id: character }); hooks.selectCharacter({ id: this.opponentCharacter }); hooks.confirmCharacter();
    const p = this.game.state.players['cpu-player'], enemy = this.game.state.players.opponent;
    if (this.scenario.startsWith('retreat')) {
      Object.assign(p, { x: -3 - this.random() * 2, z: 1 + this.random() * 2, hp: p.cfg.maxHp * (0.2 + this.random() * 0.2) });
      const distance = this.scenario === 'retreat-hard' ? 2 : 4;
      Object.assign(enemy, { x: p.x - distance - this.random(), z: p.z + 2 + this.random(), hp: enemy.cfg.maxHp * (0.6 + this.random() * 0.4) });
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
    this.state = this.game.observe('cpu-player');
    this.startedAt = this.state.time;
    Policy.updateMemory(this.memory, this.state, p.id, [], this.model.featureVersion);
    this.previousEnergy = p.energy; this.previousPotential = potential(this.state, p.id, this.model.init, this.memory);
    this.metrics.lowHp = p.hp / p.cfg.maxHp <= 0.4;
    return this.observation();
  }
  observation() {
    const state = this.state, actor = 'cpu-player', me = state.players.find(p => p.id === actor);
    Policy.updateMemory(this.memory, state, actor, this.cues, this.model.featureVersion); this.cues = [];
    const threat = Policy.defenseContext(state, actor, this.model.init, this.memory), enemy = threat?.attacker;
    const lesson = this.scenario === 'defense' && me.hp / me.maxHp > .55 && enemy?.id === 'opponent'
      ? [1, (enemy.x - me.x) * (me.slot === 1 ? -1 : 1) / 60, (enemy.z - me.z) * (me.slot === 1 ? -1 : 1) / 60] : [0, 0, 0];
    return { x: Array.from(Policy.features(state, actor, this.model.init, this.memory, this.model.featureVersion)), lesson,
      mask: Policy.actionMask(this.model, state, actor, true),
      coordinates: Policy.EVENTS.map(event => (event === 'steer' && !this.model.weights.directionW) || ['move', 'chase', 'q', 'leap'].includes(event)
        || (event === 'dash' && ['lucia', 'darius'].includes(me.character)) || (event === 'c' && me.character !== 'lucia') ? 1 : 0) };
  }
  step(action, autoReset = true) {
    if (!Number.isInteger(action.type) || action.type < 0 || action.type >= Policy.EVENTS.length || !Array.isArray(action.latent) || action.latent.length !== 2 || !action.latent.every(Number.isFinite)) throw Error('Invalid RL action');
    const mask = Policy.actionMask(this.model, this.state, 'cpu-player', true);
    if (action.direction !== undefined && (!Number.isInteger(action.direction) || action.direction < 0 || action.direction >= 9)) throw Error('Invalid steering direction');
    const point = action.type === 1 && action.direction !== undefined ? Policy.DIRECTIONS[action.direction] : action.latent.map(Math.tanh);
    const command = mask[action.type] ? Policy.decode(this.model, this.state, 'cpu-player', action.type, point) : { event: 'noop' };
    if (action.cancelOrder !== undefined && action.cancelOrder !== 0 && action.cancelOrder !== 1) throw Error('Invalid chase order');
    if (command.event === 'steer' && this.model.weights.orderW) command.cancelChase = Math.hypot(...point) < .01 || action.cancelOrder === 1;
    const before = this.state.players.find(p => p.id === 'cpu-player'), home = World.MAP.spawns[1];
    const low = !before.dead && before.hp / before.maxHp <= 0.4;
    const beforeDistance = Math.hypot(before.x - home.x, before.z - home.z);
    const defenseThreat = Policy.defenseContext(this.state, 'cpu-player', this.model.init, this.memory);
    if (low && command.event === 'chase') this.metrics.lowHpChaseCommands++;
    const attack = command.event === 'q' || command.event === 'leap';
    const noTarget = command.event === 'q' && emptyAttack(this.state, 'cpu-player', this.game.state.players['cpu-player'].cfg, this.memory);
    if (attack) this.metrics.attackAttempts++;
    for (const input of Policy.commands(this.model, this.state, 'cpu-player', command)) { this.game.input('cpu-player', input.event, input.data); this.metrics.commands++; }
    const current = this.game.state.players['cpu-player'];
    const accepted = command.event === 'q' ? current.qCd > 0 : command.event === 'leap' ? current.eCd > 0 : false;
    let attackReward = 0;
    if (attack && !accepted) { this.metrics.rejectedAttacks++; attackReward = REWARDS.rejectedAttack; }
    else if (noTarget) { this.metrics.emptyAttacks++; attackReward = REWARDS.emptyAttack; }
    if (this.scenario === 'defense') {
      const enemy = this.game.state.players.opponent;
      const retreat = this.metrics.defenseDamage > 0 && enemy.hp / enemy.cfg.maxHp < .4;
      this.game.input('opponent', retreat ? 'move' : 'chase', retreat ? World.MAP.spawns[0] : { id: this.defenseTower });
    }
    for (let i = 0; i < 3 && this.game.observe('cpu-player').phase === 'playing'; i++) this.game.tick();
    this.state = this.game.observe('cpu-player'); this.elapsed = this.state.time - this.startedAt;
    let reward = REWARDS.time + attackReward;
    for (const event of this.combat) {
      const contributed = event.source === 'cpu-player' || event.owner === 'cpu-player';
      if (event.kind === 'damage') {
        if (event.slot === 1 && event.targetKind === 'player' && contributed) {
          this.metrics.damageDealt += event.amount; reward += event.amount * REWARDS.heroDamage;
          if (defenseThreat?.attacker?.id === 'opponent') {
            this.metrics.defenseDamage += event.amount; reward += event.amount * DEFENSE_REWARDS.interceptDamage;
            this.metrics.firstDefenseHitSeconds ??= this.elapsed;
          }
        }
        if (event.slot === 1 && event.targetKind === 'tower' && contributed) reward += event.amount * REWARDS.towerDamage;
        if (event.targetSlot === 1 && event.targetKind === 'tower') { this.metrics.ownTowerDamage += event.amount; reward += event.amount * DEFENSE_REWARDS.towerDamage; }
        if (event.targetSlot === 1 && event.targetKind === 'player') {
          this.metrics.damageReceived += event.amount; reward += event.amount * REWARDS.damageReceived;
          if (event.zone) { this.metrics.zoneDamage += event.amount; reward += event.amount * REWARDS.zoneDamage; }
        }
      } else if (event.targetKind === 'player') {
        if (event.targetSlot === 1) { this.metrics.deaths++; reward += REWARDS.death; }
        else if (event.slot === 1 && contributed) { this.metrics.kills++; reward += REWARDS.kill; }
      } else if (event.targetKind === 'tower') {
        if (event.targetSlot === 1) { this.metrics.towersLost++; reward -= REWARDS.tower; }
        else if (event.slot === 1) { this.metrics.towersDestroyed++; reward += REWARDS.tower; }
      }
    }
    this.combat = [];
    const p = this.game.state.players['cpu-player'];
    if (low && !p.dead) {
      const progress = beforeDistance - Math.hypot(p.x - home.x, p.z - home.z);
      if (progress > 0.02) this.metrics.lowHpStepsTowardHome++;
      if (progress < -0.02) this.metrics.lowHpStepsAwayFromHome++;
    }
    reward += Math.max(0, p.energy - this.previousEnergy) * REWARDS.energy; this.previousEnergy = p.energy;
    if (!p.dead && p.hp / p.cfg.maxHp <= 0.4) this.metrics.lowHp = true;
    const homeBoundary = this.state.control.find(c => c.slot === p.slot).boundary;
    const ownTerritory = (p.slot === 1 ? p.z - p.x : p.x - p.z) < homeBoundary;
    if (this.metrics.lowHp && this.metrics.deaths === 0 && !p.dead && ownTerritory && p.hp / p.cfg.maxHp >= 0.65 && !this.metrics.recovery) {
      this.metrics.recovery = true; this.metrics.recoverySeconds = this.elapsed;
    }
    const matchFinished = this.state.phase === 'finished';
    const retreatTaskFinished = this.scenario.startsWith('retreat') && (this.metrics.recovery || this.metrics.deaths > 0);
    const enemy = this.game.state.players.opponent, tower = this.game.state.towers[this.defenseTower];
    if (this.scenario === 'defense' && tower && !tower.dead && this.metrics.defenseDamage >= 20
      && (enemy.dead || Math.hypot(enemy.x - tower.x, enemy.z - tower.z) > enemy.cfg.atkRange + tower.radius + 2)) this.metrics.defenseStopped = true;
    const defenseTaskFinished = this.scenario === 'defense' && (this.metrics.defenseStopped || enemy.dead || tower.dead || p.dead || this.elapsed >= 18);
    const terminal = matchFinished || retreatTaskFinished || defenseTaskFinished;
    const truncated = !terminal && this.elapsed >= this.options.maxSeconds;
    const phi = terminal ? 0 : potential(this.state, p.id, this.model.init, this.memory);
    reward += this.options.gamma * phi - this.previousPotential; this.previousPotential = phi;
    if (matchFinished) reward += this.state.winner === 1 ? REWARDS.win : REWARDS.loss;
    else if (retreatTaskFinished && this.metrics.recovery) reward += REWARDS.retreatTask;
    else if (defenseTaskFinished && this.metrics.defenseStopped) reward += DEFENSE_REWARDS.success;
    this.return += reward;
    const bootstrap = this.observation();
    const result = { reward, terminal, truncated, bootstrap, observation: bootstrap };
    if (terminal || truncated) {
      result.episode = { ...this.metrics, episode: this.episode, seconds: this.elapsed, energy: p.energy, return: this.return, winner: matchFinished ? this.state.winner : null, truncated,
        reason: matchFinished ? 'match-finished' : retreatTaskFinished ? this.metrics.recovery ? 'retreat-recovered' : 'retreat-death'
          : defenseTaskFinished ? this.metrics.defenseStopped ? 'defense-stopped' : 'defense-failed' : 'timeout' };
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
    if (!scenarios.length || scenarios.some(s => !['match', 'retreat', 'retreat-hard', 'defense', 'farm'].includes(s))) throw Error('Invalid evaluation scenarios');
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
      result = env.step({ type: target.type, latent, direction, cancelOrder: action.cancelChase ? 1 : 0 }, false);
      if (result.episode) { episodes.push(result.episode); break; }
    }
  }
  return { episodes, characters, protocol: 'balanced-tactics/4', rewardConfig: { ...REWARDS, defense: DEFENSE_REWARDS }, potentialConfig: SHAPING, limitation: 'small fixed-seed diagnostic, not a guarantee of improvement' };
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
        process.stdout.write(JSON.stringify({ observations: environments.map(e => e.reset()), init: runtimeInit(model), rewards: { ...REWARDS, defense: DEFENSE_REWARDS }, shaping: SHAPING }) + '\n');
      } else if (request.op === 'step') {
        if (request.actions.length !== environments.length) throw Error('Invalid action batch');
        process.stdout.write(JSON.stringify({ results: environments.map((e, i) => e.step(request.actions[i])) }) + '\n');
      } else if (request.op === 'evaluate') {
        process.stdout.write(JSON.stringify(evaluate(Policy.validate(readJSON(request.model)), request.options)) + '\n');
      } else if (request.op === 'close') { process.stdout.write('{"closed":true}\n'); reader.close(); process.stdin.destroy(); return; }
      else throw Error('Unknown request');
    } catch (error) { process.stdout.write(JSON.stringify({ error: error.stack }) + '\n'); }
  }
}

if (require.main === module) serve().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { Environment, potential, emptyAttack, REWARDS, SHAPING, runtimeInit, evaluate };

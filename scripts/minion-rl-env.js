const readline = require('node:readline');
const World = require('../game-world');
const Policy = require('../public/minion-policy');
const { readJSON } = require('./minion-input');

const REWARDS = Object.freeze({ win: 20, loss: -20, tower: 3, kill: 1.5, death: -2.5,
  heroDamage: 0.002, towerDamage: 0.004, damageReceived: -0.002, zoneDamage: -0.004, energy: 0.015, time: -0.0005, retreatTask: 3 });
const SHAPING = Object.freeze({ base: 0.8, health: 1.5, danger: 0.8 });
const runtimeInit = model => ({ ...model.init, cfg: World.CFG, map: World.MAP, characters: World.CHARACTERS });

function potential(state, actor) {
  const me = state.players.find(p => p.id === actor);
  if (me.dead) return 0;
  const ratio = me.hp / me.maxHp;
  const boundary = state.control.find(c => c.slot === 1 - me.slot).boundary;
  const inEnemy = (me.slot === 1 ? me.x - me.z : me.z - me.x) < boundary;
  const enemies = [...state.players.filter(p => p.id !== actor && p.vis), ...state.robots, ...state.towers]
    .filter(e => e.slot !== me.slot && !e.dead && Number.isFinite(e.x));
  const near = enemies.reduce((risk, e) => Math.max(risk, Math.max(0, 1 - Math.hypot(me.x - e.x, me.z - e.z) / 10)), 0);
  const danger = Math.min(1, (inEnemy ? 0.7 : 0) + near);
  return SHAPING.base + SHAPING.health * ratio - SHAPING.danger * (1 - ratio) ** 2 * danger;
}

class Environment {
  constructor(model, options = {}) {
    this.model = { ...model, init: runtimeInit(model), reinforcementLearning: { algorithm: 'PPO' } };
    this.options = { gamma: 0.995, maxSeconds: 120, retreatFraction: 0.5, seed: 17, ...options };
    this.seed = this.options.seed >>> 0; this.episode = 0;
  }
  random() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }
  reset(forcedScenario = null, forcedCharacter = null) {
    this.episode++; this.memory = {}; this.cues = []; this.combat = []; this.return = 0; this.elapsed = 0;
    this.scenario = forcedScenario || (this.random() < this.options.retreatFraction ? 'retreat' : 'match');
    if (!forcedScenario && this.scenario === 'retreat' && this.random() < 0.25) this.scenario = 'retreat-hard';
    const character = forcedCharacter || this.model.characters[Math.floor(this.random() * this.model.characters.length)];
    this.character = character;
    this.opponentCharacter = World.CHARACTERS[Math.floor(this.random() * World.CHARACTERS.length)].id;
    this.metrics = { scenario: this.scenario, character, opponent: this.opponentCharacter, deaths: 0, kills: 0,
      damageDealt: 0, damageReceived: 0, zoneDamage: 0, towersDestroyed: 0, towersLost: 0, recovery: false, lowHp: false, commands: 0,
      lowHpChaseCommands: 0, lowHpStepsTowardHome: 0, lowHpStepsAwayFromHome: 0 };
    const hooks = {};
    const idle = () => [];
    idle.observe = event => this.cues.push(event);
    idle.observeState = state => { Policy.updateMemory(this.memory, state, 'cpu-player', this.cues); this.cues = []; };
    this.game = World.createMatch(false, true, { policy: idle, opponent: true, onCombat: event => this.combat.push(event) });
    this.game.connect({ id: 'opponent', on(e, fn) { hooks[e] = fn; }, emit() {}, disconnect() {} });
    hooks.selectCpuCharacter({ id: character }); hooks.selectCharacter({ id: this.opponentCharacter }); hooks.confirmCharacter();
    const p = this.game.state.players['cpu-player'], enemy = this.game.state.players.opponent;
    if (this.scenario.startsWith('retreat')) {
      Object.assign(p, { x: -3 - this.random() * 2, z: 1 + this.random() * 2, hp: p.cfg.maxHp * (0.2 + this.random() * 0.2) });
      const distance = this.scenario === 'retreat-hard' ? 2 : 4;
      Object.assign(enemy, { x: p.x - distance - this.random(), z: p.z + 2 + this.random(), hp: enemy.cfg.maxHp * (0.6 + this.random() * 0.4) });
    } else {
      p.x += (this.random() - 0.5) * 2; p.z += (this.random() - 0.5) * 2;
      enemy.x += (this.random() - 0.5) * 2; enemy.z += (this.random() - 0.5) * 2;
    }
    this.state = this.game.observe('cpu-player');
    this.previousEnergy = p.energy; this.previousPotential = potential(this.state, p.id);
    this.metrics.lowHp = p.hp / p.cfg.maxHp <= 0.4;
    return this.observation();
  }
  observation() {
    const state = this.state, actor = 'cpu-player', me = state.players.find(p => p.id === actor);
    Policy.updateMemory(this.memory, state, actor, this.cues); this.cues = [];
    return { x: Array.from(Policy.features(state, actor, this.model.init, this.memory, this.model.featureVersion)),
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
    if (low && command.event === 'chase') this.metrics.lowHpChaseCommands++;
    for (const input of Policy.commands(this.model, this.state, 'cpu-player', command)) { this.game.input('cpu-player', input.event, input.data); this.metrics.commands++; }
    for (let i = 0; i < 3 && this.game.observe('cpu-player').phase === 'playing'; i++) this.game.tick();
    this.state = this.game.observe('cpu-player'); this.elapsed = this.state.time;
    let reward = REWARDS.time;
    for (const event of this.combat) {
      if (event.kind === 'damage') {
        if (event.slot === 1 && event.targetKind === 'player') { this.metrics.damageDealt += event.amount; reward += event.amount * REWARDS.heroDamage; }
        if (event.slot === 1 && event.targetKind === 'tower') reward += event.amount * REWARDS.towerDamage;
        if (event.targetSlot === 1 && event.targetKind === 'player') {
          this.metrics.damageReceived += event.amount; reward += event.amount * REWARDS.damageReceived;
          if (event.zone) { this.metrics.zoneDamage += event.amount; reward += event.amount * REWARDS.zoneDamage; }
        }
      } else if (event.targetKind === 'player') {
        if (event.targetSlot === 1) { this.metrics.deaths++; reward += REWARDS.death; }
        else if (event.slot === 1) { this.metrics.kills++; reward += REWARDS.kill; }
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
    const terminal = matchFinished || retreatTaskFinished;
    const truncated = !terminal && this.elapsed >= this.options.maxSeconds;
    const phi = terminal ? 0 : potential(this.state, p.id);
    reward += this.options.gamma * phi - this.previousPotential; this.previousPotential = phi;
    if (matchFinished) reward += this.state.winner === 1 ? REWARDS.win : REWARDS.loss;
    else if (retreatTaskFinished && this.metrics.recovery) reward += REWARDS.retreatTask;
    this.return += reward;
    const bootstrap = this.observation();
    const result = { reward, terminal, truncated, bootstrap, observation: bootstrap };
    if (terminal || truncated) {
      result.episode = { ...this.metrics, episode: this.episode, seconds: this.elapsed, energy: p.energy, return: this.return, winner: matchFinished ? this.state.winner : null, truncated,
        reason: matchFinished ? 'match-finished' : retreatTaskFinished ? this.metrics.recovery ? 'retreat-recovered' : 'retreat-death' : 'timeout' };
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
    env.reset(['match', 'retreat', 'retreat-hard'][i % 3], characters[Math.floor(i / 3) % characters.length]);
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
  return { episodes, characters, protocol: 'balanced-tactics/3', rewardConfig: REWARDS, potentialConfig: SHAPING, limitation: 'small fixed-seed diagnostic, not a guarantee of improvement' };
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
        process.stdout.write(JSON.stringify({ observations: environments.map(e => e.reset()), init: runtimeInit(model), rewards: REWARDS, shaping: SHAPING }) + '\n');
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
module.exports = { Environment, potential, REWARDS, SHAPING, runtimeInit, evaluate };

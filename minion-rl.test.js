const { test } = require('node:test');
const assert = require('node:assert/strict');
const World = require('./game-world');
const Policy = require('./public/minion-policy');
const { Environment, potential, emptyAttack, evaluate, REWARDS } = require('./scripts/minion-rl-env');

function model() {
  return { format: Policy.VERSION, inputSize: Policy.SIZE, hiddenSize: 1, characters: ['alex'], events: Policy.EVENTS,
    init: { map: World.MAP, cfg: World.CFG, characters: World.CHARACTERS },
    training: { classCounts: { recall: 0 } }, weights: { hiddenW: [Array(Policy.SIZE).fill(0)], hiddenB: [0],
      typeW: Policy.EVENTS.map(() => [0]), typeB: Policy.EVENTS.map(e => e === 'steer' ? 2 : 0),
      pointW: Array.from({ length: Policy.EVENTS.length * 2 }, () => [0]), pointB: Array(Policy.EVENTS.length * 2).fill(0) } };
}

test('RL opponent acts independently, observations stay perspective-filtered and inputs obey stun', () => {
  const env = new Environment(model(), { seed: 3, maxSeconds: 10 });
  const observation = env.reset('match');
  assert.equal(observation.x.length, Policy.SIZE); assert.ok(observation.x.every(Number.isFinite));
  const opponent = env.game.state.players.opponent, initial = { x: opponent.x, z: opponent.z };
  for (let i = 0; i < 15; i++) env.step({ type: 0, latent: [0, 0] });
  assert.ok(Math.hypot(opponent.x - initial.x, opponent.z - initial.z) > 0.1);
  const learner = env.game.state.players['cpu-player']; learner.stun = 1;
  const p = { x: learner.x, z: learner.z };
  env.state = env.game.observe(learner.id);
  env.step({ type: 1, latent: [1, 1] });
  assert.equal(learner.x, p.x); assert.equal(learner.z, p.z);
  opponent.x = -4; opponent.z = 20; opponent.bush = 0;
  assert.equal(env.game.observe(learner.id).players.find(p => p.id === opponent.id).x, undefined);
});

test('time limits truncate, bootstrap the ending state and reset independently of wins', () => {
  const env = new Environment(model(), { seed: 5, maxSeconds: 0.2 }); env.reset('match');
  env.step({ type: 0, latent: [0, 0] });
  const result = env.step({ type: 0, latent: [0, 0] });
  assert.equal(result.truncated, true); assert.equal(result.terminal, false);
  assert.equal(result.episode.winner, null); assert.equal(result.episode.truncated, true);
  assert.notDeepEqual(result.bootstrap.x, result.observation.x);
});

test('retreat scenarios start at low HP; recovery is a metric without a repeated recovery bonus', () => {
  const env = new Environment(model(), { seed: 1 }); env.reset('retreat');
  const p = env.game.state.players['cpu-player'];
  assert.ok(p.hp / p.cfg.maxHp >= 0.2 && p.hp / p.cfg.maxHp <= 0.4);
  const state = env.game.observe(p.id), damaged = structuredClone(state);
  damaged.players.find(x => x.id === p.id).hp *= 0.5;
  assert.ok(potential(damaged, p.id) < potential(state, p.id));
  // For a damage/heal cycle, discounted potential shaping telescopes: no positive cycle reward.
  const gamma = .995, high = potential(state, p.id), low = potential(damaged, p.id);
  const cycle = (gamma * low - high) + gamma * (gamma * high - low);
  assert.ok(cycle <= 0);
});

test('PPO can explore recall with zero demonstrations, while BC preserves its action mask', () => {
  const env = new Environment(model(), { seed: 1 }); env.reset('match');
  const bc = model(), state = env.state;
  assert.equal(Policy.actionMask(bc, state, 'cpu-player')[9], false);
  assert.equal(Policy.actionMask(bc, state, 'cpu-player', true)[9], true);
  bc.reinforcementLearning = { algorithm: 'PPO' };
  assert.equal(Policy.actionMask(bc, state, 'cpu-player')[9], true);
  assert.throws(() => env.step({ type: 1, latent: [NaN, 0] }));
  assert.throws(() => env.step({ type: 100, latent: [0, 0] }));
});

test('combat telemetry counts actual overkill damage once and reports the attacking team', () => {
  const events = [], handlers = {};
  const game = World.createMatch(true, false, { onCombat: e => events.push(e) });
  game.connect({ id: 'p', on(e, fn) { handlers[e] = fn; }, emit() {}, disconnect() {} });
  handlers.selectCharacter({ id: 'alex' }); handlers.confirmCharacter(); game.state.environment.enabled = false;
  const p = game.state.players.p, tower = game.state.towers['t1-2'];
  Object.assign(p, { x: tower.x - 3, z: tower.z, bush: -1 }); tower.hp = 1;
  handlers.q({ x: tower.x, z: tower.z });
  const hits = events.filter(e => e.kind === 'damage' && e.targetKind === 'tower');
  assert.ok(hits.some(e => e.amount === 1));
  assert.ok(hits.every(e => e.slot === 0));
  assert.equal(events.filter(e => e.kind === 'kill' && e.targetKind === 'tower').length, 1);
});

test('tactical steering replaces a persistent chase through ordinary player inputs', () => {
  const m = model(); m.featureVersion = Policy.TACTICAL_VERSION;
  m.weights.directionW = Array.from({ length: 9 }, () => [0]); m.weights.directionB = Array(9).fill(0);
  const env = new Environment(m, { seed: 11 }); env.reset('retreat');
  env.game.state.players.opponent.stun = 10;
  const learner = env.game.state.players['cpu-player']; learner.target = 'opponent';
  const x = learner.x, z = learner.z;
  env.state = env.game.observe(learner.id);
  // Canonical (-x,+z) becomes (+x,-z) for slot one, toward its home.
  env.step({ type: 1, direction: 4, latent: [0, 0] });
  assert.equal(learner.target, null); assert.ok(learner.x > x); assert.ok(learner.z < z);
  assert.ok(env.metrics.lowHpStepsTowardHome > 0);
});

test('tactical HP and geometry have reserved feature slots without changing old models', () => {
  const env = new Environment(model(), { seed: 1 }); env.reset('retreat');
  const state = env.state, me = state.players.find(p => p.slot === 1);
  const legacy = Policy.features(state, me.id, env.model.init, {});
  const explicit = Policy.features(state, me.id, env.model.init, {}, Policy.TACTICAL_VERSION);
  assert.equal(explicit.length, legacy.length);
  assert.deepEqual(Array.from(explicit.slice(0, Policy.SIZE - 32)), Array.from(legacy.slice(0, Policy.SIZE - 32)));
  assert.ok(Math.abs(explicit[Policy.SIZE - 32] - me.hp / me.maxHp) < 1e-6);
  const changed = structuredClone(state); changed.players.find(p => p.slot === 1).hp *= .5;
  const damaged = Policy.features(changed, me.id, env.model.init, {}, Policy.TACTICAL_VERSION);
  assert.ok(damaged[Policy.SIZE - 32] < explicit[Policy.SIZE - 32]);
  assert.ok(explicit.every(Number.isFinite));
});

test('balanced movement keeps a combat target until the model explicitly selects stop', () => {
  const m = model(); m.featureVersion = Policy.TACTICAL_VERSION; m.movementOrder = 'stop-clears-chase/1';
  const env = new Environment(m, { seed: 4 }); env.reset('retreat');
  const action = { event: 'steer', data: { x: 1, z: -1 } };
  assert.deepEqual(Policy.commands(m, env.state, 'cpu-player', action), [action]);
  const stop = Policy.commands(m, env.state, 'cpu-player', { event: 'steer', data: { x: 0, z: 0 } });
  assert.equal(stop[0].event, 'move');
  env.game.state.players['cpu-player'].target = 'opponent';
  for (const input of stop) env.game.input('cpu-player', input.event, input.data);
  assert.equal(env.game.state.players['cpu-player'].target, null);
});

test('the model can learn whether moving should preserve or cancel its combat order', () => {
  const m = model(); m.featureVersion = Policy.TACTICAL_VERSION; m.movementOrder = 'learned-chase-order/1';
  m.weights.orderW = [[0], [0]]; m.weights.orderB = [1, 0];
  Policy.validate(m);
  const env = new Environment(m, { seed: 3 }); env.reset('match');
  const keep = { event: 'steer', data: { x: 1, z: -1 }, cancelChase: false };
  assert.equal(Policy.commands(m, env.state, 'cpu-player', keep).length, 1);
  const cancel = { ...keep, cancelChase: true };
  assert.equal(Policy.commands(m, env.state, 'cpu-player', cancel)[0].event, 'move');
  m.weights.orderW[0] = [];
  assert.throws(() => Policy.validate(m));
});

test('committing to a chase releases held steering instead of walking in a stale direction', () => {
  const m = model(); m.controlProtocol = 'release-before-chase/1';
  const env = new Environment(m, { seed: 4 }); env.reset('retreat');
  const p = env.game.state.players['cpu-player'];
  p.keys = { x: 1, z: 1 }; p.inputT = 0.35;
  env.state = env.game.observe(p.id);
  const commands = Policy.commands(m, env.state, p.id, { event: 'chase', data: { id: 'opponent' } });
  for (const input of commands) env.game.input(p.id, input.event, input.data);
  assert.equal(p.keys, null); assert.equal(p.target, 'opponent');
});

test('retreat recovery ends the practice task without awarding a match win', () => {
  const env = new Environment(model(), { seed: 2 }); env.reset('retreat');
  const p = env.game.state.players['cpu-player'];
  Object.assign(p, World.MAP.spawns[1], { hp: p.cfg.maxHp * 0.7 });
  env.state = env.game.observe(p.id);
  const result = env.step({ type: 0, latent: [0, 0] });
  assert.equal(result.terminal, true); assert.equal(result.truncated, false);
  assert.equal(result.episode.reason, 'retreat-recovered'); assert.equal(result.episode.winner, null);
  assert.ok(result.reward < REWARDS.win); assert.equal(env.elapsed, 0);
});

test('practice failure resets on the first death rather than training on the respawn', () => {
  const env = new Environment(model(), { seed: 2 }); env.reset('retreat-hard');
  env.combat.push({ kind: 'kill', targetSlot: 1, slot: 0, targetKind: 'player' });
  const result = env.step({ type: 0, latent: [0, 0] });
  assert.equal(result.terminal, true); assert.equal(result.episode.reason, 'retreat-death');
  assert.equal(result.episode.winner, null); assert.equal(env.elapsed, 0);
});

test('each character is evaluated on normal, retreat and hard-retreat starts', () => {
  const m = model(); m.characters = ['alex', 'mira'];
  const result = evaluate(m, { seed: 1234, episodes: 12, maxSeconds: .1, gamma: .997 });
  for (const character of m.characters) for (const scenario of ['match', 'retreat', 'retreat-hard']) {
    assert.equal(result.episodes.filter(e => e.character === character && e.scenario === scenario).length, 2);
  }
});

test('empty Q casts cost reward without forbidding player actions or utility skills', () => {
  const env = new Environment(model(), { seed: 3 }); env.reset('match');
  const p = env.game.state.players['cpu-player'];
  assert.equal(emptyAttack(env.state, p.id, p.cfg), true);
  const result = env.step({ type: 4, latent: [0, 0] }, false);
  assert.ok(p.qCd > 0);
  assert.equal(env.metrics.emptyAttacks, 1);
  assert.equal(env.metrics.attackAttempts, 1);
  assert.ok(result.reward < REWARDS.emptyAttack);
  env.step({ type: 6, latent: [0, 0] }, false);
  assert.equal(env.metrics.emptyAttacks, 1); // Alex's summon is useful without a nearby enemy.
});

test('visible targets and recent bush sightings do not count as certainly empty casts', () => {
  const env = new Environment(model()); env.reset('match');
  const p = env.game.state.players['cpu-player'];
  const state = structuredClone(env.state);
  state.monsters = [{ id: 'm', slot: 2, x: p.x + 2, z: p.z, hp: 100, maxHp: 100 }];
  assert.equal(emptyAttack(state, p.id, p.cfg), false);
  state.monsters = [];
  const memory = { lastSeen: { opponent: { x: p.x, z: p.z + 2, seenAt: state.time } } };
  assert.equal(emptyAttack(state, p.id, p.cfg, memory), false);
  memory.lastSeen.opponent.seenAt -= 3;
  assert.equal(emptyAttack(state, p.id, p.cfg, memory), true);
});

test('farm curriculum exposes real camps and counts episode time from its reset', () => {
  const m = model(); m.featureVersion = Policy.FARM_VERSION; Policy.validate(m);
  const env = new Environment(m, { maxSeconds: .2, seed: 5 }); env.reset('farm');
  assert.ok(env.state.monsters.some(m => m.x > 0));
  assert.ok(env.startedAt >= 5);
  const first = env.step({ type: 0, latent: [0, 0] }, false);
  assert.equal(first.truncated, false);
  const result = env.step({ type: 0, latent: [0, 0] }, false);
  assert.equal(result.truncated, true);
  assert.ok(Math.abs(result.episode.seconds - .2) < .01);
});

test('farm observations preserve tactical slots and encode only observed own camps', () => {
  const env = new Environment(model(), { seed: 5 }); env.reset('farm');
  const state = env.state, actor = 'cpu-player';
  const before = Policy.features(state, actor, env.model.init, {}, Policy.TACTICAL_VERSION);
  const farm = Policy.features(state, actor, env.model.init, {}, Policy.FARM_VERSION);
  assert.deepEqual(Array.from(farm.slice(-32)), Array.from(before.slice(-32)));
  assert.equal(farm[Policy.SIZE - 48], 1);
  const hidden = structuredClone(state); hidden.monsters = [];
  assert.equal(Policy.features(hidden, actor, env.model.init, {}, Policy.FARM_VERSION)[Policy.SIZE - 48], 0);
  assert.ok(farm.every(Number.isFinite));
});

test('invalid leap release cancels aiming like the player UI and preserves valid casts', () => {
  const m = model(); m.aimProtocol = 'release-invalid-leap/1'; Policy.validate(m);
  const env = new Environment(m); env.reset('match');
  const p = env.game.state.players['cpu-player']; p.aiming = true;
  env.state = env.game.observe(p.id);
  const invalid = { event: 'leap', data: { x: -20, z: 20 } };
  const inputs = Policy.commands(m, env.state, p.id, invalid);
  assert.equal(inputs[0].event, 'cancelLeap');
  for (const input of inputs) env.game.input(p.id, input.event, input.data);
  assert.equal(p.aiming, false); assert.equal(p.eCd, 0);
  p.aiming = true; env.state = env.game.observe(p.id);
  const valid = { event: 'leap', data: { x: p.x - 1, z: p.z } };
  assert.deepEqual(Policy.commands(m, env.state, p.id, valid), [valid]);
  env.game.input(p.id, 'leap', valid.data);
  assert.ok(p.eCd > 0);
});

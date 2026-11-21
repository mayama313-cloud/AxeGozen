const { test } = require('node:test');
const assert = require('node:assert/strict');
const World = require('./game-world');
const Policy = require('./public/minion-policy');
const Goals = require('./public/minion-objectives');
const { Environment } = require('./scripts/minion-rl-env');

function model(kind = 'large') {
  const m = { format: Policy.VERSION, inputSize: Policy.SIZE, hiddenSize: 1, characters: ['alex'], events: Policy.EVENTS,
    init: { map: World.MAP, cfg: World.CFG, characters: World.CHARACTERS }, reinforcementLearning: { algorithm: 'PPO' },
    weights: { hiddenW: [Array(Policy.SIZE).fill(0)], hiddenB: [0], typeW: Policy.EVENTS.map(() => [0]), typeB: Policy.EVENTS.map(e => e === 'noop' ? 3 : 0),
      pointW: Array.from({ length: 20 }, () => [0]), pointB: Array(20).fill(0) } };
  const row = Array(Goals.SIZE).fill(0); row[{ base: 0, small: 1, large: 2, energy: 3, camp: 4 }[kind]] = 1;
  m.objectivePolicy = { version: Goals.VERSION, features: Goals.NAMES, hiddenSize: 1,
    camps: World.createMatch(true).state.camps.map(({ id, x, z, large }) => ({ id, x, z, large })),
    weights: { hiddenW: [row], hiddenB: [0], outputW: [[2]], outputB: [0] } };
  return m;
}
function frame(m = model()) {
  const env = new Environment(m, { seed: 3, maxSeconds: 20 }); env.reset('large-finish');
  return env;
}
test('low-HP reindeer outranks a nearly dead small monster when the last hit is reachable', () => {
  const m = model(), env = frame(m), state = structuredClone(env.state), me = state.players.find(p => p.id === 'cpu-player');
  Object.assign(me, { x: 8, z: 3 });
  const large = state.monsters.find(m => m.large), small = state.monsters.find(m => !m.large && m.x > 0);
  Object.assign(large, { hp: 100, x: 0, z: 3 }); Object.assign(small, { hp: 1, x: 9, z: 3 });
  const memory = { samples: { [large.id]: [{ hp: 110, time: state.time - 1 }] } };
  const choices = Goals.candidates(m, state, me.id, memory);
  assert.ok(Goals.teacher(choices.find(g => g.id === large.id)) > Goals.teacher(choices.find(g => g.id === small.id)));
  large.hp = 1; me.x = 25;
  memory.samples[large.id] = [{ hp: 51, time: state.time - 1 }];
  const late = Goals.candidates(m, state, me.id, memory);
  assert.equal(late.find(g => g.id === large.id).features[16], 0);
  assert.ok(Goals.teacher(late.find(g => g.id === large.id)) < Goals.teacher(late.find(g => g.id === small.id)));
});
test('retreat, recall and actual tower damage remain higher priority than objective farming', () => {
  const m = model(), env = frame(m), me = env.state.players.find(p => p.id === 'cpu-player');
  for (const situation of ['health', 'recall', 'defense']) {
    const state = structuredClone(env.state), self = state.players.find(p => p.id === me.id), history = {};
    if (situation === 'health') self.hp = self.maxHp * .3;
    if (situation === 'recall') self.recall = 1;
    if (situation === 'defense') history.towers = { t: { hitAt: state.time } };
    const choices = Goals.candidates(m, state, me.id, {}, history).sort((a, b) => Goals.teacher(b) - Goals.teacher(a));
    assert.equal(choices[0].kind, 'base');
  }
});
test('waiting for the first camp produces finite observations even with stale HP history', () => {
  const m = model(), env = frame(m), state = structuredClone(env.state);
  state.time = 2; state.monsters = [];
  const memory = { samples: { 'monster-4': [{ hp: 100, time: 1 }] } };
  const choices = Goals.candidates(m, state, 'cpu-player', memory);
  assert.ok(choices.some(g => g.kind === 'camp'));
  assert.ok(choices.every(g => g.features.every(Number.isFinite)));
});
test('objective movement releases old keys, keeps its target and does not swing outside range', () => {
  const m = model(), env = frame(m), p = env.game.state.players['cpu-player'];
  Object.assign(p, { x: 12, z: 3, keys: { x: 0, z: -1 }, inputT: .35 });
  env.state = env.game.observe(p.id);
  const history = {}, action = Policy.decide(m, env.state, p.id, history), inputs = Policy.commands(m, env.state, p.id, action);
  assert.equal(action.objectiveGoal.kind, 'large'); assert.ok(!inputs.some(i => i.event === 'q'));
  for (const i of inputs) env.game.input(p.id, i.event, i.data);
  assert.equal(p.keys, null);
  env.state = env.game.observe(p.id);
  const repeated = Policy.commands(m, env.state, p.id, Policy.decide(m, env.state, p.id, history));
  assert.ok(!repeated.some(i => i.event === 'chase' || i.event === 'move'));
});
test('a lethal in-range Q secures the actual large-monster reward through ordinary inputs', () => {
  const m = model(), env = frame(m), p = env.game.state.players['cpu-player'], boss = env.game.state.monsters['monster-0'];
  Object.assign(p, { x: boss.x + 3, z: boss.z }); boss.hp = 15;
  env.state = env.game.observe(p.id);
  const action = Policy.decide(m, env.state, p.id, {});
  const label = Policy.label(action, env.state, p.id);
  const result = env.step({ type: label.type, latent: label.xy.map(v => Math.atanh(v)) }, false, action);
  assert.equal(result.episode.reason, 'large-secured'); assert.equal(result.episode.largeKills, 1);
  assert.ok(p.energy >= 200); assert.equal(env.metrics.emptyAttacks, 0);
  assert.equal(env.metrics.attackAttempts, 1);
});
test('returning control to the base actor clears an objective chase without changing its features', () => {
  const m = model('base'), env = frame(m), p = env.game.state.players['cpu-player'];
  p.target = 'monster-0'; env.state = env.game.observe(p.id);
  const history = { objectives: { goal: 'monster-0' } };
  const before = Policy.features(env.state, p.id, m.init, {});
  assert.deepEqual(Array.from(Policy.features(env.state, p.id, m.init, history)), Array.from(before));
  const action = Policy.decide(m, env.state, p.id, history);
  const inputs = Policy.commands(m, env.state, p.id, action);
  assert.equal(inputs[0].event, 'move');
  for (const input of inputs) env.game.input(p.id, input.event, input.data);
  assert.equal(p.target, null);
});
test('the goal model rejects malformed weights and uses only visible monster HP', () => {
  const m = model(), env = frame(m); Policy.validate(m);
  const state = structuredClone(env.state); state.monsters = state.monsters.filter(m => !m.large);
  assert.ok(!Goals.candidates(m, state, 'cpu-player', {}).some(g => g.kind === 'large'));
  m.objectivePolicy.weights.hiddenW[0][1] = NaN;
  assert.throws(() => Policy.validate(m));
});

test('navigation can leave wall contact and reach a monster behind an obstacle', () => {
  const m = model(), env = frame(m), p = env.game.state.players['cpu-player'];
  Object.assign(p, { x: 14, z: .2 });
  env.state = env.game.observe(p.id);
  const start = Math.hypot(p.x, p.z - 3), history = {};
  for (let i = 0; i < 20; i++) {
    const action = Policy.decide(m, env.state, p.id, history), label = Policy.label(action, env.state, p.id);
    env.step({ type: label.type, latent: label.xy.map(v => Math.atanh(Math.max(-.9999, Math.min(.9999, v)))) }, false, action);
  }
  assert.ok(Math.hypot(p.x, p.z - 3) < start - 4);
});

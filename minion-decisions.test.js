const test = require('node:test');
const assert = require('node:assert/strict');
const World = require('./game-world');
const Policy = require('./public/minion-policy');
const Decisions = require('./public/minion-decisions');
const { Environment } = require('./scripts/minion-rl-env');
function model() {
  return { format: Policy.VERSION, inputSize: 1024, hiddenSize: 1, characters: ['alex', 'mira', 'bastion', 'darius'], events: Policy.EVENTS,
    decisionMode: 'learned/1', init: { map: World.MAP, cfg: World.CFG, characters: World.CHARACTERS },
    weights: { hiddenW: [Array(1024).fill(0)], hiddenB: [0], typeW: Policy.EVENTS.map(() => [0]), typeB: Policy.EVENTS.map(() => 0),
      pointW: Array.from({ length: 20 }, () => [0]), pointB: Array(20).fill(0) },
    tacticalPolicy: { version: Decisions.VERSION, hiddenSize: 1, weights: { hiddenW: [Array(64).fill(0)], hiddenB: [0], outputW: [0], outputB: 0 } } };
}
test('candidate policy exposes both retreat and exact hero targeting at either HP without forcing either', () => {
  const m = model(), env = new Environment(m, { rewardProfile: 'survival/1', decisionTraining: true }); env.reset('finish-static', 'alex');
  const state = env.state, me = state.players.find(p => p.id === 'cpu-player');
  const a = Decisions.candidates(m, state, me.id, { event: 'noop' });
  me.hp = me.maxHp * .2;
  const b = Decisions.candidates(m, state, me.id, { event: 'noop' });
  assert.deepEqual(a.map(c => c.action), b.map(c => c.action));
  assert.ok(a.some(c => c.action.event === 'chase' && c.action.data.id === 'opponent'));
  assert.ok(a.some(c => c.action.event === 'move' && c.action.data.x === World.MAP.spawns[1].x));
  assert.ok(a.length <= Decisions.MAX && a.every(c => c.x.length === 64 && c.x.every(Number.isFinite)));
});
test('untrained zero logits delegate to the existing actor; learned weights choose an actual player input', () => {
  const m = model(), env = new Environment(m, { decisionTraining: true }); env.reset('finish-static', 'alex');
  const base = { event: 'noop' };
  assert.equal(Decisions.choose(m, env.state, 'cpu-player', base).tacticalChoice, 0);
  m.tacticalPolicy.weights.hiddenW[0][35] = 1; // chase event input
  m.tacticalPolicy.weights.hiddenW[0][42] = 1; // enemy hero type
  m.tacticalPolicy.weights.outputW[0] = 1;
  const action = Decisions.choose(m, env.state, 'cpu-player', base);
  assert.equal(action.event, 'chase'); assert.equal(action.data.id, 'opponent');
  Policy.validate(m);
});
test('one-hit starts are physically one-hit and include a closer enemy minion distraction', () => {
  for (const c of model().characters) {
    const env = new Environment(model(), { seed: 71, decisionTraining: true }); env.reset('finish-static', c);
    const p = env.game.state.players['cpu-player'], enemy = env.game.state.players.opponent;
    assert.ok(enemy.hp > 0 && enemy.hp <= p.cfg.atkDmg, c);
    assert.ok(env.state.robots.some(r => r.slot !== p.slot), c);
    assert.ok(!enemy.dead);
  }
});

test('each one-hit test is actually finishable by normal chase inputs despite the distraction and fleeing', () => {
  for (const scenario of ['finish-static', 'finish-flee']) for (const c of model().characters) {
    const env = new Environment(model(), { seed: 71, decisionTraining: true }); env.reset(scenario, c);
    let result;
    for (let i = 0; i < 60; i++) {
      const index = env.decisionChoices.findIndex(c => c.action.event === 'chase' && c.action.data.id === 'opponent');
      if (index < 0) break;
      result = env.stepDecision(index, false); if (result.episode) break;
    }
    assert.equal(result?.episode?.reason, 'finish-success', `${c}/${scenario}`);
  }
});
test('decision steps use the chosen input ID and preserve chase cancellation instead of retargeting by coordinates', () => {
  const env = new Environment(model(), { decisionTraining: true }); env.reset('finish-static', 'alex');
  const index = env.decisionChoices.findIndex(c => c.action.event === 'chase' && c.action.data.id === 'opponent');
  env.stepDecision(index, false);
  assert.equal(env.game.state.players['cpu-player'].target, 'opponent');
  const steer = env.decisionChoices.findIndex(c => c.action.event === 'steer'); env.stepDecision(steer, false);
  assert.equal(env.game.state.players['cpu-player'].target, null);
  assert.throws(() => env.stepDecision(Decisions.MAX + 1));
});
test('movement locks expose only the baseline and invalid model weights are rejected', () => {
  const m = model(), env = new Environment(m, { decisionTraining: true }); env.reset('duel-retreat', 'alex');
  const me = env.state.players.find(p => p.id === 'cpu-player'); me.stun = 1;
  assert.equal(Decisions.candidates(m, env.state, me.id, { event: 'noop' }).length, 1);
  m.tacticalPolicy.weights.outputW[0] = NaN; assert.throws(() => Policy.validate(m));
});

test('encounter scope preserves the existing policy outside visible combat, independent of HP', () => {
  const m = model(); m.tacticalPolicy.scope = 'visible-encounter/1';
  const env = new Environment(m, { decisionTraining: true }); env.reset('finish-static', 'alex');
  const me = env.state.players.find(p => p.id === 'cpu-player'), enemy = env.state.players.find(p => p.id === 'opponent');
  assert.ok(Decisions.candidates(m, env.state, me.id, { event: 'noop' }).length > 1);
  enemy.vis = false;
  for (const hp of [.1, 1]) {
    me.hp = me.maxHp * hp;
    assert.equal(Decisions.candidates(m, env.state, me.id, { event: 'noop' }).length, 1);
  }
  m.tacticalPolicy.scope = 'invalid'; assert.throws(() => Policy.validate(m));
});

test('geometry observations expose blocked travel without forcing or removing the input', () => {
  const m = model(), env = new Environment(m, { decisionTraining: true }); env.reset('finish-static', 'darius');
  m.tacticalPolicy.inputSize = Decisions.SIZE;
  m.tacticalPolicy.weights.hiddenW[0].push(0, 0);
  const me = env.state.players.find(p => p.id === 'cpu-player'), wall = World.MAP.obst[0];
  me.x = wall.x + wall.r + World.configFor('darius').radius + .3; me.z = wall.z;
  const action = { event: 'steer', data: { x: -1, z: 0 } };
  const choices = Decisions.candidates(m, env.state, me.id, action);
  assert.equal(choices[0].x.length, 66); assert.ok(choices[0].x[64] < 1);
  assert.deepEqual(choices[0].action, action);
  assert.equal(Decisions.score(m.tacticalPolicy, choices[0].x), 0);
  Policy.validate(m);
});

test('training preserves the deployed base policy temperature when proposing combat candidates', () => {
  const m = model(); m.reinforcementLearning = { algorithm: 'PPO', temperature: 1, directionTemperature: .8 };
  const env = new Environment(m, { decisionTraining: true });
  assert.deepEqual(env.model.reinforcementLearning, m.reinforcementLearning);
});

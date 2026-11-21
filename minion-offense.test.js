const test = require('node:test');
const assert = require('node:assert/strict');
const World = require('./game-world');
const Goals = require('./public/minion-objectives');
function fixture() {
  const game = World.createMatch(false, false, { teamSizes: [1, 1] });
  game.addBot({ team: 0, member: 0, id: 'me', character: 'alex' });
  game.addBot({ team: 1, member: 0, id: 'enemy', character: 'alex' });
  for (let i = 0; i < 160; i++) game.tick();
  const model = { init: { cfg: World.CFG, map: World.MAP, characters: World.CHARACTERS }, objectivePolicy: { version: Goals.OFFENSE_VERSION, camps: [] } };
  const state = structuredClone(game.observe('me'));
  Object.assign(state.players[0], { x: 3, z: -3, hp: 200, recall: 0 });
  Object.assign(state.players[1], { x: 24, z: -24, vis: true, dead: true });
  state.monsters = []; state.energy = [];
  return { game, model, state, me: state.players[0], enemy: state.players[1] };
}
test('v8 can consider visible enemy camps and towers while legacy v7 candidates stay unchanged', () => {
  const { model, state } = fixture();
  state.monsters = [{ id: 'enemy-camp', x: 6, z: -2, hp: 20, maxHp: 100, large: false }];
  const choices = Goals.candidates(model, state, 'me', {});
  assert.ok(choices.some(g => g.id === 'enemy-camp')); assert.ok(choices.some(g => g.kind === 'tower'));
  assert.ok(choices.every(g => g.features.length === Goals.OFFENSE_NAMES.length && g.features.every(Number.isFinite)));
  model.objectivePolicy.version = Goals.VERSION;
  const legacy = Goals.candidates(model, state, 'me', {});
  assert.ok(!legacy.some(g => g.id === 'enemy-camp' || g.kind === 'tower'));
  assert.ok(legacy.every(g => g.features.length === Goals.SIZE));
});
test('demonstrations prefer a tower opening but account for defenders, health and tower exposure', () => {
  const { model, state, me, enemy } = fixture();
  state.control[1].boundary = -42;
  state.towers = [{ id: 'target', slot: 1, x: 5, z: -5, hp: 100, dead: false }];
  const score = () => Goals.candidates(model, state, 'me', {}).find(g => g.kind === 'tower');
  const opening = score(); assert.equal(opening.features[32], 1); assert.ok(Goals.teacher(opening) > .3);
  Object.assign(enemy, { dead: false, x: 5, z: -5, hp: 200 });
  const guarded = score(); assert.ok(Goals.teacher(guarded) < Goals.teacher(opening) - .2);
  me.hp = 60; assert.ok(Goals.teacher(score()) < 0);
});
test('reachable last-hit steals are rewarded; monsters dying before arrival are rejected', () => {
  const { model, state, me, enemy } = fixture();
  state.towers = []; state.control[1].boundary = -42;
  Object.assign(me, { x: 0, z: 0, qCd: 0 }); Object.assign(enemy, { dead: false, x: 6, z: 0 });
  state.monsters = [{ id: 'steal', x: 5, z: 0, hp: 24, maxHp: 100, large: false }];
  const memory = { samples: { steal: [{ hp: 44, time: state.time - 1 }] } };
  const g = Goals.candidates(model, state, 'me', memory).find(g => g.id === 'steal');
  assert.equal(g.features[33], 1); assert.ok(Goals.teacher(g) > .6);
  me.x = -25;
  const late = Goals.candidates(model, state, 'me', memory).find(g => g.id === 'steal');
  assert.equal(late.features[16], 0); assert.ok(Goals.teacher(late) < 0);
});
test('enemy invasion cost discourages deep raids without enough health to return', () => {
  const { model, state } = fixture(); state.towers = [];
  state.monsters = [{ id: 'deep', x: 24, z: -20, hp: 100, maxHp: 100, large: false }];
  const g = Goals.candidates(model, state, 'me', {}).find(g => g.id === 'deep');
  assert.equal(g.features[25], 1); assert.ok(g.features[26] > .65); assert.ok(Goals.teacher(g) < 0);
});
test('missing enemies are uncertainty, rather than an automatic safe tower opening', () => {
  const { model, state, enemy } = fixture();
  Object.assign(enemy, { dead: false, vis: false }); delete enemy.x; delete enemy.z;
  const g = Goals.candidates(model, state, 'me', {}).find(g => g.kind === 'tower');
  assert.equal(g.features[34], 1); assert.equal(g.features[32], 0);
});
test('the offensive model cannot override retreat, recall or a tower damage alarm', () => {
  const { model, state, me } = fixture();
  const row = Array(Goals.OFFENSE_NAMES.length).fill(0); row[24] = 1;
  Object.assign(model.objectivePolicy, { features: Goals.OFFENSE_NAMES, hiddenSize: 1, weights: { hiddenW: [row], hiddenB: [0], outputW: [[10]], outputB: [0] } });
  Goals.validate(model.objectivePolicy);
  for (const reason of ['health', 'recall', 'alarm']) {
    me.hp = reason === 'health' ? 50 : 200; me.recall = reason === 'recall' ? 1 : 0;
    const history = { objectives: { goal: 'old-chase' }, towers: reason === 'alarm' ? { t: { hitAt: state.time } } : {} };
    const action = Goals.plan(model, state, 'me', history);
    assert.equal(action.objectiveGoal, undefined); assert.equal(action.fallbackInputs[0].event, 'move');
  }
});

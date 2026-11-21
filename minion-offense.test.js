const test = require('node:test');
const assert = require('node:assert/strict');
const World = require('./game-world');
const Goals = require('./public/minion-objectives');
const Policy = require('./public/minion-policy');
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

function pursuitFixture() {
  const f = fixture(), row = Array(Goals.OFFENSE_NAMES.length).fill(0); row[1] = 1;
  Object.assign(f.model.objectivePolicy, { features: Goals.OFFENSE_NAMES, hiddenSize: 1, weights: { hiddenW: [row], hiddenB: [0], outputW: [[10]], outputB: [0] } });
  Object.assign(f.me, { x: 0, z: 8, hp: 200, qCd: 0, cCd: 0, moving: false, inputs: {} });
  Object.assign(f.enemy, { x: 6, z: 8, hp: 40, dead: false, moving: false, vis: true, shield: 0 });
  f.state.towers = []; f.state.monsters = [{ id: 'easy-farm', x: -6, z: 8, hp: 1, maxHp: 100, large: false }];
  return f;
}
test('a reachable weakened hero preempts even the highest scoring easy farm and retains pursuit', () => {
  const { model, state, me, enemy } = pursuitFixture(), history = {};
  const action = Goals.plan(model, state, me.id, history);
  assert.deepEqual(action.objectiveGoal, { id: enemy.id, kind: 'hero' });
  assert.ok(action.objectiveInputs.some(i => i.event === 'chase' && i.data.id === enemy.id));
  for (let i = 0; i < 6; i++) {
    state.time += .1; me.x += .2; me.inputs.target = enemy.id;
    assert.equal(Goals.plan(model, state, me.id, history).objectiveGoal.kind, 'hero');
  }
  enemy.hp = enemy.maxHp;
  assert.equal(Goals.plan(model, state, me.id, history).objectiveGoal.kind, 'small');
});
test('pursuit stops for low health, recall, tower alarm, faster escaping enemies, fog and protected spawns', () => {
  for (const reason of ['health', 'recall', 'alarm', 'speed', 'fog', 'spawn', 'guards']) {
    const { model, state, me, enemy } = pursuitFixture(), history = {};
    if (reason === 'health') me.hp = 60;
    if (reason === 'recall') me.recall = 1;
    if (reason === 'alarm') history.towers = { tower: { hitAt: state.time } };
    if (reason === 'speed') { enemy.character = 'mira'; enemy.moving = true; enemy.hp = 50; }
    if (reason === 'fog') { enemy.vis = false; delete enemy.x; delete enemy.z; }
    if (reason === 'spawn') Object.assign(enemy, World.MAP.spawns[1]);
    if (reason === 'guards') state.players.push({ ...enemy, id: 'guard', hp: 200, x: enemy.x + 1 });
    assert.notEqual(Goals.plan(model, state, me.id, history)?.objectiveGoal?.kind, 'hero', reason);
  }
});
test('visible movement samples cancel a pursuit that stops making progress and allow a ranged finisher', () => {
  const { model, state, me, enemy } = pursuitFixture(), history = {};
  Goals.plan(model, state, me.id, history);
  for (let i = 0; i < 17; i++) { state.time += .1; Goals.plan(model, state, me.id, history); }
  assert.notEqual(Goals.plan(model, state, me.id, history).objectiveGoal.kind, 'hero');
  state.time += 3; enemy.hp = 10; enemy.x = 3; enemy.moving = true;
  const finish = Goals.plan(model, state, me.id, history);
  assert.equal(finish.objectiveGoal.kind, 'hero'); assert.ok(finish.objectiveInputs.some(i => i.event === 'q'));
});
test('a ready in-range Q kills a weakened hero through normal inputs instead of switching to farm', () => {
  const game = World.createMatch(false, false, { controllers: [() => [], () => []] }), hooks = [{}, {}];
  ['me', 'enemy'].forEach((id, i) => game.connect({ id, on(e, fn) { hooks[i][e] = fn; }, emit() {}, disconnect() {} }));
  hooks.forEach(h => h.selectCharacter({ id: 'alex' })); hooks.forEach(h => h.confirmCharacter());
  for (let i = 0; i < 160; i++) game.tick();
  game.state.environment.enabled = false;
  Object.assign(game.state.players.me, { x: 0, z: 8, hp: 200 }); Object.assign(game.state.players.enemy, { x: 2, z: 8, hp: 15 });
  const { model } = pursuitFixture(), state = game.observe('me');
  const action = Goals.plan(model, state, 'me', {});
  assert.equal(action.objectiveGoal.kind, 'hero');
  for (const input of action.objectiveInputs) game.input('me', input.event, input.data);
  assert.equal(game.state.players.enemy.dead, true); assert.equal(game.state.players.me.kills, 1); assert.equal(game.state.players.me.energy, 15);
});

test('all four v8 characters chase and finish an exposed weakened enemy with a farm still available', () => {
  for (const character of ['alex', 'bastion', 'darius', 'mira']) {
    const game = World.createMatch(false, false, { controllers: [() => [], () => []] }), hooks = [{}, {}];
    ['me', 'enemy'].forEach((id, i) => game.connect({ id, on(e, fn) { hooks[i][e] = fn; }, emit() {}, disconnect() {} }));
    hooks[0].selectCharacter({ id: character }); hooks[1].selectCharacter({ id: 'alex' }); hooks.forEach(h => h.confirmCharacter());
    for (let i = 0; i < 160; i++) game.tick(); game.state.environment.enabled = false;
    const me = game.state.players.me, enemy = game.state.players.enemy;
    Object.assign(me, { x: 0, z: 8, hp: me.cfg.maxHp }); Object.assign(enemy, { x: 6, z: 8, hp: 40 });
    const { model } = pursuitFixture(), history = {}; let pursued = false;
    for (let i = 0; i < 60 && !enemy.dead; i++) {
      const action = Goals.plan(model, game.observe('me'), me.id, history);
      if (action?.objectiveGoal?.kind === 'hero') pursued = true;
      for (const input of action?.objectiveInputs || []) game.input(me.id, input.event, input.data);
      for (let tick = 0; tick < 3; tick++) game.tick();
    }
    assert.ok(pursued, character); assert.equal(enemy.dead, true, character); assert.equal(me.kills, 1, character);
  }
});

test('Darius keeps the hero chase and does not grab or uppercut a nearer enemy minion', () => {
  const { model, state, me, enemy } = pursuitFixture();
  Object.assign(me, { character: 'darius', maxHp: 300, hp: 300, x: 0, z: 8 });
  Object.assign(enemy, { x: 2, z: 8, hp: 40 });
  state.robots = [{ id: 'blocker', slot: 1, character: 'alex', x: 1, z: 8, hp: 80, maxHp: 80, radius: .4 }];
  const action = Goals.plan(model, state, me.id, {});
  assert.equal(action.objectiveGoal.kind, 'hero');
  assert.ok(action.objectiveInputs.some(i => i.event === 'chase' && i.data.id === enemy.id));
  assert.ok(!action.objectiveInputs.some(i => i.event === 'c' || i.event === 'q'));
});

test('the full controller keeps finishing the hero with enemy minions between them for all v8 characters', () => {
  for (const character of ['alex', 'bastion', 'darius', 'mira']) {
    const hooks = [{}, {}]; let control = null;
    const game = World.createMatch(false, false, { controllers: [() => [], () => []] });
    ['me', 'enemy'].forEach((id, i) => game.connect({ id, on(e, fn) { hooks[i][e] = fn; }, emit(e, data) { if (i === 0 && control) control.observe({ event: e, data, time: game.observe(id).time }); }, disconnect() {} }));
    hooks[0].selectCharacter({ id: character }); hooks[1].selectCharacter({ id: 'alex' }); hooks.forEach(h => h.confirmCharacter());
    for (let i = 0; i < 160; i++) game.tick(); game.state.environment.enabled = false;
    const me = game.state.players.me, enemy = game.state.players.enemy;
    Object.assign(me, { x: 0, z: 8, hp: me.cfg.maxHp }); Object.assign(enemy, { x: 3, z: 8, hp: 40 });
    hooks[1].c({ x: 0, z: 8 }); const blocker = Object.values(game.state.robots)[0];
    Object.assign(blocker, { x: 1.5, z: 8, stun: 1000, hp: 80, life: 100 });
    const { model } = pursuitFixture();
    Object.assign(model, { format: Policy.VERSION, inputSize: Policy.SIZE, hiddenSize: 1, characters: ['alex', 'bastion', 'darius', 'mira'], events: Policy.EVENTS,
      weights: { hiddenW: [Array(Policy.SIZE).fill(0)], hiddenB: [0], typeW: Policy.EVENTS.map(() => [0]),
        typeB: Policy.EVENTS.map(e => e === 'chase' ? 10 : 0), pointW: Array.from({ length: 20 }, () => [0]), pointB: Array(20).fill(0) } });
    control = Policy.controller(model, { slot: 0, actorId: me.id });
    for (let i = 0; i < 60 && !enemy.dead; i++) {
      const inputs = control(game.observe(me.id));
      assert.ok(inputs.every(input => input.event !== 'chase' || input.data.id === enemy.id), `${character}: switched chase`);
      for (const input of inputs) game.input(me.id, input.event, input.data);
      assert.notEqual(me.target, blocker.id, `${character}: selected minion`);
      for (let tick = 0; tick < 3; tick++) game.tick();
    }
    assert.equal(enemy.dead, true, `${character}: did not finish hero`);
    assert.ok(blocker.hp > 0, `${character}: killed minion first`);
  }
});

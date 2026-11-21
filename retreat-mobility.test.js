const test = require('node:test');
const assert = require('node:assert/strict');
const World = require('./game-world');
const Policy = require('./public/minion-policy');
function fixture(character, slot = 0) {
  const hooks = [{}, {}], game = World.createMatch(false, false, { controllers: [() => [], () => []] });
  for (let i = 0; i < 2; i++) game.connect({ id: i === slot ? 'me' : 'enemy', on(e, fn) { hooks[i][e] = fn; }, emit() {}, disconnect() {} });
  hooks[slot].selectCharacter({ id: character }); hooks[1 - slot].selectCharacter({ id: 'alex' }); hooks.forEach(h => h.confirmCharacter());
  game.state.environment.enabled = false;
  const me = game.state.players.me, enemy = game.state.players.enemy;
  Object.assign(me, { x: 0, z: 8, hp: me.cfg.maxHp * .3 });
  Object.assign(enemy, { x: slot ? -3 : 3, z: slot ? 10 : 6 });
  const model = { format: Policy.VERSION, inputSize: Policy.SIZE, hiddenSize: 1, characters: World.CHARACTERS.map(c => c.id), events: Policy.EVENTS,
    init: { map: World.MAP, cfg: World.CFG, characters: World.CHARACTERS }, weights: { hiddenW: [Array(Policy.SIZE).fill(0)], hiddenB: [0],
      typeW: Policy.EVENTS.map(() => [0]), typeB: Policy.EVENTS.map(e => e === 'noop' ? 10 : 0),
      pointW: Array.from({ length: 20 }, () => [0]), pointB: Array(20).fill(0) } };
  return { game, me, enemy, model, slot };
}
test('all learned characters use their own escape or guard skill through normal inputs on either side', () => {
  for (const slot of [0, 1]) for (const { id } of World.CHARACTERS) {
    const { game, me, model } = fixture(id, slot), state = game.observe(me.id), home = World.MAP.spawns[slot];
    const before = Math.hypot(me.x - home.x, me.z - home.z), action = Policy.decide(model, state, me.id, {});
    assert.equal(action.retreatMobility, true, `${id}/${slot}`);
    for (const input of Policy.commands(model, state, me.id, action)) game.input(me.id, input.event, input.data);
    assert.ok(me.eCd > 0, `${id}/${slot}: skill rejected`);
    assert.equal(me.target, null); assert.equal(me.keys, null);
    if (id === 'alex') assert.ok(me.leap);
    if (id === 'darius') assert.ok(me.charge);
    if (id === 'lucia') assert.ok(me.warp);
    if (id === 'mira') assert.ok(me.speedBoost > 0);
    if (id === 'bastion') assert.ok(me.shield > 0);
    for (let i = 0; i < 45; i++) game.tick();
    assert.ok(Math.hypot(me.x - home.x, me.z - home.z) < before - 1, `${id}/${slot}: did not escape`);
  }
});
test('escape obeys cooldown, recall, movement locks and does not spend skills at home or while healthy', () => {
  for (const condition of ['cooldown', 'recall', 'stun', 'air', 'warping', 'charging', 'grabbing', 'grabbed', 'flying', 'dead', 'home', 'healthy']) {
    const { game, me } = fixture('alex');
    if (condition === 'cooldown') me.eCd = 1;
    else if (condition === 'home') Object.assign(me, World.MAP.spawns[0]);
    else if (condition === 'healthy') me.hp = me.cfg.maxHp;
    const state = game.observe(me.id), self = state.players.find(p => p.id === me.id);
    if (!['cooldown', 'home', 'healthy'].includes(condition)) self[condition] = 1;
    assert.equal(World.retreatInputs(state, me.id), null, condition);
  }
});
test('Alex already aiming confirms the escape without toggling the aim off', () => {
  const { game, me } = fixture('alex'); me.aiming = true;
  const inputs = World.retreatInputs(game.observe(me.id), me.id);
  assert.ok(!inputs.some(i => i.event === 'dash'));
  inputs.forEach(i => game.input(me.id, i.event, i.data)); assert.ok(me.leap); assert.ok(me.eCd > 0);
});
test('retreat intent uses available mobility before critical HP without treating healthy farming as retreat', () => {
  const { game, me } = fixture('mira'); me.hp = me.cfg.maxHp * .6;
  const state = game.observe(me.id), home = World.MAP.spawns[0];
  assert.equal(World.retreatInputs(state, me.id), null);
  assert.ok(World.retreatInputs(state, me.id, { event: 'move', data: home }));
  assert.equal(World.retreatInputs(state, me.id, { event: 'chase', data: { id: 'enemy' } }), null);
});
test('Darius chooses a usable corridor and never charges through the wall on the direct homeward line', () => {
  const { game, me } = fixture('darius', 1), state = game.observe(me.id);
  const inputs = World.retreatInputs(state, me.id), to = inputs.find(i => i.event === 'dash').data;
  const obstacles = [...World.MAP.obst, ...state.towers.filter(t => !t.dead).map(t => ({ ...t, r: World.CFG.tower.radius }))];
  for (let i = 0; i <= 30; i++) {
    const p = { x: me.x + (to.x - me.x) * i / 30, z: me.z + (to.z - me.z) * i / 30 };
    assert.ok(obstacles.every(o => Math.hypot(p.x - o.x, p.z - o.z) >= o.r + me.radius - 1e-6));
  }
});
test('algorithm CPUs also use escape mobility for every character', () => {
  for (const { id } of World.CHARACTERS) {
    const game = World.createMatch(false, true), hooks = {};
    game.connect({ id: 'human', on(e, fn) { hooks[e] = fn; }, emit() {}, disconnect() {} });
    hooks.selectCpuCharacter({ id }); hooks.selectCharacter({ id: 'alex' }); hooks.confirmCharacter(); game.state.environment.enabled = false;
    const me = game.state.players['cpu-player'], enemy = game.state.players.human;
    Object.assign(me, { x: 0, z: 8, hp: me.cfg.maxHp * .25 }); Object.assign(enemy, { x: -3, z: 10 });
    game.tick(); assert.ok(me.eCd > 0, id);
  }
});

test('learned decision mode never invokes the retreat override or objective selector', () => {
  const { game, me, model } = fixture('alex'), state = game.observe(me.id);
  assert.ok(World.retreatInputs(state, me.id));
  model.decisionMode = 'learned/1';
  const action = Policy.decide(model, state, me.id, {});
  assert.equal(action.event, 'noop'); assert.equal(action.retreatMobility, undefined);
  assert.equal(action.objectiveInputs, undefined);
  const Goals = require('./public/minion-objectives'), row = Array(Goals.OFFENSE_NAMES.length).fill(0); row[1] = 1;
  model.objectivePolicy = { version: Goals.OFFENSE_VERSION, features: Goals.OFFENSE_NAMES, camps: [], hiddenSize: 1,
    weights: { hiddenW: [row], hiddenB: [0], outputW: [[10]], outputB: [0] } };
  state.players.find(p => p.id === me.id).hp = me.cfg.maxHp;
  state.monsters = [{ id: 'farm', slot: 2, x: -1, z: 8, hp: 100, maxHp: 100, large: false }];
  Policy.validate(model);
  assert.equal(Policy.decide(model, state, me.id, {}).event, 'noop');
  delete model.decisionMode;
  assert.equal(Policy.decide(model, state, me.id, {}).objectiveGoal.kind, 'small');
});

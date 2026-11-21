const test = require('node:test');
const assert = require('node:assert/strict');
const Perception = require('./public/minion-perception');
const Policy = require('./public/minion-policy');
const World = require('./game-world');
const { Environment } = require('./scripts/minion-rl-env');
function model() {
  return { format: Policy.VERSION, inputSize: 1072, featureVersion: Policy.PERCEPTION_VERSION, decisionMode: 'learned/1', hiddenSize: 1,
    characters: ['alex'], events: Policy.EVENTS, init: { map: World.MAP, cfg: World.CFG, characters: World.CHARACTERS },
    weights: { hiddenW: [Array(1072).fill(0)], hiddenB: [0], typeW: Policy.EVENTS.map(() => [0]), typeB: Policy.EVENTS.map(() => 0),
      pointW: Array.from({ length: 20 }, () => [0]), pointB: Array(20).fill(0), perceptionW: Array.from({ length: 41 }, () => Array(32).fill(0)) } };
}
function fixture() {
  const init = { map: { ...World.MAP, bushes: [{ x: 0, z: 0, r: 3 }] }, cfg: World.CFG, characters: World.CHARACTERS };
  const me = { id: 'me', slot: 0, character: 'alex', x: 6, z: 0, vis: true, hp: 200, maxHp: 200 };
  const enemy = { id: 'enemy', slot: 1, character: 'alex', x: 3.5, z: 0, vis: true, hp: 200, maxHp: 200 };
  const state = { time: 0, players: [me, enemy], robots: [], towers: [], monsters: [], projectiles: [], energy: [], control: [{ slot: 0, boundary: 0 }, { slot: 1, boundary: 0 }] };
  const memory = {}, update = events => Policy.updateMemory(memory, state, me.id, events || [], Policy.PERCEPTION_VERSION, init);
  return { init, me, enemy, state, memory, update };
}
test('witnessed brush entry persists without reading the hidden enemy current coordinates', () => {
  const f = fixture(); f.update(); f.state.time = .1; f.enemy.x = 3.1; f.update();
  f.state.time = .2; Object.assign(f.enemy, { vis: false, x: 999, z: 999 }); f.update();
  const b = f.memory.perception.enemies.enemy.belief;
  assert.equal(b.bush, 0); assert.equal(b.entry, true); assert.equal(b.x, 0); assert.equal(b.z, 0);
  f.state.time = 2; f.enemy.x = -999; f.update();
  assert.equal(f.memory.perception.enemies.enemy.belief.x, 0);
  assert.ok(f.memory.perception.enemies.enemy.belief.confidence < b.initial);
});
test('an observed attack trace creates a belief even if entry was not seen; repeated cues do not renew it', () => {
  const f = fixture(); f.enemy.vis = false; delete f.enemy.x; delete f.enemy.z;
  const cue = { event: 'fx', time: 0, data: { kind: 'bushAttack', source: 'enemy', bush: 0, x: 1, z: 0 } };
  f.update([cue]); const b = f.memory.perception.enemies.enemy.belief;
  assert.equal(b.attack, true); assert.equal(b.entry, false); assert.equal(b.x, 1);
  f.state.time = 4; f.update([cue]); assert.equal(f.memory.perception.enemies.enemy.belief.at, 0);
  f.state.time = 8.1; f.update([cue]); assert.equal(f.memory.perception.enemies.enemy.belief, null);
});
test('seen exits, death, empty searches and match reset remove stale brush beliefs', () => {
  for (const reason of ['exit', 'death', 'search', 'reset']) {
    const f = fixture(); f.enemy.vis = false; f.update([{ event: 'fx', time: 0, data: { kind: 'bushAttack', source: 'enemy', bush: 0, x: 0, z: 0 } }]);
    f.state.time = 1;
    if (reason === 'exit') Object.assign(f.enemy, { vis: true, x: 5, z: 0 });
    if (reason === 'death') f.enemy.dead = true;
    if (reason === 'search') f.me.x = 0;
    if (reason === 'reset') { f.memory.time = 2; f.state.time = 0; }
    f.update(); assert.ok(!f.memory.perception.enemies.enemy?.belief, reason);
  }
});
test('nearby disappearance unrelated to a bush, friendly and malformed attack cues are not evidence', () => {
  const f = fixture(); f.enemy.x = 20; f.update(); f.state.time = .1; f.enemy.vis = false;
  f.update([{ event: 'fx', time: .1, data: { kind: 'bushAttack', source: 'me', bush: 0, x: 0, z: 0 } },
    { event: 'fx', time: .1, data: { kind: 'bushAttack', source: 'enemy', bush: 0, x: 20, z: 0 } }]);
  assert.ok(!f.memory.perception.enemies.enemy.belief);
});
test('five opponent beliefs are encoded explicitly while legacy actor inputs remain identical', () => {
  const f = fixture(); f.enemy.vis = false;
  f.state.players.push(...Array.from({ length: 4 }, (_, i) => ({ ...f.enemy, id: 'enemy-' + i, member: i + 1 })));
  const events = f.state.players.filter(p => p.slot === 1).map(p => ({ event: 'fx', time: 0, data: { kind: 'bushAttack', source: p.id, bush: 0, x: 0, z: 0 } }));
  f.update(events);
  const x = Policy.features(f.state, 'me', f.init, f.memory, Policy.PERCEPTION_VERSION);
  assert.equal(x.length, 1072); assert.equal(x[1070], 1); assert.ok(Array.from(x).every(Number.isFinite));
  const legacy = structuredClone(f.memory); delete legacy.perception;
  assert.deepEqual(Array.from(x.slice(0, 1040)), Array.from(Policy.features(f.state, 'me', f.init, legacy, Policy.ALARM_VERSION)));
  assert.equal(Perception.features(f.memory, f.state, 'me')[0], 1);
});
test('a hidden bush attack gives nearby humans and policies the same trace, without revealing the character', () => {
  const events = [[], [], []], hooks = [{}, {}, {}], policyEvents = [], control = () => [];
  control.observe = e => policyEvents.push(e);
  const game = World.createMatch(false, false, { teamSizes: [1, 2] });
  ['source', 'near', 'far'].forEach((id, i) => game.connect({ id, on(e, fn) { hooks[i][e] = fn; }, emit(e, data) { events[i].push({ event: e, data }); }, disconnect() {} }, { team: i ? 1 : 0, member: i ? i - 1 : 0, controller: i === 1 ? control : null, bot: i === 1, character: 'alex' }));
  hooks[0].selectCharacter({ id: 'mira' }); hooks[2].selectCharacter({ id: 'alex' }); hooks[0].confirmCharacter(); hooks[2].confirmCharacter();
  game.state.environment.enabled = false;
  const bush = World.MAP.bushes[4], source = game.state.players.source, near = game.state.players.near, far = game.state.players.far;
  Object.assign(source, { x: bush.x, z: bush.z, bush: 4 }); Object.assign(near, { x: bush.x + 5, z: bush.z - 1, bush: -1 }); Object.assign(far, { x: 25, z: -25, bush: -1 });
  hooks[0].q({ x: near.x, z: near.z });
  const human = events[1].find(e => e.data?.kind === 'bushAttack'), learned = policyEvents.find(e => e.data?.kind === 'bushAttack');
  assert.ok(human); assert.deepEqual(human.data, learned.data);
  // Vision is team shared: a nearby ally's observed trace is shared, but the body stays hidden.
  assert.equal(game.observe('near').players.find(p => p.id === 'source').vis, false);
  assert.equal(game.observe('near').players.find(p => p.id === 'source').x, undefined);
  source.stealth = 5; source.qCd = 0; const count = events[1].length; hooks[0].q({ x: near.x, z: near.z });
  assert.ok(!events[1].slice(count).some(e => e.data?.kind === 'bushAttack'));
});

test('real bush resets expose the expected evidence without exposing the hidden body', () => {
  for (const scenario of ['bush-entry', 'bush-attack', 'bush-empty', 'bush-exit']) {
    const env = new Environment(model(), { seed: 17, maxSeconds: 15 });
    const observation = env.reset(scenario, 'alex'), expected = ['bush-entry', 'bush-attack'].includes(scenario);
    assert.equal(env.metrics.bushBeliefAtStart, expected, scenario);
    assert.equal(observation.x.length, 1072); assert.ok(observation.x.every(Number.isFinite));
    assert.equal(observation.x[1040] > 0, expected, scenario);
    if (expected) assert.equal(env.state.players.find(p => p.id === 'opponent').x, undefined, scenario);
  }
});
test('learned bush residual leaves base outputs unchanged without evidence and changes them with evidence', () => {
  const m = model(); m.weights.perceptionW[2][0] = 2; m.weights.perceptionW[10][1] = .5;
  Policy.validate(m);
  const x = Array(1072).fill(0), base = Policy.forward(m, x);
  x[1040] = .9; x[1041] = .2;
  const sensed = Policy.forward(m, x);
  assert.equal(base.logits[2], 0); assert.equal(sensed.logits[2], 1.8);
  assert.ok(sensed.points[0] > base.points[0]);
  m.weights.perceptionW[0].pop(); assert.throws(() => Policy.validate(m));
});

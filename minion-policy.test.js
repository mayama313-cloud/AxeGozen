const { test } = require('node:test');
const assert = require('node:assert/strict');
const Policy = require('./public/minion-policy');
const World = require('./game-world');
const { Recorder, dataset, addRange, validate } = require('./public/training-data');

function fixture(event = 'steer') {
  const init = { map: World.MAP, cfg: World.CFG, characters: World.CHARACTERS };
  const weights = { hiddenW: [Array(Policy.SIZE).fill(0)], hiddenB: [0],
    typeW: Policy.EVENTS.map(() => [0]), typeB: Policy.EVENTS.map(e => e === event ? 10 : -10),
    pointW: Array.from({ length: Policy.EVENTS.length * 2 }, () => [0]), pointB: Array(Policy.EVENTS.length * 2).fill(0.5) };
  return { format: Policy.VERSION, events: Policy.EVENTS, inputSize: Policy.SIZE, hiddenSize: 1, characters: ['alex'], init, weights };
}
function game(policy) {
  const handlers = {}, frames = [], recorder = new Recorder(); recorder.enabled = true;
  const match = World.createMatch(false, true, { policy, trace: e => recorder.consume(e) });
  match.connect({ id: 'human', on(e, fn) { handlers[e] = fn; }, emit(e, d) { if (e === 'state') frames.push(d); }, disconnect() {} });
  handlers.selectCharacter({ id: 'alex' }); handlers.confirmCharacter(); match.tick();
  return { match, handlers, frames, recorder };
}

test('model uses ordinary move commands without algorithm navigation or farming and data is labeled model', () => {
  const policy = () => [{ event: 'move', data: { x: 24, z: -16 } }];
  const { match, recorder } = game(policy);
  const bot = match.state.players['cpu-player'];
  assert.equal(bot.dest.x, 24); assert.equal(bot.dest.z, -16); assert.ok(bot.z > -24);
  const record = recorder.finish(); validate(record);
  assert.equal(record.actors[bot.id].source, 'model');
  addRange(record, bot.id, 0, record.duration); assert.deepEqual(dataset(record), []);
  assert.ok(dataset(record, true).length > 0);
});

test('model inputs still obey cooldown, stun, landing validation and visibility', () => {
  const policy = () => [{ event: 'q', data: { x: 0, z: 0 } }, { event: 'q', data: { x: 0, z: 0 } }, { event: 'chase', data: { id: 'human' } }, { event: 'leap', data: { x: 200, z: 200 } }];
  const { match } = game(policy), bot = match.state.players['cpu-player'];
  assert.ok(bot.qCd > 0); assert.equal(bot.target, null); assert.equal(bot.leap, null);
  const x = bot.x, z = bot.z; bot.stun = 1;
  for (let i = 0; i < 10; i++) match.tick();
  assert.equal(bot.x, x); assert.equal(bot.z, z);
});

test('features use only supplied observations and prediction outputs are finite and reproducible', () => {
  const { frames } = game(() => []), state = frames.at(-1), model = fixture();
  const a = Policy.features(state, 'cpu-player', model.init, {}), b = Policy.features(state, 'cpu-player', model.init, {});
  assert.deepEqual(a, b); assert.equal(a.length, Policy.SIZE); assert.ok(a.every(Number.isFinite));
  Policy.validate(model);
  const output = Policy.forward(model, a); assert.equal(output.logits.length, Policy.EVENTS.length);
  const c1 = Policy.controller(model), c2 = Policy.controller(model);
  assert.deepEqual(c1(state), c2(state)); assert.equal(c1(state)[0].event, 'steer');
  const broken = fixture(); broken.weights.hiddenW[0][0] = Infinity; assert.throws(() => Policy.validate(broken));
});

test('illegal actions are masked and unseen targets cannot be selected', () => {
  const { frames } = game(() => []), state = frames.at(-1), me = state.players.find(p => p.slot === 1);
  me.qCd = 5;
  assert.notEqual(Policy.decide(fixture('q'), state, me.id).event, 'q');
  me.stun = 2;
  assert.notEqual(Policy.decide(fixture('steer'), state, me.id).event, 'steer');
  me.stun = 0; state.players[0].vis = false; delete state.players[0].x; delete state.players[0].z;
  state.towers = []; state.robots = []; state.monsters = [];
  assert.notEqual(Policy.decide(fixture('chase'), state, me.id).event, 'chase');
});

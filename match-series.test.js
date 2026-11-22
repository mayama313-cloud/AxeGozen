const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const World = require('./game-world');
const Policy = require('./public/minion-policy');
const { Series, validate } = require('./public/match-series');
function model(event = 'noop') {
  return { format: Policy.VERSION, inputSize: Policy.SIZE, hiddenSize: 1, characters: ['alex'], events: Policy.EVENTS,
    modelName: 'Fixture', rulesVersion: 'minion-v1-collection-1', init: { cfg: World.CFG, map: World.MAP, characters: World.CHARACTERS },
    weights: { hiddenW: [Array(Policy.SIZE).fill(0)], hiddenB: [0], typeW: Policy.EVENTS.map(() => [0]), typeB: Policy.EVENTS.map(e => e === event ? 30 : -30),
      pointW: Array.from({ length: 20 }, () => [0]), pointB: Array(20).fill(.5) } };
}
const entries = () => [{ kind: 'algorithm', character: 'alex', label: 'A' }, { kind: 'algorithm', character: 'mira', label: 'B' }];
function finish(run, winner) {
  const slot = run.current.entryBySlot.indexOf(winner), loser = 1 - slot;
  const towers = Object.values(run.match.state.towers).filter(t => t.slot === loser);
  for (const t of towers.slice(1)) { t.dead = true; t.hp = 0; }
  const tower = towers[0]; tower.hp = 1;
  const p = run.match.state.players[`series-slot-${slot}`];
  Object.assign(p, { x: tower.x - 3, z: tower.z, qCd: 0 });
  run.match.input(p.id, 'q', { x: tower.x, z: tower.z }); run.advance();
}
test('a full algorithm match reaches actual tower destruction without a time cutoff', () => {
  const run = new Series({ firstTo: 1, entries: entries() });
  for (let i = 0; i < 60 && run.status === 'running'; i++) run.advance(1000);
  assert.equal(run.status, 'complete'); assert.equal(run.results.length, 1);
  assert.equal(run.results[0].reason, 'tower-destruction'); assert.ok(run.results[0].seconds > 0);
  assert.equal(run.results[0].stats[1 - run.champion].towers, 0);
  assert.equal(run.summary().winRates[run.champion], 1);
  const ticks = run.current.ticks; run.advance(100); assert.equal(run.current.ticks, ticks);
});
test('first-to results follow participant identity across side swaps and end exactly at the target', () => {
  const run = new Series({ firstTo: 2, entries: entries() });
  finish(run, 0);
  assert.deepEqual(run.wins, [1, 0]); assert.deepEqual(run.current.entryBySlot, [1, 0]);
  assert.equal(run.frame(0).init.slot, 1); assert.equal(run.frame(1).init.slot, 0);
  finish(run, 0);
  assert.equal(run.status, 'complete'); assert.deepEqual(run.wins, [2, 0]);
  assert.deepEqual(run.results.map(r => r.winner), [0, 0]);
});
test('unlimited matches do not become losses or draws at 60 seconds', () => {
  const run = new Series({ firstTo: 1, entries: [0, 1].map(() => ({ kind: 'model', character: 'alex', model: model() })) });
  run.advance(World.TICK * 61);
  assert.equal(run.status, 'running'); assert.equal(run.results.length, 0);
  assert.deepEqual(run.summary().winRates, [null, null]);
});
test('pause, optional time limits, manual draws and stopping never invent a win', () => {
  const run = new Series({ firstTo: 1, timeLimitSeconds: .1, entries: entries() });
  run.pause(); run.advance(100); assert.equal(run.current.ticks, 0);
  run.resume(); run.advance(100);
  assert.equal(run.draws, 1); assert.equal(run.results[0].reason, 'time-limit');
  assert.deepEqual(run.wins, [0, 0]); assert.deepEqual(run.summary().winRates, [null, null]);
  run.pause(); run.draw(); assert.equal(run.status, 'paused'); assert.equal(run.draws, 2);
  assert.equal(run.results[1].reason, 'manual-draw');
  run.stop(); assert.equal(run.status, 'stopped'); assert.equal(run.results.length, 2);
  assert.ok(run.report().unfinished);
});
test('both model controllers use their own slot, perspective and resettable random stream', () => {
  const seen = [[], []], actors = [0, 1].map(slot => {
    const control = Policy.controller(model('steer'), { slot, seed: 123 + slot });
    const wrapper = state => { seen[slot].push(state); return control(state); };
    wrapper.observe = control.observe; wrapper.observeState = control.observeState; wrapper.reset = control.reset;
    return wrapper;
  });
  const game = World.createMatch(false, false, { controllers: actors }), handlers = [];
  for (let i = 0; i < 2; i++) {
    const h = {}; handlers.push(h);
    game.connect({ id: `p${i}`, on(e, fn) { h[e] = fn; }, emit() {}, disconnect() {} });
  }
  handlers.forEach(h => h.selectCharacter({ id: 'alex' })); handlers.forEach(h => h.confirmCharacter());
  for (let i = 0; i < 9; i++) game.tick();
  assert.ok(game.state.players.p0.x > -24); assert.ok(game.state.players.p1.x < 24);
  for (let slot = 0; slot < 2; slot++) {
    const own = seen[slot][0].players.find(p => p.slot === slot), other = seen[slot][0].players.find(p => p.slot !== slot);
    assert.ok(own.inputs); assert.equal(other.inputs, undefined);
  }
});
test('configuration rejects unsupported characters, invalid goals and rule mismatches', () => {
  assert.throws(() => validate({ firstTo: 0, seed: 1, timeLimitSeconds: 0, entries: entries() }));
  const config = { firstTo: 1, seed: 1, timeLimitSeconds: 0, entries: [{ kind: 'model', character: 'mira', model: model() }, entries()[1]] };
  assert.throws(() => validate(config)); config.entries[0].character = 'alex'; config.entries[0].model.rulesVersion = 'other';
  assert.throws(() => validate(config));
});
function worker() {
  const messages = [], callbacks = []; let time = 0;
  const context = vm.createContext({ performance: { now: () => time }, setTimeout(fn) { callbacks.push(fn); return callbacks.length; },
    postMessage: data => messages.push(JSON.parse(JSON.stringify(data))) });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, file === '/game-world.js' ? 'game-world.js' : 'public/' + file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/match-series-worker.js'), 'utf8'), context);
  return { messages, send: data => context.onmessage({ data }), pump() { time += 16; callbacks.shift()?.(); } };
}
test('the worker finishes headless games and can render the selected participant afterwards', () => {
  const w = worker(); w.send({ type: 'start', config: { firstTo: 1, entries: entries(), render: false } });
  for (let i = 0; i < 100 && !w.messages.some(m => m.summary?.status === 'complete'); i++) w.pump();
  const complete = w.messages.find(m => m.summary?.status === 'complete');
  assert.ok(complete); assert.equal(complete.results[0].reason, 'tower-destruction');
  assert.ok(!w.messages.some(m => m.type === 'frame'));
  w.send({ type: 'view', render: true, watch: 1, speed: 4 });
  const frame = w.messages.findLast(m => m.type === 'frame');
  assert.equal(frame.init.slot, 1); assert.equal(frame.state.phase, 'finished');
  assert.equal(frame.state.players.find(p => p.slot === 0).inputs, undefined);
});
test('series sessions block human inputs, relay spectator frames and discard terminated-worker messages', () => {
  const workers = [], context = vm.createContext({ window: {}, Worker: class {
    constructor() { this.posts = []; this.terminated = false; workers.push(this); }
    postMessage(data) { this.posts.push(data); }
    terminate() { this.terminated = true; }
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/session.js'), 'utf8'), context);
  const session = context.window.gameSession; let frames = 0;
  session.on('state', () => frames++);
  session.startSeries({ firstTo: 1, render: false, entries: entries() });
  assert.equal(session.readOnly, true); assert.equal(session.rendering, false);
  session.emit('q', { x: 1, z: 1 }); assert.equal(workers[0].posts.length, 1);
  workers[0].onmessage({ data: { type: 'frame', init: null, state: {} } }); assert.equal(frames, 1);
  session.stop(); assert.equal(workers[0].terminated, true);
  workers[0].onmessage({ data: { type: 'frame', init: null, state: {} } }); assert.equal(frames, 1);
});

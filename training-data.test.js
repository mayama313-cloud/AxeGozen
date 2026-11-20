const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createMatch, TICK } = require('./game-world');
const { Recorder, addRange, dataset, validate } = require('./public/training-data');

function setup(cpu = true) {
  const saved = [], recorder = new Recorder(record => saved.push(record)); recorder.enabled = true;
  const match = createMatch(!cpu, cpu, { trace: e => recorder.consume(e) }), handlers = {};
  const socket = { id: 'human', on(e, fn) { handlers[e] = fn; }, emit() {}, disconnect() {} };
  match.connect(socket); handlers.selectCharacter({ id: 'alex' }); handlers.confirmCharacter();
  return { recorder, match, handlers, saved };
}

test('records immutable pre-input observations, resulting frames, idle ticks and perspective-only data', () => {
  const { recorder, match, handlers } = setup();
  match.state.environment.enabled = false;
  const human = match.state.players.human, bot = match.state.players['cpu-player'];
  Object.assign(bot, { x: 22, z: -12, bush: 4, qCd: 100, eCd: 100, cCd: 100, stun: 20 });
  handlers.move({ x: -24, z: 20, secret: 'not an input' });
  const action = recorder.current.entries.find(e => e.kind === 'action');
  assert.equal(action.observation.players.find(p => p.id === 'human').z, 24);
  assert.equal(action.observation.players.find(p => p.id === bot.id).x, undefined);
  assert.equal(action.data.secret, undefined);
  match.tick(); match.tick();
  const record = recorder.finish(); validate(record);
  assert.equal(record.actors.human.source, 'human'); assert.equal(record.actors[bot.id].source, 'algorithm');
  addRange(record, 'human', 0, record.duration, 'movement');
  const samples = dataset(record);
  assert.equal(samples.length, 2); assert.equal(samples[0].actions[0].event, 'move');
  assert.equal(samples[0].observation.players.find(p => p.id === human.id).z, 24);
  assert.ok(samples[0].nextObservation.players.find(p => p.id === human.id).z < 24);
  assert.equal(samples[1].actions.length, 0); assert.equal(samples[1].truncated, true);
  assert.equal(samples[0].nextObservation.players.find(p => p.id === bot.id).x, undefined);
  assert.equal(samples[0].nextObservation.players.find(p => p.id === bot.id).qCd, undefined);
  assert.equal(action.observation.players.find(p => p.id === human.id).z, 24);
});

test('selection is opt-in, source filters are respected and overlapping ranges do not duplicate ticks', () => {
  const { recorder, match } = setup();
  for (let i = 0; i < TICK; i++) match.tick();
  const record = recorder.finish();
  assert.deepEqual(dataset(record), []);
  addRange(record, 'cpu-player', 0, record.duration);
  assert.deepEqual(dataset(record), []);
  assert.equal(dataset(record, true).length, TICK);
  assert.ok(dataset(record, true).some(s => s.actions.some(a => a.origin === 'derived')));
  addRange(record, 'human', 0, 0.5); addRange(record, 'human', 0.2, 0.6);
  const samples = dataset(record); assert.equal(samples.length, 18);
  assert.equal(new Set(samples.map(s => s.tick)).size, 18);
  assert.equal(samples[0].sequenceStart, true); assert.equal(samples.at(-1).sequenceEnd, true); assert.equal(samples.at(-1).truncated, true);
  assert.throws(() => addRange(record, 'human', -1, 1));
  assert.throws(() => addRange(record, 'human', 0, 10));
  assert.throws(() => addRange(record, 'missing', 0, 0.1));
});

test('restart and stop create separate episodes and preserve complete ending frames', () => {
  const { recorder, match, handlers, saved } = setup(false);
  handlers.move({ x: -24, z: 20 }); match.tick();
  handlers.restart(); assert.equal(saved.length, 1); assert.equal(saved[0].status, 'restart');
  assert.equal(recorder.current.entries[0].tick, 0);
  match.tick();
  const human = match.state.players.human;
  for (const t of Object.values(match.state.towers)) if (t.slot === 1) { t.dead = true; t.hp = 0; }
  const tower = match.state.towers['t1-2']; tower.dead = false; tower.hp = 1;
  Object.assign(human, { x: tower.x - 3, z: tower.z, bush: -1 });
  handlers.q({ x: tower.x, z: tower.z }); match.tick();
  assert.equal(saved.length, 2); assert.equal(saved[1].status, 'finished'); assert.equal(saved[1].winner, 0);
  assert.notEqual(saved[0].id, saved[1].id);
  const record = saved[1]; addRange(record, 'human', 0, record.duration);
  assert.equal(dataset(record).at(-1).terminal, true);
  match.tick(); assert.equal(recorder.current, null); assert.equal(saved.length, 2);
});

test('recording can be disabled and import validation rejects corrupt timelines', () => {
  const recorder = new Recorder(); recorder.consume({ kind: 'frame', time: 1 }); assert.equal(recorder.current, null);
  const fixture = setup(false); fixture.match.tick(); const record = fixture.recorder.finish();
  validate(JSON.parse(JSON.stringify(record)));
  record.entries[0].seq = 9; assert.throws(() => validate(record));
  assert.throws(() => validate({ schema: 'wrong' }));
});

test('event/action sequence numbers retain cue order and invalid requests do not bypass game rules', () => {
  const { recorder, match, handlers } = setup(false);
  const human = match.state.players.human;
  handlers.q({ x: 0, z: 0 }); const cooldown = human.qCd;
  handlers.q({ x: 1, z: 1 }); assert.equal(human.qCd, cooldown);
  match.tick();
  const record = recorder.finish(); addRange(record, 'human', 0, record.duration);
  const sample = dataset(record)[0];
  assert.equal(sample.actions.length, 2);
  assert.equal(sample.actions[0].observation.players[0].qCd, 0);
  assert.ok(sample.actions[1].observation.players[0].qCd > 0);
  const fx = sample.events.find(e => e.event === 'fx');
  assert.ok(sample.actions[0].seq < fx.seq && fx.seq < sample.actions[1].seq);
});

test('recording time limit seals a truncated episode once and reset allows a new episode', () => {
  const { recorder, match, handlers, saved } = setup(false);
  match.tick();
  recorder.consume({ kind: 'frame', time: 1201, tick: 36030, views: {} });
  assert.equal(saved.length, 1); assert.equal(saved[0].status, 'limit'); assert.equal(recorder.capped, true);
  match.tick(); assert.equal(recorder.current, null);
  handlers.restart(); match.tick(); assert.ok(recorder.current); assert.equal(saved.length, 1);
});

test('session replay supports pause, seek, actor switch and prevents live input or recording', () => {
  const { recorder, match, handlers } = setup();
  handlers.move({ x: -24, z: 20 }); for (let i = 0; i < 4; i++) match.tick();
  const record = recorder.finish(), timers = new Map(); let next = 0;
  const context = vm.createContext({ window: {}, ArenaWorld: require('./game-world'),
    setInterval(fn) { timers.set(++next, fn); return next; }, clearInterval(id) { timers.delete(id); } });
  vm.runInContext(fs.readFileSync('public/session.js', 'utf8'), context);
  const session = context.window.gameSession; let state, init;
  session.on('state', s => { state = s; }); session.on('init', d => { init = d; });
  session.playReplay(record, 'human'); assert.equal(session.replaying, true); assert.equal(init.id, 'human');
  session.emit('q', { x: 0, z: 0 }); assert.equal(timers.size, 1);
  const step = [...timers.values()][0]; step(); assert.equal(state.tick, 1);
  session.pauseReplay(true); step(); assert.equal(state.tick, 1);
  session.seekReplay(3 / TICK); assert.equal(state.tick, 3);
  session.pauseReplay(false); step(); assert.equal(state.tick, 4); step();
  session.playReplay(record, 'cpu-player'); assert.equal(init.id, 'cpu-player'); assert.equal(timers.size, 1);
  session.stop(); assert.equal(session.replaying, false); assert.equal(timers.size, 0);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const World = require('./game-world');
const Policy = require('./public/minion-policy');
const Teams = require('./public/team-config');
const Goals = require('./public/minion-objectives');
const { Series } = require('./public/match-series');
const { createMatchmaker } = require('./matchmaking');
const { Recorder, validate: validateReplay } = require('./public/training-data');
function socket(id) {
  const incoming = new EventEmitter();
  return { id, events: {}, on: (event, fn) => incoming.on(event, fn), send: (event, ...data) => incoming.emit(event, ...data),
    emit(event, data) { this.events[event] = data; }, disconnect() { incoming.emit('disconnect'); } };
}
function fixtureModel() {
  return { format: Policy.VERSION, inputSize: Policy.SIZE, hiddenSize: 1, characters: ['alex'], rulesVersion: 'minion-v1-collection-1', events: Policy.EVENTS,
    init: { cfg: World.CFG, map: World.MAP, characters: World.CHARACTERS }, weights: { hiddenW: [Array(Policy.SIZE).fill(0)], hiddenB: [0],
      typeW: Policy.EVENTS.map(() => [0]), typeB: Policy.EVENTS.map(e => e === 'steer' ? 30 : -30), pointW: Array.from({ length: 20 }, () => [0]), pointB: Array(20).fill(.5) } };
}
function local(sizes = [3, 2], trace = null) {
  const game = World.createMatch(false, true, { teamSizes: sizes, trace }), human = socket('human');
  game.connect(human, { team: 0, member: 0 });
  for (let t = 0; t < 2; t++) for (let i = t ? 0 : 1; i < sizes[t]; i++) game.addBot({ team: t, member: i, character: World.CHARACTERS[i % 5].id });
  human.send('selectCharacter', { id: 'alex' }); human.send('confirmCharacter'); return { game, human };
}
test('unequal teams use independent member identities and do not start until all human seats are ready', () => {
  const game = World.createMatch(false, false, { teamSizes: [2, 3] }), a = socket('a'), b = socket('b');
  game.connect(a, { team: 0, member: 0 }); game.connect(b, { team: 0, member: 1 });
  for (let i = 0; i < 3; i++) game.addBot({ team: 1, member: i, character: 'mira' });
  a.send('selectCharacter', { id: 'alex' }); a.send('confirmCharacter'); game.tick();
  assert.equal(a.events.state.phase, 'selecting');
  b.send('selectCharacter', { id: 'bastion' }); b.send('confirmCharacter'); game.tick();
  assert.equal(a.events.state.phase, 'playing'); assert.equal(a.events.state.players.length, 5);
  assert.equal(a.events.state.players.filter(p => p.slot === 0).length, 2);
  assert.deepEqual(a.events.state.teamSizes, [2, 3]);
  assert.notDeepEqual([game.state.players.a.x, game.state.players.a.z], [game.state.players.b.x, game.state.players.b.z]);
  assert.equal(a.events.state.players.find(p => p.id === 'b').inputs, undefined);
});
test('friendly attacks and enemy memory stay team-aware while enemy damage is applied', () => {
  const { game, human } = local(); game.state.environment.enabled = false;
  const p = game.state.players.human, ally = game.state.players['team-cpu-0-1'], enemy = game.state.players['team-cpu-1-0'];
  game.tick(); assert.equal(ally.cpuMemory, null);
  Object.assign(p, { x: 0, z: 0 }); Object.assign(ally, { x: 0, z: 2, hp: 200 }); Object.assign(enemy, { x: 0, z: 3, hp: 200 });
  human.send('q', { x: 0, z: 3 });
  assert.equal(ally.hp, 200); assert.ok(enemy.hp < 200);
  const state = game.observe(p.id), memory = {}; Policy.updateMemory(memory, state, p.id);
  assert.equal(memory.lastSeen.opponent.character, state.players.filter(e => e.slot === 1).at(-1).character);
});
test('five members per side run, respect capacity and spawn at separate safe positions', () => {
  const { game } = local([5, 5]);
  const positions = Object.values(game.state.players).filter(p => p.slot === 0).map(p => `${p.x},${p.z}`);
  assert.equal(new Set(positions).size, 5);
  for (let i = 0; i < 120; i++) game.tick();
  const state = game.observe('human'); assert.equal(state.players.length, 10);
  assert.ok(state.players.every(p => !p.vis || [p.x, p.z, p.hp].every(Number.isFinite)));
  const extra = socket('extra'); assert.equal(game.connect(extra, { team: 0, member: 5 }), false); assert.ok(extra.events.full !== undefined || !game.state.players.extra);
  assert.throws(() => World.createMatch(false, false, { teamSizes: [0, 6] }));
});
test('learned teammates each control their own member and never mistake allies for enemy objectives', () => {
  const game = World.createMatch(false, false, { teamSizes: [2, 1] }), model = fixtureModel();
  for (const [id, member] of [['m0', 0], ['m1', 1]]) game.addBot({ team: 0, member, id, character: 'alex', controller: Teams.controller({ kind: 'model', model }, 0, id, 17 + member) });
  game.addBot({ team: 1, member: 0, character: 'alex' });
  const before = [game.state.players.m0.x, game.state.players.m1.x];
  for (let i = 0; i < 9; i++) game.tick();
  assert.ok(game.state.players.m0.x > before[0]); assert.ok(game.state.players.m1.x > before[1]);
  const state = game.observe('m0'); Object.assign(state.players.find(p => p.id === 'm1'), { x: state.players[0].x + 1, z: state.players[0].z });
  model.objectivePolicy = { camps: [] };
  assert.ok(Goals.candidates(model, state, 'm0', {}).every(g => g.features[23] > .1));
});
test('disconnecting a human in a team match keeps the team slot with an algorithm replacement', () => {
  const game = World.createMatch(false, false, { teamSizes: [2, 1] }), a = socket('a'), b = socket('b');
  game.connect(a, { team: 0, member: 0 }); game.connect(b, { team: 0, member: 1 }); game.addBot({ team: 1, member: 0, character: 'alex' });
  for (const s of [a, b]) { s.send('selectCharacter', { id: 'alex' }); s.send('confirmCharacter'); }
  b.disconnect(); game.tick();
  assert.equal(game.state.players.b.bot, true); assert.equal(a.events.state.phase, 'playing'); assert.equal(game.empty(), false);
  a.disconnect(); assert.equal(game.empty(), true);
});
test('team recordings retain every actor and can still be validated and replayed by perspective', () => {
  const recorder = new Recorder(); recorder.enabled = true;
  const { game } = local([2, 3], e => recorder.consume(e));
  for (let i = 0; i < 15; i++) game.tick();
  const record = recorder.finish('stopped'); validateReplay(record);
  assert.equal(Object.keys(record.actors).length, 5);
  assert.equal(record.entries.find(e => e.kind === 'frame').views.human.players.length, 5);
});
test('asymmetric automatic series aggregate team stats, alternate sides and support member viewpoints', () => {
  const cpu = character => ({ kind: 'algorithm', character });
  const run = new Series({ firstTo: 1, timeLimitSeconds: .1, teams: [[cpu('alex'), { kind: 'model', character: 'alex', model: fixtureModel() }], [cpu('bastion'), cpu('lucia'), cpu('darius')]] });
  assert.equal(run.frame(1, 2).init.member, 2); assert.equal(run.frame(1, 2).state.players.length, 5);
  assert.equal(run.summary().current.stats[0].members.length, 2);
  run.advance(10); assert.deepEqual(run.current.entryBySlot, [1, 0]);
  assert.equal(run.frame(0, 1).init.slot, 1); assert.equal(run.frame(0, 1).init.member, 1);
  assert.equal(run.summary().entries[1].members.length, 3); assert.equal(run.draws, 1);
});
function roomFixture() {
  const maker = createMatchmaker(), clients = [socket('host'), socket('ally'), socket('foe')];
  clients.forEach(s => maker.attach(s));
  const human = { kind: 'human', character: 'alex' }, cpu = { kind: 'algorithm', character: 'mira' };
  clients[0].send('createTeamRoom', { teams: [[human, human, cpu], [human, cpu]] });
  return { maker, clients, code: clients[0].events.teamRoom.code };
}
test('online teammates join the requested side and a room starts a mixed 3 versus 2 game', () => {
  const { maker, clients: [host, ally, foe], code } = roomFixture();
  ally.send('joinTeamRoom', { code, team: 0 }); foe.send('joinTeamRoom', { code, team: 1 });
  assert.deepEqual(ally.events.teamRoom.self, { team: 0, member: 1 });
  for (const c of [host, ally]) c.send('teamRoomReady', { character: 'alex', ready: true });
  assert.equal(host.events.init, undefined);
  foe.send('teamRoomReady', { character: 'lucia', ready: true }); maker.tick();
  assert.equal(host.events.state.phase, 'playing'); assert.equal(host.events.state.players.length, 5);
  assert.equal(ally.events.init.member, 1); assert.equal(foe.events.init.slot, 1);
  ally.disconnect(); maker.tick(); assert.equal(host.events.state.players.find(p => p.id === 'ally').bot, true);
});
test('online host can add/remove CPU seats; other clients cannot edit the roster or replace occupied humans', () => {
  const { clients: [host, ally], code } = roomFixture(); ally.send('joinTeamRoom', { code, team: 0 });
  ally.send('setTeamSeat', { team: 1, member: 2, kind: 'algorithm', character: 'alex' }); assert.ok(ally.events.teamRoomError);
  host.send('setTeamSeat', { team: 1, member: 2, kind: 'algorithm', character: 'darius' }); assert.equal(host.events.teamRoom.teams[1].length, 3);
  host.send('setTeamSeat', { team: 1, member: 2, remove: true }); assert.equal(host.events.teamRoom.teams[1].length, 2);
  host.send('setTeamSeat', { team: 0, member: 1, kind: 'algorithm', character: 'alex' });
  assert.equal(host.events.teamRoom.teams[0][1].kind, 'human'); assert.ok(host.events.teamRoomError);
});
test('online learned CPUs are validated, uploaded separately and not exposed in room snapshots', () => {
  const { clients: [host] } = roomFixture();
  host.send('setTeamSeat', { team: 0, member: 2, kind: 'model', character: 'alex' });
  assert.equal(host.events.teamRoom.teams[0][2].ready, false);
  host.send('setTeamModel', { team: 0, member: 2, model: fixtureModel(), fileName: 'fixture.json' });
  const member = host.events.teamRoom.teams[0][2];
  assert.equal(member.ready, true); assert.equal(member.model.fileName, 'fixture.json'); assert.equal(member.model.weights, undefined);
  assert.equal(member.model.sha256.length, 64);
});

test('removing an empty seat before a human shifts their seat without removing the player', () => {
  const maker = createMatchmaker(), host = socket('host'), ally = socket('ally');
  [host, ally].forEach(s => maker.attach(s));
  host.send('createTeamRoom', { teams: [[{ kind: 'human' }, { kind: 'algorithm' }, { kind: 'human' }], [{ kind: 'algorithm' }]] });
  ally.send('joinTeamRoom', { code: host.events.teamRoom.code, team: 0 });
  assert.equal(ally.events.teamRoom.self.member, 2);
  host.send('setTeamSeat', { team: 0, member: 1, remove: true });
  assert.equal(ally.events.teamRoom.self.member, 1); assert.equal(ally.events.teamRoom.teams[0][1].self, true);
  for (const s of [host, ally]) s.send('teamRoomReady', { character: 'alex', ready: true });
  maker.tick(); assert.equal(ally.events.state.phase, 'playing'); assert.equal(ally.events.state.players.length, 3);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createMatchmaker } = require('./matchmaking');

function client(id) {
  const inbound = new EventEmitter();
  return { id, events: {}, on: (event, fn) => inbound.on(event, fn),
    send: (event, data) => inbound.emit(event, data),
    emit(event, data) { this.events[event] = data; }, disconnect() { inbound.emit('disconnect'); } };
}

test('lobby connections do not join until requested; queued players pair into independent matches', () => {
  const maker = createMatchmaker(), sockets = ['a', 'b', 'c', 'd'].map(client);
  sockets.forEach(s => maker.attach(s)); maker.tick();
  sockets.forEach(s => assert.equal(s.events.init, undefined));
  sockets[0].send('joinQueue'); sockets[0].send('joinQueue'); maker.tick();
  assert.equal(sockets[0].events.init, undefined);
  sockets[1].send('joinQueue'); sockets[2].send('joinQueue'); sockets[3].send('joinQueue'); maker.tick();
  for (const s of sockets) assert.equal(s.events.state.phase, 'selecting');
  assert.deepEqual(sockets[0].events.state.players.map(p => p.id), ['a', 'b']);
  assert.deepEqual(sockets[2].events.state.players.map(p => p.id), ['c', 'd']);
  for (const s of sockets.slice(0, 2)) { s.send('selectCharacter', { id: 'alex' }); s.send('confirmCharacter'); }
  maker.tick(); assert.equal(sockets[0].events.state.phase, 'playing'); assert.equal(sockets[2].events.state.phase, 'selecting');
});

test('disconnect removes queued players and notifies a matched opponent without affecting another match', () => {
  const maker = createMatchmaker(), a = client('a'), b = client('b'), c = client('c');
  for (const s of [a, b, c]) maker.attach(s);
  a.send('joinQueue'); a.disconnect(); b.send('joinQueue'); maker.tick();
  assert.equal(b.events.init, undefined);
  c.send('joinQueue'); maker.tick(); assert.equal(b.events.state.phase, 'selecting');
  c.disconnect(); maker.tick();
  assert.ok(b.events.matchEnded.reason); assert.equal(b.events.state.phase, 'abandoned');
  b.disconnect(); maker.tick();
});

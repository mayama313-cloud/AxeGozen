const test = require('node:test');
const assert = require('node:assert/strict');
const { Competition, validate } = require('./public/competition');
function config(n = 4, extra = {}) {
  return { firstTo: 1, rounds: n - 1, seed: 17, participants: Array.from({ length: n }, (_, i) => ({ label: `Team ${i}`, team: Array.from({ length: i % 3 + 1 }, () => ({ kind: 'algorithm', character: 'alex' })) })), ...extra };
}
function win(c, side = 0) {
  const s = c.series, slot = s.current.entryBySlot[side];
  const towers = Object.values(s.match.state.towers).filter(t => t.slot !== slot);
  for (const tower of towers.slice(1)) { tower.dead = true; tower.hp = 0; }
  const tower = towers[0], player = s.match.state.players[`series-slot-${slot}`]; tower.hp = 1;
  Object.assign(player, { x: tower.x - 3, z: tower.z, qCd: 0 });
  s.match.input(player.id, 'q', { x: tower.x, z: tower.z });
  c.advance();
}
test('Swiss validates team counts, round counts, first-to and rosters', () => {
  for (const c of [config(1), config(17), config(4, { rounds: 4 }), config(4, { firstTo: 0 }), config(4, { rounds: 0 })]) assert.throws(() => validate(c));
  const c = config(); c.participants[0].team[0].kind = 'human'; assert.throws(() => validate(c));
});
test('Swiss plays independent asymmetric teams, records wins and advances rounds', () => {
  const c = new Competition(config(4, { rounds: 2 }));
  const participants = c.pairing.teams;
  assert.deepEqual(c.series.teams.map(t => t.length), participants.map(id => id % 3 + 1));
  win(c); assert.equal(c.rounds[0].pairings[0].winner, participants[0]);
  win(c); assert.equal(c.rounds.length, 2);
  assert.equal(c.standings().filter(p => p.points === 1).length, 2);
  while (c.status === 'running') win(c);
  assert.equal(c.status, 'complete'); assert.equal(c.results.length, 4);
  assert.equal(c.standings()[0].points, 2); assert.equal(c.report().unfinished, null);
  assert.ok(c.report().competition.participants.every(p => p.members.length > 0));
  assert.equal(c.report().seed, 17); assert.equal(c.report().competition.games, 4);
});
test('odd Swiss assigns one bye per round fairly and avoids repeat opponents', () => {
  const c = new Competition(config(5));
  while (c.status === 'running') c.draw();
  const byes = c.rounds.flatMap(r => r.pairings.filter(p => p.bye));
  assert.equal(byes.length, 4); assert.equal(new Set(byes.map(p => p.winner)).size, 4);
  const pairs = c.rounds.flatMap(r => r.pairings.filter(p => !p.bye).map(p => [...p.teams].sort().join(':')));
  assert.equal(new Set(pairs).size, pairs.length);
  assert.equal(c.results.length, 8); assert.equal(c.standings().reduce((n, p) => n + p.points, 0), 12);
});
test('draw cap completes a Swiss pairing even when no player reaches first-to', () => {
  const c = new Competition(config(2, { firstTo: 2 }));
  c.draw(); c.draw(); assert.equal(c.status, 'running'); c.draw();
  assert.equal(c.status, 'complete'); assert.equal(c.pairing.winner, null);
  assert.deepEqual(c.standings().map(p => p.points), [.5, .5]);
});
test('Swiss caps tied series with game advantage and includes draws in game history', () => {
  const c = new Competition(config(2, { firstTo: 2 }));
  const id = c.pairing.teams[0]; win(c); c.draw(); c.draw();
  assert.equal(c.status, 'complete'); assert.equal(c.pairing.winner, id);
  assert.equal(c.standings()[0].gameDifference, 1); assert.equal(c.results.length, 3);
});
test('pause, draw, resume, render viewpoint tokens and stop preserve tournament state', () => {
  const c = new Competition(config(4)); const token = c.frame(0).token;
  c.pause(); c.advance(300); assert.equal(c.series.current.ticks, 0);
  c.draw(); assert.equal(c.status, 'paused'); assert.equal(c.series.status, 'paused'); assert.notEqual(c.frame(0).token, token);
  c.resume(); c.advance(); assert.equal(c.series.current.ticks, 1);
  c.captureEvents = true; c.visualEvents = []; assert.equal(c.series.captureEvents, true);
  c.stop(); assert.equal(c.status, 'stopped'); assert.equal(c.results.length, 1);
  assert.ok(c.report().unfinished); assert.ok(c.endedAt);
});
test('seeded pairings and tiebreak ordering are reproducible', () => {
  const a = new Competition(config(8)), b = new Competition(config(8));
  while (a.status === 'running') a.draw(); while (b.status === 'running') b.draw();
  assert.deepEqual(a.rounds, b.rounds); assert.deepEqual(a.standings(), b.standings());
  for (const p of a.standings()) assert.equal(p.buchholz, p.opponents.reduce((sum, id) => sum + a.standings().find(r => r.id === id).points, 0));
});
test('time-limited games cannot cause an endless Swiss pairing', () => {
  const c = new Competition(config(2, { timeLimitSeconds: .1 })); c.advance(30);
  assert.equal(c.status, 'complete'); assert.equal(c.results[0].reason, 'time-limit');
});

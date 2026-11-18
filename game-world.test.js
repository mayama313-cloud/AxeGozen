const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMatch, CFG, MAP, TICK } = require('./game-world');

function socket(id) {
  return {
    id, handlers: {}, events: {},
    on(event, fn) { this.handlers[event] = fn; },
    emit(event, data) { this.events[event] = data; },
    send(event, data) { this.handlers[event](data); },
    disconnect() { this.closed = true; },
  };
}
function setup(solo = false) {
  const match = createMatch(solo), a = socket('a'), b = socket('b');
  match.connect(a);
  if (!solo) match.connect(b);
  const { players, towers, robots } = match.state;
  // 各テストで必要なタワーだけ反撃させる。
  for (const t of Object.values(towers)) t.atkCd = 10000;
  return { match, a, b, p: players.a, q: players.b, towers, robots };
}
const ticks = (match, n) => { for (let i = 0; i < n; i++) match.tick(); };
const aim = e => ({ x: e.x, z: e.z });
function place(e, x, z) { Object.assign(e, { x, z, dest: null, target: null, bush: -1 }); }

test('five symmetric towers per spawn, all outside safe zones and map walls', () => {
  const { towers } = setup();
  for (let i = 0; i < 5; i++) {
    const a = towers[`t0-${i}`], b = towers[`t1-${i}`];
    assert.ok(Math.abs(a.x + b.x) < 1e-10 && Math.abs(a.z + b.z) < 1e-10);
    assert.ok(Math.abs(a.x) + a.radius < MAP.half && Math.abs(a.z) + a.radius < MAP.half);
    assert.ok(Math.hypot(a.x - MAP.spawns[0].x, a.z - MAP.spawns[0].z) > CFG.safeRadius + a.radius);
  }
  assert.equal(Object.keys(towers).length, 10);
});

test('own safe zone blocks Q, automatic attacks, robot attacks and tower damage; rapidly heals', () => {
  const { match, a, b, p, q, towers, robots } = setup();
  place(p, -21, 24); p.hp = 50;
  place(q, -18.9, 24);
  b.send('q', aim(p));
  assert.equal(p.hp, 50);
  b.send('chase', { id: p.id });
  assert.equal(q.target, null);
  robots.enemy = { id: 'enemy', owner: q.id, slot: q.slot, radius: CFG.robot.radius, hp: 40, life: 20,
    x: -19.3, z: 24, face: 0, atkCd: 0, target: p.id, moving: false, bush: -1 };
  towers['t1-0'].x = -19; towers['t1-0'].z = 24; towers['t1-0'].atkCd = 0;
  ticks(match, TICK);
  assert.ok(Math.abs(p.hp - 130) < 1e-8);
  ticks(match, TICK);
  assert.equal(p.hp, CFG.maxHp);
});

test('walking and dashing cannot enter enemy safe zone for either player', () => {
  for (const slot of [0, 1]) {
    const { match, a, b, p, q } = setup();
    const e = slot ? q : p, sock = slot ? b : a, s = MAP.spawns[1 - slot];
    place(e, s.x, s.z + (slot ? -5 : 5));
    sock.send('move', s);
    ticks(match, TICK);
    assert.ok(Math.hypot(e.x - s.x, e.z - s.z) >= CFG.safeRadius + e.radius);
    sock.send('dash', s);
    ticks(match, 8);
    assert.ok(Math.hypot(e.x - s.x, e.z - s.z) >= CFG.safeRadius + e.radius);
    sock.send('c');
    for (const r of Object.values(match.state.robots)) {
      assert.ok(Math.hypot(r.x - s.x, r.z - s.z) >= CFG.safeRadius + r.radius);
    }
  }
});

test('summoned C unit acquires and damages an enemy tower without a player target', () => {
  const { match, a, p, towers, robots } = setup(true);
  const t = towers['t1-2'];
  place(p, t.x - 4, t.z + 4); p.face = Math.atan2(t.x - p.x, t.z - p.z);
  a.send('c');
  assert.equal(Object.keys(robots).length, 3);
  ticks(match, TICK * 2);
  assert.ok(t.hp < CFG.tower.hp);
  assert.equal(Object.values(robots)[0].target, t.id);
});

test('player right-click and Q damage towers; last destroyed tower ends match and freezes combat', () => {
  const { match, a, b, p, towers } = setup();
  const t = towers['t1-2'];
  place(p, t.x - 2.5, t.z);
  a.send('chase', { id: t.id }); match.tick();
  assert.equal(t.hp, CFG.tower.hp - CFG.atkDmg);
  for (const tower of Object.values(towers).filter(t => t.slot === 1 && t.id !== 't1-2')) {
    place(p, tower.x, tower.z + 3); p.qCd = 0; tower.hp = CFG.qDmg;
    a.send('q', aim(tower));
    assert.equal(tower.dead, true);
    match.tick(); assert.equal(a.events.state.winner, null);
  }
  place(p, t.x - 3, t.z); p.qCd = 0; t.hp = CFG.qDmg;
  a.send('q', aim(t)); match.tick();
  assert.equal(a.events.state.winner, 0);
  assert.equal(b.events.state.winner, 0);
  assert.equal(a.events.state.phase, 'finished');
  const pos = aim(p), hp = p.hp;
  a.send('move', { x: 0, z: 0 }); a.send('c'); ticks(match, TICK);
  assert.deepEqual(aim(p), pos); assert.equal(p.hp, hp);
});

test('respawn is five seconds plus five per own destroyed tower, including destruction while dead', () => {
  const { match, a, b, p, q, towers } = setup();
  place(p, 0, 0); place(q, 1, 0); p.hp = CFG.qDmg;
  b.send('q', aim(p));
  assert.equal(p.dead, true); assert.equal(p.respawn, 5);
  const t = towers['t0-2'];
  place(q, t.x + 3, t.z); q.qCd = 0; t.hp = CFG.qDmg;
  b.send('q', aim(t));
  assert.equal(p.respawn, 10);
  ticks(match, TICK * 9); assert.equal(p.dead, true);
  ticks(match, TICK + 1); assert.equal(p.dead, false); assert.equal(p.hp, CFG.maxHp);
  assert.deepEqual(aim(p), MAP.spawns[0]);
  place(p, 0, 0); place(q, 1, 0); p.hp = CFG.qDmg; q.qCd = 0;
  b.send('q', aim(p)); assert.equal(p.respawn, 10);
  // 敵タワーの破壊数は自分の復活時間に加算されない。
  const enemy = towers['t1-2'];
  place(q, 0, 0); q.hp = CFG.qDmg; place(p, 1, 0); p.dead = false; p.qCd = 0;
  enemy.dead = true;
  a.send('q', aim(q)); assert.equal(q.respawn, 10);
});

test('tower retaliates against enemies, not its owner', () => {
  const { match, p, q, towers } = setup();
  const t = towers['t1-2'];
  place(p, t.x - 3, t.z); place(q, t.x + 2, t.z); t.atkCd = 0;
  match.tick();
  assert.equal(p.hp, CFG.maxHp - CFG.tower.dmg);
  assert.equal(q.hp, CFG.maxHp);
});

test('each side uses its own tower losses for every playable respawn penalty', () => {
  for (const slot of [0, 1]) for (let count = 0; count < 5; count++) {
    const { match, a, b, p, q, towers } = setup();
    const victim = slot ? q : p, attacker = slot ? p : q, sock = slot ? a : b;
    for (const t of Object.values(towers)) {
      if (t.slot === slot && Number(t.id.split('-')[1]) < count) { t.dead = true; t.hp = 0; }
    }
    place(victim, 0, 0); place(attacker, 1, 0); victim.hp = CFG.qDmg;
    sock.send('q', aim(victim));
    assert.equal(victim.respawn, 5 + count * 5);
    match.tick();
    assert.equal(sock.events.state.winner, null);
  }
});

test('online waits for two players; solo is isolated, starts immediately and restarts', () => {
  const online = createMatch(), a = socket('a'); online.connect(a);
  a.send('move', { x: 0, z: 0 }); online.tick();
  assert.equal(a.events.state.phase, 'waiting');
  assert.deepEqual(aim(online.state.players.a), MAP.spawns[0]);
  const { match, a: soloSocket, p, towers } = setup(true);
  soloSocket.send('move', { x: -24, z: 20 }); ticks(match, 5);
  assert.notEqual(p.z, MAP.spawns[0].z); assert.equal(soloSocket.events.state.phase, 'playing');
  towers['t1-0'].hp = 1;
  assert.equal(online.state.towers['t1-0'].hp, CFG.tower.hp);
  soloSocket.send('restart'); match.tick();
  assert.equal(towers['t1-0'].hp, CFG.tower.hp); assert.deepEqual(aim(p), MAP.spawns[0]);
  const b = socket('b'); online.connect(b); online.tick();
  assert.equal(a.events.state.phase, 'playing');
  const c = socket('c'); assert.equal(online.connect(c), false); assert.equal(c.closed, true);
  b.send('disconnect'); online.tick(); assert.equal(a.events.state.phase, 'waiting');
});

test('central crossroads are free of bushes, and invalid input is ignored', () => {
  for (const b of MAP.bushes) assert.ok(Math.hypot(b.x, b.z) - b.r > 12);
  const { match, a, p } = setup(true);
  a.send('move', { x: NaN, z: 0 }); a.send('q', { x: Infinity, z: 0 }); a.send('dash', null);
  match.tick(); assert.deepEqual(aim(p), MAP.spawns[0]); assert.equal(p.qCd, 0); assert.equal(p.eCd, 0);
});

test('keyboard movement normalizes diagonals, stops on release and times out without fresh input', () => {
  const { match, a, p } = setup(true);
  place(p, 0, 0);
  a.send('steer', { x: 1, z: 1 }); match.tick();
  assert.ok(Math.abs(Math.hypot(p.x, p.z) - CFG.speed / TICK) < 1e-9);
  a.send('steer', { x: 0, z: 0 });
  const stopped = aim(p); ticks(match, 5); assert.deepEqual(aim(p), stopped);
  a.send('steer', { x: 1, z: 0 }); ticks(match, TICK);
  const expired = aim(p); match.tick(); assert.deepEqual(aim(p), expired);
  a.send('steer', { x: Infinity, z: 0 });
  a.send('steer', { x: 2, z: 0 }); match.tick(); assert.deepEqual(aim(p), expired);
});

test('keyboard movement preserves in-range automatic attacks and cannot enter enemy safe zones', () => {
  const { match, a, p, q } = setup();
  place(p, 0, 0); place(q, 1, 0);
  a.send('chase', { id: q.id }); a.send('steer', { x: 0, z: 1 }); match.tick();
  assert.ok(p.z > 0); assert.equal(q.hp, CFG.maxHp - CFG.atkDmg);
  for (const slot of [0, 1]) {
    const victim = match.state.players[slot ? 'b' : 'a'], s = MAP.spawns[1 - slot];
    const sock = slot ? q.socket : a;
    place(victim, s.x, s.z + (slot ? -5 : 5));
    for (let i = 0; i < 20; i++) { sock.send('steer', { x: 0, z: slot ? 1 : -1 }); match.tick(); }
    assert.ok(Math.hypot(victim.x - s.x, victim.z - s.z) >= CFG.safeRadius + victim.radius);
  }
});

test('B recalls each player after exactly five seconds, preserving HP and skill cooldowns', () => {
  for (const slot of [0, 1]) {
    const { match, a, b, p, q } = setup();
    const e = slot ? q : p, sock = slot ? b : a;
    place(e, 0, 0); e.hp = 40; e.cCd = 8;
    sock.send('recall'); ticks(match, TICK * 5 - 1);
    assert.deepEqual(aim(e), { x: 0, z: 0 }); assert.ok(e.recall > 0);
    match.tick();
    assert.deepEqual(aim(e), MAP.spawns[slot]); assert.equal(e.recall, 0);
    assert.ok(e.hp < CFG.maxHp); assert.ok(e.cCd > 2.9);
  }
});

test('recall cancels on movement, attacks, skills, damage and another B press', () => {
  for (const event of ['move', 'steer', 'chase', 'q', 'dash', 'c', 'recall', 'damage']) {
    const { match, a, b, p, q } = setup();
    place(p, 0, 0); place(q, 1, 0);
    a.send('recall'); ticks(match, 3); assert.ok(p.recall > 0);
    if (event === 'damage') { b.send('chase', { id: p.id }); match.tick(); }
    else a.send(event, event === 'chase' ? { id: q.id } : { x: 1, z: 0 });
    assert.equal(p.recall, 0, event);
  }
});

test('C summons three at once, fills only remaining capacity and caps each owner at five', () => {
  const { a, b, p, q, robots } = setup();
  a.send('c'); assert.equal(Object.keys(robots).length, 3);
  a.send('c'); assert.equal(Object.keys(robots).length, 3);
  p.cCd = 0; a.send('c'); assert.equal(Object.keys(robots).length, 5);
  p.cCd = 0; a.send('c'); assert.equal(Object.keys(robots).length, 5); assert.equal(p.cCd, 0);
  b.send('c'); assert.equal(Object.values(robots).filter(r => r.owner === q.id).length, 3);
  delete robots[Object.values(robots).find(r => r.owner === p.id).id];
  a.send('c'); assert.equal(Object.values(robots).filter(r => r.owner === p.id).length, 5);
});

test('Q stuns for 0.3 seconds, interrupts dash and recall, and blocks all actions until recovery', () => {
  const { match, a, b, p, q, robots } = setup();
  place(p, 0, 0); place(q, 1, 0);
  q.dashT = 0.1; q.recall = 3; q.keys = { x: 1, z: 0 }; q.inputT = 1;
  a.send('q', aim(q));
  assert.equal(q.hp, CFG.maxHp - CFG.qDmg); assert.equal(q.stun, 0.3);
  assert.equal(q.dashT, 0); assert.equal(q.recall, 0); assert.equal(q.keys, null);
  for (const event of ['move', 'steer', 'chase', 'q', 'dash', 'c', 'recall']) {
    b.send(event, event === 'chase' ? { id: p.id } : { x: 1, z: 0 });
  }
  assert.equal(q.dest, null); assert.equal(q.target, null); assert.equal(q.qCd, 0);
  assert.equal(q.eCd, 0); assert.equal(q.cCd, 0); assert.equal(q.recall, 0);
  assert.equal(Object.keys(robots).length, 0);
  const pos = aim(q); ticks(match, 8); assert.deepEqual(aim(q), pos); assert.ok(q.stun > 0);
  match.tick(); assert.equal(q.stun, 0); assert.deepEqual(aim(q), pos);
  b.send('steer', { x: 1, z: 0 }); match.tick(); assert.ok(q.x > pos.x);
});

test('Q stuns robots but not towers, missed enemies or enemies inside their safe zone', () => {
  const { match, a, b, p, q, robots, towers } = setup();
  place(p, 0, 0); place(q, 1, 0); b.send('c');
  const r = Object.values(robots)[0]; place(r, 1, 0); r.target = p.id;
  place(q, -6, 0);
  a.send('q', aim(r));
  assert.equal(r.stun, 0.3); assert.equal(q.stun, 0);
  const pos = aim(r); ticks(match, 9); assert.deepEqual(aim(r), pos); assert.equal(r.stun, 0);
  const t = towers['t1-2']; place(p, t.x - 3, t.z); p.qCd = 0;
  a.send('q', aim(t)); assert.equal(t.stun, undefined); assert.ok(t.hp < CFG.tower.hp);
  place(q, MAP.spawns[1].x, MAP.spawns[1].z);
  place(p, q.x - 4.8, q.z); p.qCd = 0; a.send('q', aim(q));
  assert.equal(q.stun, 0); assert.equal(q.hp, CFG.maxHp);
});

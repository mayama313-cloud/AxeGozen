const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMatch, CFG, MAP, TICK, CHARACTERS, configFor } = require('./game-world');

function socket(id) {
  return {
    id, handlers: {}, events: {}, killEvents: [],
    on(event, fn) { this.handlers[event] = fn; },
    emit(event, data) { this.events[event] = data; if (event === 'kill') this.killEvents.push(data); },
    send(event, data) { this.handlers[event](data); },
    disconnect() { this.closed = true; },
  };
}
function setup(solo = false, characters = ['alex', 'alex']) {
  const match = createMatch(solo), a = socket('a'), b = socket('b');
  match.connect(a);
  if (!solo) match.connect(b);
  a.send('selectCharacter', { id: characters[0] }); a.send('confirmCharacter');
  if (!solo) { b.send('selectCharacter', { id: characters[1] }); b.send('confirmCharacter'); }
  const { players, towers, robots } = match.state;
  match.state.environment.enabled = false;
  // 各テストで必要なタワーだけ反撃させる。
  for (const t of Object.values(towers)) t.atkCd = 10000;
  return { match, a, b, p: players.a, q: players.b, towers, robots };
}
const ticks = (match, n) => { for (let i = 0; i < n; i++) match.tick(); };
const aim = e => ({ x: e.x, z: e.z });
function place(e, x, z) { Object.assign(e, { x, z, dest: null, target: null, bush: -1 }); }

test('Alex and Lucia can land in a gap exactly one body wide, but reject overlapping destinations', () => {
  for (const character of ['alex', 'lucia']) {
    const { match, a, p, towers } = setup(true, [character]);
    place(p, 0, 0);
    place(towers['t1-0'], 4, 1.8); place(towers['t1-1'], 4, -1.8);
    if (character === 'alex') a.send('dash');
    const event = character === 'alex' ? 'leap' : 'dash';
    a.send(event, { x: 4, z: 0.01 });
    assert.equal(p.eCd, 0);
    assert.equal(p.warp, null); assert.equal(p.leap, null);
    a.send(event, { x: 4, z: 0 });
    assert.ok(p.eCd > 0);
    ticks(match, character === 'alex' ? 14 : 30);
    assert.ok(Math.abs(p.x - 4) < 1e-8 && Math.abs(p.z) < 1e-8);
  }
});

test('landing beyond a rock is allowed when the body fits even if the landing AoE overlaps it', () => {
  for (const character of ['alex', 'lucia']) {
    const { match, a, p } = setup(true, [character]);
    place(p, -8, -3.5);
    if (character === 'alex') a.send('dash');
    a.send(character === 'alex' ? 'leap' : 'dash', { x: -8, z: 3.5 });
    assert.ok(p.eCd > 0);
    ticks(match, character === 'alex' ? 14 : 30);
    assert.deepEqual(aim(p), { x: -8, z: 3.5 });
  }
});

test('Lucia warp checks the safe zone at the destination rather than along a nonexistent travel path', () => {
  const { match, a, p } = setup(true, ['lucia']);
  place(p, 20, -19.5); a.send('dash', { x: 28, z: -19.5 });
  assert.ok(p.warp); ticks(match, 30);
  assert.deepEqual(aim(p), { x: 28, z: -19.5 });
});

test('five Alex minions attack a large monster from outside its body without overlapping', () => {
  const { match, a, p, robots } = setup(true);
  place(p, 0, 7);
  a.send('c', { x: 0, z: 3 }); p.cCd = 0;
  a.send('c', { x: 0, z: 3 });
  place(p, MAP.spawns[0].x, MAP.spawns[0].z);
  const monster = match.state.monsters['monster-0'] = {
    id: 'monster-0', monster: true, large: true, slot: 2, x: 0, z: 3,
    radius: 1.5, maxHp: 10000, hp: 10000, face: 0, atkCd: 0,
    stun: 0, dead: false, moving: false, bush: -1,
  };
  ticks(match, TICK * 3);
  assert.equal(Object.keys(robots).length, 5);
  assert.ok(monster.hp < 10000, 'minions must damage the monster instead of searching for a point inside its body');
  for (const minion of Object.values(robots)) {
    assert.equal(minion.target, monster.id);
    assert.ok(Math.hypot(minion.x - monster.x, minion.z - monster.z) >= minion.radius + monster.radius);
  }
  assertAlexSeparated(match);
});

test('Alex minions wait before retrying an unreachable route and can recover when it opens', () => {
  const { match, a, p, robots, towers } = setup(true);
  const tower = towers['t1-2'];
  // Place the target inside a solid rock: no attack position is reachable.
  for (const t of Object.values(towers)) t.dead = t !== tower;
  place(tower, -20, 0); place(p, -20, 6);
  a.send('c', { x: -20, z: 0 });
  const minion = Object.values(robots)[0];
  for (const other of Object.values(robots).slice(1)) delete robots[other.id];
  place(minion, -20, 5); place(p, MAP.spawns[0].x, MAP.spawns[0].z);
  match.tick();
  const failedPath = minion.path;
  assert.deepEqual(failedPath, []);
  ticks(match, 8);
  assert.equal(minion.path, failedPath, 'failed searches must not repeat every frame');
  assert.ok(minion.pathAge > 0.2);
  place(tower, -20, 10);
  ticks(match, TICK * 2);
  assert.ok(tower.hp < CFG.tower.hp, 'a failed search must not prevent later movement and attacks');
});

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
    sock.send('leap', s);
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
  assert.equal(t.hp, CFG.tower.hp - CFG.atkDmg * 2);
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

test('respawn is five seconds plus five per own destroyed tower, fixed at death even when a tower is destroyed during countdown', () => {
  const { match, a, b, p, q, towers } = setup();
  place(p, 0, 0); place(q, 1, 0); p.hp = CFG.qDmg;
  b.send('q', aim(p));
  assert.equal(p.dead, true); assert.equal(p.respawn, 5);
  ticks(match, TICK * 2);
  const remaining = p.respawn;
  const t = towers['t0-2'];
  place(q, t.x + 3, t.z); q.qCd = 0; t.hp = CFG.qDmg;
  b.send('q', aim(t));
  assert.equal(p.respawn, remaining);
  ticks(match, TICK * 2); assert.equal(p.dead, true);
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

test('online waits for two players and character confirmation; solo is isolated and restarts', () => {
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
  assert.equal(a.events.state.phase, 'selecting');
  a.send('selectCharacter', { id: 'alex' }); a.send('confirmCharacter');
  b.send('selectCharacter', { id: 'alex' }); b.send('confirmCharacter'); online.tick();
  assert.equal(a.events.state.phase, 'playing');
  const c = socket('c'); assert.equal(online.connect(c), false); assert.equal(c.closed, true);
  b.send('disconnect'); online.tick(); assert.equal(a.events.state.phase, 'abandoned');
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
  const r = Object.values(robots)[0]; place(r, 1.5, 0); r.target = p.id;
  r.hp = 80;
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

test('character selection freezes gameplay and requires both valid selections to be confirmed', () => {
  const match = createMatch(), a = socket('a'), b = socket('b');
  match.connect(a); match.connect(b);
  a.send('selectCharacter', { id: 'unknown' }); a.send('confirmCharacter');
  a.send('move', { x: 0, z: 0 }); a.send('c'); match.tick();
  assert.equal(a.events.state.phase, 'selecting');
  assert.equal(match.state.players.a.character, null); assert.equal(Object.keys(match.state.robots).length, 0);
  a.send('selectCharacter', { id: 'mira' }); a.send('confirmCharacter');
  a.send('selectCharacter', { id: 'alex' });
  ticks(match, 10); assert.equal(a.events.state.phase, 'selecting');
  assert.equal(match.state.players.a.character, 'mira');
  b.send('selectCharacter', { id: 'bastion' }); b.send('confirmCharacter'); match.tick();
  assert.equal(a.events.state.phase, 'playing'); assert.equal(match.state.players.b.hp, 280);
  a.send('selectCharacter', { id: 'alex' }); assert.equal(match.state.players.a.character, 'mira');
});

test('Alex doubles Q and normal damage against towers and summoned units, never against players', () => {
  const { match, a, p, q, towers, robots } = setup();
  const tower = towers['t1-2'];
  place(p, tower.x - 3, tower.z); a.send('q', aim(tower));
  assert.equal(tower.hp, CFG.tower.hp - 46);
  assert.equal(a.events.fx.boosted, true); assert.equal(a.events.hit.dmg, 46); assert.equal(a.events.hit.boosted, true);
  robots.target = { id: 'target', slot: 1, owner: q.id, x: 1, z: 0, radius: 0.4, hp: 100, maxHp: 100, life: 20, face: 0, atkCd: 100, bush: -1, stun: 0 };
  place(p, 0, 0); p.qCd = 0; place(q, -6, 0);
  a.send('q', { x: 1, z: 0 }); assert.equal(robots.target.hp, 54);
  p.atkCd = 0; a.send('chase', { id: 'target' }); match.tick(); assert.equal(robots.target.hp, 34);
  delete robots.target;
  place(q, 1, 0); p.qCd = 0; a.send('q', aim(q));
  assert.equal(q.hp, CFG.maxHp - 23);
  assert.equal(a.events.hit.boosted, false);
});

test('Alex summoned units inherit the passive exactly once, with red effect metadata only for affected targets', () => {
  const { match, a, p, q, robots, towers } = setup();
  a.send('c');
  const r = Object.values(robots)[0];
  for (const other of Object.values(robots).slice(1)) delete robots[other.id];
  const tower = towers['t1-2']; place(r, tower.x - 2, tower.z); place(p, tower.x - 5, tower.z);
  match.tick();
  assert.equal(tower.hp, CFG.tower.hp - 10);
  assert.equal(a.events.fx.id, r.id); assert.equal(a.events.fx.boosted, true);
  assert.equal(a.events.hit.dmg, 10);
  place(r, 0, 0); place(q, 1, 0); r.atkCd = 0; r.target = q.id; match.tick();
  assert.equal(q.hp, CFG.maxHp - 5); assert.equal(a.events.fx.boosted, false);
});

test('each additional character has active skills and a working passive', () => {
  for (const c of CHARACTERS) for (const key of ['q', 'e', 'c']) assert.ok(c.skills[key].name && c.skills[key].text);
  for (const id of ['mira', 'bastion']) {
    const match = createMatch(true), a = socket('a'); match.connect(a);
    a.send('selectCharacter', { id }); a.send('confirmCharacter');
    const p = match.state.players.a, cfg = configFor(id);
    assert.equal(p.hp, cfg.maxHp);
    place(p, 0, 0); a.send('steer', { x: 1, z: 0 }); match.tick();
    assert.ok(Math.abs(p.x - cfg.speed / TICK) < 1e-9);
    a.send('c', { x: 5, z: 0 });
    assert.equal(Object.keys(match.state.robots).length, id === 'mira' ? 0 : 3);
    if (id === 'mira') assert.equal(Object.keys(match.state.projectiles).length, 1);
    for (const r of Object.values(match.state.robots)) { assert.equal(r.hp, cfg.robot.hp); assert.equal(r.cfg.dmg, cfg.robot.dmg); }
    a.send('q', { x: 5, z: 0 }); assert.equal(p.qCd, cfg.qCd);
    a.send('dash', { x: 5, z: 0 }); assert.equal(p.eCd, cfg.eCd);
    if (id === 'bastion') { assert.equal(p.shield, 2); assert.equal(p.dashT, 0); }
    else { assert.equal(p.speedBoost, 3); assert.equal(p.dashT, 0); }
  }
});

test('Bastion guard halves incoming damage for two seconds and expires', () => {
  const match = createMatch(), a = socket('a'), b = socket('b'); match.connect(a); match.connect(b);
  a.send('selectCharacter', { id: 'alex' }); a.send('confirmCharacter');
  b.send('selectCharacter', { id: 'bastion' }); b.send('confirmCharacter');
  match.state.environment.enabled = false;
  const p = match.state.players.a, q = match.state.players.b;
  place(p, 0, 0); place(q, 1, 0);
  b.send('dash', aim(p)); a.send('q', aim(q)); assert.equal(q.hp, 280 - 11.5);
  ticks(match, TICK * 2 + 1); assert.equal(q.shield, 0);
  p.qCd = 0; a.send('q', aim(q)); assert.equal(q.hp, 280 - 11.5 - 23);
});

function assertAlexSeparated(match) {
  const live = [...Object.values(match.state.players), ...Object.values(match.state.robots)].filter(e => !e.dead);
  for (const a of live.filter(e => e.owner !== undefined && e.character === 'alex')) for (const b of live) {
    if (a === b) continue;
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= a.radius + b.radius - 0.0001, `${a.id} overlaps ${b.id}`);
  }
}

test('Alex minions do not overlap at summoning, when refilling to five, or while marching', () => {
  const { match, a, p } = setup(true);
  a.send('c'); p.cCd = 0; a.send('c');
  assert.equal(Object.keys(match.state.robots).length, 5); assertAlexSeparated(match);
  for (let i = 0; i < TICK * 12; i++) { match.tick(); assertAlexSeparated(match); }
});

test('Alex minions march from either spawn around friendly towers to attack enemy towers even while their owner is dead', () => {
  for (const slot of [0, 1]) {
    const { match, a, b, p, q, robots, towers } = setup();
    const owner = slot ? q : p, sock = slot ? b : a;
    sock.send('c'); owner.dead = true; owner.respawn = 100;
    for (let i = 0; i < TICK * 14; i++) { match.tick(); assertAlexSeparated(match); }
    assert.ok(Object.values(towers).some(t => t.slot !== slot && t.hp < CFG.tower.hp), `slot ${slot} never reached a tower: ${JSON.stringify(Object.values(robots).map(r => ({ x: r.x, z: r.z, goal: r.objective })))}`);
    for (const r of Object.values(robots)) assert.ok(Math.hypot(r.x - MAP.spawns[slot].x, r.z - MAP.spawns[slot].z) > 40);
  }
});

test('Alex minions fight encountered enemies and then resume marching, choosing a new tower after destruction', () => {
  const { match, a, p, q, robots, towers } = setup();
  a.send('c'); const r = Object.values(robots)[0];
  for (const other of Object.values(robots).slice(1)) delete robots[other.id];
  place(r, 0, 0); place(p, -24, 24); place(q, 1.5, 0);
  q.hp = 5; match.tick(); assert.equal(q.dead, true); assert.equal(r.target, q.id);
  const before = aim(r); match.tick();
  assert.ok(r.moving); assert.notDeepEqual(aim(r), before);
  assert.equal(r.target, r.objective); assert.ok(towers[r.objective]);
  const old = r.objective; towers[old].dead = true; towers[old].hp = 0;
  match.tick(); assert.notEqual(r.objective, old); assert.equal(r.target, r.objective);
});

test('Alex separation handles coincident units, other characters, players and map edges without moving players', () => {
  const { match, a, p, q, robots } = setup();
  place(p, -28.9, 28.9); place(q, -28.9, 28.9);
  a.send('c'); p.cCd = 0; a.send('c');
  for (const r of Object.values(robots)) { place(r, -28.9, 28.9); r.stun = 1; }
  robots.mira = { id: 'mira', owner: q.id, character: 'mira', slot: 1, radius: 0.4, hp: 30, life: 20, x: -28, z: 28, face: 0, atkCd: 100, stun: 1, bush: -1 };
  const positions = [aim(p), aim(q), aim(robots.mira)];
  match.tick(); assertAlexSeparated(match);
  assert.deepEqual([aim(p), aim(q), aim(robots.mira)], positions);
  for (const r of Object.values(robots)) assert.ok(Math.abs(r.x) <= MAP.half - 1 && Math.abs(r.z) <= MAP.half - 1);
});

test('Bastion guardians retain their owner-following behavior when no enemy is nearby', () => {
  for (const id of ['bastion']) {
    const match = createMatch(true), a = socket('a'); match.connect(a);
    a.send('selectCharacter', { id }); a.send('confirmCharacter');
    const p = match.state.players.a; a.send('c');
    for (const t of Object.values(match.state.towers)) t.atkCd = 10000;
    place(p, -24, 20);
    ticks(match, TICK);
    for (const r of Object.values(match.state.robots)) {
      assert.equal(r.objective, undefined); assert.equal(r.target, null);
      assert.ok(Math.hypot(r.x - p.x, r.z - p.z) <= 4.1);
    }
  }
});

test('Alex minions summoned against an obstacle can leave its edge and continue marching', () => {
  const { match, a, p, robots } = setup(true);
  place(p, -24, 0); p.face = Math.PI / 2; a.send('c');
  const starts = new Map(Object.values(robots).map(r => [r.id, aim(r)]));
  ticks(match, TICK * 2);
  assertAlexSeparated(match);
  for (const r of Object.values(robots)) {
    const start = starts.get(r.id);
    assert.ok(Math.hypot(r.x - start.x, r.z - start.z) > 1, `${r.id} stuck at an obstacle`);
    for (const o of MAP.obst) assert.ok(Math.hypot(r.x - o.x, r.z - o.z) >= r.radius + o.r - 0.0001);
  }
});

test('opposing full waves remain separated while meeting and fighting', () => {
  const { match, a, b, p, q } = setup();
  a.send('c'); p.cCd = 0; a.send('c'); b.send('c'); q.cCd = 0; b.send('c');
  for (let i = 0; i < TICK * 14; i++) { match.tick(); assertAlexSeparated(match); }
});

test('Alex minions slide out of overlap when pressed directly against a wall', () => {
  const { match, a, p, robots } = setup(true);
  a.send('c'); const r = Object.values(robots)[0];
  for (const other of Object.values(robots).slice(1)) delete robots[other.id];
  place(p, 28.5, 0); place(r, 29, 0); r.stun = 1;
  match.tick(); assertAlexSeparated(match);
  assert.deepEqual(aim(p), { x: 28.5, z: 0 });
  assert.ok(Math.abs(r.x) <= MAP.half - 1 && Math.abs(r.z) <= MAP.half - 1);
});

test('Alex E waits for click confirmation, leaps, then hits for 45 damage and one second stun with a 30 second cooldown', () => {
  const { match, a, p, q } = setup(); place(p, 0, 0); place(q, 5, 0);
  a.send('dash', { x: 4, z: 0 }); match.tick();
  assert.equal(p.aiming, true); assert.equal(p.eCd, 0); assert.deepEqual(aim(p), { x: 0, z: 0 });
  a.send('leap', { x: 4, z: 0 }); assert.equal(p.eCd, 30); assert.equal(p.aiming, false);
  ticks(match, 7); assert.ok(p.air > 2); assert.equal(q.hp, 200);
  a.send('move', { x: -10, z: 0 }); a.send('q', aim(q)); a.send('c');
  assert.equal(p.qCd, 0); assert.equal(Object.keys(match.state.robots).length, 0);
  ticks(match, 7); assert.equal(p.leap, null); assert.equal(p.air, 0);
  assert.deepEqual(aim(p), { x: 4, z: 0 }); assert.equal(q.hp, 155); assert.ok(q.stun > 0.9 && q.stun <= 1);
  a.send('dash'); assert.equal(p.aiming, false);
});

test('Alex leap rejects unarmed, out-of-range, occupied and safe-zone destinations without spending cooldown; aiming can cancel', () => {
  const { a, p, towers } = setup(true); place(p, 0, 0);
  a.send('leap', { x: 4, z: 0 }); assert.equal(p.leap, null);
  a.send('dash');
  for (const point of [{ x: 20, z: 0 }, { x: NaN, z: 0 }, { x: -8, z: 0 }]) {
    a.send('leap', point); assert.equal(p.eCd, 0); assert.equal(p.leap, null);
  }
  const tower = towers['t1-2']; place(p, tower.x - 4, tower.z);
  a.send('leap', aim(tower)); assert.equal(p.leap, null);
  place(p, 20, -19.5); a.send('leap', { x: 28, z: -19.5 }); assert.equal(p.leap, null);
  a.send('cancelLeap'); assert.equal(p.aiming, false); assert.equal(p.eCd, 0);
});

test('missed leaps do not damage distant enemies; stun interrupts an in-flight leap', () => {
  const { match, a, b, p, q } = setup(); place(p, 0, 0); place(q, -5, 0);
  a.send('dash'); a.send('leap', { x: 4, z: 0 }); ticks(match, 14); assert.equal(q.hp, 200); assert.equal(q.stun, 0);
  place(p, 0, 0); place(q, 1, 0); p.eCd = 0; a.send('dash'); a.send('leap', { x: 4, z: 0 }); match.tick();
  b.send('q', aim(p)); assert.equal(p.leap, null); assert.equal(p.air, 0); assert.equal(p.stun, 0.3);
});

test('Mira wind step doubles movement for three seconds with a ten second cooldown and never dashes', () => {
  const { match, a, p } = setup(true, ['mira']); place(p, 0, 0);
  a.send('dash'); assert.equal(p.speedBoost, 3); assert.equal(p.eCd, 10); assert.equal(p.dashT, 0);
  a.send('steer', { x: 1, z: 0 }); match.tick(); assert.ok(Math.abs(p.x - 22 / TICK) < 1e-9);
  a.send('steer', { x: 0, z: 0 }); ticks(match, 89); assert.equal(p.speedBoost, 0); assert.ok(p.eCd > 6.9);
  a.send('dash'); assert.equal(p.speedBoost, 0);
  a.send('move', { x: 5, z: 0 }); const before = p.x; match.tick(); assert.ok(Math.abs(p.x - before - 11 / TICK) < 1e-9);
});

test('Magic Scout is a fast projectile that pulls the first enemy and stuns for 1.5 seconds without summoning', () => {
  const { match, a, p, q } = setup(false, ['mira', 'alex']); place(p, 0, 0); place(q, 5, 0);
  a.send('c', aim(q)); assert.equal(p.cCd, 8); assert.equal(Object.keys(match.state.robots).length, 0);
  assert.equal(Object.keys(match.state.projectiles).length, 1); match.tick();
  assert.equal(Object.values(match.state.projectiles)[0].x, 45 / TICK);
  ticks(match, 2); assert.equal(q.stun, 1.5); assert.equal(q.hp, 170); assert.equal(Object.keys(match.state.projectiles).length, 0);
  ticks(match, 10); assert.ok(q.x < 2 && q.x >= p.radius + q.radius); assert.ok(q.stun > 1);
  ticks(match, 35); assert.equal(q.stun, 0);
});

test('Magic Scout misses off-axis enemies and stops at obstacles or protected spawn zones', () => {
  for (const scenario of ['miss', 'obstacle', 'safe']) {
    const { match, a, p, q } = setup(false, ['mira', 'alex']); place(p, 0, 0);
    let point;
    if (scenario === 'miss') { place(q, 6, 2); point = { x: 14, z: 0 }; }
    if (scenario === 'obstacle') { place(q, -12, 0); point = aim(q); }
    if (scenario === 'safe') { place(p, 24, -17); place(q, 24, -24); point = aim(q); }
    a.send('c', point); const before = aim(q); ticks(match, 12);
    assert.equal(q.stun, 0, scenario); assert.equal(q.pull, null); assert.deepEqual(aim(q), before);
    assert.equal(Object.keys(match.state.projectiles).length, 0);
  }
});

test('Magic Scout hits minions before a player and cannot pull a target through an obstacle', () => {
  const { match, a, p, q, robots } = setup(false, ['mira', 'alex']); place(p, 0, 0); place(q, 9, 0);
  robots.guard = { id: 'guard', owner: q.id, character: 'bastion', slot: 1, radius: 0.4, hp: 70, maxHp: 70, life: 20,
    cfg: { ...CFG.robot, speed: 0 }, x: 4, z: 0, face: 0, atkCd: 100, stun: 0, bush: -1 };
  a.send('c', aim(q)); ticks(match, 3); assert.ok(robots.guard.stun > 1.4); assert.equal(q.stun, 0);
  ticks(match, 5); assert.ok(robots.guard.x < 2); assert.equal(robots.guard.hp, 40);
  // 引き寄せ中に召喚者が岩の向こうへ移動しても、岩を通り抜けない。
  place(q, -4, 0); place(p, -12, 0); q.pull = { caster: p.id, remaining: 6 }; q.stun = 1.5;
  ticks(match, 10); assert.ok(q.x >= -5.3); assert.equal(q.pull, null);
});

test('Mira Q reaches twice its previous range and stuns for exactly two seconds', () => {
  const { match, a, b, p, q } = setup(false, ['mira', 'alex']); place(p, 0, 0); place(q, 10, 4);
  assert.equal(p.cfg.qRange, 14); a.send('q', aim(q));
  assert.equal(q.hp, 200 - 22); assert.equal(q.stun, 2);
  b.send('move', { x: 0, z: 0 }); assert.equal(q.dest, null);
  ticks(match, 59); assert.ok(q.stun > 0); match.tick(); assert.equal(q.stun, 0);
  p.qCd = 0; place(q, 18, 0); const hp = q.hp; a.send('q', aim(q)); assert.equal(q.hp, hp);
});

test('player deaths emit one shared kill log without hidden coordinates and retain player kill credit', () => {
  const { a, b, p, q } = setup(); place(p, 0, 0); place(q, 1.5, 0); q.hp = 1;
  a.send('q', aim(q)); assert.equal(p.kills, 1);
  assert.equal(a.killEvents.length, 1); assert.deepEqual(a.killEvents, b.killEvents);
  const event = a.killEvents[0]; assert.equal(event.attacker.kind, 'player'); assert.equal(event.victim.kind, 'player');
  assert.equal(event.attacker.name, 'アレックス'); assert.equal(event.victim.slot, 1);
  assert.ok(!('x' in event.attacker) && !('z' in event.victim));
  p.qCd = 0; a.send('q', aim(q)); assert.equal(a.killEvents.length, 1);
});

test('minion deaths have a kill log before removal and do not count as player kills', () => {
  const { a, b, p, q, robots } = setup(); b.send('c');
  const r = Object.values(robots)[0]; place(r, 1.5, 0); r.hp = 1;
  place(p, 0, 0); place(q, 20, 20); a.send('q', aim(r));
  assert.equal(robots[r.id], undefined); assert.equal(a.killEvents.length, 1);
  assert.equal(a.killEvents[0].victim.kind, 'minion'); assert.equal(a.killEvents[0].victim.name, 'アレックスのミニオン');
  assert.equal(p.kills, 0);
});

test('minion player kills identify the minion as attacker and credit the owner', () => {
  const { match, a, p, q, robots } = setup(); a.send('c');
  const r = Object.values(robots)[0]; place(r, 0, 0); place(q, 1.5, 0); q.hp = 1;
  match.tick(); assert.equal(p.kills, 1); assert.equal(a.killEvents.length, 1);
  assert.equal(a.killEvents[0].attacker.kind, 'minion'); assert.equal(a.killEvents[0].victim.id, q.id);
});

test('tower destruction and tower attacks both emit kill logs with correct attribution', () => {
  const { match, a, p, q, towers } = setup(); const enemy = towers['t1-2'];
  place(p, enemy.x - 3, enemy.z); enemy.hp = 1; a.send('q', aim(enemy));
  assert.equal(a.killEvents[0].victim.kind, 'tower'); assert.equal(a.killEvents[0].victim.name, 'タワー 3');
  const ally = towers['t0-2']; place(q, ally.x + 3, ally.z); q.hp = 1; ally.atkCd = 0;
  match.tick(); assert.equal(a.killEvents.length, 2); assert.equal(a.killEvents[1].attacker.kind, 'tower');
  assert.equal(a.killEvents[1].victim.id, q.id); assert.equal(p.kills, 0);
});

test('Magic Scout lethal damage triggers player and minion kill logs without pulling dead targets', () => {
  for (const kind of ['player', 'minion']) {
    const { match, a, p, q, robots } = setup(false, ['mira', 'alex']); place(p, 0, 0); place(q, 5, 0);
    let victim = q;
    if (kind === 'minion') {
      place(q, 20, 20);
      victim = robots.guard = { id: 'guard', owner: q.id, character: 'bastion', slot: 1, radius: 0.4, hp: 30, maxHp: 70, life: 20,
        cfg: { ...CFG.robot, speed: 0 }, x: 4, z: 0, face: 0, atkCd: 100, stun: 0, bush: -1 };
    }
    victim.hp = 30; a.send('c', aim(victim)); ticks(match, 4);
    assert.equal(victim.dead, true); assert.ok(!victim.pull); assert.equal(a.killEvents.length, 1);
    assert.equal(a.killEvents[0].victim.kind, kind); assert.equal(a.killEvents[0].attacker.character, 'mira');
    assert.equal(p.kills, kind === 'player' ? 1 : 0);
  }
});

test('Bastion shield reduces Magic Scout damage to 15 while preserving its control effects', () => {
  const { match, a, b, p, q } = setup(false, ['mira', 'bastion']); place(p, 0, 0); place(q, 5, 0);
  b.send('dash'); a.send('c', aim(q)); ticks(match, 3);
  assert.equal(q.hp, 280 - 15); assert.equal(q.stun, 1.5); assert.ok(q.pull);
});

test('Lucia passive heals ten percent of actual enemy character damage, not minion or tower damage', () => {
  const { match, a, p, q, robots, towers } = setup(false, ['lucia', 'alex']);
  place(p, 0, 0); place(q, 1.5, 0); p.hp = 100;
  a.send('chase', { id: q.id }); match.tick(); assert.equal(q.hp, 190); assert.equal(p.hp, 101);
  place(q, 20, 20); p.target = null; p.atkCd = 0; p.hp = 100;
  robots.guard = { id: 'guard', owner: q.id, character: 'bastion', slot: 1, radius: 0.4, hp: 100, life: 20,
    cfg: { ...CFG.robot, speed: 0 }, x: 1.5, z: 0, face: 0, atkCd: 100, stun: 0, bush: -1 };
  a.send('chase', { id: 'guard' }); match.tick(); assert.equal(p.hp, 100);
  const tower = towers['t1-2']; place(p, tower.x - 2.5, tower.z); p.atkCd = 0;
  a.send('chase', { id: tower.id }); match.tick(); assert.equal(p.hp, 100);
});

test('Lucia Q deals 50 and heals 30 plus passive on character hit, but never on a miss', () => {
  const { match, a, p, q } = setup(false, ['lucia', 'alex']); place(p, 0, 0); place(q, 5, 0); p.hp = 100;
  a.send('q', aim(q)); assert.equal(p.hp, 100); assert.equal(Object.keys(match.state.projectiles).length, 1);
  ticks(match, 6); assert.equal(q.hp, 150); assert.equal(q.stun, 0); assert.equal(p.hp, 135);
  p.qCd = 0; p.hp = 100; place(q, 5, 3); a.send('q', { x: 12, z: 0 }); ticks(match, 20);
  assert.equal(p.hp, 100); assert.equal(q.hp, 150);
});

test('Lucia Q healing handles minions, damage reduction, lethal hits and maximum HP', () => {
  const { match, a, b, p, q, robots } = setup(false, ['lucia', 'bastion']); place(p, 0, 0); place(q, 5, 0); p.hp = 100;
  b.send('dash'); a.send('q', aim(q)); ticks(match, 6);
  assert.equal(q.hp, 255); assert.equal(p.hp, 132.5);
  p.qCd = 0; p.hp = 100; place(q, 20, 20);
  robots.guard = { id: 'guard', owner: q.id, character: 'bastion', slot: 1, radius: 0.4, hp: 100, life: 20,
    cfg: { ...CFG.robot, speed: 0 }, x: 4, z: 0, face: 0, atkCd: 100, stun: 0, bush: -1 };
  a.send('q', { x: 4, z: 0 }); ticks(match, 6); assert.equal(robots.guard.hp, 50); assert.equal(p.hp, 130);
  delete robots.guard; place(q, 5, 0); q.hp = 1; q.shield = 0; p.qCd = 0; p.hp = 100;
  a.send('q', aim(q)); ticks(match, 6); assert.equal(p.hp, 130.1); assert.equal(p.kills, 1);
  q.dead = false; q.hp = 200; p.qCd = 0; p.hp = 195;
  a.send('q', aim(q)); ticks(match, 6); assert.equal(p.hp, p.cfg.maxHp);
});

test('Lucia E vanishes for one second, locks other actions and deals AoE only after warping', () => {
  const { match, a, b, p, q, robots } = setup(false, ['lucia', 'alex']); place(p, 0, 0); place(q, 5, 0); p.hp = 100;
  robots.guard = { id: 'guard', owner: q.id, character: 'bastion', slot: 1, radius: 0.4, hp: 100, life: 20,
    cfg: { ...CFG.robot, speed: 0 }, x: 4, z: 2, face: 0, atkCd: 100, stun: 0, bush: -1 };
  a.send('dash', { x: 4, z: 0 }); assert.ok(p.warp); assert.equal(p.eCd, 12);
  a.send('move', { x: -10, z: 0 }); a.send('q', aim(q)); a.send('c');
  assert.equal(p.dest, null); assert.equal(p.qCd, 0); assert.equal(p.cCd, 0);
  ticks(match, 29); assert.deepEqual(aim(p), { x: 0, z: 0 }); assert.equal(q.hp, 200);
  const hidden = b.events.state.players.find(e => e.id === p.id);
  assert.equal(hidden.vis, false); assert.equal(hidden.x, undefined); assert.equal(hidden.warping, undefined);
  assert.ok(a.events.state.players.find(e => e.id === p.id).warping > 0);
  match.tick(); assert.deepEqual(aim(p), { x: 4, z: 0 }); assert.equal(p.warp, null);
  assert.equal(q.hp, 160); assert.equal(robots.guard.hp, 60); assert.equal(p.hp, 104);
});

test('Lucia E rejects unsafe destinations and is interrupted by stun', () => {
  const { match, a, b, p, q, towers } = setup(false, ['lucia', 'alex']); place(p, 0, 0); place(q, 1.5, 0);
  for (const d of [{ x: 20, z: 0 }, { x: -8, z: 0 }, { x: NaN, z: 0 }]) {
    a.send('dash', d); assert.equal(p.warp, null); assert.equal(p.eCd, 0);
  }
  const tower = towers['t1-2']; place(p, tower.x - 4, tower.z); a.send('dash', aim(tower)); assert.equal(p.warp, null);
  place(p, 20, -19.5); a.send('dash', { x: 24, z: -20 }); assert.equal(p.warp, null);
  place(p, 0, 0); a.send('dash', { x: 4, z: 0 }); match.tick(); b.send('q', aim(p));
  assert.equal(p.warp, null); assert.equal(p.stun, 0.3); ticks(match, 30); assert.deepEqual(aim(p), { x: 0, z: 0 });
});

test('Lucia C hides coordinates for exactly five seconds and removes enemy chase and tower aggro', () => {
  const { match, a, b, p, q, towers } = setup(false, ['lucia', 'alex']); place(p, 0, 0); place(q, 1.5, 0); p.hp = 100;
  const tower = towers['t1-0']; tower.x = 0; tower.z = 3; tower.atkCd = 0;
  b.send('chase', { id: p.id }); a.send('c'); ticks(match, 149);
  assert.equal(p.hp, 100); assert.equal(q.target, null); assert.equal(p.cCd > 15, true);
  const hidden = b.events.state.players.find(e => e.id === p.id);
  assert.equal(hidden.vis, false);
  for (const key of ['x', 'z', 'face', 'stealth', 'warping']) assert.equal(hidden[key], undefined);
  assert.ok(a.events.state.players.find(e => e.id === p.id).stealth > 0);
  match.tick(); assert.equal(p.stealth, 0); assert.equal(b.events.state.players.find(e => e.id === p.id).vis, true);
});

test('Lucia stays invisible when attacking, but can still be hit by area attacks', () => {
  const { match, a, b, p, q } = setup(false, ['lucia', 'alex']); place(p, 0, 0); place(q, 1.5, 0); p.hp = 100;
  a.send('c'); a.send('chase', { id: q.id }); match.tick();
  assert.equal(q.hp, 190); assert.equal(p.hp, 101); assert.ok(p.stealth > 4.9);
  assert.equal(b.events.state.players.find(e => e.id === p.id).vis, false);
  p.target = null; b.send('q', aim(p)); assert.equal(p.hp, 78); assert.ok(p.stealth > 0);
});

test('Lucia C and E compose without leaking the warp destination, and expire on the original timer', () => {
  const { match, a, b, p, q } = setup(false, ['lucia', 'alex']); place(p, 0, 0); place(q, 20, 20);
  a.send('c'); a.send('dash', { x: 4, z: 0 }); ticks(match, 30);
  assert.deepEqual(aim(p), { x: 4, z: 0 }); assert.ok(Math.abs(p.stealth - 4) < 1e-8);
  assert.equal(b.events.state.players.find(e => e.id === p.id).x, undefined);
  ticks(match, 120); assert.equal(p.stealth, 0); assert.equal(b.events.state.players.find(e => e.id === p.id).vis, true);
});


test('Mira basic attacks travel before hitting players and towers without scout control effects', () => {
  const { match, a, p, q, towers } = setup(false, ['mira','alex']);
  place(p, 0, 0); place(q, 6, 0);
  a.send('chase', { id: q.id }); match.tick();
  assert.equal(q.hp, 200); assert.equal(Object.values(match.state.projectiles)[0].kind, 'basic');
  ticks(match, 5); assert.equal(q.hp, 190); assert.equal(q.stun, 0); assert.equal(q.pull, null);
  p.target = null; p.atkCd = 0;
  const tower = towers['t1-2']; place(p, tower.x-6, tower.z);
  a.send('chase', { id: tower.id }); ticks(match, 7);
  assert.equal(tower.hp, 290);
});

test('control zones heal only their owner, damage invaders and preserve spawn protection', () => {
  const { match, p, q } = setup(); match.state.environment.enabled = true;
  place(p, -2, 4); place(q, -1, 4); p.hp = q.hp = 100;
  ticks(match, TICK);
  assert.ok(Math.abs(p.hp - 108)<0.01); assert.ok(Math.abs(q.hp-88)<0.01);
  place(q, MAP.spawns[1].x, MAP.spawns[1].z); q.hp = 100;
  ticks(match, TICK); assert.ok(q.hp >= 180 - 1e-8);
});

test('central energy is shared, collectible once, shrinks only opposing territory and resets with the match', () => {
  const { match, a, p } = setup(true); match.state.environment.enabled = true;
  match.tick(); const orb = Object.values(match.state.energy)[0]; assert.ok(orb);
  place(p, orb.x, orb.z); match.tick();
  assert.equal(p.energy, 5); assert.equal(Object.keys(match.state.energy).length, 0);
  assert.equal(a.events.state.control[0].boundary, 0); assert.equal(a.events.state.control[1].boundary, -0.75);
  match.tick(); assert.equal(p.energy, 5);
  a.send('restart'); assert.equal(p.energy, 0); assert.deepEqual(match.state.environment.totals, [0,0]);
});

test('monster camps spawn periodically, grant kill energy and respawn after defeat', () => {
  const { match, a, p } = setup(true); match.state.environment.enabled = true;
  ticks(match, TICK * 5); const { monsters, camps } = match.state;
  assert.equal(Object.keys(monsters).length, 7);
  const large = monsters['monster-0']; assert.ok(large.radius > p.radius); assert.ok(large.maxHp > p.cfg.maxHp);
  const small = monsters['monster-2']; place(p, small.x+1, small.z); small.hp=1;
  a.send('q', aim(small)); assert.equal(monsters[small.id], undefined); assert.equal(p.energy, 8);
  assert.equal(a.killEvents.at(-1).victim.kind, 'monster'); assert.equal(p.kills, 0);
  place(p, MAP.spawns[0].x, MAP.spawns[0].z); ticks(match, TICK*29); assert.equal(monsters[small.id], undefined);
  ticks(match, TICK); assert.ok(monsters[small.id]); assert.equal(camps[2].timer, 0);
});

test('player, tower, minion and owner minion kills award energy exactly once', () => {
  const { match, a, p, q, towers, robots } = setup();
  place(p, 0, 0); place(q, 1, 0); q.hp=1; a.send('q', aim(q)); assert.equal(p.energy, 15);
  p.qCd=0; const tower=towers['t1-2']; place(p,tower.x-3,tower.z); tower.hp=1;
  a.send('q',aim(tower)); assert.equal(p.energy,40);
  robots.victim={ id:'victim', slot:1, owner:q.id, x:1,z:0,radius:0.4,hp:1,life:20,face:0,atkCd:100,bush:-1,stun:0 };
  place(p,0,0); p.qCd=0; a.send('q',{x:1,z:0}); assert.equal(p.energy,43);
  a.send('c'); const minion=Object.values(robots)[0]; const target=towers['t1-1'];
  place(minion,target.x-2,target.z); target.hp=1; match.tick(); assert.equal(p.energy,68);
  match.tick(); assert.equal(p.energy,68);
});

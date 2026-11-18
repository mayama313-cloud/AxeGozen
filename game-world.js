const HALF = 30, TICK = 30, DT = 1 / TICK;
const CFG = {
  maxHp: 200, speed: 9, radius: 0.7,
  atkRange: 2.4, atkCd: 0.8, atkDmg: 10,
  qRange: 4, qArc: Math.PI / 3, qCd: 5, qDmg: 28, qStun: 0.3,
  dashSpeed: 40, dashTime: 0.18, eCd: 3, cCd: 8,
  robot: { hp: 40, dmg: 5, atkCd: 0.7, atkRange: 1.8, speed: 7, radius: 0.4, aggro: 9, leash: 14, life: 20, max: 5, batch: 3 },
  safeRadius: 4, safeHeal: 80,
  tower: { hp: 300, radius: 1.1, count: 5, range: 7, dmg: 5, atkCd: 1 },
  recallTime: 5, inputTimeout: 0.35,
  respawn: 5, respawnPerTower: 5,
};
const R = CFG.robot;
const SPAWNS = [{ x: -24, z: 24 }, { x: 24, z: -24 }];
const BASE = [[-20, 0, 3], [-14, 3, 2.5], [-14, -6, 2.5], [-3, -12, 2], [-26, -4, 2], [-10, -22, 2.5], [-8, 0, 2]];
const OBST = BASE.flatMap(([x, z, r]) => [{ x, z, r }, { x: -x, z: -z, r }]);
// 中央の十字路から茂み全体を離す。描画と視界判定で同じリストを使う。
const BUSH_BASE = [[-4, 20, 3], [-22, 12, 3], [-16, -14, 3]];
const BUSHES = BUSH_BASE.flatMap(([x, z, r]) => [{ x, z, r }, { x: -x, z: -z, r }]);
const MAP = { half: HALF, obst: OBST, spawns: SPAWNS, bushes: BUSHES };
const clamp = v => Math.max(-HALF + 1, Math.min(HALF - 1, v));
const wrap = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const ang = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const isNum = (...v) => v.every(Number.isFinite);
const r2 = n => Math.round(n * 100) / 100;
const decay = time => time <= DT + 1e-9 ? 0 : time - DT;
const isRobot = e => e.owner !== undefined;
const protectedUnit = e => !e.tower && dist(e, SPAWNS[e.slot]) <= CFG.safeRadius;

function createMatch(solo = false) {
  const players = {}, robots = {}, towers = {};
  let robotSeq = 0, winner = null;
  const active = () => winner === null && (solo || Object.keys(players).length === 2);
  const units = () => [...Object.values(players), ...Object.values(robots)];
  const targets = () => [...units(), ...Object.values(towers)];
  const unit = id => players[id] || robots[id] || towers[id];
  const destroyed = slot => Object.values(towers).filter(t => t.slot === slot && t.dead).length;
  const updateBush = e => { e.bush = BUSHES.findIndex(b => dist(e, b) < b.r); };
  function canSee(slot, e) {
    return e.tower || e.slot === slot || e.bush < 0 || units().some(u => u.slot === slot && !u.dead && u.bush === e.bush);
  }
  const attackable = (a, b) => b && !b.dead && b.slot !== a.slot && !protectedUnit(b) && canSee(a.slot, b);
  function emitSee(src, ev, data) {
    for (const v of Object.values(players)) if (canSee(v.slot, src)) v.socket.emit(ev, data);
  }
  const fx = (p, kind) => emitSee(p, 'fx', { id: p.id, kind, x: r2(p.x), z: r2(p.z), face: r2(p.face) });

  function pushOut(e) {
    // 障害物と生存タワーは通り抜けられない。
    for (const o of [...OBST, ...Object.values(towers).filter(t => !t.dead).map(t => ({ ...t, r: t.radius }))]) {
      const d = dist(e, o), min = o.r + e.radius;
      if (d < min) {
        e.x = o.x + (d ? (e.x - o.x) / d : 1) * min;
        e.z = o.z + (d ? (e.z - o.z) / d : 0) * min;
      }
    }
    const s = SPAWNS[1 - e.slot], d = dist(e, s), min = CFG.safeRadius + e.radius + 0.01;
    if (d < min) {
      const fallback = SPAWNS[e.slot];
      const dx = d ? (e.x - s.x) / d : (fallback.x - s.x) / dist(fallback, s);
      const dz = d ? (e.z - s.z) / d : (fallback.z - s.z) / dist(fallback, s);
      e.x = s.x + dx * min; e.z = s.z + dz * min;
    }
    e.x = clamp(e.x); e.z = clamp(e.z);
  }
  function spawn(p) {
    Object.assign(p, SPAWNS[p.slot], { hp: CFG.maxHp, dest: null, target: null, dead: false, dashT: 0, moving: false, respawn: 0, stun: 0, recall: 0, keys: null, inputT: 0 });
    p.face = ang(p, { x: 0, z: 0 });
    updateBush(p);
  }
  function reset() {
    winner = null;
    for (const id of Object.keys(robots)) delete robots[id];
    for (const slot of [0, 1]) {
      const s = SPAWNS[slot], facing = ang(s, { x: 0, z: 0 });
      for (let i = 0; i < CFG.tower.count; i++) {
        const a = facing + (i - 2) * Math.PI / 6, id = `t${slot}-${i}`;
        towers[id] = { id, slot, tower: true, x: s.x + Math.sin(a) * 8, z: s.z + Math.cos(a) * 8,
          radius: CFG.tower.radius, hp: CFG.tower.hp, dead: false, atkCd: 0, bush: -1, face: facing, moving: false };
      }
    }
    for (const p of Object.values(players)) {
      Object.assign(p, { kills: 0, atkCd: 0, qCd: 0, eCd: 0, cCd: 0 });
      spawn(p);
    }
  }
  reset();

  function hit(a, b, dmg) {
    if (!active() || !attackable(a, b)) return;
    b.hp = Math.max(0, b.hp - dmg);
    b.recall = 0;
    emitSee(b, 'hit', { id: b.id, dmg });
    if (b.hp > 0) return;
    b.dead = true;
    if (b.tower) {
      // 復活待ちの間にタワーが壊れた場合も、その分だけ延長する。
      for (const p of Object.values(players)) if (p.slot === b.slot && p.dead) p.respawn += CFG.respawnPerTower;
      if (destroyed(b.slot) === CFG.tower.count) winner = a.slot;
      return;
    }
    if (isRobot(b)) { delete robots[b.id]; return; }
    b.respawn = CFG.respawn + destroyed(b.slot) * CFG.respawnPerTower;
    b.dest = null; b.target = null; b.moving = false;
    const credit = isRobot(a) ? players[a.owner] : a.tower ? null : a;
    if (credit) credit.kills++;
  }
  function melee(p, range, halfArc, dmg, kind) {
    fx(p, kind);
    for (const o of targets()) {
      if (!attackable(p, o) || dist(p, o) > range + o.radius) continue;
      if (Math.abs(wrap(ang(p, o) - p.face)) <= halfArc) {
        const before = o.hp;
        hit(p, o, dmg);
        if (o.hp < before && kind === 'q' && !o.tower && !o.dead) {
          o.stun = CFG.qStun;
          o.dest = null; o.target = null; o.dashT = 0; o.keys = null; o.recall = 0; o.moving = false;
        }
      }
    }
  }
  function connect(socket) {
    const slot = [0, 1].find(s => !Object.values(players).some(p => p.slot === s));
    if (slot === undefined) { socket.emit('full'); socket.disconnect(); return false; }
    const p = players[socket.id] = { id: socket.id, socket, slot, radius: CFG.radius, kills: 0, atkCd: 0, qCd: 0, eCd: 0, cCd: 0 };
    spawn(p);
    if (active()) reset();
    socket.emit('init', { id: p.id, slot, cfg: CFG, map: MAP, solo });
    const ready = () => active() && !p.dead && p.stun <= 0;
    socket.on('steer', d => {
      if (!isNum(d?.x, d?.z) || Math.abs(d.x) > 1 || Math.abs(d.z) > 1) return;
      if (d.x === 0 && d.z === 0) { p.keys = null; return; }
      if (!ready()) return;
      const length = Math.hypot(d.x, d.z);
      p.keys = { x: d.x / length, z: d.z / length }; p.inputT = CFG.inputTimeout;
      p.dest = null; p.recall = 0;
    });
    socket.on('recall', () => {
      if (!ready()) return;
      if (p.recall > 0) { p.recall = 0; return; }
      p.recall = CFG.recallTime;
      p.dest = null; p.target = null; p.keys = null; p.dashT = 0; p.moving = false;
    });
    socket.on('move', d => {
      if (!ready() || !isNum(d?.x, d?.z)) return;
      p.recall = 0; p.keys = null;
      p.dest = { x: clamp(d.x), z: clamp(d.z) }; p.target = null;
    });
    socket.on('chase', d => {
      const t = typeof d?.id === 'string' ? unit(d.id) : null;
      if (!ready() || !attackable(p, t)) return;
      p.recall = 0;
      p.target = t.id; p.dest = null;
    });
    socket.on('q', d => {
      if (!ready() || p.qCd > 0 || p.dashT > 0 || !isNum(d?.x, d?.z)) return;
      p.recall = 0;
      p.qCd = CFG.qCd; p.face = ang(p, d); p.dest = null;
      melee(p, CFG.qRange, CFG.qArc, CFG.qDmg, 'q');
    });
    socket.on('dash', d => {
      if (!ready() || p.eCd > 0 || !isNum(d?.x, d?.z)) return;
      p.recall = 0;
      p.eCd = CFG.eCd; p.face = ang(p, d); p.dashT = CFG.dashTime; p.dest = null;
    });
    socket.on('c', () => {
      const count = Object.values(robots).filter(r => r.owner === p.id).length;
      if (!ready() || p.cCd > 0 || count >= R.max) return;
      p.recall = 0;
      p.cCd = CFG.cCd;
      for (let i = 0; i < Math.min(R.batch, R.max - count); i++) {
        const a = p.face + (i - 1) * 0.6, id = 'r' + (++robotSeq);
        const r = robots[id] = { id, owner: p.id, slot, radius: R.radius, hp: R.hp, life: R.life, dead: false, stun: 0,
          x: clamp(p.x + Math.sin(a) * 1.6), z: clamp(p.z + Math.cos(a) * 1.6), face: p.face, atkCd: 0, target: null, moving: false };
        pushOut(r); updateBush(r);
      }
    });
    socket.on('restart', () => { if (solo) reset(); });
    socket.on('disconnect', () => { delete players[p.id]; reset(); });
    return true;
  }
  const reach = (range, e) => range + (e.tower ? e.radius : 0);
  function tickRobot(r) {
    r.life -= DT; r.atkCd = Math.max(0, r.atkCd - DT);
    const owner = players[r.owner];
    if (r.life <= 0 || !owner) { delete robots[r.id]; return; }
    if (r.stun > 0) { r.stun = decay(r.stun); r.moving = false; return; }
    const ok = e => attackable(r, e) && dist(r, e) <= R.leash;
    let foe = unit(r.target);
    if (!ok(foe)) {
      foe = null;
      let best = R.aggro;
      for (const e of targets()) {
        const d = dist(r, e);
        if (ok(e) && d < best) { best = d; foe = e; }
      }
    }
    r.target = foe ? foe.id : null;
    let goal = null;
    if (foe) {
      if (dist(r, foe) <= reach(R.atkRange, foe)) {
        r.face = ang(r, foe);
        if (r.atkCd <= 0) { r.atkCd = R.atkCd; fx(r, 'atk'); hit(r, foe, R.dmg); }
      } else goal = foe;
    } else if (!owner.dead && dist(r, owner) > 4) goal = owner;
    r.moving = false;
    if (goal) {
      const d = dist(r, goal), step = Math.min(R.speed * DT, d);
      if (d > 0.05) {
        r.face = ang(r, goal);
        r.x += (goal.x - r.x) / d * step; r.z += (goal.z - r.z) / d * step;
        r.moving = true;
      }
    }
    pushOut(r); updateBush(r);
  }
  function tickPlayer(p) {
    for (const cd of ['atkCd', 'qCd', 'eCd', 'cCd']) p[cd] = Math.max(0, p[cd] - DT);
    if (p.dead) { p.respawn -= DT; if (p.respawn <= 0) spawn(p); return; }
    p.moving = false;
    p.inputT = Math.max(0, p.inputT - DT);
    if (p.inputT <= 0) p.keys = null;
    if (p.stun > 0) { p.stun = decay(p.stun); return; }
    if (p.recall > 0) {
      p.recall = Math.max(0, p.recall - DT);
      if (p.recall < 1e-9) {
        const hp = p.hp;
        spawn(p); p.hp = hp;
      }
      if (protectedUnit(p)) p.hp = Math.min(CFG.maxHp, p.hp + CFG.safeHeal * DT);
      return;
    }
    let dir = null, step = 0, foe = p.target && unit(p.target);
    if (!attackable(p, foe)) { foe = null; p.target = null; }
    if (p.dashT > 0) {
      p.dashT -= DT; step = CFG.dashSpeed * DT; p.moving = true;
      dir = { x: Math.sin(p.face), z: Math.cos(p.face) };
    } else {
      let goal = p.dest;
      if (foe) {
        if (dist(p, foe) <= reach(CFG.atkRange, foe)) {
          goal = null; p.face = ang(p, foe);
          if (p.atkCd <= 0) { p.atkCd = CFG.atkCd; fx(p, 'atk'); hit(p, foe, CFG.atkDmg); }
        } else if (!p.keys) goal = foe;
      }
      if (p.keys) {
        dir = p.keys; step = CFG.speed * DT; p.moving = true;
        if (!foe || dist(p, foe) > reach(CFG.atkRange, foe)) p.face = Math.atan2(dir.x, dir.z);
      }
      if (goal) {
        const d = dist(p, goal);
        if (d < 0.1) p.dest = null;
        else {
          step = Math.min(CFG.speed * DT, d); p.moving = true;
          dir = { x: (goal.x - p.x) / d, z: (goal.z - p.z) / d };
          p.face = Math.atan2(dir.x, dir.z);
        }
      }
    }
    if (dir) { p.x += dir.x * step; p.z += dir.z * step; }
    pushOut(p); updateBush(p);
    if (protectedUnit(p)) p.hp = Math.min(CFG.maxHp, p.hp + CFG.safeHeal * DT);
  }
  function tickTower(t) {
    if (t.dead) return;
    t.atkCd = Math.max(0, t.atkCd - DT);
    const foe = units().filter(e => attackable(t, e) && dist(t, e) <= CFG.tower.range)
      .sort((a, b) => dist(t, a) - dist(t, b))[0];
    if (foe && t.atkCd <= 0) {
      t.face = ang(t, foe); t.atkCd = CFG.tower.atkCd;
      fx(t, 'atk'); hit(t, foe, CFG.tower.dmg);
    }
  }
  function tick() {
    if (active()) {
      for (const p of Object.values(players)) if (active()) tickPlayer(p);
      for (const r of Object.values(robots)) if (active()) tickRobot(r);
      for (const t of Object.values(towers)) if (active()) tickTower(t);
    }
    const list = Object.values(players);
    for (const v of list) {
      v.socket.emit('state', {
        solo, winner, phase: winner !== null ? 'finished' : active() ? 'playing' : 'waiting',
        towers: Object.values(towers).map(t => ({ id: t.id, slot: t.slot, x: r2(t.x), z: r2(t.z), hp: t.hp, dead: t.dead, face: t.face })),
        players: list.map(p => {
          const vis = canSee(v.slot, p);
          const s = { id: p.id, slot: p.slot, hp: r2(p.hp), dead: p.dead, kills: p.kills, vis, stun: r2(p.stun), recall: r2(p.recall) };
          if (vis) Object.assign(s, { x: r2(p.x), z: r2(p.z), face: r2(p.face), moving: active() && p.moving });
          if (p === v) Object.assign(s, { qCd: r2(p.qCd), eCd: r2(p.eCd), cCd: r2(p.cCd), respawn: r2(Math.max(0, p.respawn)), safe: !p.dead && protectedUnit(p), respawnTime: CFG.respawn + destroyed(p.slot) * CFG.respawnPerTower });
          return s;
        }),
        robots: Object.values(robots).filter(r => canSee(v.slot, r)).map(r => ({ id: r.id, slot: r.slot, x: r2(r.x), z: r2(r.z), face: r2(r.face), hp: r.hp, stun: r2(r.stun || 0), moving: active() && r.moving })),
      });
    }
  }
  // サーバー内部の状態。Socket.IOのイベントからは直接変更できない。
  return { connect, tick, state: { players, robots, towers } };
}

module.exports = { createMatch, CFG, MAP, TICK };

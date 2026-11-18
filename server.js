const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

// ---- 設定（クライアントにも init で送る） ----
const HALF = 30, TICK = 30, DT = 1 / TICK;
const CFG = {
  maxHp: 200, speed: 9, radius: 0.7,
  atkRange: 2.4, atkCd: 0.8, atkDmg: 10,          // 通常攻撃（近接）
  qRange: 4, qArc: Math.PI / 3, qCd: 5, qDmg: 28,  // Q: 前方の扇形斬り
  dashSpeed: 40, dashTime: 0.18, eCd: 3,           // E: ダッシュ
  cCd: 8,                                          // C: ロボット召喚
  robot: { hp: 40, dmg: 5, atkCd: 0.7, atkRange: 1.8, speed: 7, radius: 0.4, aggro: 9, leash: 14, life: 20, max: 3 },
  respawn: 3,
};
const R = CFG.robot;
const SPAWNS = [{ x: -24, z: 24 }, { x: 24, z: -24 }];   // slot0 = 左下 / slot1 = 右上（クライアント側で視点を回転）
// 点対称にして左右の有利不利をなくす
const BASE = [[-20, 0, 3], [-14, 3, 2.5], [-14, -6, 2.5], [-3, -12, 2], [-26, -4, 2], [-10, -22, 2.5], [-8, 0, 2]];
const OBST = BASE.flatMap(([x, z, r]) => [{ x, z, r }, { x: -x, z: -z, r }]);
const BUSH_BASE = [[-12, 12, 3.5], [-4, 20, 3], [-22, 12, 3], [2, -6, 3], [-16, -14, 3]];
const BUSHES = BUSH_BASE.flatMap(([x, z, r]) => [{ x, z, r }, { x: -x, z: -z, r }]);

// ---- ユーティリティ ----
const players = {}, robots = {};
let robotSeq = 0;
const clamp = v => Math.max(-HALF + 1, Math.min(HALF - 1, v));
const wrap = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const ang = (a, b) => Math.atan2(b.x - a.x, b.z - a.z); // 向き = (sin, cos)
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const isNum = (...v) => v.every(Number.isFinite);
const r2 = n => Math.round(n * 100) / 100;

const units = () => [...Object.values(players), ...Object.values(robots)];
const unit = id => players[id] || robots[id];
const isRobot = e => e.owner !== undefined;

// ---- ブッシュ（視界） ----
// bush = いまいるブッシュの番号（外なら -1）。同じブッシュ内に味方がいる時だけ中が見える。
const updateBush = e => { e.bush = BUSHES.findIndex(b => Math.hypot(e.x - b.x, e.z - b.z) < b.r); };
function canSee(slot, e) {
  if (e.slot === slot || e.bush < 0) return true;
  return units().some(u => u.slot === slot && !u.dead && u.bush === e.bush);
}
// 発生源が見えているプレイヤーにだけイベントを送る（位置の漏洩防止）
function emitSee(src, ev, data) {
  for (const v of Object.values(players)) if (canSee(v.slot, src)) v.socket.emit(ev, data);
}
const fx = (p, kind) => emitSee(p, 'fx', { id: p.id, kind, x: r2(p.x), z: r2(p.z), face: r2(p.face) });

function pushOut(e) {                       // 障害物の押し出し
  for (const o of OBST) {
    const d = dist(e, o), min = o.r + e.radius;
    if (d < min && d > 0) { e.x += (e.x - o.x) / d * (min - d); e.z += (e.z - o.z) / d * (min - d); }
  }
}

function spawn(p) {
  const s = SPAWNS[p.slot];
  Object.assign(p, { x: s.x, z: s.z, hp: CFG.maxHp, dest: null, target: null, dead: false, dashT: 0, moving: false });
  p.face = ang(p, { x: 0, z: 0 });
  updateBush(p);
}

function hit(a, b, dmg) {
  b.hp -= dmg;
  emitSee(b, 'hit', { id: b.id, dmg });
  if (b.hp > 0) return;
  b.hp = 0;
  if (isRobot(b)) { delete robots[b.id]; return; }
  b.dead = true; b.respawn = CFG.respawn; b.dest = null; b.target = null;
  const credit = isRobot(a) ? players[a.owner] : a;   // ロボットが倒した分は持ち主のキルになる
  if (credit) credit.kills++;
}

// 近接判定: 距離 + 扇形の角度（敵プレイヤーと敵ロボットが対象）
function melee(p, range, halfArc, dmg, kind) {
  fx(p, kind);
  for (const o of units()) {
    if (o.slot === p.slot || o.dead) continue;
    if (dist(p, o) > range + o.radius) continue;
    if (Math.abs(wrap(ang(p, o) - p.face)) > halfArc) continue;
    hit(p, o, dmg);
  }
}

// ---- 接続 ----
io.on('connection', socket => {
  const slot = [0, 1].find(s => !Object.values(players).some(p => p.slot === s));
  if (slot === undefined) { socket.emit('full'); socket.disconnect(); return; }

  const p = players[socket.id] = { id: socket.id, socket, slot, radius: CFG.radius, kills: 0, atkCd: 0, qCd: 0, eCd: 0, cCd: 0, respawn: 0 };
  spawn(p);
  socket.emit('init', { id: socket.id, slot, cfg: CFG, map: { half: HALF, obst: OBST, spawns: SPAWNS, bushes: BUSHES } });

  socket.on('move', d => {                 // 右クリック: 地面へ移動
    if (p.dead || !isNum(d?.x, d?.z)) return;
    p.dest = { x: clamp(d.x), z: clamp(d.z) }; p.target = null;
  });
  socket.on('chase', d => {                // 右クリック: 敵（プレイヤー/ロボット）を追いかけて自動攻撃
    const t = typeof d?.id === 'string' ? unit(d.id) : null;
    if (p.dead || !t || t.dead || t.slot === p.slot || !canSee(p.slot, t)) return;
    p.target = t.id; p.dest = null;
  });
  socket.on('q', d => {
    if (p.dead || p.qCd > 0 || p.dashT > 0 || !isNum(d?.x, d?.z)) return;
    p.qCd = CFG.qCd; p.face = ang(p, d); p.dest = null;
    melee(p, CFG.qRange, CFG.qArc, CFG.qDmg, 'q');
  });
  socket.on('dash', d => {
    if (p.dead || p.eCd > 0 || !isNum(d?.x, d?.z)) return;
    p.eCd = CFG.eCd; p.face = ang(p, d); p.dashT = CFG.dashTime; p.dest = null;
  });
  socket.on('c', () => {                   // C: 自動攻撃ロボットを生成
    if (p.dead || p.cCd > 0) return;
    if (Object.values(robots).filter(r => r.owner === p.id).length >= R.max) return;
    p.cCd = CFG.cCd;
    const a = p.face + (Math.random() - 0.5), id = 'r' + (++robotSeq);
    const r = robots[id] = {
      id, owner: p.id, slot: p.slot, radius: R.radius, hp: R.hp, life: R.life, dead: false,
      x: clamp(p.x + Math.sin(a) * 1.6), z: clamp(p.z + Math.cos(a) * 1.6),
      face: p.face, atkCd: 0, target: null, moving: false,
    };
    pushOut(r); updateBush(r);
  });
  socket.on('disconnect', () => {
    delete players[socket.id];
    for (const r of Object.values(robots)) if (r.owner === socket.id) delete robots[r.id];
  });
});

// ---- ロボットAI: 近くの見える敵を狙う。いなければ持ち主について行く ----
function tickRobot(r) {
  r.life -= DT;
  r.atkCd = Math.max(0, r.atkCd - DT);
  const owner = players[r.owner];
  if (r.life <= 0 || !owner) { delete robots[r.id]; return; }

  const ok = e => e && !e.dead && e.slot !== r.slot && canSee(r.slot, e) && dist(r, e) <= R.leash;
  let foe = unit(r.target);
  if (!ok(foe)) {
    foe = null;
    let best = R.aggro;
    for (const e of units()) {
      if (!ok(e)) continue;
      const d = dist(r, e);
      if (d < best) { best = d; foe = e; }
    }
  }
  r.target = foe ? foe.id : null;

  let goal = null;
  if (foe) {
    if (dist(r, foe) <= R.atkRange) {
      r.face = ang(r, foe);
      if (r.atkCd <= 0) { r.atkCd = R.atkCd; fx(r, 'atk'); hit(r, foe, R.dmg); }
    } else goal = foe;
  } else if (!owner.dead && dist(r, owner) > 4) goal = owner;

  r.moving = false;
  if (goal) {
    const d = dist(r, goal);
    if (d > 0.05) {
      const step = Math.min(R.speed * DT, d);
      r.face = ang(r, goal);
      r.x = clamp(r.x + (goal.x - r.x) / d * step);
      r.z = clamp(r.z + (goal.z - r.z) / d * step);
      r.moving = true;
    }
  }
  pushOut(r); updateBush(r);
}

// ---- ゲームループ ----
setInterval(() => {
  for (const p of Object.values(players)) {
    p.atkCd = Math.max(0, p.atkCd - DT);
    p.qCd = Math.max(0, p.qCd - DT);
    p.eCd = Math.max(0, p.eCd - DT);
    p.cCd = Math.max(0, p.cCd - DT);
    if (p.dead) { p.respawn -= DT; if (p.respawn <= 0) spawn(p); continue; }

    p.moving = false;
    let dir = null, step = 0;
    let foe = p.target && unit(p.target);
    if (foe && (foe.dead || !canSee(p.slot, foe))) foe = null;   // 死亡 / ブッシュに隠れた → 追跡終了
    if (!foe) p.target = null;

    if (p.dashT > 0) {
      p.dashT -= DT; step = CFG.dashSpeed * DT; p.moving = true;
      dir = { x: Math.sin(p.face), z: Math.cos(p.face) };
    } else {
      let goal = p.dest;
      if (foe) {
        if (dist(p, foe) <= CFG.atkRange) {
          goal = null; p.face = ang(p, foe);
          if (p.atkCd <= 0) { p.atkCd = CFG.atkCd; fx(p, 'atk'); hit(p, foe, CFG.atkDmg); }
        } else goal = foe;
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
    if (dir) { p.x = clamp(p.x + dir.x * step); p.z = clamp(p.z + dir.z * step); }
    pushOut(p); updateBush(p);
  }

  for (const r of Object.values(robots)) tickRobot(r);

  // プレイヤーごとに「見えるものだけ」を送る（ブッシュ内の敵の座標は送らない）
  const list = Object.values(players), rl = Object.values(robots);
  for (const v of list) {
    v.socket.emit('state', {
      players: list.map(p => {
        const vis = canSee(v.slot, p);
        const s = { id: p.id, slot: p.slot, hp: p.hp, dead: p.dead, kills: p.kills, vis };
        if (vis) Object.assign(s, { x: r2(p.x), z: r2(p.z), face: r2(p.face), moving: p.moving });
        if (p === v) Object.assign(s, { qCd: r2(p.qCd), eCd: r2(p.eCd), cCd: r2(p.cCd) });
        return s;
      }),
      robots: rl.filter(r => canSee(v.slot, r)).map(r => ({
        id: r.id, slot: r.slot, x: r2(r.x), z: r2(r.z), face: r2(r.face), hp: r.hp, moving: r.moving,
      })),
    });
  }
}, 1000 / TICK);

server.listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000)));

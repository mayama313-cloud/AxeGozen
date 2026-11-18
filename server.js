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
  respawn: 3,
};
const SPAWNS = [{ x: -24, z: 24 }, { x: 24, z: -24 }];
// 点対称にして左右の有利不利をなくす
const BASE = [[-20, 0, 3], [-14, 3, 2.5], [-14, -6, 2.5], [-3, -12, 2], [-26, -4, 2], [-10, -22, 2.5], [-8, 0, 2]];
const OBST = BASE.flatMap(([x, z, r]) => [{ x, z, r }, { x: -x, z: -z, r }]);

// ---- ユーティリティ ----
const players = {};
const clamp = v => Math.max(-HALF + 1, Math.min(HALF - 1, v));
const wrap = a => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const ang = (a, b) => Math.atan2(b.x - a.x, b.z - a.z); // 向き = (sin, cos)
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const isNum = (...v) => v.every(Number.isFinite);
const r2 = n => Math.round(n * 100) / 100;

function spawn(p) {
  const s = SPAWNS[p.slot];
  Object.assign(p, { x: s.x, z: s.z, hp: CFG.maxHp, dest: null, target: null, dead: false, dashT: 0, moving: false });
  p.face = ang(p, { x: 0, z: 0 });
}

function hit(a, b, dmg) {
  b.hp -= dmg;
  io.emit('hit', { id: b.id, dmg });
  if (b.hp <= 0) { b.hp = 0; b.dead = true; b.respawn = CFG.respawn; b.dest = null; b.target = null; a.kills++; }
}

// 近接判定: 距離 + 扇形の角度
function melee(p, range, halfArc, dmg, kind) {
  io.emit('fx', { id: p.id, kind, x: r2(p.x), z: r2(p.z), face: r2(p.face) });
  for (const o of Object.values(players)) {
    if (o === p || o.dead) continue;
    if (dist(p, o) > range + CFG.radius) continue;
    if (Math.abs(wrap(ang(p, o) - p.face)) > halfArc) continue;
    hit(p, o, dmg);
  }
}

// ---- 接続 ----
io.on('connection', socket => {
  const slot = [0, 1].find(s => !Object.values(players).some(p => p.slot === s));
  if (slot === undefined) { socket.emit('full'); socket.disconnect(); return; }

  const p = players[socket.id] = { id: socket.id, slot, kills: 0, atkCd: 0, qCd: 0, eCd: 0, respawn: 0 };
  spawn(p);
  socket.emit('init', { id: socket.id, cfg: CFG, map: { half: HALF, obst: OBST, spawns: SPAWNS } });

  socket.on('move', d => {                 // 右クリック: 地面へ移動
    if (p.dead || !isNum(d?.x, d?.z)) return;
    p.dest = { x: clamp(d.x), z: clamp(d.z) }; p.target = null;
  });
  socket.on('chase', () => {               // 右クリック: 敵を追いかけて自動攻撃
    if (p.dead) return;
    p.target = Object.keys(players).find(id => id !== p.id) || null; p.dest = null;
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
  socket.on('disconnect', () => { delete players[socket.id]; });
});

// ---- ゲームループ ----
setInterval(() => {
  for (const p of Object.values(players)) {
    p.atkCd = Math.max(0, p.atkCd - DT);
    p.qCd = Math.max(0, p.qCd - DT);
    p.eCd = Math.max(0, p.eCd - DT);
    if (p.dead) { p.respawn -= DT; if (p.respawn <= 0) spawn(p); continue; }

    p.moving = false;
    let dir = null, step = 0;
    const foe = p.target && players[p.target];
    if (p.target && (!foe || foe.dead)) p.target = null;

    if (p.dashT > 0) {
      p.dashT -= DT; step = CFG.dashSpeed * DT; p.moving = true;
      dir = { x: Math.sin(p.face), z: Math.cos(p.face) };
    } else {
      let goal = p.dest;
      if (p.target) {
        if (dist(p, foe) <= CFG.atkRange) {
          goal = null; p.face = ang(p, foe);
          if (p.atkCd <= 0) { p.atkCd = CFG.atkCd; melee(p, CFG.atkRange, 0.9, CFG.atkDmg, 'atk'); }
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

    for (const o of OBST) {                 // 障害物の押し出し
      const d = dist(p, o), min = o.r + CFG.radius;
      if (d < min && d > 0) { p.x += (p.x - o.x) / d * (min - d); p.z += (p.z - o.z) / d * (min - d); }
    }
  }

  io.emit('state', Object.values(players).map(p => ({
    id: p.id, slot: p.slot, x: r2(p.x), z: r2(p.z), face: r2(p.face), hp: p.hp,
    dead: p.dead, moving: p.moving, kills: p.kills,
    qCd: r2(p.qCd), eCd: r2(p.eCd),
  })));
}, 1000 / TICK);

server.listen(process.env.PORT || 3000, () => console.log('http://localhost:' + (process.env.PORT || 3000)));

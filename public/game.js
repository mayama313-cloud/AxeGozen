const socket = window.gameSession;
const $ = id => document.getElementById(id);
const canvas = $('gameCanvas');
const ALLY = 0x2f7fb0, ENEMY = 0xb0413a;   // 自分=青 / 相手=赤（どちらのプレイヤーから見ても同じ）

// ---------- シーン / カメラ（LoL風の斜め見下ろし固定） ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10161a);
scene.fog = new THREE.Fog(0x10161a, 45, 95);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
const CAM_OFF = new THREE.Vector3(0, 26, 20);   // slot1 は init で (0,26,-20) に反転 → 自分が常に左下

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x2a2f26, 0.9));
const sun = new THREE.DirectionalLight(0xfff0d0, 0.9);
sun.position.set(-20, 40, 12);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, far: 120 });
sun.shadow.camera.updateProjectionMatrix();
scene.add(sun);

// ---------- 共通ヘルパー ----------
const std = c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 });
function add(geo, color, x, y, z, parent = scene, shadow = true) {
  const m = new THREE.Mesh(geo, std(color));
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

// ---------- マップ（サーバーの設定から生成） ----------
const crystals = [], bushes = [];
const mapRoot = new THREE.Group();
scene.add(mapRoot);
function disposeObject(object) {
  if (object.parent) object.parent.remove(object);
  object.traverse(child => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  });
}
function buildMap({ half, obst, spawns, bushes: bushList }, mySlot) {
  const ground = add(new THREE.PlaneGeometry(half * 2, half * 2), 0x2f3b3a, 0, 0, 0, mapRoot, false);
  ground.rotation.x = -Math.PI / 2;

  const strip = (w, color, y, rotY) => {
    const g = new THREE.Group();
    g.rotation.y = rotY;
    g.position.y = y;
    const m = add(new THREE.PlaneGeometry(w, half * 2 * Math.SQRT2 - 4), color, 0, 0, 0, g, false);
    m.rotation.x = -Math.PI / 2;
    mapRoot.add(g);
  };
  strip(6, 0x2d5f7a, 0.02, Math.PI / 4);       // 川
  strip(10, 0x7a7766, 0.04, 3 * Math.PI / 4);  // レーン（川の上は橋になる）

  spawns.forEach((s, i) => {
    const col = i === mySlot ? ALLY : ENEMY;
    const pad = add(new THREE.CylinderGeometry(cfg.safeRadius, cfg.safeRadius, 0.1, 48), col, s.x, 0.05, s.z, mapRoot, false);
    pad.material.transparent = true;
    pad.material.opacity = 0.55;
    const shield = add(new THREE.SphereGeometry(cfg.safeRadius, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), col, s.x, 0, s.z, mapRoot, false);
    shield.material.transparent = true;
    shield.material.opacity = 0.12;
    shield.material.depthWrite = false;
    const ring = add(new THREE.RingGeometry(cfg.safeRadius - 0.08, cfg.safeRadius + 0.08, 48), col, s.x, 0.13, s.z, mapRoot, false);
    ring.rotation.x = -Math.PI / 2;
    const c = add(new THREE.OctahedronGeometry(1.6), col, s.x * 1.125, 2.2, s.z * 1.125, mapRoot);
    c.material.emissive.setHex(col);
    c.material.emissiveIntensity = 0.6;
    crystals.push(c);
  });

  // 外周の壁
  [[0, -half, half * 2, 1], [0, half, half * 2, 1], [-half, 0, 1, half * 2], [half, 0, 1, half * 2]]
    .forEach(([x, z, w, d]) => add(new THREE.BoxGeometry(w, 3, d), 0x1b2226, x, 1.5, z, mapRoot));

  // 障害物（木と岩を交互に）
  obst.forEach((o, i) => {
    if (Math.floor(i / 2) % 2) {
      const r = add(new THREE.DodecahedronGeometry(o.r), 0x6b7078, o.x, o.r * 0.6, o.z, mapRoot);
      r.scale.y = 0.8;
    } else {
      add(new THREE.CylinderGeometry(0.35, 0.45, o.r * 1.4, 8), 0x5a4030, o.x, o.r * 0.7, o.z, mapRoot);
      add(new THREE.ConeGeometry(o.r, o.r * 3.2, 8), 0x2f6b45, o.x, o.r * 2.2, o.z, mapRoot);
    }
  });

  // ブッシュ（低い茂み。自分が中にいる間は半透明にして自キャラが隠れないようにする）
  bushList.forEach((b, i) => {
    const mats = [];
    const track = m => { m.material.transparent = true; mats.push(m.material); return m; };
    track(add(new THREE.CylinderGeometry(b.r, b.r, 0.06, 28), 0x23542f, b.x, 0.03, b.z, mapRoot, false));
    const n = Math.round(b.r * 4);
    for (let k = 0; k < n; k++) {
      const rr = b.r * 0.85 * Math.sqrt((k + 0.5) / n), a = k * 2.39996 + i;   // ひまわり状に敷き詰める
      const s = 0.55 + ((k * 7 + i * 3) % 5) * 0.1;
      track(add(new THREE.IcosahedronGeometry(s, 1), k % 2 ? 0x2f8a46 : 0x3a9d52, b.x + Math.cos(a) * rr, s * 0.9, b.z + Math.sin(a) * rr, mapRoot, false));
    }
    bushes.push({ ...b, mats, op: 1 });
  });
}

// ---------- ヒト型キャラクター（箱と球の組み合わせ） ----------
function makeHuman(color, character) {
  const g = new THREE.Group(), mats = [];
  const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const part = (geo, c, x, y, z, parent = g) => {
    const m = add(geo, c, x, y, z, parent);
    mats.push(m.material);
    return m;
  };
  const pivot = (x, y) => { const p = new THREE.Group(); p.position.set(x, y, 0); g.add(p); return p; };

  const legL = pivot(-0.2, 0.9), legR = pivot(0.2, 0.9);
  const armL = pivot(-0.5, 1.65), armR = pivot(0.5, 1.65);
  [legL, legR].forEach(l => part(B(0.26, 0.9, 0.28), 0x2b2b33, 0, -0.45, 0, l));
  [armL, armR].forEach(a => part(B(0.2, 0.75, 0.22), 0xe8c39e, 0, -0.37, 0, a));
  part(B(0.74, 0.85, 0.42), color, 0, 1.3, 0);                                   // 胴体
  part(new THREE.SphereGeometry(0.28, 16, 12), 0xe8c39e, 0, 2.0, 0);            // 頭
  part(new THREE.SphereGeometry(0.31, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0x2b2b33, 0, 2.04, 0); // ヘルメット
  part(B(0.3, 0.06, 0.08), 0xe6c15a, 0, -0.8, 0, armR);                          // ツバ
  part(B(0.08, 1.2, 0.04), 0xdfe6ee, 0, -1.4, 0, armR);                          // 剣身
  const accent = parseInt((ArenaWorld.characterFor(character)?.color || '#ffffff').slice(1), 16);
  if (character === 'mira') {
    part(new THREE.ConeGeometry(0.45, 0.7, 8), accent, 0, 2.45, 0);
    part(new THREE.SphereGeometry(0.23, 12, 8), accent, 0, -1.95, 0, armR);
  } else if (character === 'bastion') {
    part(B(0.75, 1.1, 0.18), accent, 0, -0.5, 0.2, armL);
    part(B(1, 0.25, 0.6), accent, 0, 1.8, 0);
  }
  return { g, mats, legL, legR, armL, armR };
}

// ---------- 小型ロボット（人の半分くらいの背丈。目が前＝+z） ----------
function makeRobot(color) {
  const g = new THREE.Group(), mats = [];
  const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const part = (geo, c, x, y, z, parent = g) => {
    const m = add(geo, c, x, y, z, parent);
    mats.push(m.material);
    return m;
  };
  const pivot = (x, y) => { const p = new THREE.Group(); p.position.set(x, y, 0); g.add(p); return p; };

  const legL = pivot(-0.14, 0.35), legR = pivot(0.14, 0.35);
  const armL = pivot(-0.36, 0.88), armR = pivot(0.36, 0.88);
  [legL, legR].forEach(l => part(B(0.16, 0.35, 0.18), 0x4a525c, 0, -0.17, 0, l));
  [armL, armR].forEach(a => part(B(0.12, 0.42, 0.12), 0x9aa4ae, 0, -0.21, 0, a));
  part(B(0.5, 0.5, 0.36), color, 0, 0.7, 0);                                     // 胴体
  part(B(0.46, 0.34, 0.36), 0xc9d1d9, 0, 1.12, 0);                               // 頭
  part(new THREE.CylinderGeometry(0.02, 0.02, 0.22, 6), 0x9aa4ae, 0, 1.4, 0);    // アンテナ
  part(new THREE.SphereGeometry(0.06, 8, 8), 0xff6a5a, 0, 1.54, 0);
  const eye = add(B(0.32, 0.08, 0.05), 0xffd36a, 0, 1.14, 0.19, g, false);        // 目（光る。flash対象外）
  eye.material.emissive.setHex(0xffd36a);
  return { g, mats, legL, legR, armL, armR };
}

// 防衛タワー
function makeTower(color) {
  const g = new THREE.Group(), mats = [];
  const part = (geo, c, y) => { const m = add(geo, c, 0, y, 0, g); mats.push(m.material); return m; };
  part(new THREE.CylinderGeometry(1.1, 1.25, 0.5, 12), 0x687784, 0.25);
  part(new THREE.CylinderGeometry(0.65, 0.85, 2.7, 10), color, 1.85);
  part(new THREE.CylinderGeometry(1, 0.7, 0.45, 10), 0x9eabb4, 3.35);
  const core = part(new THREE.OctahedronGeometry(0.65), color, 4.05);
  core.material.emissive.setHex(color);
  core.material.emissiveIntensity = 0.6;
  return { g, mats };
}

// 頭上HPバー（カメラの向きに合わせて常に正面表示）
function makeBar() {
  const bar = new THREE.Group();
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.12), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthTest: false }));
  const fg = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.08).translate(0.43, 0, 0), new THREE.MeshBasicMaterial({ color: 0x8be0a0, depthTest: false }));
  fg.position.set(-0.43, 0, 0.001);
  bg.renderOrder = 10; fg.renderOrder = 11;
  bar.add(bg, fg);
  scene.add(bar);
  bar.fill = fg;
  return bar;
}
function makeProjectile() {
  const g = new THREE.Group(), mats = [];
  for (const [geo, z] of [[new THREE.IcosahedronGeometry(0.32, 1), 0], [new THREE.BoxGeometry(0.16, 0.16, 1.4), -0.8]]) {
    const mesh = add(geo, 0x76ffff, 0, 0.8, z, g, false);
    mesh.material.emissive.setHex(0x42cccc); mats.push(mesh.material);
  }
  return { g, mats };
}

// ---------- ネットワーク状態 ----------
let myId = null, mySlot = 0, cfg = null;
let phase = 'waiting';
let leapAiming = false, mapData = null;
const ents = {};    // 見えているプレイヤー / ロボット（id → 表示用データ）
const fxs = [];

function ensure(s, kind) {
  if (ents[s.id] && ents[s.id].s.character !== s.character) {
    disposeObject(ents[s.id].g);
    if (ents[s.id].bar) disposeObject(ents[s.id].bar);
    delete ents[s.id];
  }
  if (ents[s.id]) return ents[s.id];
  const color = s.slot === mySlot ? ALLY : ENEMY;
  const h = kind === 'projectile' ? makeProjectile() : kind === 'tower' ? makeTower(color) : kind === 'robot' ? makeRobot(color) : makeHuman(color, s.character);
  h.g.position.set(s.x, 0, s.z);
  scene.add(h.g);
  return (ents[s.id] = Object.assign(h, { kind, bar: kind === 'robot' || kind === 'tower' ? makeBar() : null, x: s.x, z: s.z, face: s.face, s, phase: 0, swing: 0, flash: 0 }));
}

socket.on('init', d => {
  clearKeys();
  [...mapRoot.children].forEach(disposeObject);
  crystals.length = 0; bushes.length = 0;
  for (const id of Object.keys(ents)) {
    disposeObject(ents[id].g);
    if (ents[id].bar) disposeObject(ents[id].bar);
    delete ents[id];
  }
  myId = d.id; mySlot = d.slot; cfg = d.cfg;
  mapData = d.map; leapAiming = false;
  CAM_OFF.set(0, 26, mySlot === 1 ? -20 : 20);
  const sp = d.map.spawns[mySlot];
  camera.position.set(sp.x + CAM_OFF.x, CAM_OFF.y, sp.z + CAM_OFF.z);
  camera.lookAt(sp.x, 0, sp.z);
  buildMap(d.map, mySlot);
  $('msg').textContent = '';
});
socket.on('full', () => { $('msg').textContent = '満員です（2人まで）'; });

socket.on('state', st => {
  phase = st.phase;
  const self = st.players.find(p => p.id === myId);
  if (self?.character) cfg = ArenaWorld.configFor(self.character);
  leapAiming = !!self?.aiming && phase === 'playing' && !self.dead && self.stun <= 0;
  canvas.style.cursor = leapAiming ? 'crosshair' : '';
  const seen = new Set();
  st.players.forEach(s => { if (s.vis) { seen.add(s.id); ensure(s, 'human').s = s; } });   // ブッシュ内の敵は vis=false で座標なし
  st.robots.forEach(s => { seen.add(s.id); ensure(s, 'robot').s = s; });
  st.towers.forEach(s => { seen.add(s.id); ensure(s, 'tower').s = s; });
  st.projectiles.forEach(s => { seen.add(s.id); ensure(s, 'projectile').s = s; });
  Object.keys(ents).forEach(id => {
    if (seen.has(id)) return;
    disposeObject(ents[id].g);
    if (ents[id].bar) disposeObject(ents[id].bar);
    delete ents[id];
  });
  hud(st);
});

socket.on('fx', d => {
  const e = ents[d.id];
  if (!e) return;
  e.swing = 0.25;
  e.attackBoost = !!d.boosted;
  const color = d.boosted ? 0xff3535 : ['magic', 'magicHit', 'wind'].includes(d.kind) ? 0x76ffff : d.kind === 'shield' ? 0x72bbff : 0xe6c15a;
  if (e.kind === 'tower') arc(d.x, d.z, d.face, cfg.tower.range, 0.06, color);
  else if (d.kind === 'q') arc(d.x, d.z, d.face, d.range, d.halfArc, color);
  else if (d.kind === 'atk') arc(d.x, d.z, d.face, e.kind === 'robot' ? 1.8 : 2.4, 0.55, color);
  else if (d.kind === 'shield') arc(d.x, d.z, d.face, 2, Math.PI, color);
  else if (d.kind === 'leapHit') arc(d.x, d.z, d.face, d.range, Math.PI, color);
  else if (['magicHit', 'wind'].includes(d.kind)) arc(d.x, d.z, d.face, 1.5, Math.PI, color);
});

socket.on('hit', d => {
  const e = ents[d.id];
  if (!e) return;
  e.flash = 0.12;
  dmgText(e, d.dmg, d.boosted);
});

function hud(st) {
  const list = st.players;
  const m = list.find(s => s.id === myId), f = list.find(s => s.id !== myId);
  if (!m || !cfg) return;
  $('playerHpFill').style.width = `${Math.max(0, m.hp / m.maxHp) * 100}%`;
  $('enemyHpFill').style.width = f ? `${Math.max(0, f.hp / f.maxHp) * 100}%` : '0%';
  const character = ArenaWorld.characterFor(m.character);
  if (character) for (const key of ['q', 'e', 'c']) {
    $(key + 'Label').textContent = character.skills[key].name;
    $(key + 'Skill').title = character.skills[key].text;
  }
  $('qCooldown').style.height = `${(m.qCd / cfg.qCd) * 100}%`;
  $('eCooldown').style.height = `${(m.eCd / cfg.eCd) * 100}%`;
  $('cCooldown').style.height = `${(m.cCd / cfg.cCd) * 100}%`;
  $('recallProgress').style.height = `${m.recall > 0 ? (1 - m.recall / cfg.recallTime) * 100 : 0}%`;
  $('score').textContent = `${m.kills} - ${f ? f.kills : 0}`;
  const own = st.towers.filter(t => t.slot === mySlot && !t.dead).length;
  const enemy = st.towers.filter(t => t.slot !== mySlot && !t.dead).length;
  $('objective').textContent = `タワー残り　自陣 ${own}/5　敵陣 ${enemy}/5`;
  $('status').textContent = `${st.solo ? 'オフライン' : 'オンライン対戦'}｜${character?.name || ''}｜復活 ${m.respawnTime}秒${m.safe ? '｜安全地帯：無敵・HP急速回復' : ''}${m.shield > 0 ? '｜ダメージ50%軽減中' : ''}${m.speedBoost > 0 ? `｜移動速度2倍 ${m.speedBoost.toFixed(1)}秒` : ''}`;
  $('status').title = character?.passive || '';
  $('msg').textContent = st.phase === 'finished' ? (st.winner === mySlot ? '勝利！ 敵タワーを全て破壊しました' : '敗北 — 自陣タワーが全て破壊されました')
    : st.phase === 'waiting' ? '対戦相手を待っています…（1人用テストも選べます）'
    : m.dead ? `リスポーンまで ${Math.ceil(m.respawn)}秒`
    : m.stun > 0 ? 'スタン中'
    : leapAiming ? 'ラッシュ：着地点を左クリック（右クリック・Escでキャンセル）'
    : m.recall > 0 ? `リコール中… ${m.recall.toFixed(1)}秒（移動・攻撃・被ダメージで中断）` : '';
}

$('restart').addEventListener('click', () => socket.emit('restart'));
socket.on('lobby', () => { phase = 'waiting'; leapAiming = false; clearKeys(); myId = null; });
socket.on('disconnect', reason => { phase = 'waiting'; clearKeys(); if (reason !== 'io server disconnect') $('msg').textContent = '接続が切れました。再接続中…'; });
socket.on('connect_error', () => { $('msg').textContent = '接続できません。サーバーを確認してください'; });

// ---------- エフェクト ----------
function arc(x, z, face, r, half, color = 0xe6c15a) {
  const g = new THREE.Group();
  g.position.set(x, 0.1, z);
  g.rotation.y = face - Math.PI / 2;
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide });
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 24, -half, half * 2), mat);
  m.rotation.x = -Math.PI / 2;
  g.add(m);
  scene.add(g);
  fxs.push({ g, m: mat, t: 0, life: 0.25 });
}

function marker(p) {
  const mat = new THREE.MeshBasicMaterial({ color: 0x8be0a0, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
  const m = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.5, 24), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(p.x, 0.12, p.z);
  scene.add(m);
  fxs.push({ g: m, m: mat, t: 0, life: 0.4 });
}

function dmgText(e, n, boosted = false) {
  const v = new THREE.Vector3(e.x, e.kind === 'tower' ? 4.8 : e.kind === 'robot' ? 1.9 : 2.8, e.z).project(camera);
  const d = document.createElement('div');
  d.className = 'dmg';
  d.textContent = n;
  if (boosted) d.style.color = '#ff4545';
  d.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
  d.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 700);
}

// ---------- 入力（WASD / 右クリック移動 / Q・E・C・B） ----------
const ray = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const pt = new THREE.Vector3(), ndc = new THREE.Vector2();
let mouse = { clientX: 0, clientY: 0 }, aim = { x: 0, z: 0 };
const heldKeys = new Set();
let lastSteer = 0;
function aimRing(color) {
  const mesh = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.8, depthWrite: false }));
  mesh.rotation.x = -Math.PI / 2; mesh.visible = false; scene.add(mesh); return mesh;
}
const leapRangeRing = aimRing(0x8fd9ff), leapPointRing = aimRing(0x8be0a0);
function validLeapPoint(point, self) {
  if (!mapData || Math.hypot(point.x - self.x, point.z - self.z) > cfg.leapRange || Math.abs(point.x) > mapData.half - 1 || Math.abs(point.z) > mapData.half - 1) return false;
  const blocks = [...mapData.obst, ...Object.values(ents).filter(e => e.kind === 'tower' && !e.s.dead).map(e => ({ x: e.x, z: e.z, r: cfg.tower.radius }))];
  if (blocks.some(o => Math.hypot(point.x - o.x, point.z - o.z) < o.r + cfg.radius + 0.03)) return false;
  const safe = mapData.spawns[1 - mySlot], dx = point.x - self.x, dz = point.z - self.z, length2 = dx * dx + dz * dz;
  const t = length2 ? Math.max(0, Math.min(1, ((safe.x - self.x) * dx + (safe.z - self.z) * dz) / length2)) : 0;
  return Math.hypot(self.x + dx * t - safe.x, self.z + dz * t - safe.z) >= cfg.safeRadius + cfg.radius + 0.03;
}
function sendKeys() {
  const sign = mySlot === 1 ? -1 : 1;
  socket.emit('steer', { x: (Number(heldKeys.has('d')) - Number(heldKeys.has('a'))) * sign,
    z: (Number(heldKeys.has('s')) - Number(heldKeys.has('w'))) * sign });
  lastSteer = performance.now();
}
function clearKeys() {
  heldKeys.clear();
  if (myId && socket.connected) sendKeys();
}
addEventListener('blur', clearKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearKeys(); });
addEventListener('keyup', ev => {
  if (heldKeys.delete(ev.key.toLowerCase())) sendKeys();
});

function groundAt(ev) {
  ndc.set((ev.clientX / innerWidth) * 2 - 1, -(ev.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (ray.ray.intersectPlane(plane, pt)) aim = { x: pt.x, z: pt.z };
  return aim;
}

canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('mousemove', ev => { mouse = ev; });
canvas.addEventListener('mousedown', ev => {
  if (!myId || phase !== 'playing') return;
  if (leapAiming) {
    if (ev.button === 2) socket.emit('cancelLeap');
    else if (ev.button === 0) {
      const point = groundAt(ev), self = ents[myId]?.s;
      if (self && validLeapPoint(point, self)) { clearKeys(); socket.emit('leap', point); }
    }
    return;
  }
  if (ev.button !== 2) return;
  const g = groundAt(ev);
  const enemies = Object.values(ents).filter(e => e.kind !== 'projectile' && e.s.slot !== mySlot && !e.s.dead);
  // タワーの上部をクリックしても、そのタワーを選択する。
  const picked = ray.intersectObjects(enemies.map(e => e.g), true)[0];
  let foe = picked && enemies.find(e => {
    for (let o = picked.object; o; o = o.parent) if (o === e.g) return true;
    return false;
  });
  let best = 1.6;
  for (const e of foe ? [] : enemies) {
    const d = Math.hypot(e.x - g.x, e.z - g.z);
    if (d < best) { best = d; foe = e; }
  }
  if (foe) socket.emit('chase', { id: foe.s.id });
  else { socket.emit('move', g); marker(g); }
});
addEventListener('keydown', ev => {
  if (ev.repeat || !myId || phase !== 'playing' || ev.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
  const k = ev.key.toLowerCase();
  if (k === 'escape') { socket.emit('cancelLeap'); return; }
  if (leapAiming && ['q', 'c', 'b'].includes(k)) socket.emit('cancelLeap');
  if ('wasd'.includes(k) && k.length === 1) {
    ev.preventDefault(); heldKeys.add(k); sendKeys();
  } else if (k === 'q' || k === 'e') socket.emit(k === 'q' ? 'q' : 'dash', groundAt(mouse));
  else if (k === 'c') socket.emit('c', groundAt(mouse));
  else if (k === 'b') { clearKeys(); socket.emit('recall'); }
});

// ---------- 描画ループ ----------
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
  const k = 1 - Math.exp(-dt * 20);
  if (phase === 'playing' && heldKeys.size && performance.now() - lastSteer >= 100) sendKeys();

  for (const e of Object.values(ents)) {
    const s = e.s;
    e.x += (s.x - e.x) * k;
    e.z += (s.z - e.z) * k;
    e.face += Math.atan2(Math.sin(s.face - e.face), Math.cos(s.face - e.face)) * k;

    e.swing = Math.max(0, e.swing - dt);
    e.flash = Math.max(0, e.flash - dt);
    if (e.kind === 'projectile') { e.g.position.set(e.x, 0, e.z); e.g.rotation.y = e.face; continue; }
    if (e.kind === 'tower') {
      e.g.scale.y = s.dead ? 0.12 : 1;
      e.mats.forEach(m => m.emissive.setHex(e.flash > 0 ? 0x992222 : 0x000000));
      e.bar.visible = !s.dead;
      e.bar.position.set(e.x, 4.9, e.z);
      e.bar.quaternion.copy(camera.quaternion);
      e.bar.scale.setScalar(2.5);
      e.bar.fill.scale.x = Math.max(0.001, s.hp / cfg.tower.hp);
      continue;
    }
    if (s.moving) e.phase += dt * 11;
    const w = s.moving ? Math.sin(e.phase) * 0.9 : 0;

    e.g.visible = !s.dead;
    e.g.position.set(e.x, (s.air || 0) + (s.moving ? Math.abs(Math.sin(e.phase)) * 0.08 : 0), e.z);
    e.g.rotation.y = e.face;
    e.legL.rotation.x = w;
    e.legR.rotation.x = -w;
    e.armL.rotation.x = -w * 0.8;
    e.armR.rotation.x = e.swing > 0 ? -2.6 + 3 * (1 - e.swing / 0.25) : w * 0.8; // 振り下ろし
    e.mats.forEach(m => m.emissive.setHex(e.flash > 0 ? 0x992222 : s.stun > 0 ? 0x776600 : e.swing > 0 && e.attackBoost ? 0xaa1010 : s.shield > 0 ? 0x224477 : s.speedBoost > 0 ? 0x226655 : 0x000000));

    if (e.bar) {
      e.bar.position.set(e.x, 1.85, e.z);
      e.bar.quaternion.copy(camera.quaternion);
      e.bar.fill.scale.x = Math.max(0.001, s.hp / s.maxHp);
    }
  }

  const me = ents[myId];
  leapRangeRing.visible = leapPointRing.visible = leapAiming && !!me && phase === 'playing';
  if (leapRangeRing.visible) {
    const point = groundAt(mouse);
    leapRangeRing.position.set(me.x, 0.14, me.z); leapRangeRing.scale.setScalar(cfg.leapRange);
    leapPointRing.position.set(point.x, 0.15, point.z); leapPointRing.scale.setScalar(cfg.leapHitRange);
    leapPointRing.material.color.setHex(validLeapPoint(point, me.s) ? 0x8be0a0 : 0xff4545);
  }
  if (me) {
    const target = new THREE.Vector3(me.x, 0, me.z).add(CAM_OFF);
    camera.position.lerp(target, 1 - Math.exp(-dt * 6));
    camera.lookAt(camera.position.x - CAM_OFF.x, 0, camera.position.z - CAM_OFF.z);
  }

  // 自分がいるブッシュだけ半透明に
  const inside = me && bushes.find(b => Math.hypot(me.x - b.x, me.z - b.z) < b.r);
  bushes.forEach(b => {
    b.op += ((b === inside ? 0.35 : 1) - b.op) * (1 - Math.exp(-dt * 10));
    b.mats.forEach(m => { m.opacity = b.op; });
  });

  crystals.forEach(c => { c.rotation.y = t; });
  for (let i = fxs.length - 1; i >= 0; i--) {
    const f = fxs[i];
    f.t += dt;
    f.m.opacity = 0.8 * (1 - f.t / f.life);
    if (f.t >= f.life) { disposeObject(f.g); fxs.splice(i, 1); }
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();

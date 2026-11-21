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
  } else if (character === 'lucia') {
    for (const side of [-1, 1]) {
      const horn = part(new THREE.ConeGeometry(0.14, 0.65, 8), 0xb781e8, side * 0.24, 2.45, 0);
      horn.rotation.z = -side * 0.35;
      const wing = part(new THREE.ConeGeometry(0.85, 1.25, 3), 0x41204f, side * 0.8, 1.5, -0.3);
      wing.rotation.z = side * 1.1; wing.scale.z = 0.15;
    }
    const gem = part(new THREE.IcosahedronGeometry(0.18, 1), 0xe86cff, 0, 1.5, 0.26);
    gem.material.emissive.setHex(0x952bba);
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
function makeBar(color = 0x8be0a0) {
  const bar = new THREE.Group();
  // 背景と残量を同じ描画キューに入れ、透明な物体より後に背景→残量の順で描く。
  const material = color => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.16), material(0x101820));
  const fg = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.08).translate(0.43, 0, 0), material(color));
  fg.position.set(-0.43, 0, 0.001);
  bar.renderOrder = 1000;
  bg.renderOrder = 1000; fg.renderOrder = 1001;
  bar.add(bg, fg);
  scene.add(bar);
  bar.fill = fg;
  return bar;
}
function makeProjectile(character) {
  const g = new THREE.Group(), mats = [];
  const color = character === 'lucia' ? 0xc357ff : 0x76ffff;
  for (const [geo, z] of [[new THREE.IcosahedronGeometry(0.32, 1), 0], [new THREE.BoxGeometry(0.16, 0.16, 1.4), -0.8]]) {
    const mesh = add(geo, color, 0, 0.8, z, g, false);
    mesh.material.emissive.setHex(character === 'lucia' ? 0x772299 : 0x42cccc); mats.push(mesh.material);
  }
  if (character === 'lucia') g.scale.setScalar(1.4);
  return { g, mats };
}

// ---------- ネットワーク状態 ----------
let myId = null, mySlot = 0, cfg = null;
let phase = 'waiting';
let mapData = null;
const ents = {};    // 見えているプレイヤー / ロボット（id → 表示用データ）
const fxs = [];
const killTimers = new Set();
function clearKillFeed() {
  for (const timer of killTimers) clearTimeout(timer);
  killTimers.clear(); $('killFeed').replaceChildren();
}
socket.on('kill', d => {
  const entry = document.createElement('div');
  entry.className = `kill-entry${d.attacker.slot === mySlot ? '' : ' enemy'}`;
  const time = document.createElement('time'), killer = document.createElement('span'), victim = document.createElement('span');
  const seconds = Math.floor(d.time);
  time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const label = e => e.kind === 'monster' ? e.name : e.id === myId ? `自分（${e.name}）` : `${e.slot === mySlot ? '味方' : '敵'} ${e.name}`;
  killer.className = 'killer'; killer.textContent = label(d.attacker);
  victim.textContent = ` → ${label(d.victim)}${d.victim.kind === 'tower' ? 'を破壊' : 'を撃破'}`;
  entry.append(time, killer, victim); $('killFeed').prepend(entry);
  while ($('killFeed').children.length > 5) $('killFeed').lastElementChild.remove();
  const later = (fn, delay) => {
    const timer = setTimeout(() => { killTimers.delete(timer); fn(); }, delay);
    killTimers.add(timer);
  };
  later(() => entry.classList.add('fading'), 7500);
  later(() => entry.remove(), 8000);
});

function makeMonster(large, id) {
  const species = large ? 'reindeer' : Number(id.split('-').pop()) % 2 ? 'boar' : 'deer';
  const boar = species === 'boar', reindeer = species === 'reindeer';
  const g = new THREE.Group(), mats = [], limbs = [];
  g.userData.species = species;
  const coat = boar ? 0x675044 : reindeer ? 0x89705b : 0xb68450;
  const part = (geo, color, x, y, z, parent = g) => {
    const mesh = add(geo, color, x, y, z, parent); mats.push(mesh.material); return mesh;
  };
  const oval = (color, x, y, z, sx, sy, sz, parent = g) => {
    const mesh = part(new THREE.IcosahedronGeometry(1, 1), color, x, y, z, parent);
    mesh.scale.set(sx, sy, sz); return mesh;
  };
  const bodyY = boar ? 0.8 : 1.1;
  oval(coat, 0, bodyY, 0, boar ? 0.55 : 0.43, boar ? 0.55 : 0.53, 0.85);
  for (const x of [-0.3, 0.3]) for (const z of [-0.52, 0.53]) {
    const leg = new THREE.Group(); leg.position.set(x, bodyY - 0.12, z); g.add(leg); limbs.push(leg);
    const length = boar ? 0.58 : 0.88;
    part(new THREE.CylinderGeometry(0.09, 0.065, length, 6), coat, 0, -length / 2, 0, leg);
    part(new THREE.BoxGeometry(0.17, 0.14, 0.22), 0x282321, 0, -length + 0.03, 0.02, leg);
  }
  const head = new THREE.Group(); head.position.set(0, bodyY, 0.6); g.add(head);
  if (boar) {
    oval(coat, 0, 0.08, 0.23, 0.4, 0.4, 0.49, head);
    oval(0x9c7564, 0, -0.02, 0.68, 0.25, 0.2, 0.2, head);
    for (const x of [-0.1, 0.1]) oval(0x29201d, x, 0, 0.85, 0.045, 0.05, 0.02, head);
    for (const side of [-1, 1]) {
      const ear = part(new THREE.ConeGeometry(0.18, 0.4, 4), coat, side * 0.28, 0.42, 0.05, head); ear.rotation.z = -side * 0.45;
      const tusk = part(new THREE.ConeGeometry(0.075, 0.38, 6), 0xf2dfb5, side * 0.3, -0.02, 0.57, head); tusk.rotation.z = -side * 0.4;
      oval(0x131414, side * 0.34, 0.2, 0.37, 0.055, 0.065, 0.055, head);
    }
    for (let z = -0.6; z < 0.45; z += 0.22) part(new THREE.ConeGeometry(0.13, 0.26, 4), 0x3c302a, 0, 1.35, z);
  } else {
    oval(reindeer ? 0xd9cbb4 : coat, 0, 0.25, 0.12, 0.29, 0.62, 0.28, head);
    oval(coat, 0, 0.85, 0.31, 0.28, 0.31, 0.47, head);
    oval(reindeer ? 0xd7c6ac : 0xddbd94, 0, 0.73, 0.65, 0.21, 0.18, 0.24, head);
    oval(0x2c2724, 0, 0.76, 0.86, 0.16, 0.12, 0.07, head);
    for (const side of [-1, 1]) {
      const ear = oval(coat, side * 0.39, 1.02, 0.18, 0.24, 0.1, 0.15, head); ear.rotation.z = side * 0.4;
      oval(0x15191b, side * 0.25, 0.93, 0.46, 0.045, 0.055, 0.045, head);
    }
    const antler = (a, b, radius) => {
      const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), delta = to.clone().sub(from);
      const branch = part(new THREE.CylinderGeometry(radius * 0.65, radius, delta.length(), 5), 0xe2ceb0, 0, 0, 0, head);
      branch.position.copy(from.add(to).multiplyScalar(0.5));
      branch.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    };
    for (const side of [-1, 1]) {
      const base = [side * 0.18, 1.05, 0.16], elbow = [side * (reindeer ? 0.6 : 0.38), 1.55, 0];
      const tip = [side * (reindeer ? 0.88 : 0.48), reindeer ? 2.05 : 1.85, -0.12];
      antler(base, elbow, 0.07); antler(elbow, tip, 0.055);
      antler(elbow, [side * (reindeer ? 0.92 : 0.65), 1.7, 0.3], 0.045);
      if (reindeer) {
        antler([side * 0.74, 1.8, -0.06], [side * 1.12, 2.05, 0.1], 0.04);
        antler(base, [side * 0.44, 1.38, 0.57], 0.05);
        antler([side * 0.44, 1.38, 0.57], [side * 0.68, 1.62, 0.62], 0.035);
      }
    }
    oval(reindeer ? 0xefe2ce : 0xe7cfaa, 0, 1.05, -0.8, 0.15, 0.21, 0.13);
  }
  const scale = large ? 1.65 : 0.9; g.scale.setScalar(scale);
  return { g, mats, limbs, head, hpHeight: (boar ? 1.8 : reindeer ? 3.35 : 3.1) * scale };
}
function makeEnergy() {
  const g = new THREE.Group();
  add(new THREE.OctahedronGeometry(0.35), 0xffd85b, 0, 0, 0, g, false);
  return { g, mats: [] };
}
function makeDarius(color) {
  const beast = makeMonster(false, 'monster-1');
  beast.g.scale.setScalar(1.7); beast.hpHeight = 3.1;
  beast.g.userData.species = 'darius';
  for (const side of [-1, 1]) {
    const plate = add(new THREE.BoxGeometry(0.16, 0.36, 0.65), color, side * 0.5, 1, 0.25, beast.g);
    beast.mats.push(plate.material);
  }
  return beast;
}
const controlRoot = new THREE.Group(); scene.add(controlRoot);
let controlSignature = '';
function updateControlZones(zones) {
  const signature = JSON.stringify(zones.map(z => [z.slot, z.boundary]));
  if (signature === controlSignature) return;
  controlSignature = signature;
  [...controlRoot.children].forEach(disposeObject);
  for (const zone of zones) {
    const sign = zone.slot === 0 ? 1 : -1, b = zone.boundary;
    const corners = [[-30,-30], [30,-30], [30,30], [-30,30]], polygon = [];
    const value = p => sign*(p[0]-p[1])-b;
    for (let i=0; i<4; i++) {
      const a = corners[i], c = corners[(i+1)%4], va = value(a), vc = value(c);
      if (va<=0) polygon.push(a);
      if ((va<=0)!==(vc<=0)) { const t=va/(va-vc); polygon.push([a[0]+(c[0]-a[0])*t,a[1]+(c[1]-a[1])*t]); }
    }
    if (polygon.length<3) continue;
    const shape = new THREE.Shape(polygon.map(p => new THREE.Vector2(p[0],-p[1])));
    const material = new THREE.MeshBasicMaterial({color: zone.slot === mySlot ? ALLY : ENEMY, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide});
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape),material); mesh.rotation.x=-Math.PI/2; mesh.position.y=0.16; controlRoot.add(mesh);
    const points = polygon.map(p => new THREE.Vector3(p[0],0.18,p[1])); points.push(points[0]);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({color: zone.slot === mySlot ? 0x6cd7ff : 0xff8176})); controlRoot.add(line);
  }
}
function ensure(s, kind) {
  if (ents[s.id] && ents[s.id].s.character !== s.character) {
    disposeObject(ents[s.id].g);
    if (ents[s.id].bar) disposeObject(ents[s.id].bar);
    delete ents[s.id];
  }
  if (ents[s.id]) return ents[s.id];
  const color = s.slot === mySlot ? ALLY : ENEMY;
  const h = kind === 'energy' ? makeEnergy() : kind === 'monster' ? makeMonster(s.large, s.id) : kind === 'projectile' ? makeProjectile(s.character) : kind === 'tower' ? makeTower(color) : kind === 'robot' ? makeRobot(color) : s.character === 'darius' ? makeDarius(color) : makeHuman(color, s.character);
  h.g.position.set(s.x, 0, s.z);
  scene.add(h.g);
  return (ents[s.id] = Object.assign(h, { kind, bar: ['human', 'monster', 'robot', 'tower'].includes(kind) ? makeBar(kind === 'human' ? color : 0x8be0a0) : null, x: s.x, z: s.z, face: s.face, s, phase: 0, swing: 0, flash: 0 }));
}

socket.on('init', d => {
  skillAim.cancel();
  for (const f of fxs) disposeObject(f.g);
  fxs.length = 0;
  updateControlZones([]);
  clearKillFeed();
  clearKeys();
  [...mapRoot.children].forEach(disposeObject);
  crystals.length = 0; bushes.length = 0;
  for (const id of Object.keys(ents)) {
    disposeObject(ents[id].g);
    if (ents[id].bar) disposeObject(ents[id].bar);
    delete ents[id];
  }
  myId = d.id; mySlot = d.slot; cfg = d.cfg;
  mapData = d.map;
  CAM_OFF.set(0, 26, mySlot === 1 ? -20 : 20);
  const sp = d.map.spawns[mySlot];
  camera.position.set(sp.x + CAM_OFF.x, CAM_OFF.y, sp.z + CAM_OFF.z);
  camera.lookAt(sp.x, 0, sp.z);
  buildMap(d.map, mySlot);
  const energyRing = add(new THREE.RingGeometry(2.8, 3, 64), 0xffd85b, 0, 0.2, 0, mapRoot, false);
  energyRing.rotation.x = -Math.PI / 2;
  $('msg').textContent = '';
});
socket.on('full', () => { $('msg').textContent = '満員です（2人まで）'; });

socket.on('state', st => {
  phase = st.phase;
  const self = st.players.find(p => p.id === myId);
  if (self?.character) cfg = ArenaWorld.configFor(self.character);
  const seen = new Set();
  st.players.forEach(s => { if (s.vis) { seen.add(s.id); ensure(s, 'human').s = s; } });   // ブッシュ内の敵は vis=false で座標なし
  st.robots.forEach(s => { seen.add(s.id); ensure(s, 'robot').s = s; });
  st.towers.forEach(s => { seen.add(s.id); ensure(s, 'tower').s = s; });
  (st.monsters || []).forEach(s => { seen.add(s.id); ensure(s, 'monster').s = s; });
  (st.energy || []).forEach(s => { seen.add(s.id); ensure({ ...s, slot: 2, face: 0 }, 'energy').s = { ...s, slot: 2, face: 0 }; });
  updateControlZones(st.control || []);
  st.projectiles.forEach(s => { seen.add(s.id); ensure(s, 'projectile').s = s; });
  skillAim.update();
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
  const color = d.boosted ? 0xff3535 : ['abyss', 'abyssHit', 'warp', 'warpHit', 'stealth'].includes(d.kind) ? 0xbb55ff : ['magic', 'magicHit', 'wind'].includes(d.kind) ? 0x76ffff : d.kind === 'shield' ? 0x72bbff : 0xe6c15a;
  if (e.kind === 'tower') arc(d.x, d.z, d.face, cfg.tower.range, 0.06, color);
  else if (d.kind === 'q') arc(d.x, d.z, d.face, d.range, d.halfArc, color);
  else if (d.kind === 'atk') arc(d.x, d.z, d.face, e.kind === 'robot' ? 1.8 : 2.4, 0.55, color);
  else if (d.kind === 'shield') arc(d.x, d.z, d.face, 2, Math.PI, color);
  else if (d.kind === 'leapHit') arc(d.x, d.z, d.face, d.range, Math.PI, color);
  else if (['magicHit', 'wind'].includes(d.kind)) arc(d.x, d.z, d.face, 1.5, Math.PI, color);
  else if (d.kind === 'warpHit') arc(d.x, d.z, d.face, d.range, Math.PI, color);
  else if (['warp', 'stealth', 'abyssHit'].includes(d.kind)) arc(d.x, d.z, d.face, 1.5, Math.PI, color);
  else if (['grab', 'uppercut'].includes(d.kind)) arc(d.x, d.z, d.face, d.range, d.halfArc, 0xffa358);
  else if (['charge', 'chargeHit', 'throw'].includes(d.kind)) arc(d.x, d.z, d.face, 2, 0.7, 0xffa358);
  else if (d.kind === 'throwImpact') arc(d.x, d.z, d.face, 2, Math.PI, 0xffa358);
});
socket.on('heal', d => { const e = ents[d.id]; if (e) dmgText(e, `+${d.amount}`, false, '#8bffae'); });

socket.on('hit', d => {
  const e = ents[d.id];
  if (!e) return;
  e.flash = 0.12;
  dmgText(e, d.dmg, d.boosted);
});

function hud(st) {
  const list = st.players;
  const m = list.find(s => s.id === myId), enemies = list.filter(s => s.slot !== mySlot), allies = list.filter(s => s.slot === mySlot);
  if (!m || !cfg) return;
  const locked = socket.readOnly || m.dead || m.stun > 0 || m.warping > 0 || m.air > 0 || m.charging || m.grabbing || m.grabbed || m.flying || phase !== 'playing';
  for (const key of ['q', 'e', 'c', 'b']) $(key + 'Skill').disabled = locked || (key !== 'b' && m[key + 'Cd'] > 0);
  $('touchAttack').disabled = locked;
  touchControls?.update();
  $('playerHpFill').style.width = `${Math.max(0, m.hp / m.maxHp) * 100}%`;
  $('enemyHpFill').style.width = enemies.length ? `${Math.max(0, enemies.reduce((n, p) => n + p.hp, 0) / enemies.reduce((n, p) => n + p.maxHp, 0)) * 100}%` : '0%';
  $('foeBar').title = enemies.length > 1 ? '敵チームの合計HP' : '敵のHP';
  const character = ArenaWorld.characterFor(m.character);
  if (character) for (const key of ['q', 'e', 'c']) {
    $(key + 'Label').textContent = character.skills[key].name;
    $(key + 'Skill').title = character.skills[key].text;
  }
  $('qCooldown').style.height = `${(m.qCd / cfg.qCd) * 100}%`;
  $('eCooldown').style.height = `${(m.eCd / cfg.eCd) * 100}%`;
  $('cCooldown').style.height = `${(m.cCd / cfg.cCd) * 100}%`;
  $('recallProgress').style.height = `${m.recall > 0 ? (1 - m.recall / cfg.recallTime) * 100 : 0}%`;
  $('score').textContent = `${allies.reduce((n, p) => n + p.kills, 0)} - ${enemies.reduce((n, p) => n + p.kills, 0)}`;
  $('teamRosterHud').hidden = list.length <= 2;
  if (list.length > 2) {
    $('teamRosterSummary').textContent = `チーム状況　味方 ${allies.length}人 / 敵 ${enemies.length}人`;
    const rows = [];
    for (const p of [...allies, ...enemies]) {
      const row = document.createElement('div'); row.className = p.slot === mySlot ? 'team-hud-ally' : 'team-hud-enemy';
      row.textContent = `${p.id === myId ? '自分 ' : ''}${ArenaWorld.characterFor(p.character)?.name || '選択中'} ${p.bot ? 'CPU ' : ''}${p.dead ? '復活待ち' : `HP ${Math.ceil(p.hp)}/${p.maxHp}`}`;
      rows.push(row);
    }
    $('teamRosterRows').replaceChildren(...rows);
  }
  const own = st.towers.filter(t => t.slot === mySlot && !t.dead).length;
  const enemy = st.towers.filter(t => t.slot !== mySlot && !t.dead).length;
  $('objective').textContent = `タワー残り　自陣 ${own}/5　敵陣 ${enemy}/5｜エネルギー ${m.energy || 0}｜自陣領域 ${Math.round(100 * (1 + (st.control?.[mySlot]?.boundary || 0) / 60) ** 2)}%`;
  $('status').textContent = `${socket.mode === 'series' ? '自動対戦・観戦' : st.cpu ? 'CPU対戦' : st.solo ? 'オフライン' : 'オンライン対戦'}｜${character?.name || ''}｜次回の復活 ${m.respawnTime}秒${m.safe ? '｜安全地帯：無敵・HP急速回復' : ''}${m.shield > 0 ? '｜ダメージ50%軽減中' : ''}${m.speedBoost > 0 ? `｜移動速度2倍 ${m.speedBoost.toFixed(1)}秒` : ''}`;
  $('status').title = character?.passive || '';
  if (socket.replaying) $('status').textContent = 'リプレイ｜' + $('status').textContent;
  if (m.stealth > 0) $('status').textContent += `｜透明化 ${m.stealth.toFixed(1)}秒`;
  $('msg').textContent = st.phase === 'finished' ? (st.winner === mySlot ? '勝利！ 敵タワーを全て破壊しました' : '敗北 — 自陣タワーが全て破壊されました')
    : st.phase === 'waiting' ? '対戦相手を待っています…（1人用テストも選べます）'
    : m.dead ? `リスポーンまで ${Math.ceil(m.respawn)}秒`
    : m.stun > 0 ? 'スタン中'
    : m.grabbed ? '掴まれています'
    : m.flying ? '空中に投げ飛ばされています'
    : m.grabbing ? '敵を掴んでいます'
    : m.charging ? '猪突猛進！'
    : m.warping > 0 ? `魔影転移・無敵… ${m.warping.toFixed(1)}秒`
    : skillAim.current ? `${character.skills[skillAim.current.key].name}：${touchControls?.active ? '地面をタップして発動／×でキャンセル' : gameControls.mode === 'hold' ? 'キーを離すか左クリックで発動' : '左クリックで発動・同じキーでキャンセル'}${touchControls?.active ? '' : '（右クリック・Escでキャンセル）'}`
    : m.recall > 0 ? `リコール中… ${m.recall.toFixed(1)}秒（移動・攻撃・被ダメージで中断）` : '';
}

$('restart').addEventListener('click', () => { skillAim.cancel(); clearKillFeed(); socket.emit('restart'); });
socket.on('lobby', () => { skillAim.cancel(); clearKillFeed(); phase = 'waiting'; clearKeys(); myId = null; });
socket.on('disconnect', reason => { skillAim.cancel(); phase = 'waiting'; clearKeys(); if (reason !== 'io server disconnect') $('msg').textContent = '接続が切れました。再接続中…'; });
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

function dmgText(e, n, boosted = false, color = null) {
  const v = new THREE.Vector3(e.x, e.kind === 'tower' ? 4.8 : e.kind === 'robot' ? 1.9 : 2.8, e.z).project(camera);
  const d = document.createElement('div');
  d.className = 'dmg';
  d.textContent = n;
  if (boosted) d.style.color = '#ff4545';
  if (color) d.style.color = color;
  d.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
  d.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 700);
}

// ---------- 入力（WASD / 右クリック移動 / Q・E・C・B） ----------
const ray = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const pt = new THREE.Vector3(), ndc = new THREE.Vector2();
let mouse = { clientX: innerWidth / 2, clientY: innerHeight / 2 }, aim = { x: 0, z: 0 };
let touchControls = null, touchTarget = null, touchMove = { x: 0, z: 0 };
const heldKeys = new Set();
let lastSteer = 0;
function aimRing(color) {
  const mesh = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 64), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.8, depthWrite: false }));
  mesh.rotation.x = -Math.PI / 2; mesh.visible = false; scene.add(mesh); return mesh;
}
const leapRangeRing = aimRing(0x8fd9ff), leapPointRing = aimRing(0x8be0a0);
const skillArea = new THREE.Group();
const skillAreaMesh = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ color: 0x72d8ff, side: THREE.DoubleSide, transparent: true, opacity: 0.22, depthWrite: false }));
skillAreaMesh.rotation.x = -Math.PI / 2; skillArea.add(skillAreaMesh); skillArea.visible = false; scene.add(skillArea);
const skillLine = new THREE.Group();
const skillLineMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x72ffff, side: THREE.DoubleSide, transparent: true, opacity: 0.4, depthWrite: false }));
skillLineMesh.rotation.x = -Math.PI / 2; skillLine.add(skillLineMesh);
const skillArrow = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.7, 3), new THREE.MeshBasicMaterial({ color: 0x9bffff }));
skillArrow.rotation.x = Math.PI / 2; skillLine.add(skillArrow); skillLine.visible = false; scene.add(skillLine);
const skillAim = createSkillAim({
  mode: () => gameControls.mode,
  self: () => ents[myId]?.s,
  playing: () => phase === 'playing' && !socket.readOnly,
  point: () => touchTarget || groundAt(mouse),
  validLeap: validLeapPoint,
  emit: (event, data) => { if (event === 'leap' || (event === 'dash' && data)) clearKeys(); socket.emit(event, data); },
  changed: current => {
    if (!current) touchTarget = null;
    touchControls?.update();
    canvas.style.cursor = current ? 'crosshair' : '';
    const color = current?.character === 'lucia' ? 0xc58cff : current?.character === 'darius' ? 0xffa358 : 0x72d8ff;
    skillAreaMesh.material.color.setHex(color); skillLineMesh.material.color.setHex(color); skillArrow.material.color.setHex(color);
    if (current?.kind === 'cone') {
      skillAreaMesh.geometry.dispose();
      skillAreaMesh.geometry = new THREE.CircleGeometry(1, 64, -cfg.qArc, cfg.qArc * 2);
    }
  },
});
function validLeapPoint(point, self) {
  if (!mapData) return false;
  const blocks = [...mapData.obst, ...Object.values(ents).filter(e => e.kind === 'tower' && !e.s.dead).map(e => ({ x: e.s.x, z: e.s.z, r: cfg.tower.radius }))];
  return ArenaWorld.validLanding(self, point, { range: cfg.leapRange, radius: cfg.radius, half: mapData.half, blocks, safe: { ...mapData.spawns[1 - mySlot], r: cfg.safeRadius }, travel: self.character === 'alex' });
}
function sendKeys() {
  const sign = mySlot === 1 ? -1 : 1;
  let x = Number(heldKeys.has('d')) - Number(heldKeys.has('a')) + touchMove.x;
  let z = Number(heldKeys.has('s')) - Number(heldKeys.has('w')) + touchMove.z;
  const length = Math.max(1, Math.hypot(x,z));
  socket.emit('steer', { x: x / length * sign, z: z / length * sign });
  lastSteer = performance.now();
}
function clearKeys() {
  heldKeys.clear();
  touchControls?.reset(); touchMove = { x: 0, z: 0 };
  if (myId && socket.connected) sendKeys();
}
addEventListener('controlschange', () => { skillAim.cancel(); clearKeys(); });
addEventListener('blur', () => { skillAim.cancel(); clearKeys(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { skillAim.cancel(); clearKeys(); } });
document.addEventListener('pointerdown', ev => {
  if (ev.target !== canvas && !ev.target.closest('[data-touch-control], #skills')) { skillAim.cancel(); clearKeys(); }
}, { capture: true });
addEventListener('keyup', ev => {
  const key = gameControls.action(ev.code);
  if (heldKeys.delete(key)) sendKeys();
  if (ev.target.closest('button, a, input, textarea, select, [contenteditable]')) skillAim.cancel();
  else skillAim.release(key);
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
  if (ev.sourceCapabilities?.firesTouchEvents) return;
  if (!myId || phase !== 'playing' || socket.readOnly) return;
  if (skillAim.current) {
    if (ev.button === 2) skillAim.cancel();
    else if (ev.button === 0) skillAim.confirm(groundAt(ev));
    return;
  }
  if (ev.button !== 2) return;
  commandAt(ev);
});
function commandAt(ev) {
  const g = groundAt(ev);
  const enemies = Object.values(ents).filter(e => !['projectile', 'energy'].includes(e.kind) && e.s.slot !== mySlot && !e.s.dead);
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
}
addEventListener('keydown', ev => {
  if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey || !myId || phase !== 'playing' || socket.readOnly || ev.target.closest('button, a, input, textarea, select, [contenteditable]')) return;
  const k = gameControls.action(ev.code);
  if (ev.code === 'Escape') { skillAim.cancel(); return; }
  if (['w', 'a', 's', 'd'].includes(k)) {
    ev.preventDefault(); heldKeys.add(k); sendKeys();
  } else if (k === 'c' && ents[myId]?.s.character === 'lucia') {
    skillAim.cancel(); socket.emit('c');
  } else if (['q', 'c'].includes(k) || (k === 'e' && ['alex', 'lucia', 'darius'].includes(ents[myId]?.s.character))) {
    ev.preventDefault(); skillAim.begin(k);
  } else if (k === 'e') { skillAim.cancel(); socket.emit('dash'); }
  else if (k === 'b') { skillAim.cancel(); clearKeys(); socket.emit('recall'); }
});

// ---------- 描画ループ ----------
touchControls = createTouchControls({
  canvas, stick: $('touchStick'), knob: $('touchKnob'), skills: { q: $('qSkill'), e: $('eSkill'), c: $('cSkill'), b: $('bSkill') },
  attackButton: $('touchAttack'), cancelButton: $('touchCancel'), aim: skillAim,
  canPlay: () => {
    const s = ents[myId]?.s;
    return phase === 'playing' && !socket.readOnly && s && !s.dead && !(s.stun > 0) && !(s.air > 0) && !(s.warping > 0) && !s.charging && !s.grabbing && !s.grabbed && !s.flying;
  },
  move: (x,z) => { touchMove = { x,z }; if (myId) sendKeys(); },
  targetAt: groundAt, setTarget: point => { touchTarget = point; }, command: commandAt,
  defaultTarget: key => {
    const s = ents[myId].s, distance = Math.min(key === 'e' ? cfg.leapRange : key === 'q' ? cfg.qRange : cfg.cRange || cfg.magicRange, 4);
    return { x: s.x + Math.sin(s.face)*distance, z: s.z + Math.cos(s.face)*distance };
  },
  instant: key => (key === 'e' && ['mira','bastion'].includes(ents[myId]?.s.character)) || (key === 'c' && ents[myId]?.s.character === 'lucia'),
  activate: key => socket.emit(key === 'e' ? 'dash' : key),
  recall: () => { clearKeys(); socket.emit('recall'); },
  attack: () => {
    const me = ents[myId];
    const enemy = Object.values(ents).filter(e => !['energy','projectile'].includes(e.kind) && e.s.slot !== mySlot && !e.s.dead && Math.hypot(e.x-me.x,e.z-me.z) <= 14)
      .sort((a,b) => Math.hypot(a.x-me.x,a.z-me.z)-Math.hypot(b.x-me.x,b.z-me.z))[0];
    if (enemy) socket.emit('chase', { id: enemy.s.id });
  },
});
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
  if (!socket.rendering) { requestAnimationFrame(frame); return; }
  const k = 1 - Math.exp(-dt * 20);
  if (phase === 'playing' && (heldKeys.size || touchMove.x || touchMove.z) && performance.now() - lastSteer >= 100) sendKeys();

  for (const e of Object.values(ents)) {
    const s = e.s;
    e.x += (s.x - e.x) * k;
    e.z += (s.z - e.z) * k;
    e.face += Math.atan2(Math.sin(s.face - e.face), Math.cos(s.face - e.face)) * k;

    e.swing = Math.max(0, e.swing - dt);
    e.flash = Math.max(0, e.flash - dt);
    if (e.kind === 'energy') { e.g.position.set(e.x, 0.8 + Math.sin(t*3)*0.15, e.z); e.g.rotation.y += dt; continue; }
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

    e.g.visible = !s.dead && !(s.warping > 0);
    e.mats.forEach(m => { m.transparent = s.stealth > 0; m.opacity = s.stealth > 0 ? 0.35 : 1; });
    e.g.position.set(e.x, (s.air || 0) + (s.moving ? Math.abs(Math.sin(e.phase)) * 0.08 : 0), e.z);
    e.g.rotation.y = e.face;
    if (e.limbs) {
      e.limbs.forEach((leg, i) => { leg.rotation.x = w * (i === 0 || i === 3 ? 1 : -1) * 0.55; });
      e.head.rotation.x = e.swing > 0 ? Math.sin(e.swing / 0.25 * Math.PI) * 0.35 : 0;
    } else {
      e.legL.rotation.x = w;
      e.legR.rotation.x = -w;
      e.armL.rotation.x = -w * 0.8;
      e.armR.rotation.x = e.swing > 0 ? -2.6 + 3 * (1 - e.swing / 0.25) : w * 0.8;
    }
    e.mats.forEach(m => m.emissive.setHex(e.flash > 0 ? 0x992222 : s.stun > 0 ? 0x776600 : e.swing > 0 && e.attackBoost ? 0xaa1010 : s.shield > 0 ? 0x224477 : s.speedBoost > 0 ? 0x226655 : 0x000000));

    if (e.bar) {
      e.bar.visible = !s.dead && !(s.warping > 0) && (e.kind !== 'human' || gameControls.hpBar === 'overhead');
      const height = (e.hpHeight || (e.kind === 'human' ? 2.8 : 1.85)) + (s.air || 0);
      e.bar.position.set(e.x, height, e.z);
      e.bar.scale.setScalar(e.kind === 'human' ? 2 : e.kind === 'monster' ? (s.large ? 2.6 : 1.5) : 1);
      e.bar.quaternion.copy(camera.quaternion);
      e.bar.fill.scale.x = Math.max(0.001, s.hp / s.maxHp);
    }
  }

  const me = ents[myId];
  const targeting = skillAim.current, showingAim = !!targeting && !!me && phase === 'playing';
  leapRangeRing.visible = showingAim && ['leap', 'warp', 'charge', 'cone'].includes(targeting.kind);
  leapPointRing.visible = showingAim && ['leap', 'warp', 'charge'].includes(targeting.kind);
  skillArea.visible = showingAim && targeting.kind === 'cone';
  skillLine.visible = showingAim && ['projectile', 'summon', 'charge'].includes(targeting.kind);
  if (showingAim) {
    const point = touchTarget || groundAt(mouse);
    const face = Math.atan2(point.x - me.x, point.z - me.z);
    leapRangeRing.position.set(me.x, 0.14, me.z);
    leapRangeRing.scale.setScalar(['leap', 'warp', 'charge'].includes(targeting.kind) ? cfg.leapRange : targeting.key === 'c' ? cfg.cRange : cfg.qRange);
    if (targeting.kind === 'charge') {
      leapPointRing.position.set(point.x, 0.15, point.z); leapPointRing.scale.setScalar(cfg.radius);
      leapPointRing.material.color.setHex(validLeapPoint(point, me.s) ? 0x8be0a0 : 0xff4545);
    }
    if (['leap', 'warp'].includes(targeting.kind)) {
      leapPointRing.position.set(point.x, 0.15, point.z); leapPointRing.scale.setScalar(cfg.leapHitRange);
      leapPointRing.material.color.setHex(validLeapPoint(point, me.s) ? 0x8be0a0 : 0xff4545);
    } else if (targeting.kind === 'cone') {
      skillArea.position.set(me.x, 0.13, me.z); skillArea.rotation.y = face - Math.PI / 2;
      skillArea.scale.setScalar(targeting.key === 'c' ? cfg.cRange : cfg.qRange);
    } else {
      const length = targeting.kind === 'charge' ? Math.min(cfg.leapRange, Math.hypot(point.x-me.x, point.z-me.z)) : targeting.kind === 'projectile' ? targeting.key === 'q' ? cfg.qRange : cfg.magicRange : 2.4;
      skillLine.position.set(me.x, 0.15, me.z); skillLine.rotation.y = face;
      skillLineMesh.scale.set(targeting.kind === 'charge' ? cfg.radius*2 : targeting.kind === 'projectile' ? (targeting.key === 'q' ? cfg.qRadius : cfg.magicRadius) * 2 : 0.5, length, 1);
      skillLineMesh.position.z = length / 2; skillArrow.position.set(0, 0, length);
    }
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

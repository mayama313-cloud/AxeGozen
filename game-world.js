const HALF = 30, TICK = 30, DT = 1 / TICK;
const CFG = {
  maxHp: 200, speed: 9, radius: 0.7,
  atkRange: 2.4, atkCd: 0.8, atkDmg: 10,
  qRange: 4, qArc: Math.PI / 3, qCd: 5, qDmg: 23, qStun: 0.3,
  dashSpeed: 40, dashTime: 0.18, eCd: 3, cCd: 8,
  robot: { hp: 40, dmg: 5, atkCd: 0.7, atkRange: 1.8, speed: 7, radius: 0.4, aggro: 9, leash: 14, life: 20, max: 5, batch: 3 },
  safeRadius: 4, safeHeal: 80,
  tower: { hp: 300, radius: 1.1, count: 5, range: 7, dmg: 5, atkCd: 1 },
  recallTime: 5, inputTimeout: 0.35,
  leapRange: 8, leapTime: 0.45, leapDmg: 45, leapStun: 1, leapHitRange: 2.4,
  windTime: 3, windMultiplier: 2,
  magicRange: 14, magicSpeed: 45, magicRadius: 0.35, magicPull: 6, magicStun: 1.5, magicDmg: 30,
  respawn: 5, respawnPerTower: 5,
  controlHeal: 8, controlDamage: 12, energyShrink: 0.15, energyInterval: 8,
};
const R = CFG.robot;
const CHARACTERS = [
  { id: 'alex', name: 'アレックス', role: 'タワー攻略', color: '#ee675d',
    passive: '攻城の血脈：自身と自身の召喚ユニットが、敵タワー・召喚ユニットに与えるダメージが2倍。適用時の攻撃は赤く発光。',
    skills: { q: { name: 'クレセント', text: '前方を23ダメージで斬り、0.3秒スタン。' }, e: { name: 'ラッシュ', text: 'E長押しで照準、キーを離すか左クリックで射程8の着地点を確定。着地後に近くの敵1体へ45ダメージ・1秒スタン。CD30秒。右クリック・Escで照準解除。' }, c: { name: 'アサルト部隊', text: 'ミニオンを3体召喚。最大5体。他のユニットを避けて敵タワーへ進軍し、途中の敵と戦う。' } }, stats: { eCd: 30, qDmg: 23, leapDmg: 45 }, robot: {} },
  { id: 'mira', name: 'ミラ', role: '機動力・遠めの範囲攻撃', color: '#7ddbd3',
    passive: '風の足取り：移動速度が9から11に上昇。',
    skills: { q: { name: 'フロストファン', text: '射程14の扇形に22ダメージ、2秒スタン。' }, e: { name: 'ウィンドステップ', text: '3秒間、移動速度が2倍（11→22）。CD10秒。' }, c: { name: 'マジックスカウト', text: 'カーソル方向へ射程14の高速魔法を放つ。最初に当たった敵ユニットに30ダメージ、最大6引き寄せ、1.5秒スタン。CD8秒。' } },
    stats: { atkRange: 8, speed: 11, qRange: 14, qArc: Math.PI / 5, qDmg: 22, qStun: 2, qCd: 6, eCd: 10 }, robot: {} },
  { id: 'bastion', name: 'バスティオン', role: '耐久・防衛', color: '#e8bc65',
    passive: '不屈の体：最大HPが200から280に上昇。',
    skills: { q: { name: 'グラウンドブレイク', text: '周囲3.5の敵に20ダメージ、0.5秒スタン。' }, e: { name: 'アイアンガード', text: '2秒間、受けるダメージを50%軽減。クールダウン6秒。' }, c: { name: 'ガーディアン部隊', text: 'HP70・速度5・攻撃力4の守護ユニットを3体召喚。最大5体。' } },
    stats: { maxHp: 280, speed: 8.5, qRange: 3.5, qArc: Math.PI, qDmg: 20, qStun: 0.5, qCd: 7, eCd: 6, cCd: 10 }, robot: { hp: 70, dmg: 4, speed: 5 } },
  { id: 'lucia', name: 'ルシア', role: '悪魔・吸収・奇襲', color: '#c58cff',
    passive: '悪魔の渇望：敵キャラクターに実際に与えたダメージの10%をHPとして回復。',
    skills: { q: { name: '禍球', text: '射程12の禍々しい球を放ち、最初に当たった敵ユニットに50ダメージ。命中時に自身のHPを30回復。CD6秒。' }, e: { name: '魔影転移', text: '指定地点へ1秒間姿を消してからワープし、半径3に40ダメージ。射程8、CD12秒。' }, c: { name: '闇の帳', text: '5秒間、敵から見えなくなる。攻撃しても解除されない。CD20秒。' } },
    stats: { qRange: 12, qDmg: 50, qStun: 0, qCd: 6, qSpeed: 26, qRadius: 0.45, qHeal: 30, eCd: 12, cCd: 20, leapRange: 8, leapHitRange: 3, warpTime: 1, warpDmg: 40, lifeSteal: 0.1 }, robot: {} },
];
const characterFor = id => CHARACTERS.find(c => c.id === id);
const configFor = id => { const c = characterFor(id) || CHARACTERS[0]; return { ...CFG, ...c.stats, robot: { ...R, ...c.robot } }; };
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
const protectedUnit = e => e.slot < 2 && !e.tower && dist(e, SPAWNS[e.slot]) <= CFG.safeRadius;

// 着地点に本体の円が収まればよい。途中の壁や範囲攻撃の大きさは問わない。
function validLanding(from, to, { range, radius, half, blocks, safe, travel = false }) {
  if (!isNum(to?.x, to?.z) || dist(from, to) > range + 1e-8) return false;
  const edge = Math.min(half - 1, half - radius);
  if (Math.abs(to.x) > edge + 1e-8 || Math.abs(to.z) > edge + 1e-8) return false;
  // 実際に空中を移動するラッシュは、敵の安全地帯を横切らない。
  if (travel) {
    const dx = to.x - from.x, dz = to.z - from.z, length2 = dx * dx + dz * dz;
    const t = length2 ? Math.max(0, Math.min(1, ((safe.x - from.x) * dx + (safe.z - from.z) * dz) / length2)) : 0;
    if (Math.hypot(from.x + dx * t - safe.x, from.z + dz * t - safe.z) + 1e-8 < safe.r + radius) return false;
  }
  return [...blocks, safe].every(o => dist(to, o) + 1e-8 >= o.r + radius);
}

function createMatch(solo = false) {
  const players = {}, robots = {}, towers = {}, projectiles = {}, monsters = {}, energy = {};
  const environment = { enabled: true, totals: [0, 0] };
  let energySeq = 0, energyTimer = 0;
  const camps = [{ x: 0, z: 3, large: true }, ...[-1, 1].flatMap(side => [-7, 0, 7].map(z => ({ x: side * 23, z, large: false })))].map((c, i) => ({ ...c, id: `monster-${i}`, timer: 5 }));
  const boundary = slot => Math.max(-42, -environment.totals[1 - slot] * CFG.energyShrink) || 0;
  const inControl = (e, slot) => (slot === 0 ? e.x - e.z : e.z - e.x) < boundary(slot);
  function award(a, amount) {
    const p = isRobot(a) ? players[a.owner] : players[a.id];
    if (!p) return;
    p.energy += amount; environment.totals[p.slot] += amount;
  }
  let robotSeq = 0, projectileSeq = 0, killSeq = 0, elapsed = 0, winner = null, phase = 'waiting';
  const active = () => phase === 'playing' && winner === null;
  const units = () => [...Object.values(players), ...Object.values(robots), ...Object.values(monsters)];
  const targets = () => [...units(), ...Object.values(towers)];
  const unit = id => players[id] || robots[id] || towers[id] || monsters[id];
  const isAlexMinion = e => isRobot(e) && (e.character || players[e.owner]?.character) === 'alex';
  const destroyed = slot => Object.values(towers).filter(t => t.slot === slot && t.dead).length;
  const updateBush = e => { e.bush = BUSHES.findIndex(b => dist(e, b) < b.r); };
  function canSee(slot, e) {
    if (e.slot === slot || e.tower) return true;
    if (e.stealth > 0 || e.warp) return false;
    return e.bush < 0 || units().some(u => u.slot === slot && !u.dead && u.bush === e.bush);
  }
  const damageable = (a, b) => b && !b.dead && b.slot !== a.slot && !protectedUnit(b);
  const attackable = (a, b) => damageable(a, b) && canSee(a.slot, b);
  function emitSee(src, ev, data) {
    for (const v of Object.values(players)) if (canSee(v.slot, src)) v.socket.emit(ev, data);
  }
  const boosted = (a, b) => (isRobot(a) ? players[a.owner]?.character : a.character) === 'alex' && (b.tower || isRobot(b));
  const fx = (p, kind, extra = {}) => emitSee(p, 'fx', { id: p.id, character: p.character, kind, x: r2(p.x), z: r2(p.z), face: r2(p.face), ...extra });
  const attack = (a, b, dmg) => {
    fx(a, 'atk', { boosted: boosted(a, b) });
    if (a.character === 'mira' && !isRobot(a)) {
      const id = 'm' + (++projectileSeq);
      const bolt = projectiles[id] = { id, owner: a.id, slot: a.slot, character: 'mira', kind: 'basic', x: a.x, z: a.z, face: ang(a, b), remaining: a.cfg.atkRange + 2 };
      updateBush(bolt);
    } else hit(a, b, dmg);
  };

  function pushOut(e) {
    // 障害物と生存タワーは通り抜けられない。
    for (const o of [...OBST, ...Object.values(towers).filter(t => !t.dead).map(t => ({ ...t, r: t.radius }))]) {
      const d = dist(e, o), min = o.r + e.radius + (isAlexMinion(e) ? 0.05 : 0);
      if (d < min) {
        e.x = o.x + (d ? (e.x - o.x) / d : 1) * min;
        e.z = o.z + (d ? (e.z - o.z) / d : 0) * min;
      }
    }
    if (e.monster) { e.x = clamp(e.x); e.z = clamp(e.z); return; }
    const s = SPAWNS[1 - e.slot], d = dist(e, s), min = CFG.safeRadius + e.radius + (isAlexMinion(e) ? 0.05 : 0.01);
    if (d < min) {
      const fallback = SPAWNS[e.slot];
      const dx = d ? (e.x - s.x) / d : (fallback.x - s.x) / dist(fallback, s);
      const dz = d ? (e.z - s.z) / d : (fallback.z - s.z) / dist(fallback, s);
      e.x = s.x + dx * min; e.z = s.z + dz * min;
    }
    e.x = clamp(e.x); e.z = clamp(e.z);
  }
  function separateAlexMinions() {
    const live = units().filter(e => !e.dead);
    function slideApart(mover, anchor, min) {
      const heading = ang(anchor, mover);
      let fallback = null;
      for (const turn of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.8, -1.8, 2.2, -2.2, 2.6, -2.6, Math.PI]) {
        const candidate = { ...mover, x: anchor.x + Math.sin(heading + turn) * min, z: anchor.z + Math.cos(heading + turn) * min };
        pushOut(candidate);
        if (dist(candidate, anchor) < min - 0.0001) continue;
        fallback ||= candidate;
        if (live.some(e => e !== mover && e !== anchor && dist(candidate, e) < mover.radius + e.radius + 0.03)) continue;
        mover.x = candidate.x; mover.z = candidate.z;
        return;
      }
      if (fallback) { mover.x = fallback.x; mover.z = fallback.z; }
    }
    // プレイヤーや他キャラのユニットは押さず、アレックスのミニオン側で避ける。
    for (let pass = 0; pass < 24; pass++) {
      let overlap = false;
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j], moveA = isAlexMinion(a), moveB = isAlexMinion(b);
        if (!moveA && !moveB) continue;
        const d = dist(a, b), min = a.radius + b.radius + 0.04;
        if (d >= min - 0.0001) continue;
        // 同じ座標に召喚された場合も、IDから安定した分離方向を決める。
        const seed = [...a.id + ':' + b.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 0);
        const angle = seed % 6283 / 1000;
        const dx = d > 1e-8 ? (a.x - b.x) / d : Math.cos(angle);
        const dz = d > 1e-8 ? (a.z - b.z) / d : Math.sin(angle);
        const amount = min - d, share = moveA && moveB ? 0.5 : 1;
        if (moveA) { a.x += dx * amount * share; a.z += dz * amount * share; }
        if (moveB) { b.x -= dx * amount * share; b.z -= dz * amount * share; }
        if (moveA) pushOut(a);
        if (moveB) pushOut(b);
        // 壁やタワーに挟まれて真横に押せない場合は、周囲の空きへずらす。
        if (dist(a, b) < min - 0.0001) {
          if (moveA) slideApart(a, b, min);
          if (moveB && dist(a, b) < min - 0.0001) slideApart(b, a, min);
        }
        overlap = true;
      }
      for (const e of live) if (isAlexMinion(e)) pushOut(e);
      if (!overlap) break;
    }
    for (const e of live) if (isAlexMinion(e)) updateBush(e);
  }
  function navigationBlocks(r) {
    return [...OBST, ...Object.values(towers).filter(t => !t.dead).map(t => ({ x: t.x, z: t.z, r: t.radius })),
      ...units().filter(e => e !== r && !e.dead).map(e => ({ x: e.x, z: e.z, r: e.radius })),
      ...(r.slot < 2 ? [{ ...SPAWNS[1 - r.slot], r: CFG.safeRadius }] : SPAWNS.map(s => ({ ...s, r: CFG.safeRadius })))];
  }
  function clearSegment(a, b, radius, blocks) {
    if (Math.abs(b.x) > HALF - 1 || Math.abs(b.z) > HALF - 1) return false;
    const dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
    return blocks.every(o => {
      const t = length2 ? Math.max(0, Math.min(1, ((o.x - a.x) * dx + (o.z - a.z) * dz) / length2)) : 0;
      return Math.hypot(a.x + dx * t - o.x, a.z + dz * t - o.z) >= o.r + radius + 0.03;
    });
  }
  function findPath(r, goal, stop, blocks) {
    const key = (x, z) => `${x},${z}`;
    // 実座標から安全に入れる最寄りのグリッドを起点にする。
    let start = null, nearest = Infinity;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const n = { x: Math.round(r.x) + dx, z: Math.round(r.z) + dz };
      const d = dist(r, n);
      if (d < nearest && clearSegment(r, n, r.radius, blocks)) { start = n; nearest = d; }
    }
    if (!start) return [];
    const open = [start], nodes = new Map([[key(start.x, start.z), start]]), closed = new Set();
    start.cost = 0; start.score = dist(start, goal);
    // 到達不能な目的地でも、1回の探索でフレーム全体を使い切らない。
    let explored = 0;
    while (open.length && explored++ < 512) {
      let best = 0;
      for (let i = 1; i < open.length; i++) if (open[i].score < open[best].score) best = i;
      const current = open.splice(best, 1)[0], id = key(current.x, current.z);
      if (dist(current, goal) <= stop) {
        const path = [];
        for (let n = current; n; n = n.parent) path.unshift({ x: n.x, z: n.z });
        return path;
      }
      closed.add(id);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const next = { x: current.x + dx, z: current.z + dz }, nextId = key(next.x, next.z);
        if (closed.has(nextId) || !clearSegment(current, next, r.radius, blocks)) continue;
        const cost = current.cost + Math.hypot(dx, dz), old = nodes.get(nextId);
        if (old && cost >= old.cost) continue;
        const n = old || next;
        Object.assign(n, { cost, score: cost + Math.max(0, dist(next, goal) - stop), parent: current });
        if (!old) { nodes.set(nextId, n); open.push(n); }
      }
    }
    return [];
  }
  function march(r, goal, range, speed) {
    const blocks = navigationBlocks(r), d = dist(r, goal), stop = Math.max(0.1, range - 0.12);
    const approach = { x: goal.x + (r.x - goal.x) / d * stop, z: goal.z + (r.z - goal.z) / d * stop };
    let waypoint = approach;
    if (!clearSegment(r, approach, r.radius, blocks)) {
      r.pathAge = (r.pathAge || 0) + DT;
      const changedTarget = r.pathTarget !== goal.id;
      const movedTarget = r.pathGoal && dist(r.pathGoal, goal) > 1;
      const retryAfter = r.path?.length ? 1 : 0.5;
      if (changedTarget || r.pathAge >= retryAfter || (movedTarget && r.pathAge >= 0.25)) {
        r.path = findPath(r, goal, stop, blocks); r.pathTarget = goal.id; r.pathGoal = { x: goal.x, z: goal.z }; r.pathAge = 0;
      }
      while (r.path.length && dist(r, r.path[0]) < 0.2) r.path.shift();
      // 見通せるところまで経路をまとめ、格子に沿った細かい蛇行を避ける。
      for (let i = r.path.length - 1; i >= 0; i--) if (clearSegment(r, r.path[i], r.radius, blocks)) {
        r.path.splice(0, i); break;
      }
      waypoint = r.path[0];
      if (!waypoint) return;
    }
    const heading = ang(r, waypoint), step = Math.min(speed * DT, dist(r, waypoint));
    const others = units().filter(e => e !== r && !e.dead);
    // 正面がユニットに塞がれていれば、横へ回り込む。
    for (const turn of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.8, -1.8, 2.2, -2.2, 2.6, -2.6, Math.PI]) {
      const face = heading + turn, next = { x: r.x + Math.sin(face) * step, z: r.z + Math.cos(face) * step };
      if (!clearSegment(r, next, r.radius, blocks) || others.some(e => dist(next, e) < r.radius + e.radius + 0.03)) continue;
      r.x = next.x; r.z = next.z; r.face = face; r.moving = step > 0.001;
      return;
    }
  }
  function spawn(p) {
    Object.assign(p, SPAWNS[p.slot], { hp: p.cfg.maxHp, dest: null, target: null, dead: false, dashT: 0, moving: false, respawn: 0, stun: 0, recall: 0, keys: null, inputT: 0, shield: 0, aiming: false, leap: null, air: 0, speedBoost: 0, pull: null, stealth: 0, warp: null });
    p.face = ang(p, { x: 0, z: 0 });
    updateBush(p);
  }
  function reset() {
    winner = null; elapsed = 0; energyTimer = 0; environment.totals = [0, 0];
    for (const collection of [monsters, energy]) for (const id of Object.keys(collection)) delete collection[id];
    for (const camp of camps) camp.timer = 5;
    for (const id of Object.keys(robots)) delete robots[id];
    for (const id of Object.keys(projectiles)) delete projectiles[id];
    for (const slot of [0, 1]) {
      const s = SPAWNS[slot], facing = ang(s, { x: 0, z: 0 });
      for (let i = 0; i < CFG.tower.count; i++) {
        const a = facing + (i - 2) * Math.PI / 6, id = `t${slot}-${i}`;
        towers[id] = { id, slot, tower: true, x: s.x + Math.sin(a) * 8, z: s.z + Math.cos(a) * 8,
          radius: CFG.tower.radius, hp: CFG.tower.hp, dead: false, atkCd: 0, bush: -1, face: facing, moving: false };
      }
    }
    for (const p of Object.values(players)) {
      Object.assign(p, { energy: 0, kills: 0, atkCd: 0, qCd: 0, eCd: 0, cCd: 0 });
      spawn(p);
    }
  }
  reset();

  function heal(p, amount) {
    if (!p || p.dead || amount <= 0) return;
    const before = p.hp;
    p.hp = Math.min(p.cfg.maxHp, r2(p.hp + amount));
    if (p.hp > before) emitSee(p, 'heal', { id: p.id, amount: r2(p.hp - before) });
  }
  function hit(a, b, dmg) {
    if (!active() || !damageable(a, b)) return 0;
    const enhanced = boosted(a, b);
    dmg = r2(dmg * (enhanced ? 2 : 1) * (b.shield > 0 ? 0.5 : 1));
    const dealt = Math.min(b.hp, dmg);
    b.hp = Math.max(0, b.hp - dmg);
    if (a.character === 'lucia' && !isRobot(a) && !b.tower && !b.monster && !isRobot(b)) heal(a, dealt * a.cfg.lifeSteal);
    b.recall = 0;
    emitSee(b, 'hit', { id: b.id, source: a.id, dmg, boosted: enhanced });
    if (b.hp > 0) return dealt;
    b.dead = true;
    b.leap = null; b.air = 0; b.aiming = false; b.pull = null; b.speedBoost = 0; b.stealth = 0; b.warp = null;
    const describe = e => {
      const character = e.character || players[e.owner]?.character;
      const kind = e.monster ? 'monster' : e.tower ? 'tower' : isRobot(e) ? 'minion' : 'player';
      const name = e.id.startsWith('zone-') ? 'コントロールゾーン' : e.monster ? (e.large ? '大型モンスター' : '小型モンスター') : e.tower ? `タワー ${Number(e.id.split('-')[1]) + 1}`
        : `${characterFor(character)?.name || 'プレイヤー'}${kind === 'minion' ? 'のミニオン' : ''}`;
      return { id: e.id, slot: e.slot, kind, character, name };
    };
    // 撃破は試合内全員へ通知する。ブッシュ内の座標はログに含めない。
    const kill = { id: ++killSeq, time: r2(elapsed), attacker: describe(a), victim: describe(b) };
    for (const viewer of Object.values(players)) viewer.socket.emit('kill', kill);
    award(a, b.monster ? (b.large ? 30 : 8) : b.tower ? 25 : isRobot(b) ? 3 : 15);
    if (b.monster) {
      delete monsters[b.id];
      const camp = camps.find(c => c.id === b.id);
      if (camp) camp.timer = b.large ? 45 : 30;
      return dealt;
    }
    if (b.tower) {
      if (destroyed(b.slot) === CFG.tower.count) { winner = a.slot; phase = 'finished'; }
      return dealt;
    }
    if (isRobot(b)) { delete robots[b.id]; return dealt; }
    b.respawn = CFG.respawn + destroyed(b.slot) * CFG.respawnPerTower;
    b.dest = null; b.target = null; b.moving = false;
    const credit = isRobot(a) ? players[a.owner] : a.tower || a.monster ? null : a;
    if (credit) credit.kills++;
    return dealt;
  }
  function melee(p, range, halfArc, dmg, kind) {
    const victims = targets().filter(o => damageable(p, o) && dist(p, o) <= range + o.radius && Math.abs(wrap(ang(p, o) - p.face)) <= halfArc);
    fx(p, kind, { range, halfArc, boosted: victims.some(o => boosted(p, o)) });
    for (const o of victims) {
      const before = o.hp;
      hit(p, o, dmg);
      if (o.hp < before && kind === 'q' && !o.tower && !o.dead) {
        stun(o, p.cfg.qStun);
      }
    }
  }
  function stun(e, duration) {
    if (e.tower || e.dead) return;
    e.stun = Math.max(e.stun || 0, duration);
    e.dest = null; e.target = null; e.dashT = 0; e.keys = null; e.recall = 0; e.moving = false;
    e.aiming = false; e.leap = null; e.air = 0; e.warp = null;
    pushOut(e); updateBush(e);
  }
  function pullUnit(e) {
    if (!e.pull) return;
    const caster = players[e.pull.caster];
    if (!caster || caster.dead || e.dead) { e.pull = null; return; }
    const d = dist(e, caster), stop = e.radius + caster.radius + 0.12;
    const step = Math.min(30 * DT, e.pull.remaining, Math.max(0, d - stop));
    if (step <= 0.001) { e.pull = null; return; }
    const next = { x: e.x + (caster.x - e.x) / d * step, z: e.z + (caster.z - e.z) / d * step };
    if (!clearSegment(e, next, Math.max(0, e.radius - 0.03), navigationBlocks(e))) { e.pull = null; return; }
    e.x = next.x; e.z = next.z; e.pull.remaining -= step;
    pushOut(e); updateBush(e);
  }
  function tickLeap(p) {
    const leap = p.leap;
    leap.elapsed = Math.min(p.cfg.leapTime, leap.elapsed + DT);
    const t = leap.elapsed / p.cfg.leapTime;
    p.x = leap.from.x + (leap.to.x - leap.from.x) * t;
    p.z = leap.from.z + (leap.to.z - leap.from.z) * t;
    p.air = Math.sin(t * Math.PI) * 3; p.moving = true;
    updateBush(p);
    if (t < 1) return;
    p.leap = null; p.air = 0; p.moving = false; pushOut(p); updateBush(p);
    const foe = targets().filter(e => attackable(p, e) && dist(p, e) <= p.cfg.leapHitRange + e.radius)
      .sort((a, b) => dist(p, a) - dist(p, b))[0];
    fx(p, 'leapHit', { range: p.cfg.leapHitRange, boosted: !!foe && boosted(p, foe) });
    if (foe) { hit(p, foe, p.cfg.leapDmg); stun(foe, p.cfg.leapStun); }
  }
  function intersection(a, b, center, radius) {
    const dx = b.x - a.x, dz = b.z - a.z, ox = a.x - center.x, oz = a.z - center.z;
    const c = ox * ox + oz * oz - radius * radius;
    if (c <= 0) return 0;
    const length2 = dx * dx + dz * dz, dot = ox * dx + oz * dz, discriminant = dot * dot - length2 * c;
    if (!length2 || discriminant < 0) return Infinity;
    const t = (-dot - Math.sqrt(discriminant)) / length2;
    return t >= 0 && t <= 1 ? t : Infinity;
  }
  function tickProjectile(bolt) {
    const caster = players[bolt.owner];
    if (!caster) { delete projectiles[bolt.id]; return; }
    const basic = bolt.kind === 'basic';
    const abyss = bolt.kind === 'abyss', radius = abyss ? caster.cfg.qRadius : CFG.magicRadius;
    const step = Math.min((abyss ? caster.cfg.qSpeed : CFG.magicSpeed) * DT, bolt.remaining);
    const next = { x: bolt.x + Math.sin(bolt.face) * step, z: bolt.z + Math.cos(bolt.face) * step };
    let contact = Infinity, victim = null;
    for (const e of (basic ? targets() : units())) {
      if (!damageable(caster, e)) continue;
      const t = intersection(bolt, next, e, e.radius + radius);
      if (t < contact) { contact = t; victim = e; }
    }
    const blocks = [...OBST, ...Object.values(towers).filter(t => !t.dead && (!basic || t.slot === bolt.slot)).map(t => ({ ...t, r: t.radius })), { ...SPAWNS[1 - bolt.slot], r: CFG.safeRadius }];
    for (const o of blocks) {
      const t = intersection(bolt, next, o, o.r + radius);
      if (t <= contact) { contact = t; victim = null; }
    }
    if (contact !== Infinity) {
      if (victim) {
        const dealt = hit(caster, victim, basic ? caster.cfg.atkDmg : abyss ? caster.cfg.qDmg : CFG.magicDmg);
        if (abyss && dealt > 0) heal(caster, caster.cfg.qHeal);
        if (!basic && !abyss && !victim.dead) {
          stun(victim, CFG.magicStun);
          victim.pull = { caster: caster.id, remaining: CFG.magicPull };
        }
        if (!basic) fx(victim, abyss ? 'abyssHit' : 'magicHit');
      }
      delete projectiles[bolt.id]; return;
    }
    bolt.x = next.x; bolt.z = next.z; bolt.remaining -= step; updateBush(bolt);
    if (bolt.remaining <= 0 || Math.abs(bolt.x) > HALF - 1 || Math.abs(bolt.z) > HALF - 1) delete projectiles[bolt.id];
  }
  function validDestination(p, d) {
    const blocks = [...OBST, ...Object.values(towers).filter(t => !t.dead).map(t => ({ ...t, r: t.radius }))];
    return validLanding(p, d, { range: p.cfg.leapRange, radius: p.radius, half: HALF, blocks, safe: { ...SPAWNS[1 - p.slot], r: CFG.safeRadius }, travel: p.character === 'alex' });
  }
  function tickWarp(p) {
    p.warp.remaining = decay(p.warp.remaining);
    if (p.warp.remaining > 0) return;
    const destination = p.warp.to;
    p.warp = null; p.x = destination.x; p.z = destination.z;
    pushOut(p); updateBush(p);
    fx(p, 'warpHit', { range: p.cfg.leapHitRange });
    for (const e of targets()) if (damageable(p, e) && dist(p, e) <= p.cfg.leapHitRange + e.radius) hit(p, e, p.cfg.warpDmg);
  }
  function connect(socket) {
    const slot = [0, 1].find(s => !Object.values(players).some(p => p.slot === s));
    if (slot === undefined) { socket.emit('full'); socket.disconnect(); return false; }
    const p = players[socket.id] = { id: socket.id, socket, slot, radius: CFG.radius, kills: 0, atkCd: 0, qCd: 0, eCd: 0, cCd: 0, character: null, confirmed: false, cfg: configFor('alex') };
    spawn(p);
    if (solo || Object.keys(players).length === 2) phase = 'selecting';
    socket.emit('init', { id: p.id, slot, cfg: CFG, map: MAP, solo, characters: CHARACTERS });
    socket.on('selectCharacter', d => {
      if (phase !== 'selecting' || p.confirmed || !characterFor(d?.id)) return;
      p.character = d.id; p.cfg = configFor(d.id); spawn(p);
    });
    socket.on('confirmCharacter', () => {
      if (phase !== 'selecting' || !p.character) return;
      p.confirmed = true;
      if ((solo || Object.keys(players).length === 2) && Object.values(players).every(p => p.confirmed)) {
        reset(); phase = 'playing';
      }
    });
    const ready = () => active() && !p.dead && p.stun <= 0 && !p.leap && !p.warp;
    socket.on('cancelLeap', () => { p.aiming = false; });
    socket.on('leap', d => {
      if (!ready() || p.character !== 'alex' || !p.aiming || p.eCd > 0 || !isNum(d?.x, d?.z)) return;
      if (!validDestination(p, d)) return;
      p.aiming = false; p.eCd = p.cfg.eCd; p.dest = null; p.target = null; p.keys = null; p.recall = 0;
      p.face = ang(p, d); p.leap = { from: { x: p.x, z: p.z }, to: { x: d.x, z: d.z }, elapsed: 0 };
      fx(p, 'leap');
    });
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
      p.qCd = p.cfg.qCd; p.face = ang(p, d); p.dest = null;
      if (p.character === 'lucia') {
        const id = 'm' + (++projectileSeq);
        const bolt = projectiles[id] = { id, owner: p.id, slot: p.slot, character: 'lucia', kind: 'abyss', x: p.x, z: p.z, face: p.face, remaining: p.cfg.qRange };
        updateBush(bolt); fx(p, 'abyss'); return;
      }
      melee(p, p.cfg.qRange, p.cfg.qArc, p.cfg.qDmg, 'q');
    });
    socket.on('dash', d => {
      if (!ready() || p.eCd > 0) return;
      if (p.character === 'lucia') {
        if (!validDestination(p, d)) return;
        p.eCd = p.cfg.eCd; p.recall = 0; p.dest = null; p.target = null; p.keys = null; p.face = ang(p, d); p.moving = false;
        fx(p, 'warp'); p.warp = { remaining: p.cfg.warpTime, to: { x: d.x, z: d.z } }; return;
      }
      p.recall = 0;
      if (p.character === 'alex') { p.aiming = !p.aiming; return; }
      p.eCd = p.cfg.eCd;
      if (p.character === 'bastion') { p.shield = 2; fx(p, 'shield'); return; }
      if (p.character === 'mira') { p.speedBoost = p.cfg.windTime; fx(p, 'wind'); }
    });
    socket.on('c', d => {
      if (p.character === 'lucia') {
        if (!ready() || p.cCd > 0) return;
        p.cCd = p.cfg.cCd; p.recall = 0; fx(p, 'stealth'); p.stealth = 5; return;
      }
      if (p.character === 'mira') {
        if (!ready() || p.cCd > 0 || !isNum(d?.x, d?.z) || dist(p, d) < 0.01) return;
        p.recall = 0; p.cCd = p.cfg.cCd; p.face = ang(p, d);
        const id = 'm' + (++projectileSeq);
        const bolt = projectiles[id] = { id, owner: p.id, slot: p.slot, character: 'mira', x: p.x, z: p.z, face: p.face, remaining: CFG.magicRange };
        updateBush(bolt); fx(p, 'magic'); return;
      }
      const R = p.cfg.robot;
      const count = Object.values(robots).filter(r => r.owner === p.id).length;
      if (!ready() || p.cCd > 0 || count >= R.max) return;
      p.recall = 0;
      if (isNum(d?.x, d?.z) && dist(p, d) > 0.01) p.face = ang(p, d);
      p.cCd = p.cfg.cCd;
      for (let i = 0; i < Math.min(R.batch, R.max - count); i++) {
        const a = p.face + (i - 1) * 0.6, id = 'r' + (++robotSeq);
        const r = robots[id] = { id, owner: p.id, slot, character: p.character, cfg: R, radius: R.radius, hp: R.hp, maxHp: R.hp, life: R.life, dead: false, stun: 0,
          x: clamp(p.x + Math.sin(a) * 1.6), z: clamp(p.z + Math.cos(a) * 1.6), face: p.face, atkCd: 0, target: null, moving: false };
        pushOut(r); updateBush(r);
      }
      separateAlexMinions();
      fx(p, 'summon');
    });
    socket.on('restart', () => { if (solo && (active() || phase === 'finished')) { reset(); phase = 'playing'; } });
    socket.on('disconnect', () => {
      delete players[p.id];
      phase = 'abandoned';
      for (const v of Object.values(players)) v.socket.emit('matchEnded', { reason: '対戦相手が退出しました。ロビーからもう一度参加してください。' });
    });
    return true;
  }
  // 大型モンスターの中心ではなく、体の外周を攻撃可能な距離として扱う。
  const reach = (range, e) => range + (e.tower || e.monster ? e.radius : 0);
  function tickRobot(r) {
    const R = r.cfg || CFG.robot;
    r.life -= DT; r.atkCd = Math.max(0, r.atkCd - DT);
    const owner = players[r.owner];
    if (r.life <= 0 || !owner) { delete robots[r.id]; return; }
    pullUnit(r);
    if (r.stun > 0) { r.stun = decay(r.stun); r.moving = false; return; }
    const marching = isAlexMinion(r);
    let objective = towers[r.objective];
    if (marching && (!objective || objective.dead)) {
      objective = Object.values(towers).filter(t => !t.dead && t.slot !== r.slot).sort((a, b) => dist(r, a) - dist(r, b))[0];
      r.objective = objective?.id || null;
    }
    const ok = e => attackable(r, e) && (!marching || !e.tower) && dist(r, e) <= R.leash;
    let foe = unit(r.target);
    if (!ok(foe)) {
      foe = null;
      let best = R.aggro;
      for (const e of targets()) {
        const d = dist(r, e);
        if (ok(e) && d < best) { best = d; foe = e; }
      }
    }
    if (marching && !foe) foe = objective;
    r.target = foe ? foe.id : null;
    let goal = null;
    if (foe) {
      if (dist(r, foe) <= reach(R.atkRange, foe)) {
        r.face = ang(r, foe);
        if (r.atkCd <= 0) { r.atkCd = R.atkCd; attack(r, foe, R.dmg); }
      } else goal = foe;
    } else if (!marching && !owner.dead && dist(r, owner) > 4) goal = owner;
    r.moving = false;
    if (goal) {
      if (marching) {
        march(r, goal, reach(R.atkRange, goal), R.speed);
        pushOut(r); updateBush(r);
        return;
      }
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
    if (p.dead) { p.respawn = decay(p.respawn); if (p.respawn <= 0) spawn(p); return; }
    p.moving = false;
    const speed = p.cfg.speed * (p.speedBoost > 0 ? p.cfg.windMultiplier : 1);
    p.speedBoost = decay(p.speedBoost);
    p.stealth = decay(p.stealth);
    p.shield = Math.max(0, p.shield - DT);
    p.inputT = Math.max(0, p.inputT - DT);
    if (p.inputT <= 0) p.keys = null;
    pullUnit(p);
    if (p.stun > 0) { p.stun = decay(p.stun); return; }
    if (p.warp) { tickWarp(p); return; }
    if (p.leap) { tickLeap(p); return; }
    if (p.recall > 0) {
      p.recall = Math.max(0, p.recall - DT);
      if (p.recall < 1e-9) {
        const hp = p.hp;
        spawn(p); p.hp = hp;
      }
      if (protectedUnit(p)) p.hp = Math.min(p.cfg.maxHp, p.hp + CFG.safeHeal * DT);
      return;
    }
    let dir = null, step = 0, foe = p.target && unit(p.target);
    if (!attackable(p, foe)) { foe = null; p.target = null; }
    if (p.dashT > 0) {
      p.dashT -= DT; step = p.cfg.dashSpeed * DT; p.moving = true;
      dir = { x: Math.sin(p.face), z: Math.cos(p.face) };
    } else {
      let goal = p.dest;
      if (foe) {
        if (dist(p, foe) <= reach(p.cfg.atkRange, foe)) {
          goal = null; p.face = ang(p, foe);
          if (p.atkCd <= 0) { p.atkCd = p.cfg.atkCd; attack(p, foe, p.cfg.atkDmg); }
        } else if (!p.keys) goal = foe;
      }
      if (p.keys) {
        dir = p.keys; step = speed * DT; p.moving = true;
        if (!foe || dist(p, foe) > reach(p.cfg.atkRange, foe)) p.face = Math.atan2(dir.x, dir.z);
      }
      if (goal) {
        const d = dist(p, goal);
        if (d < 0.1) p.dest = null;
        else {
          step = Math.min(speed * DT, d); p.moving = true;
          dir = { x: (goal.x - p.x) / d, z: (goal.z - p.z) / d };
          p.face = Math.atan2(dir.x, dir.z);
        }
      }
    }
    if (dir) { p.x += dir.x * step; p.z += dir.z * step; }
    pushOut(p); updateBush(p);
    if (protectedUnit(p)) p.hp = Math.min(p.cfg.maxHp, p.hp + CFG.safeHeal * DT);
  }
  function tickTower(t) {
    if (t.dead) return;
    t.atkCd = Math.max(0, t.atkCd - DT);
    const foe = units().filter(e => !e.monster && attackable(t, e) && dist(t, e) <= CFG.tower.range)
      .sort((a, b) => dist(t, a) - dist(t, b))[0];
    if (foe && t.atkCd <= 0) {
      t.face = ang(t, foe); t.atkCd = CFG.tower.atkCd;
      fx(t, 'atk'); hit(t, foe, CFG.tower.dmg);
    }
  }
  function tickEnvironment() {
    if (!environment.enabled) return;
    for (const camp of camps) {
      if (monsters[camp.id]) continue;
      camp.timer = decay(camp.timer);
      if (camp.timer > 0) continue;
      const m = monsters[camp.id] = { id: camp.id, monster: true, large: camp.large, slot: 2, x: camp.x, z: camp.z, home: camp,
        radius: camp.large ? 1.5 : 0.65, maxHp: camp.large ? 600 : 100, hp: camp.large ? 600 : 100, face: 0, atkCd: 0, stun: 0, dead: false, moving: false };
      updateBush(m);
    }
    for (const m of Object.values(monsters)) {
      m.atkCd = decay(m.atkCd); pullUnit(m); m.moving = false;
      if (m.stun > 0) { m.stun = decay(m.stun); continue; }
      const foe = units().filter(e => !e.monster && attackable(m, e) && dist(e, m.home) < 11 && dist(e, m) < 8).sort((a,b) => dist(m,a)-dist(m,b))[0];
      const goal = foe || m.home, d = dist(m, goal);
      m.face = ang(m, goal);
      if (foe && d <= m.radius + foe.radius + 0.6) {
        if (!m.atkCd) { m.atkCd = 1.2; attack(m, foe, m.large ? 20 : 8); }
      } else if (d > 0.15) {
        const step = Math.min(d, DT * (m.large ? 3 : 4));
        m.x += (goal.x-m.x)/d*step; m.z += (goal.z-m.z)/d*step; m.moving = true; pushOut(m); updateBush(m);
      }
      if (!foe) m.hp = Math.min(m.maxHp, m.hp + DT * 10);
    }
    energyTimer = decay(energyTimer);
    if (!energyTimer) {
      energyTimer = CFG.energyInterval;
      if (Object.keys(energy).length < 12) {
        const id = 'energy-' + (++energySeq), angle = energySeq * 2.4;
        energy[id] = { id, x: Math.sin(angle)*2, z: Math.cos(angle)*2, amount: 5 };
      }
    }
    for (const p of Object.values(players)) {
      if (p.dead) continue;
      for (const orb of Object.values(energy)) if (dist(p, orb) < 1.5) { award(p, orb.amount); delete energy[orb.id]; }
      if (protectedUnit(p)) continue;
      if (inControl(p, p.slot)) p.hp = Math.min(p.cfg.maxHp, p.hp + CFG.controlHeal * DT);
      if (inControl(p, 1-p.slot)) hit({ id: 'zone-' + (1-p.slot), slot: 1-p.slot, tower: true }, p, CFG.controlDamage * DT);
    }
  }
  function tick() {
    if (active()) {
      elapsed += DT;
      tickEnvironment();
      separateAlexMinions();
      for (const p of Object.values(players)) if (active()) tickPlayer(p);
      for (const r of Object.values(robots)) if (active()) tickRobot(r);
      for (const bolt of Object.values(projectiles)) if (active()) tickProjectile(bolt);
      separateAlexMinions();
      for (const t of Object.values(towers)) if (active()) tickTower(t);
    }
    const list = Object.values(players);
    for (const v of list) {
      v.socket.emit('state', {
        solo, winner, phase,
        control: [0, 1].map(slot => ({ slot, boundary: boundary(slot), energy: environment.totals[slot] })),
        energy: Object.values(energy),
        monsters: Object.values(monsters).filter(m => canSee(v.slot, m)).map(m => ({ id: m.id, slot: 2, large: m.large, x: r2(m.x), z: r2(m.z), hp: r2(m.hp), maxHp: m.maxHp, face: m.face, moving: m.moving, stun: m.stun })),
        towers: Object.values(towers).map(t => ({ id: t.id, slot: t.slot, x: r2(t.x), z: r2(t.z), hp: t.hp, dead: t.dead, face: t.face })),
        players: list.map(p => {
          const vis = canSee(v.slot, p);
          const s = { id: p.id, slot: p.slot, character: p.character, confirmed: p.confirmed, maxHp: p.cfg.maxHp, hp: r2(p.hp), dead: p.dead, kills: p.kills, energy: p.energy, vis, stun: r2(p.stun), recall: r2(p.recall), shield: r2(p.shield) };
          if (vis) Object.assign(s, { x: r2(p.x), z: r2(p.z), face: r2(p.face), moving: active() && p.moving, air: r2(p.air), speedBoost: r2(p.speedBoost), stealth: r2(p.stealth), warping: p.warp ? r2(p.warp.remaining) : 0 });
          if (p === v) Object.assign(s, { aiming: p.aiming, qCd: r2(p.qCd), eCd: r2(p.eCd), cCd: r2(p.cCd), respawn: r2(Math.max(0, p.respawn)), safe: !p.dead && protectedUnit(p), respawnTime: CFG.respawn + destroyed(p.slot) * CFG.respawnPerTower });
          return s;
        }),
        robots: Object.values(robots).filter(r => canSee(v.slot, r)).map(r => ({ id: r.id, slot: r.slot, character: r.character, maxHp: r.maxHp || R.hp, x: r2(r.x), z: r2(r.z), face: r2(r.face), hp: r.hp, stun: r2(r.stun || 0), moving: active() && r.moving })),
        projectiles: Object.values(projectiles).filter(b => canSee(v.slot, b)).map(b => ({ id: b.id, slot: b.slot, character: b.character, x: r2(b.x), z: r2(b.z), face: b.face, kind: b.kind })),
      });
    }
  }
  // サーバー内部の状態。Socket.IOのイベントからは直接変更できない。
  return { connect, tick, empty: () => Object.keys(players).length === 0, state: { players, robots, towers, projectiles, monsters, energy, environment, camps } };
}

const ArenaWorld = { createMatch, CFG, MAP, TICK, CHARACTERS, characterFor, configFor, validLanding };
if (typeof module !== 'undefined' && module.exports) module.exports = ArenaWorld;
else globalThis.ArenaWorld = ArenaWorld;

(function(root) {
  'use strict';
  const VERSION = 'minion-bush-memory/10', SIZE = 32, TTL = 8;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  function update(memory, state, actor, events, init) {
    const me = state.players.find(p => p.id === actor), bushes = init?.map?.bushes || [];
    if (!me) return;
    const perception = memory.perception ||= { enemies: {} }, records = perception.enemies;
    const enemies = state.players.filter(p => p.slot !== me.slot);
    for (const id of Object.keys(records)) if (!enemies.some(p => p.id === id)) delete records[id];
    for (const enemy of enemies) {
      const r = records[enemy.id] ||= { member: enemy.member || 0 };
      if (enemy.dead) { delete records[enemy.id]; continue; }
      if (enemy.vis && Number.isFinite(enemy.x) && Number.isFinite(enemy.z)) {
        const old = r.visible;
        r.visible = { x: enemy.x, z: enemy.z, time: state.time,
          vx: old && state.time > old.time ? (enemy.x - old.x) / (state.time - old.time) : old?.vx || 0,
          vz: old && state.time > old.time ? (enemy.z - old.z) / (state.time - old.time) : old?.vz || 0 };
        r.belief = null;
      } else if (!r.belief && r.visible && state.time - r.visible.time <= .4) {
        const v = r.visible, projected = { x: v.x + v.vx * .25, z: v.z + v.vz * .25 };
        const index = bushes.findIndex(b => distance(v, b) <= b.r + .8 || distance(projected, b) < b.r && distance(projected, b) < distance(v, b));
        if (index >= 0) r.belief = { bush: index, x: bushes[index].x, z: bushes[index].z, at: state.time, entry: true, attack: false, initial: .9 };
      }
    }
    for (const e of events || []) {
      if (e.event !== 'fx' || e.data?.kind !== 'bushAttack' || !Number.isFinite(e.time) || e.time > state.time + .1 || state.time - e.time > TTL) continue;
      const enemy = enemies.find(p => p.id === e.data.source);
      if (!enemy || enemy.dead || enemy.vis) continue;
      const bush = bushes[e.data.bush];
      if (!bush || !Number.isFinite(e.data.x) || !Number.isFinite(e.data.z) || distance(e.data, bush) > bush.r + .1) continue;
      const r = records[enemy.id] ||= { member: enemy.member || 0 };
      if (!r.belief || e.time > r.belief.at) r.belief = { bush: e.data.bush, x: e.data.x, z: e.data.z, at: e.time, entry: !!r.belief?.entry && r.belief.bush === e.data.bush, attack: true, initial: 1 };
    }
    for (const r of Object.values(records)) if (r.belief) {
      const b = r.belief, bush = bushes[b.bush], age = state.time - b.at;
      const searched = bush && [...state.players, ...(state.robots || [])].some(p => p.slot === me.slot && !p.dead && Number.isFinite(p.x) && distance(p, bush) < bush.r - .1);
      if (age < 0 || age >= TTL || searched && age > .2) r.belief = null;
      else b.confidence = b.initial * (1 - age / TTL);
    }
  }
  function features(memory, state, actor) {
    const me = state.players.find(p => p.id === actor), sign = me.slot ? -1 : 1, x = Array(SIZE).fill(0);
    const records = Object.entries(memory.perception?.enemies || {}).sort((a, b) => a[1].member - b[1].member || a[0].localeCompare(b[0])).slice(0, 5);
    let count = 0, nearest = 60;
    records.forEach(([id, r], i) => {
      const b = r.belief, enemy = state.players.find(p => p.id === id);
      if (!b || !enemy || enemy.dead || enemy.vis || !(b.confidence > 0)) return;
      const values = [b.confidence, (b.x - me.x) * sign / 30, (b.z - me.z) * sign / 30, Math.min(1, (state.time - b.at) / TTL), Number(b.attack), Number(b.entry)];
      values.forEach((v, j) => { x[i * 6 + j] = Math.max(-2, Math.min(2, v)); });
      count++; nearest = Math.min(nearest, distance(me, b));
    });
    x[30] = count / 5; x[31] = count ? Math.min(1, nearest / 30) : 0;
    return x;
  }
  const api = { VERSION, SIZE, TTL, update, features };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MinionPerception = api;
})(globalThis);

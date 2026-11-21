(function(root) {
  'use strict';
  const VERSION = 'minion-objectives/1', SIZE = 24;
  const NAMES = ['base', 'small', 'large', 'energy', 'camp', 'selfHp', 'criticalHp', 'towerAlarm', 'distance', 'eta',
    'targetHpRatio', 'targetHp', 'reward', 'ownTerritory', 'largeLow', 'lethal', 'arrivable', 'contested', 'damageRate',
    'arrivalHp', 'sameGoal', 'stuck', 'recalling', 'enemyDistance'];
  const OFFENSE_VERSION = 'minion-objectives/2';
  const OFFENSE_NAMES = [...NAMES, 'tower', 'enemyTerritory', 'zoneCost', 'towerExposure', 'enemyPressure', 'allySupport',
    'enemyDead', 'enemyAway', 'opening', 'stealWindow', 'enemyMissing', 'targetEnemyDistance', 'enemyWeak'];
  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const clip = n => Math.max(-2, Math.min(2, n));
  const config = (model, me) => ({ ...model.init.cfg, ...(model.init.characters.find(c => c.id === me.character)?.stats || {}) });
  function validate(policy) {
    const names = policy.version === OFFENSE_VERSION ? OFFENSE_NAMES : NAMES;
    if (![VERSION, OFFENSE_VERSION].includes(policy.version) || JSON.stringify(policy.features) !== JSON.stringify(names) || !Number.isInteger(policy.hiddenSize)
      || policy.hiddenSize < 1 || policy.hiddenSize > 64) throw Error('対応していない目的選択モデルです。');
    const w = policy.weights, h = policy.hiddenSize;
    for (const [name, rows, columns] of [['hiddenW', h, names.length], ['outputW', 1, h]]) {
      if (!Array.isArray(w?.[name]) || w[name].length !== rows || w[name].some(r => !Array.isArray(r) || r.length !== columns || r.some(v => !Number.isFinite(v)))) throw Error('目的選択の重みが不正です。');
    }
    for (const [name, size] of [['hiddenB', h], ['outputB', 1]]) if (!Array.isArray(w[name]) || w[name].length !== size || w[name].some(v => !Number.isFinite(v))) throw Error('目的選択のバイアスが不正です。');
    if (!Array.isArray(policy.camps) || policy.camps.some(c => !Number.isFinite(c.x) || !Number.isFinite(c.z) || typeof c.id !== 'string')) throw Error('キャンプ情報が不正です。');
  }
  function forward(policy, x) {
    const w = policy.weights;
    const hidden = w.hiddenW.map((row, i) => Math.tanh(row.reduce((n, v, j) => n + v * x[j], w.hiddenB[i])));
    return w.outputW[0].reduce((n, v, j) => n + v * hidden[j], w.outputB[0]);
  }
  function observe(memory, state) {
    memory.samples ||= {};
    for (const m of state.monsters || []) {
      let samples = memory.samples[m.id] || [];
      if (samples.length && (state.time < samples.at(-1).time || m.hp > samples.at(-1).hp)) samples = [];
      if (!samples.length || state.time > samples.at(-1).time) samples.push({ hp: m.hp, time: state.time });
      memory.samples[m.id] = samples.filter(s => state.time - s.time <= 1.5);
    }
  }
  function candidates(model, state, actor, memory, history = {}) {
    const me = state.players.find(p => p.id === actor), cfg = config(model, me);
    const offense = model.objectivePolicy.version === OFFENSE_VERSION;
    const own = state.control.find(c => c.slot === me.slot), ownZone = e => (me.slot === 1 ? e.z - e.x : e.x - e.z) < own.boundary;
    const enemies = [...state.players.filter(p => p.slot !== me.slot && p.vis && !p.dead), ...state.robots.filter(r => r.slot !== me.slot)].filter(e => Number.isFinite(e.x));
    const enemyDistance = enemies.length ? Math.min(...enemies.map(e => distance(me, e))) : 60;
    const alarm = Object.values(history.towers || {}).some(t => state.time - t.hitAt <= 3);
    const goals = [{ kind: 'base', id: 'base', x: me.x, z: me.z }];
    for (const m of state.monsters || []) if (!m.dead && m.hp > 0 && (offense || m.large || ownZone(m))) goals.push({ ...m, kind: m.large ? 'large' : 'small', reward: m.large ? (model.init.cfg.largeMonsterEnergy ?? 200) : 8 });
    if (offense && state.time >= 5) for (const t of state.towers) if (t.slot !== me.slot && !t.dead) goals.push({ ...t, kind: 'tower', maxHp: model.init.cfg.tower.hp, reward: 30 });
    for (const orb of state.energy || []) goals.push({ ...orb, kind: 'energy', reward: orb.amount });
    if (state.time < 5) for (const c of model.objectivePolicy.camps) if (!c.large && ownZone(c)) goals.push({ ...c, kind: 'camp', reward: 8 });
    const lastBasic = [...(history.cues || [])].reverse().find(c => c.event === 'fx' && c.data?.id === actor && c.data.kind === 'atk');
    const basicWait = lastBasic ? Math.max(0, cfg.atkCd - (state.time - lastBasic.time)) : 0;
    return goals.map(g => {
      const d = distance(me, g), radius = g.kind === 'large' ? 1.5 : g.kind === 'small' ? .65 : g.kind === 'tower' ? model.init.cfg.tower.radius : 0;
      const eta = Math.max(0, d - cfg.atkRange - radius) / cfg.speed;
      const samples = memory.samples?.[g.id] || [], first = samples[0];
      const rate = first && Number.isFinite(g.hp) && state.time > first.time ? Math.max(0, (first.hp - g.hp) / (state.time - first.time)) : 0;
      const damage = Math.max(cfg.atkDmg, me.qCd <= 0 && me.character !== 'darius' ? cfg.qDmg : 0,
        me.cCd <= 0 && me.character === 'darius' ? cfg.cDmg : 0, me.cCd <= 0 && me.character === 'mira' ? cfg.magicDmg : 0);
      const arrival = (g.hp || 0) - rate * (eta + basicWait);
      const contested = enemies.some(e => distance(e, g) < 12);
      const same = memory.goal === g.id;
      const stuck = same && memory.progressAt !== undefined && state.time - memory.progressAt > 2 && d > cfg.atkRange + radius + .5;
      const hp = g.hp || 0, ratio = g.maxHp ? hp / g.maxHp : 0;
      const x = [g.kind === 'base', g.kind === 'small', g.kind === 'large', g.kind === 'energy', g.kind === 'camp',
        me.hp / me.maxHp, me.hp / me.maxHp <= .5, alarm, d / 60, eta / 10, ratio, hp / 600, (g.reward || 0) / 30,
        ownZone(g), g.kind === 'large' && ratio <= .4, hp > 0 && hp <= damage, !hp || !rate || arrival > 0,
        contested, rate / 100, Math.max(0, arrival) / 600, same, stuck, me.recall > 0, enemyDistance / 30];
      if (offense) {
        const enemyHeroes = state.players.filter(p => p.slot !== me.slot), visible = enemyHeroes.filter(p => p.vis && !p.dead && Number.isFinite(p.x));
        const missing = enemyHeroes.some(p => !p.dead && !p.vis), allDead = enemyHeroes.length > 0 && enemyHeroes.every(p => p.dead);
        const nearest = visible.length ? Math.min(...visible.map(p => distance(p, g))) : 60;
        const away = visible.length > 0 && !missing && visible.every(p => distance(p, g) / config(model, p).speed > eta + 2.5);
        const pressure = enemies.reduce((sum, e) => sum + Math.max(0, 1 - distance(e, g) / 12) * (e.maxHp ? .5 + e.hp / e.maxHp : .4), 0);
        const support = [...state.players.filter(p => p.id !== actor && p.slot === me.slot && !p.dead), ...state.robots.filter(r => r.slot === me.slot)].reduce((sum, e) => sum + Math.max(0, 1 - distance(e, g) / 12) * .7, 0);
        const weak = visible.length > 0 && visible.every(p => p.hp / p.maxHp <= .35);
        const enemyZone = state.control.find(c => c.slot !== me.slot);
        const depth = enemyZone ? enemyZone.boundary - (me.slot === 1 ? g.x - g.z : g.z - g.x) : 0;
        const enemyTerritory = depth > 0;
        const strike = { x: g.x + (me.x - g.x) / (d || 1) * Math.min(d, cfg.atkRange + radius - .2), z: g.z + (me.z - g.z) / (d || 1) * Math.min(d, cfg.atkRange + radius - .2) };
        const exposure = state.towers.filter(t => t.slot !== me.slot && !t.dead && distance(t, strike) <= model.init.cfg.tower.range + .3).length;
        const killTime = Math.min(8, hp / Math.max(1, cfg.atkDmg * (g.kind === 'tower' && me.character === 'alex' ? 2 : 1) / cfg.atkCd));
        const zoneSeconds = enemyTerritory ? Math.min(eta, depth / Math.SQRT2 / cfg.speed) + killTime + depth / Math.SQRT2 / cfg.speed : 0;
        const cost = (zoneSeconds * cfg.controlDamage + exposure * model.init.cfg.tower.dmg / model.init.cfg.tower.atkCd * Math.min(4, killTime)) / Math.max(1, me.hp);
        const opening = allDead || away || (support > pressure + .5) || weak;
        const steal = ['small', 'large'].includes(g.kind) && contested && rate > 0 && arrival > 0 && arrival <= damage * 1.6;
        x.push(g.kind === 'tower', enemyTerritory, cost, exposure, pressure, support, allDead, away, opening, steal, missing, nearest / 30, weak);
      }
      const features = x.map(v => {
          if (!Number.isFinite(Number(v))) throw Error('Non-finite objective observation');
          return clip(Number(v));
        });
      return { ...g, features, distance: d, eta, rate, arrival, radius, damage, cfg };
    });
  }
  // Narrow demonstration targets for this lesson; these scores are never used to choose goals in a deployed model.
  function teacher(g) {
    const x = g.features;
    if (x.length === OFFENSE_NAMES.length) {
      if (x[6] || x[22] || x[7]) return g.kind === 'base' ? 1 : -1;
      if (g.kind === 'base') return .02;
      if (g.hp > 0 && !x[16]) return -.9;
      const risk = .55 * x[26] + .24 * Math.max(0, x[28] - x[29]) + .08 * x[34] * x[25];
      if (x[26] > .65 || (x[25] && x[5] < .7 && !x[33])) return -.65;
      let score;
      if (g.kind === 'tower') score = .05 + .48 * x[32] + .12 * (1 - x[10]) + .06 * Math.min(1, x[29]) - .11 * x[9] - .15 * x[34];
      else if (g.kind === 'small') score = .25 + .05 * (1 - x[10]) - .1 * x[9] + .14 * x[25] * x[32] + .65 * x[33];
      else if (g.kind === 'large') score = .05 + .22 * (1 - x[10]) + .65 * x[14] + .22 * x[15] + .35 * x[33] - .12 * x[9];
      else if (g.kind === 'energy') score = .19 + .12 * x[12] - .15 * x[9];
      else score = .23 - .12 * x[9];
      return score - risk + .035 * x[20] - .65 * x[21];
    }
    if (x[6] || x[22] || x[7]) return g.kind === 'base' ? 1 : -1;
    if (g.kind === 'base') return x[23] < .2 ? .3 : 0;
    let score = 0;
    if (g.kind === 'small') score = .22 + .04 * (1 - x[10]) - .12 * x[9];
    if (g.kind === 'energy') score = .16 + .1 * x[12] - .15 * x[9];
    if (g.kind === 'camp') score = .2 - .12 * x[9];
    if (g.kind === 'large') score = !x[16] ? -.8 : .04 + .2 * (1 - x[10]) + .65 * x[14] + .25 * x[15] - .12 * x[9];
    return score + .015 * x[20] - .6 * x[21];
  }
  function clear(a, b, radius, blocks, half) {
    if (Math.abs(b.x) > half - 1 || Math.abs(b.z) > half - 1) return false;
    const dx = b.x - a.x, dz = b.z - a.z, len = dx * dx + dz * dz;
    return blocks.every(o => {
      const t = len ? Math.max(0, Math.min(1, ((o.x - a.x) * dx + (o.z - a.z) * dz) / len)) : 0;
      const minimum = Math.hypot(a.x + dx * t - o.x, a.z + dz * t - o.z), start = Math.hypot(a.x - o.x, a.z - o.z);
      return minimum >= o.r + radius + .03 || (t <= 1e-8 && start < o.r + radius + .03 && distance(b, o) > start + .01);
    });
  }
  function waypoint(me, goal, range, init, state, memory) {
    const radius = goal.cfg.radius, half = init.map.half;
    const blocks = [...init.map.obst, ...state.towers.filter(t => !t.dead).map(t => ({ x: t.x, z: t.z, r: init.cfg.tower.radius })),
      { ...init.map.spawns[1 - me.slot], r: init.cfg.safeRadius }];
    const d = distance(me, goal), stop = Math.max(.1, range - .2);
    const end = { x: goal.x + (me.x - goal.x) / (d || 1) * Math.min(d, stop), z: goal.z + (me.z - goal.z) / (d || 1) * Math.min(d, stop) };
    if (clear(me, end, radius, blocks, half)) return null;
    if (memory.routeGoal !== goal.id || !memory.route || state.time - memory.routeAt > .8) {
      const key = p => `${p.x},${p.z}`, nodes = new Map(), closed = new Set(), open = [];
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const p = { x: Math.round(me.x) + dx, z: Math.round(me.z) + dz };
        if (clear(me, p, radius, blocks, half)) { p.cost = distance(me, p); p.score = p.cost + distance(p, goal); open.push(p); nodes.set(key(p), p); }
      }
      memory.route = []; memory.routeAt = state.time; memory.routeGoal = goal.id;
      for (let searched = 0; open.length && searched < 2048; searched++) {
        let best = 0; for (let i = 1; i < open.length; i++) if (open[i].score < open[best].score) best = i;
        const p = open.splice(best, 1)[0]; if (closed.has(key(p))) continue; closed.add(key(p));
        if (distance(p, goal) <= range) { for (let n = p; n; n = n.parent) memory.route.unshift({ x: n.x, z: n.z }); break; }
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
          const next = { x: p.x + dx, z: p.z + dz }, k = key(next), cost = p.cost + Math.hypot(dx, dz);
          if (closed.has(k) || !clear(p, next, radius, blocks, half) || (nodes.has(k) && nodes.get(k).cost <= cost)) continue;
          Object.assign(next, { cost, score: cost + distance(next, goal), parent: p }); nodes.set(k, next); open.push(next);
        }
      }
    }
    while (memory.route.length && distance(me, memory.route[0]) < .7) memory.route.shift();
    for (let i = memory.route.length - 1; i >= 0; i--) if (clear(me, memory.route[i], radius, blocks, half)) { memory.route.splice(0, i); break; }
    return memory.route[0] || { x: me.x, z: me.z };
  }
  function plan(model, state, actor, history) {
    const me = state.players.find(p => p.id === actor);
    if (!me || state.phase !== 'playing' || me.dead || me.stun > 0 || me.air > 0 || me.warping > 0 || me.charging || me.grabbing || me.grabbed || me.flying) return null;
    const memory = history.objectives ||= {}; observe(memory, state);
    const choices = candidates(model, state, actor, memory, history);
    for (const g of choices) g.score = forward(model.objectivePolicy, g.features);
    // New offensive goals never preempt a recall, low-health retreat or active tower alarm.
    if (model.objectivePolicy.version === OFFENSE_VERSION && [6, 7, 22].some(i => choices[0].features[i])) choices[0].score = Infinity;
    choices.sort((a, b) => b.score - a.score);
    const goal = choices[0];
    if (goal.kind === 'base') {
      const release = !!memory.goal; memory.goal = null; memory.route = null;
      return release ? { fallbackInputs: [{ event: 'move', data: { x: me.x, z: me.z } }] } : null;
    }
    if (memory.goal !== goal.id || goal.distance < (memory.progressDistance ?? Infinity) - .25) {
      memory.progressAt = state.time; memory.progressDistance = goal.distance;
    }
    memory.goal = goal.id; memory.kind = goal.kind;
    const inputs = [], point = { x: goal.x, z: goal.z };
    if (me.aiming) inputs.push({ event: 'cancelLeap' });
    const combat = ['small', 'large', 'tower'].includes(goal.kind), cfg = goal.cfg;
    const range = combat ? cfg.atkRange + goal.radius : goal.kind === 'energy' ? .8 : .5;
    const routeGoal = { ...point, id: goal.id, cfg }, via = waypoint(me, routeGoal, range, model.init, state, memory);
    if (me.inputs?.keys) inputs.push({ event: 'steer', data: { x: 0, z: 0 } });
    if (via) {
      if (!me.inputs?.dest || distance(me.inputs.dest, via) > .4) inputs.push({ event: 'move', data: via });
    } else if (combat) {
      if (me.inputs?.target !== goal.id) inputs.push({ event: 'chase', data: { id: goal.id } });
      const contested = goal.features[17] > 0;
      const reserve = (goal.kind === 'large' || model.objectivePolicy.version === OFFENSE_VERSION && goal.kind === 'small') && contested;
      if (goal.kind === 'tower' && me.character === 'alex' && me.cCd <= 0 && goal.distance <= 12) inputs.push({ event: 'c', data: point });
      if (me.cCd <= 0 && me.character === 'darius' && goal.distance <= cfg.cRange + goal.radius && (!reserve || goal.hp <= cfg.cDmg)) inputs.push({ event: 'c', data: point });
      else if (me.cCd <= 0 && me.character === 'mira' && goal.distance <= cfg.magicRange && goal.hp <= cfg.magicDmg
        && clear(me, point, cfg.magicRadius, model.init.map.obst, model.init.map.half)) inputs.push({ event: 'c', data: point });
      else if (me.qCd <= 0 && me.character !== 'darius' && goal.distance <= cfg.qRange + goal.radius && (!reserve || goal.hp <= cfg.qDmg)) inputs.push({ event: 'q', data: point });
    } else if (goal.distance > range && (!me.inputs?.dest || distance(me.inputs.dest, point) > .4)) inputs.push({ event: 'move', data: point });
    return { event: inputs[0]?.event || 'noop', data: inputs[0]?.data || null, objectiveInputs: inputs, objectiveGoal: { id: goal.id, kind: goal.kind } };
  }
  const api = { VERSION, SIZE, NAMES, OFFENSE_VERSION, OFFENSE_NAMES, validate, forward, observe, candidates, teacher, plan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MinionObjectives = api;
})(globalThis);

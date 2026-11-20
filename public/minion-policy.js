(function(root) {
  'use strict';
  const VERSION = 'minion-hash-mlp/1', SIZE = 1024;
  const EVENTS = ['noop', 'steer', 'move', 'chase', 'q', 'dash', 'c', 'leap', 'cancelLeap', 'recall'];
  const hash = text => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return h >>> 0; };
  const clip = (n, limit = 1) => Math.max(-limit, Math.min(limit, n));
  function features(state, actor, init, memory = {}) {
    const me = state.players.find(p => p.id === actor);
    if (!me) throw Error('モデルの視点がありません。');
    const sign = me.slot === 1 ? -1 : 1, vector = new Float32Array(SIZE);
    const ids = new Map([[actor, 'self']]);
    for (const p of state.players) if (p.id !== actor) ids.set(p.id, 'opponent');
    const scene = { ...state, players: [me, ...state.players.filter(p => p.id !== actor)], control: [...(state.control || [])].sort((a, b) => (a.slot === me.slot ? 0 : 1) - (b.slot === me.slot ? 0 : 1)) };
    for (const kind of ['robots', 'projectiles', 'towers', 'monsters', 'energy']) {
      scene[kind] = [...(state[kind] || [])].sort((a, b) => (a.slot === me.slot ? 0 : 1) - (b.slot === me.slot ? 0 : 1) || sign * (a.x - b.x) || sign * (a.z - b.z));
      scene[kind].forEach((e, i) => ids.set(e.id, `${kind}/${e.slot === me.slot ? 'own' : 'other'}/${i}`));
    }
    function add(key, value) {
      const h = hash(key); vector[h % SIZE] += (h & 0x80000000 ? -1 : 1) * value;
    }
    function walk(value, path, key) {
      if (value === null || value === undefined) { add(path + '=null', 0.25); return; }
      if (typeof value === 'boolean') { add(path, value ? 1 : -1); return; }
      if (typeof value === 'string') { add(path + '=' + (ids.get(value) || value), 0.5); return; }
      if (typeof value === 'number') {
        let n = value;
        if (key === 'x' || key === 'z') n = n * sign / 30;
        else if (key === 'slot' || key === 'winner') n = n === 2 ? 2 : n === me.slot ? 0 : 1;
        else if (key === 'face') n = Math.atan2(Math.sin(n + (sign < 0 ? Math.PI : 0)), Math.cos(n + (sign < 0 ? Math.PI : 0))) / Math.PI;
        else if (/hp|damage|dmg/i.test(key)) n /= 300;
        else if (key === 'tick') n /= 18000;
        else if (/time|seenAt/i.test(key)) n /= 600;
        else if (/energy|kills/i.test(key)) n /= 100;
        else n /= 30;
        add(path, clip(n, 4)); return;
      }
      if (Array.isArray(value)) value.forEach((e, i) => walk(e, path + '/' + i, String(i)));
      else for (const k of Object.keys(value).sort()) walk(value[k], path + '/' + k, k);
    }
    // 全観測のフィールドを取り込む。固定長へのハッシュ圧縮には衝突がある。
    const map = { ...init.map, spawns: [init.map.spawns[me.slot], init.map.spawns[1 - me.slot]] };
    for (const kind of ['obst', 'bushes']) map[kind] = [...(map[kind] || [])].sort((a, b) => sign * (a.x - b.x) || sign * (a.z - b.z));
    walk(scene, 'state', ''); walk(map, 'map', ''); walk(init.cfg, 'cfg', ''); walk(init.characters, 'characters', '');
    walk(memory, 'history', '');
    for (let i = 0; i < SIZE; i++) vector[i] = clip(vector[i], 8);
    return vector;
  }
  function updateMemory(memory, state, actor, events = []) {
    if (memory.time > state.time) { for (const key of Object.keys(memory)) delete memory[key]; }
    memory.time = state.time; memory.lastSeen ||= {};
    for (const p of state.players) if (p.id !== actor && p.vis) memory.lastSeen.opponent = { x: p.x, z: p.z, seenAt: state.time, character: p.character };
    memory.cues ||= [];
    for (const e of events) memory.cues.push({ event: e.event, data: e.data, time: e.time });
    memory.cues = memory.cues.filter(e => state.time - e.time <= 3).slice(-32);
    return memory;
  }
  function targets(state, me, init) {
    const safe = init.map.spawns[1 - me.slot];
    return [...state.players.filter(p => p.id !== me.id && p.vis), ...state.robots, ...state.towers, ...(state.monsters || [])]
      .filter(e => !e.dead && !e.warping && e.slot !== me.slot && Number.isFinite(e.x) && Number.isFinite(e.z)
        && (e.tower || e.slot === 2 || Math.hypot(e.x - safe.x, e.z - safe.z) > init.cfg.safeRadius));
  }
  function label(action, observation, actor) {
    const me = observation.players.find(p => p.id === actor), sign = me.slot === 1 ? -1 : 1;
    const type = EVENTS.indexOf(action?.event || 'noop');
    if (type < 0) throw Error('未知の入力: ' + action.event);
    let point = action?.data;
    if (action?.event === 'chase') point = [...observation.players, ...observation.robots, ...observation.towers, ...(observation.monsters || [])].find(e => e.id === point?.id && e.vis !== false);
    const hasPoint = Number.isFinite(point?.x) && Number.isFinite(point?.z);
    return { type, xy: hasPoint ? action.event === 'steer' ? [point.x * sign, point.z * sign]
      : [clip((point.x - me.x) * sign / 60), clip((point.z - me.z) * sign / 60)] : [0, 0], hasPoint };
  }
  function validate(model) {
    if (model?.format !== VERSION || model.inputSize !== SIZE || JSON.stringify(model.events) !== JSON.stringify(EVENTS) || !Array.isArray(model.characters) || !model.characters.length || model.characters.some(id => !['alex', 'mira', 'bastion', 'lucia', 'darius'].includes(id))) throw Error('対応していないミニオンモデルです。');
    const h = model.hiddenSize, w = model.weights;
    if (!Number.isInteger(h) || h < 1 || h > 256 || !model.init?.map?.spawns || !w) throw Error('モデルの設定が不正です。');
    for (const [name, rows, columns] of [['hiddenW', h, SIZE], ['typeW', EVENTS.length, h], ['pointW', EVENTS.length * 2, h]]) {
      if (!Array.isArray(w[name]) || w[name].length !== rows || w[name].some(row => !Array.isArray(row) || row.length !== columns || row.some(n => !Number.isFinite(n)))) throw Error('モデルの重みが不正です。');
    }
    for (const [name, length] of [['hiddenB', h], ['typeB', EVENTS.length], ['pointB', EVENTS.length * 2]]) if (!Array.isArray(w[name]) || w[name].length !== length || w[name].some(n => !Number.isFinite(n))) throw Error('モデルのバイアスが不正です。');
    return model;
  }
  function forward(model, x) {
    const dense = (w, b, v) => w.map((row, i) => row.reduce((sum, n, j) => sum + n * v[j], b[i]));
    const w = model.weights, hidden = dense(w.hiddenW, w.hiddenB, x).map(Math.tanh);
    return { logits: dense(w.typeW, w.typeB, hidden), points: dense(w.pointW, w.pointB, hidden).map(Math.tanh) };
  }
  function decide(model, observation, actor, memory = {}, draw = null) {
    const me = observation.players.find(p => p.id === actor);
    if (!me || !model.characters.includes(me.character)) return { event: 'noop', data: null };
    const result = forward(model, features(observation, actor, model.init, memory));
    const locked = observation.phase !== 'playing' || me.dead || me.stun > 0 || me.air > 0 || me.warping > 0 || me.charging || me.grabbing || me.grabbed || me.flying;
    const candidates = targets(observation, me, model.init);
    const allowed = [true, !locked, !locked, !locked && candidates.length > 0, !locked && me.qCd <= 0,
      !locked && me.eCd <= 0, !locked && me.cCd <= 0, !locked && me.character === 'alex' && me.aiming && me.eCd <= 0, true, !locked];
    for (let i = 1; i < EVENTS.length; i++) if (model.training?.classCounts?.[EVENTS[i]] === 0) allowed[i] = false;
    let type = 0;
    for (let i = 1; i < EVENTS.length; i++) if (allowed[i] && result.logits[i] > result.logits[type]) type = i;
    if (draw !== null) {
      const maximum = result.logits[type];
      const probabilities = result.logits.map((n, i) => allowed[i] ? Math.exp((n - maximum) / 0.7) : 0);
      let remaining = draw * probabilities.reduce((a, b) => a + b, 0);
      for (let i = 0; i < probabilities.length; i++) { remaining -= probabilities[i]; if (remaining <= 0) { type = i; break; } }
    }
    const event = EVENTS[type], sign = me.slot === 1 ? -1 : 1;
    let x = result.points[type * 2], z = result.points[type * 2 + 1];
    if (event === 'noop' || event === 'cancelLeap' || event === 'recall') return { event, data: null };
    if (event === 'steer') return { event, data: { x: clip(x * sign), z: clip(z * sign) } };
    x = me.x + x * 60 * sign; z = me.z + z * 60 * sign;
    if (event === 'chase') {
      candidates.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
      return { event, data: { id: candidates[0].id } };
    }
    return { event, data: { x: clip(x, 29), z: clip(z, 29) } };
  }
  function controller(model) {
    validate(model); const memory = {}; let lastTick = -1, cues = [], seed = 17;
    const observeState = state => {
      const actor = state.players.find(p => p.slot === 1)?.id;
      if (state.tick < lastTick) { for (const key of Object.keys(memory)) delete memory[key]; cues = []; seed = 17; }
      lastTick = state.tick;
      updateMemory(memory, state, actor, cues); cues = [];
      return actor;
    };
    const act = state => {
      const actor = observeState(state);
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const action = decide(model, state, actor, memory, seed / 4294967296);
      return action.event === 'noop' ? [] : [action];
    };
    act.observe = event => cues.push(event);
    act.observeState = observeState;
    act.reset = () => { for (const key of Object.keys(memory)) delete memory[key]; cues = []; seed = 17; lastTick = -1; };
    return act;
  }
  const api = { VERSION, SIZE, EVENTS, features, updateMemory, label, validate, forward, decide, controller };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MinionPolicy = api;
})(globalThis);

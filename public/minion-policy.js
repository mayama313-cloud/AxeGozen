(function(root) {
  'use strict';
  const VERSION = 'minion-hash-mlp/1', SIZE = 1024;
  const EVENTS = ['noop', 'steer', 'move', 'chase', 'q', 'dash', 'c', 'leap', 'cancelLeap', 'recall'];
  const DIRECTIONS = [[0, 0], [1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2], [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2]];
  const TACTICAL_VERSION = 'minion-tactical/2';
  const FARM_VERSION = 'minion-tactical/3';
  const DEFENSE_VERSION = 'minion-tactical/4';
  const ADAPTER_VERSION = 'minion-defense-adapter/5';
  const ALARM_VERSION = 'minion-defense-alarm/6';
  const PERCEPTION_VERSION = 'minion-bush-memory/10';
  const hash = text => { let h = 2166136261; for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619); return h >>> 0; };
  const clip = (n, limit = 1) => Math.max(-limit, Math.min(limit, n));
  function features(state, actor, init, memory = {}, version = null) {
    const perception = version === PERCEPTION_VERSION;
    if (perception) version = ALARM_VERSION;
    const me = state.players.find(p => p.id === actor);
    if (!me) throw Error('モデルの視点がありません。');
    const adapter = [ADAPTER_VERSION, ALARM_VERSION].includes(version);
    const sign = me.slot === 1 ? -1 : 1, vector = new Float32Array(adapter ? SIZE + 16 + (perception ? 32 : 0) : SIZE);
    const ids = new Map([[actor, 'self']]);
    for (const p of state.players) if (p.id !== actor) ids.set(p.id, p.slot === me.slot ? `ally/${p.member || 0}` : state.players.length > 2 ? `opponent/${p.member || 0}` : 'opponent');
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
    // Tower history has reserved inputs in v4; hashing it again would perturb the old policy everywhere.
    const history = [DEFENSE_VERSION, ADAPTER_VERSION, ALARM_VERSION].includes(version) || memory.objectives || memory.recallControl ? { ...memory } : memory;
    delete history.recallControl;
    if (memory.objectives) delete history.objectives;
    if (perception) delete history.perception;
    if ([DEFENSE_VERSION, ADAPTER_VERSION, ALARM_VERSION].includes(version)) delete history.towers;
    walk(history, 'history', '');
    for (let i = 0; i < SIZE; i++) vector[i] = clip(vector[i], 8);
    if ([TACTICAL_VERSION, FARM_VERSION, DEFENSE_VERSION, ADAPTER_VERSION, ALARM_VERSION].includes(version)) {
      const cfg = { ...init.cfg, ...(init.characters.find(c => c.id === me.character)?.stats || {}) };
      const enemy = state.players.find(p => p.slot !== me.slot && p.vis && !p.dead);
      const home = init.map.spawns[me.slot], homeD = Math.hypot(home.x - me.x, home.z - me.z);
      const enemyD = enemy ? Math.hypot(enemy.x - me.x, enemy.z - me.z) : 60;
      const enemyHp = enemy ? enemy.hp / enemy.maxHp : 0;
      const enemyZone = state.control.find(c => c.slot !== me.slot);
      const invaded = enemyZone && (me.slot === 1 ? me.x - me.z : me.z - me.x) < enemyZone.boundary;
      const towers = state.towers.filter(t => t.slot !== me.slot && !t.dead);
      const towerD = towers.length ? Math.min(...towers.map(t => Math.hypot(t.x - me.x, t.z - me.z))) : 60;
      const x = me.inputs?.keys?.x || 0, z = me.inputs?.keys?.z || 0;
      const tactical = [me.hp / me.maxHp, enemyHp, me.hp / me.maxHp - enemyHp, enemy ? 1 : 0,
        clip(enemyD / 30), clip(homeD / 60), (home.x - me.x) * sign / 60, (home.z - me.z) * sign / 60,
        enemy ? (enemy.x - me.x) * sign / 60 : 0, enemy ? (enemy.z - me.z) * sign / 60 : 0,
        invaded ? 1 : 0, me.safe ? 1 : 0, clip(towerD / 30), me.inputs?.target ? 1 : 0,
        x * sign, z * sign, me.qCd / cfg.qCd, me.eCd / cfg.eCd, me.cCd / cfg.cCd,
        clip(me.recall / cfg.recallTime), clip(me.stun), me.dead ? 1 : 0, me.aiming ? 1 : 0,
        enemyD <= cfg.atkRange ? 1 : 0, enemyD <= cfg.qRange ? 1 : 0, me.shield > 0 ? 1 : 0,
        me.speedBoost > 0 ? 1 : 0, Math.sin(me.face) * sign, Math.cos(me.face) * sign,
        clip(me.energy / 100), clip((me.x - me.z) * sign / 60), homeD > 0 ? (x * (home.x - me.x) + z * (home.z - me.z)) / homeD : 0];
      tactical.forEach((v, i) => { vector[SIZE - 32 + i] = Number.isFinite(v) ? clip(v) : 0; });
      if ([FARM_VERSION, DEFENSE_VERSION, ADAPTER_VERSION, ALARM_VERSION].includes(version)) {
        const own = state.control.find(c => c.slot === me.slot);
        const distance = e => Math.hypot(e.x - me.x, e.z - me.z);
        const nearest = entities => [...entities].sort((a, b) => distance(a) - distance(b))[0];
        const monster = nearest((state.monsters || []).filter(m => !m.large && !m.dead
          && own && (me.slot === 1 ? m.z - m.x : m.x - m.z) < own.boundary));
        const pickup = nearest(state.energy || []);
        const target = targets(state, me, init).find(e => e.id === me.inputs?.target);
        const relative = e => e && Number.isFinite(e.x) && Number.isFinite(e.z)
          ? [(e.x - me.x) * sign / 60, (e.z - me.z) * sign / 60] : [0, 0];
        const farm = [monster ? 1 : 0, ...relative(monster), monster ? distance(monster) / 60 : 1,
          monster ? monster.hp / monster.maxHp : 0, monster && distance(monster) <= cfg.atkRange + .9 ? 1 : 0,
          monster && distance(monster) <= cfg.qRange + .9 ? 1 : 0, target?.slot === 2 ? 1 : 0,
          pickup ? 1 : 0, ...relative(pickup), pickup ? distance(pickup) / 60 : 1,
          ...relative(me.inputs?.dest), ...relative(target)];
        farm.forEach((v, i) => { vector[SIZE - 48 + i] = Number.isFinite(v) ? clip(v) : 0; });
      }
      if ([DEFENSE_VERSION, ADAPTER_VERSION, ALARM_VERSION].includes(version)) {
        let threat = defenseContext(state, actor, init, memory);
        if (version === ALARM_VERSION && !threat?.recentDamage) threat = null;
        const t = threat?.tower, a = threat?.attacker;
        const td = t ? Math.hypot(t.x - me.x, t.z - me.z) : 60;
        const ad = a ? Math.hypot(a.x - me.x, a.z - me.z) : 60;
        const ownTowers = state.towers.filter(t => t.slot === me.slot && !t.dead);
        const defense = [t ? 1 : 0, t ? (t.x - me.x) * sign / 60 : 0, t ? (t.z - me.z) * sign / 60 : 0,
          td / 60, t ? t.hp / cfg.tower.hp : 0, threat?.recentDamage ? 1 : 0,
          a ? 1 : 0, a ? (a.x - me.x) * sign / 60 : 0, a ? (a.z - me.z) * sign / 60 : 0,
          ad / 60, a ? a.hp / (a.maxHp || cfg.robot.hp) : 0, state.players.some(p => p.id === a?.id) ? 1 : 0,
          a && ad <= cfg.atkRange ? 1 : 0, ownTowers.length / cfg.tower.count,
          ownTowers.reduce((sum, t) => sum + t.hp, 0) / (cfg.tower.hp * cfg.tower.count),
          adapter ? me.hp / me.maxHp : t && td > 0 ? (x * (t.x - me.x) + z * (t.z - me.z)) / td : 0];
        defense.forEach((v, i) => { vector[adapter ? SIZE + i : SIZE - 64 + i]
          = adapter && !t ? 0 : Number.isFinite(v) ? clip(v) : 0; });
      }
    }
    if (perception) vector.set((root.MinionPerception || require('./minion-perception')).features(memory, state, actor), 1040);
    return vector;
  }
  function updateMemory(memory, state, actor, events = [], version = null, init = null) {
    if (memory.time > state.time) { for (const key of Object.keys(memory)) delete memory[key]; }
    memory.time = state.time; memory.lastSeen ||= {};
    if (version === PERCEPTION_VERSION) {
      (root.MinionPerception || require('./minion-perception')).update(memory, state, actor, events, init);
      version = ALARM_VERSION;
    }
    const self = state.players.find(p => p.id === actor);
    for (const p of state.players) if (p.slot !== self?.slot && p.vis) memory.lastSeen.opponent = { x: p.x, z: p.z, seenAt: state.time, character: p.character };
    memory.cues ||= [];
    for (const e of events) memory.cues.push({ event: e.event, data: e.data, time: e.time });
    memory.cues = memory.cues.filter(e => state.time - e.time <= 3).slice(-32);
    if ([DEFENSE_VERSION, ADAPTER_VERSION, ALARM_VERSION].includes(version)) {
      const me = state.players.find(p => p.id === actor); memory.towers ||= {};
      for (const t of state.towers.filter(t => t.slot === me?.slot)) {
        const previous = memory.towers[t.id];
        memory.towers[t.id] = { hp: t.hp, hitAt: previous && t.hp < previous.hp ? state.time : previous?.hitAt ?? -100 };
      }
    }
    return memory;
  }
  function defenseContext(state, actor, init, memory = {}) {
    const me = state.players.find(p => p.id === actor);
    if (!me) return null;
    const enemies = [...state.players.filter(p => p.id !== actor && p.vis), ...state.robots]
      .filter(e => e.slot !== me.slot && !e.dead && !e.warping && Number.isFinite(e.x));
    let best = null, score = -Infinity;
    for (const tower of state.towers.filter(t => t.slot === me.slot && !t.dead)) {
      const nearby = enemies.filter(e => {
        const range = state.players.some(p => p.id === e.id)
          ? { ...init.cfg, ...(init.characters.find(c => c.id === e.character)?.stats || {}) }.atkRange : init.cfg.robot.atkRange;
        return Math.hypot(e.x - tower.x, e.z - tower.z) <= range + init.cfg.tower.radius + 2;
      }).sort((a, b) => Math.hypot(a.x - tower.x, a.z - tower.z) - Math.hypot(b.x - tower.x, b.z - tower.z));
      const recentDamage = state.time - (memory.towers?.[tower.id]?.hitAt ?? -100) <= 3;
      if (!nearby.length && !recentDamage) continue;
      const priority = (recentDamage ? 2 : 0) + (nearby.length ? 1 : 0) + 1 - tower.hp / init.cfg.tower.hp;
      if (priority > score) { best = { tower, attacker: nearby[0] || null, recentDamage }; score = priority; }
    }
    return best;
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
    if (model?.format !== VERSION || model.inputSize !== (model.featureVersion === PERCEPTION_VERSION ? 1072 : [ADAPTER_VERSION, ALARM_VERSION].includes(model.featureVersion) ? SIZE + 16 : SIZE) || JSON.stringify(model.events) !== JSON.stringify(EVENTS) || !Array.isArray(model.characters) || !model.characters.length || model.characters.some(id => !['alex', 'mira', 'bastion', 'lucia', 'darius'].includes(id))) throw Error('対応していないミニオンモデルです。');
    const h = model.hiddenSize, w = model.weights;
    if (model.featureVersion && ![TACTICAL_VERSION, FARM_VERSION, DEFENSE_VERSION, ADAPTER_VERSION, ALARM_VERSION, PERCEPTION_VERSION].includes(model.featureVersion)) throw Error('対応していない観測形式です。');
    if (model.movementOrder && !['stop-clears-chase/1', 'learned-chase-order/1'].includes(model.movementOrder)) throw Error('対応していない移動操作形式です。');
    if (model.controlProtocol && model.controlProtocol !== 'release-before-chase/1') throw Error('対応していない攻撃操作形式です。');
    if (model.aimProtocol && model.aimProtocol !== 'release-invalid-leap/1') throw Error('対応していない照準操作形式です。');
    if (model.decisionMode && model.decisionMode !== 'learned/1') throw Error('対応していない判断方式です。');
    if (!Number.isInteger(h) || h < 1 || h > 256 || !model.init?.map?.spawns || !w) throw Error('モデルの設定が不正です。');
    for (const [name, rows, columns] of [['hiddenW', h, model.inputSize], ['typeW', EVENTS.length, h], ['pointW', EVENTS.length * 2, h]]) {
      if (!Array.isArray(w[name]) || w[name].length !== rows || w[name].some(row => !Array.isArray(row) || row.length !== columns || row.some(n => !Number.isFinite(n)))) throw Error('モデルの重みが不正です。');
    }
    for (const [name, length] of [['hiddenB', h], ['typeB', EVENTS.length], ['pointB', EVENTS.length * 2]]) if (!Array.isArray(w[name]) || w[name].length !== length || w[name].some(n => !Number.isFinite(n))) throw Error('モデルのバイアスが不正です。');
    if (w.directionW || w.directionB) {
      if (!Array.isArray(w.directionW) || w.directionW.length !== 9 || w.directionW.some(row => !Array.isArray(row) || row.length !== h || row.some(n => !Number.isFinite(n)))
        || !Array.isArray(w.directionB) || w.directionB.length !== 9 || w.directionB.some(n => !Number.isFinite(n))) throw Error('移動方向の重みが不正です。');
    }
    if (w.orderW || w.orderB) {
      if (!Array.isArray(w.orderW) || w.orderW.length !== 2 || w.orderW.some(row => !Array.isArray(row) || row.length !== h || row.some(n => !Number.isFinite(n)))
        || !Array.isArray(w.orderB) || w.orderB.length !== 2 || w.orderB.some(n => !Number.isFinite(n))) throw Error('追跡操作の重みが不正です。');
    }
    if (w.defenseW && (![ADAPTER_VERSION, ALARM_VERSION, PERCEPTION_VERSION].includes(model.featureVersion) || !Array.isArray(w.defenseW) || w.defenseW.length !== 41
      || w.defenseW.some(row => !Array.isArray(row) || row.length !== 16 || row.some(n => !Number.isFinite(n))))) throw Error('防衛用の重みが不正です。');
    if (w.perceptionW && (model.featureVersion !== PERCEPTION_VERSION || !Array.isArray(w.perceptionW) || w.perceptionW.length !== 41
      || w.perceptionW.some(row => !Array.isArray(row) || row.length !== 32 || row.some(n => !Number.isFinite(n))))) throw Error('ブッシュ観測用の重みが不正です。');
    if (model.objectivePolicy) (root.MinionObjectives || require('./minion-objectives')).validate(model.objectivePolicy);
    if (model.tacticalPolicy) (root.MinionDecisions || require('./minion-decisions')).validate(model.tacticalPolicy);
    return model;
  }
  function forward(model, x) {
    const dense = (w, b, v) => w.map((row, i) => row.reduce((sum, n, j) => sum + n * v[j], b[i]));
    const w = model.weights, hidden = dense(w.hiddenW, w.hiddenB, x).map(Math.tanh);
    const extra = w.defenseW ? dense(w.defenseW, Array(41).fill(0), x.slice(SIZE)) : Array(41).fill(0);
    if (w.perceptionW) dense(w.perceptionW, Array(41).fill(0), x.slice(1040)).forEach((v, i) => { extra[i] += v; });
    const points = dense(w.pointW, w.pointB, hidden).map((n, i) => Math.tanh(n + extra[10 + i]));
    const directions = w.directionW ? dense(w.directionW, w.directionB, hidden).map((n, i) => n + extra[30 + i] + 1.5 * (DIRECTIONS[i][0] * points[2] + DIRECTIONS[i][1] * points[3])) : null;
    const orders = w.orderW ? dense(w.orderW, w.orderB, hidden).map((n, i) => n + extra[39 + i]) : null;
    return { logits: dense(w.typeW, w.typeB, hidden).map((n, i) => n + extra[i]), points, directions, orders };
  }
  function actionMask(model, observation, actor, explore = false) {
    const me = observation.players.find(p => p.id === actor);
    if (!me) return EVENTS.map((_, i) => i === 0);
    const locked = observation.phase !== 'playing' || me.dead || me.stun > 0 || me.air > 0 || me.warping > 0 || me.charging || me.grabbing || me.grabbed || me.flying;
    const candidates = targets(observation, me, model.init);
    const allowed = [true, !locked, !locked, !locked && candidates.length > 0, !locked && me.qCd <= 0,
      !locked && me.eCd <= 0, !locked && me.cCd <= 0, !locked && me.character === 'alex' && me.aiming && me.eCd <= 0, true, !locked];
    for (let i = 1; i < EVENTS.length; i++) if (!explore && !model.reinforcementLearning && model.training?.classCounts?.[EVENTS[i]] === 0) allowed[i] = false;
    return allowed;
  }
  function decode(model, observation, actor, type, point) {
    const me = observation.players.find(p => p.id === actor), event = EVENTS[type], sign = me.slot === 1 ? -1 : 1;
    let [x, z] = point;
    if (event === 'noop' || event === 'cancelLeap' || event === 'recall') return { event, data: null };
    if (event === 'steer') return { event, data: { x: clip(x * sign), z: clip(z * sign) } };
    x = me.x + x * 60 * sign; z = me.z + z * 60 * sign;
    if (event === 'chase') {
      const candidates = targets(observation, me, model.init);
      if (!candidates.length) return { event: 'noop', data: null };
      candidates.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
      return { event, data: { id: candidates[0].id } };
    }
    return { event, data: { x: clip(x, 29), z: clip(z, 29) } };
  }
  function decide(model, observation, actor, memory = {}, draw = null, directionDraw = null, orderDraw = null, decisionDraw = null) {
    const me = observation.players.find(p => p.id === actor);
    if (!me || !model.characters.includes(me.character)) return { event: 'noop', data: null };
    const world = root.ArenaWorld || (typeof require === 'function' ? require('../game-world') : null);
    const escapeAction = intent => {
      const inputs = model.decisionMode === 'learned/1' ? null : world?.retreatInputs?.(observation, actor, intent);
      return inputs ? { event: inputs[0].event, data: inputs[0].data, objectiveInputs: inputs, retreatMobility: true } : null;
    };
    const escape = escapeAction(null);
    if (escape) return escape;
    const objective = model.decisionMode !== 'learned/1' && model.objectivePolicy ? (root.MinionObjectives || require('./minion-objectives')).plan(model, observation, actor, memory) : null;
    if (objective && !objective.fallbackInputs) return objective;
    const observationFeatures = features(observation, actor, model.init, memory, model.featureVersion);
    const result = forward(model, observationFeatures);
    const allowed = actionMask(model, observation, actor);
    let type = 0;
    for (let i = 1; i < EVENTS.length; i++) if (allowed[i] && result.logits[i] > result.logits[type]) type = i;
    if (draw !== null) {
      const maximum = result.logits[type];
      const probabilities = result.logits.map((n, i) => allowed[i] ? Math.exp((n - maximum) / (model.reinforcementLearning?.temperature || 0.7)) : 0);
      let remaining = draw * probabilities.reduce((a, b) => a + b, 0);
      for (let i = 0; i < probabilities.length; i++) { remaining -= probabilities[i]; if (remaining <= 0) { type = i; break; } }
    }
    let point = result.points.slice(type * 2, type * 2 + 2);
    if (type === 1 && result.directions) {
      let selected = result.directions.indexOf(Math.max(...result.directions));
      if (directionDraw !== null) {
        const maximum = result.directions[selected], probabilities = result.directions.map(n => Math.exp((n - maximum) / (model.reinforcementLearning?.temperature || 0.7)));
        let remaining = directionDraw * probabilities.reduce((a, b) => a + b, 0);
        for (let i = 0; i < probabilities.length; i++) { remaining -= probabilities[i]; if (remaining <= 0) { selected = i; break; } }
      }
      point = DIRECTIONS[selected];
    }
    const action = decode(model, observation, actor, type, point);
    if (type === 1 && result.orders) {
      const temperature = model.reinforcementLearning?.temperature || .7;
      const probability = 1 / (1 + Math.exp((result.orders[0] - result.orders[1]) / temperature));
      action.cancelChase = Math.hypot(...point) < .01 || (orderDraw === null ? probability >= .5 : orderDraw < probability);
    }
    if (objective?.fallbackInputs) action.prefixInputs = objective.fallbackInputs;
    if (model.tacticalPolicy) return (root.MinionDecisions || require('./minion-decisions')).choose(model, observation, actor, action, memory,
      model.tacticalPolicy.contextSize?()=>features(observation,actor,model.init,memory,model.featureVersion):observationFeatures, decisionDraw ?? draw);
    return escapeAction(action) || action;
  }
  function commands(model, state, actor, action) {
    if(action.inputs)return action.inputs;
    if (action.objectiveInputs) return action.objectiveInputs;
    if (action.prefixInputs) return [...action.prefixInputs, ...commands(model, state, actor, { ...action, prefixInputs: null })];
    if (action.event === 'noop') return [];
    if (action.event === 'leap' && model.aimProtocol === 'release-invalid-leap/1') {
      const me = state.players.find(p => p.id === actor), init = model.init;
      const cfg = { ...init.cfg, ...(init.characters.find(c => c.id === me.character)?.stats || {}) };
      const world = root.ArenaWorld || (typeof require === 'function' ? require('../game-world') : null);
      const blocks = [...init.map.obst, ...state.towers.filter(t => !t.dead).map(t => ({ x: t.x, z: t.z, r: cfg.tower.radius }))];
      if (!world.validLanding(me, action.data, { range: cfg.leapRange, radius: cfg.radius, half: init.map.half,
        blocks, safe: { ...init.map.spawns[1 - me.slot], r: cfg.safeRadius }, travel: true })) return [{ event: 'cancelLeap' }];
    }
    if (action.event === 'chase' && model.controlProtocol === 'release-before-chase/1') return [{ event: 'steer', data: { x: 0, z: 0 } }, action];
    if (action.event === 'steer' && [TACTICAL_VERSION, FARM_VERSION, DEFENSE_VERSION, ADAPTER_VERSION, ALARM_VERSION, PERCEPTION_VERSION].includes(model.featureVersion)) {
      if (model.weights.orderW && !action.cancelChase && Math.hypot(action.data.x, action.data.z) > 0.01) return [action];
      if (model.movementOrder === 'stop-clears-chase/1' && Math.hypot(action.data.x, action.data.z) > 0.01) return [action];
      const me = state.players.find(p => p.id === actor);
      return [{ event: 'move', data: { x: me.x, z: me.z } }, action];
    }
    return [action];
  }
  function controller(model, { slot = 1, seed: initialSeed = 17, actorId = null } = {}) {
    validate(model);
    if (model.decisionIntervalTicks !== undefined && (!Number.isInteger(model.decisionIntervalTicks) || model.decisionIntervalTicks < 3 || model.decisionIntervalTicks > 9)) throw Error('Invalid policy decision interval');
    if (![0, 1].includes(slot) || !Number.isInteger(initialSeed)) throw Error('Invalid controller slot or seed');
    const memory = {}; let lastTick = -1, lastDecisionTick = -Infinity, cues = [], seed = initialSeed >>> 0;
    const observeState = state => {
      const actor = actorId || state.players.find(p => p.slot === slot && p.inputs)?.id || state.players.find(p => p.slot === slot)?.id;
      if (state.tick < lastTick) { for (const key of Object.keys(memory)) delete memory[key]; cues = []; seed = initialSeed >>> 0; }
      lastTick = state.tick;
      updateMemory(memory, state, actor, cues, model.featureVersion, model.init); cues = [];
      return actor;
    };
    const act = state => {
      const actor = observeState(state);
      if (state.tick < lastDecisionTick) lastDecisionTick = -Infinity;
      if (model.decisionIntervalTicks && state.tick - lastDecisionTick < model.decisionIntervalTicks) return [];
      lastDecisionTick = state.tick;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const draw = seed / 4294967296;
      let directionDraw = null;
      if (model.weights.directionW) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; directionDraw = seed / 4294967296; }
      let orderDraw = null;
      if (model.weights.orderW) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; orderDraw = seed / 4294967296; }
      let decisionDraw = null;
      if (model.tacticalPolicy && (root.MinionDecisions || require('./minion-decisions')).temperature(model.tacticalPolicy) > 0) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; decisionDraw = seed / 4294967296;
      }
      const action = decide(model, state, actor, memory, draw, directionDraw, orderDraw, decisionDraw);
      return commands(model, state, actor, action);
    };
    act.observe = event => cues.push(event);
    act.observeState = observeState;
    act.reset = () => { for (const key of Object.keys(memory)) delete memory[key]; cues = []; seed = initialSeed >>> 0; lastTick = -1; lastDecisionTick = -Infinity; };
    act.snapshot=()=>structuredClone({memory,cues,seed,lastTick,lastDecisionTick});
    act.restore=saved=>{
      const state=structuredClone(saved);for(const key of Object.keys(memory))delete memory[key];Object.assign(memory,state.memory);
      cues=state.cues;seed=state.seed;lastTick=state.lastTick;lastDecisionTick=state.lastDecisionTick;
    };
    return act;
  }
  const api = { VERSION, SIZE, EVENTS, DIRECTIONS, TACTICAL_VERSION, FARM_VERSION, DEFENSE_VERSION, ADAPTER_VERSION, ALARM_VERSION, PERCEPTION_VERSION, features, updateMemory, defenseContext, label, validate, forward, actionMask, decode, decide, commands, controller };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MinionPolicy = api;
})(globalThis);

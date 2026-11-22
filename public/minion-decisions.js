(function(root) {
  'use strict';
  const World = root.ArenaWorld || require('../game-world');
  const VERSION = 'minion-player-decisions/11', SIZE = 66, LEAGUE_SIZE = 96, STUDENT_SIZE = 128, MAX = 128;
  const DEFAULT_INFERENCE_TEMPERATURE = .5;
  const EVENTS = ['noop', 'steer', 'move', 'chase', 'q', 'dash', 'c', 'leap', 'cancelLeap', 'recall'];
  const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const clip = n => Math.max(-2, Math.min(2, Number.isFinite(n) ? n : 0));
  function validate(p) {
    const h = p?.hiddenSize, w = p?.weights;
    if (p?.version !== VERSION || !Number.isInteger(h) || h < 1 || h > 128 || !w || w.hiddenW?.length !== h
      || ![64, SIZE, LEAGUE_SIZE, STUDENT_SIZE].includes(p.inputSize || 64) || w.hiddenW.some(r => r.length !== (p.inputSize || 64) || r.some(v => !Number.isFinite(v))) || w.hiddenB?.length !== h
      || w.hiddenB.some(v => !Number.isFinite(v)) || w.outputW?.length !== h || w.outputW.some(v => !Number.isFinite(v)) || !Number.isFinite(w.outputB)) throw Error('戦闘判断モデルが不正です。');
    if (p.scope && p.scope !== 'visible-encounter/1') throw Error('戦闘判断の適用範囲が不正です。');
    if (p.contextSize !== undefined && (!Number.isInteger(p.contextSize) || p.contextSize < 1024 || p.contextSize > 2048 || w.contextW?.length !== h || w.contextW.some(r => r.length !== p.contextSize || r.some(v => !Number.isFinite(v))))) throw Error('全体観測の重みが不正です。');
    if (p.inferenceTemperature !== undefined) temperature(p);
    if(p.camps!==undefined&&(!Array.isArray(p.camps)||p.camps.length>6||p.camps.some(c=>typeof c.id!=='string'||!Number.isFinite(c.x)||!Number.isFinite(c.z)||Math.abs(c.x)>29||Math.abs(c.z)>29)))throw Error('Invalid known camp locations');
    if(p.baseProposal!==undefined&&typeof p.baseProposal!=='boolean')throw Error('Invalid base proposal setting');
    if(p.inputSize===STUDENT_SIZE&&!['minion-student-state/23','minion-student-state/24'].includes(p.featureVersion))throw Error('Unknown student observation features');
    if(['minion-student-state/23','minion-student-state/24'].includes(p.featureVersion)&&p.inputSize!==STUDENT_SIZE)throw Error('Student feature width mismatch');
    if(p.inputSize===STUDENT_SIZE&&p.camps?.length!==6)throw Error('Student observations need six known camp locations');
    if(p.actionProtocol!==undefined&&p.actionProtocol!=='composed-inputs/14')throw Error('Unknown learned input protocol');
  }
  function temperature(p, override = undefined) {
    const value = override ?? p.inferenceTemperature ?? (p.inputSize === LEAGUE_SIZE ? DEFAULT_INFERENCE_TEMPERATURE : 0);
    if (!Number.isFinite(value) || value < 0 || value > 5) throw Error('推論温度は0〜5で指定してください。');
    return value;
  }
  function select(scores, t, draw = null) {
    if (!scores.length || scores.some(v => !Number.isFinite(v))) throw Error('推論スコアが不正です。');
    if (!Number.isFinite(t) || t < 0 || t > 5) throw Error('推論温度は0〜5で指定してください。');
    const maximum = Math.max(...scores), best = scores.indexOf(maximum);
    if (t === 0 || draw === null) return best;
    if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw Error('推論乱数が不正です。');
    const weights = scores.map(s => Math.exp((s - maximum) / t));
    let remaining = draw * weights.reduce((s,w) => s+w,0);
    for (let i=0;i<weights.length;i++) { remaining-=weights[i]; if (remaining < 0) return i; }
    return weights.length-1;
  }
  function context(p, observation) {
    if (!p.contextSize) return null;
    if (observation?.length !== p.contextSize) throw Error('全体観測の長さが一致しません。');
    return p.weights.contextW.map(row => {
      let sum=0;for(let j=0;j<row.length;j++)sum+=row[j]*observation[j];return sum;
    });
  }
  function score(p, x, conditioning = null) {
    const w = p.weights;
    let total=w.outputB;
    for(let i=0;i<w.outputW.length;i++){
      const row=w.hiddenW[i];let sum=w.hiddenB[i]+(conditioning?.[i]||0);
      for(let j=0;j<row.length;j++)sum+=row[j]*x[j];
      total+=w.outputW[i]*Math.tanh(sum);
    }
    return total;
  }
  function candidates(model, state, actor, base, memory = {}) {
    const me = state.players.find(p => p.id === actor), cfg = World.configFor(me.character), sign = me.slot ? -1 : 1, home = World.MAP.spawns[me.slot];
    const league = [LEAGUE_SIZE,STUDENT_SIZE].includes(model.tacticalPolicy?.inputSize);
    const student = model.tacticalPolicy?.inputSize === STUDENT_SIZE;
    const bundles = model.tacticalPolicy?.featureVersion === 'minion-student-state/24';
    const composed=model.tacticalPolicy?.actionProtocol==='composed-inputs/14';
    let recallAllowed = true, holdRecall = false;
    if (league) {
      const prior = memory.recallControl;
      const now = state.time;
      const control = !prior || now < prior.time ? { retryAt: -100, damagedAt: -100 } : prior;
      if (prior && me.hp < prior.hp) control.damagedAt = now;
      if (prior?.recall > 0 && !me.recall) control.retryAt = now + 3;
      const threatens = (e, range) => {
        if (e.slot === me.slot || e.dead || e.vis === false || !Number.isFinite(e.x)) return false;
        return distance(me, e) <= range + cfg.radius + 1;
      };
      const danger = state.players.some(e => {
        const enemyCfg = World.configFor(e.character);
        return threatens(e, Math.max(enemyCfg.atkRange, enemyCfg.qRange, e.character === 'mira' ? enemyCfg.magicRange : enemyCfg.cRange || 0));
      }) || state.robots.some(e => threatens(e, World.configFor(e.character).robot.atkRange))
        || state.towers.some(e => threatens(e, World.CFG.tower.range)) || now - control.damagedAt < 1;
      const homeD = distance(me, home), dx = home.x - me.x, dz = home.z - me.z;
      const routeBlocked = [...state.players, ...state.robots].some(e => {
        if (e.slot === me.slot || e.dead || e.vis === false || !Number.isFinite(e.x) || !Number.isFinite(e.z)) return false;
        const t = ((e.x - me.x) * dx + (e.z - me.z) * dz) / (homeD * homeD || 1);
        if (t < 0 || t > 1) return false;
        const radius = state.robots.includes(e) ? World.configFor(e.character).robot.radius : World.configFor(e.character).radius;
        return Math.hypot(e.x - me.x - t * dx, e.z - me.z - t * dz) <= cfg.radius + radius + 2;
      });
      recallAllowed = !me.recall && !me.safe && me.hp < me.maxHp * .6
        && homeD > World.CFG.safeRadius + 2 && !(homeD <= 25 && !routeBlocked)
        && now >= control.retryAt && !danger;
      holdRecall = me.recall > 0 && !danger;
      memory.recallControl = { ...control, time: now, hp: me.hp, recall: me.recall };
      if (holdRecall || !recallAllowed && (base?.event === 'recall' || base?.inputs?.some(c => c.event === 'recall'))) base = { event: 'noop' };
    }
    if (league) {
      const prior = memory.leagueSignals;
      if (!prior || prior.tick !== state.tick) memory.leagueSignals = { tick: state.tick, hp: me.hp,
        damagedAt: prior && me.hp < prior.hp ? state.time : prior?.damagedAt ?? -100,
        recall: me.recall, cancelledAt: prior?.recall > 0 && me.recall === 0 && distance(me, home) > World.CFG.safeRadius ? state.time : prior?.cancelledAt ?? -100 };
    }
    const homeD = distance(me, home), heroes = state.players.filter(p => p.slot !== me.slot && p.vis && !p.dead && Number.isFinite(p.x));
    const enemy = [...heroes].sort((a, b) => distance(me, a) - distance(me, b))[0], d = enemy ? distance(me, enemy) : 60;
    const enemyZone = state.control.find(c => c.slot !== me.slot), ownZone = state.control.find(c => c.slot === me.slot);
    const depth = p => enemyZone ? Math.max(0, enemyZone.boundary - (me.slot ? p.x - p.z : p.z - p.x)) : 0;
    const towerRisk = p => state.towers.filter(t => t.slot !== me.slot && !t.dead && distance(t, p) <= World.CFG.tower.range + cfg.radius).length;
    const hp = me.hp / me.maxHp, ehp = enemy ? enemy.hp / enemy.maxHp : 0;
    const stateX = [hp, ehp, hp - ehp, Number(!!enemy), d / 30, (home.x - me.x) * sign / 60, (home.z - me.z) * sign / 60,
      enemy ? (enemy.x - me.x) * sign / 30 : 0, enemy ? (enemy.z - me.z) * sign / 30 : 0,
      me.qCd / cfg.qCd, me.eCd / cfg.eCd, me.cCd / cfg.cCd, Number(me.aiming), Number(me.shield > 0), Number(me.speedBoost > 0),
      me.recall / cfg.recallTime, Number(me.safe), depth(me) / 30, towerRisk(me), homeD / 60,
      enemy ? Number(enemy.hp <= cfg.atkDmg) : 0, enemy && me.qCd <= 0 ? Number(enemy.hp <= cfg.qDmg) : 0,
      enemy ? Number(d <= cfg.atkRange) : 0, enemy ? Number(d <= cfg.qRange) : 0, cfg.atkRange / 14, cfg.speed / 12,
      me.inputs?.target ? 1 : 0, Number(!!ownZone && (me.slot ? me.z - me.x : me.x - me.z) < ownZone.boundary),
      enemy ? enemy.shield / 2 : 0, heroes.length / 5, me.stun, Number(me.dead)].map(clip);
    const result = [];
    const obstacles = [...World.MAP.obst, ...state.towers.filter(t => !t.dead).map(t => ({ ...t, r: World.CFG.tower.radius })), { ...World.MAP.spawns[1 - me.slot], r: World.CFG.safeRadius }];
    function clearance(point) {
      const dx = point.x - me.x, dz = point.z - me.z, a = dx * dx + dz * dz;
      if (a < 1e-8) return 1;
      return obstacles.reduce((first, o) => {
        const ox = me.x - o.x, oz = me.z - o.z, radius = o.r + cfg.radius;
        const b = 2 * (dx * ox + dz * oz), c = ox * ox + oz * oz - radius * radius, disc = b * b - 4 * a * c;
        if (disc < 0 || c <= 0 && b >= 0) return first;
        const t = (-b - Math.sqrt(disc)) / (2 * a);
        return t <= 1 && (t >= 0 || c <= 0) ? Math.min(first, Math.max(0, t)) : first;
      }, 1);
    }
    function add(action, target = null, kind = 'point', delegate = false) {
      if (league && !recallAllowed && (action.event === 'recall' || action.inputs?.some(c => c.event === 'recall'))) return;
      if (result.length >= MAX) return;
      const point = action.event === 'steer' ? { x: me.x + action.data.x * 6, z: me.z + action.data.z * 6 } : target || (Number.isFinite(action.data?.x) ? action.data : me);
      const range = action.event === 'q' ? cfg.qRange : action.event === 'c' && me.character === 'mira' ? cfg.magicRange : action.event === 'c' ? cfg.cRange || cfg.atkRange : action.event === 'dash' || action.event === 'leap' ? cfg.leapRange : cfg.atkRange;
      const damage = action.event === 'q' ? cfg.qDmg : action.event === 'c' ? me.character === 'mira' ? cfg.magicDmg : cfg.cDmg || 0 : action.event === 'dash' ? cfg.chargeDmg || cfg.warpDmg || 0 : action.event === 'leap' ? cfg.leapDmg : cfg.atkDmg;
      const x = Array(model.tacticalPolicy?.inputSize || 64).fill(0); stateX.forEach((v, i) => { x[i] = v; });
      x[32 + EVENTS.indexOf(action.event)] = 1;
      ['hero', 'robot', 'monster', 'tower', 'home', 'point'].forEach((k, i) => { x[42 + i] = Number(kind === k); });
      const values = [target?.maxHp ? target.hp / target.maxHp : 0, target?.hp ? target.hp / cfg.atkDmg : 0,
        Number(target?.hp > 0 && target.hp <= cfg.atkDmg), Number(target?.hp > 0 && target.hp <= damage), distance(me, point) / 30,
        (point.x - me.x) * sign / 30, (point.z - me.z) * sign / 30, (homeD - distance(point, home)) / 20,
        depth(point) / 30, towerRisk(point), target?.hp ? target.hp / Math.max(1, me.hp) : 0, range / 20,
        Number(target?.id === me.inputs?.target), Number(kind === 'hero') * hp, Number(kind === 'home') * (1 - hp), Number(delegate)];
      values.forEach((v, i) => { x[48 + i] = clip(v); });
      if (x.length >= 66) {
        x[64] = clearance(point);
        x[65] = clip(Math.min(...obstacles.map(o => distance(me, o) - o.r - cfg.radius)) / 10);
      }
      if (league) {
        const signals = memory.leagueSignals;
        const shared = [state.time / 600, state.towers.filter(t => t.slot === me.slot && !t.dead).length / 5,
          state.towers.filter(t => t.slot !== me.slot && !t.dead).length / 5, (ownZone?.energy || 0) / 1000, (enemyZone?.energy || 0) / 1000,
          me.recall / World.CFG.recallTime, Math.max(0, 1 - (state.time - signals.damagedAt) / 3),
          Math.max(0, 1 - (state.time - signals.cancelledAt) / 5), Number(me.safe),
          ...['alex','mira','bastion','darius','lucia'].map(c => Number(me.character === c)),
          ...['alex','mira','bastion','darius','lucia'].map(c => Number(enemy?.character === c))];
        shared.forEach((v, i) => { x[66 + i] = clip(v); });
        const extras = [Number(!!target?.large), target?.large ? 1 - target.hp / target.maxHp : 0,
          Number(kind === 'tower') * (1 - (target?.hp || 0) / World.CFG.tower.hp),
          Number(kind === 'monster') * Number(depth(point) > 0), Number(action.event === 'recall') * hp,
          Number(action.event === 'recall') * homeD / 60,
          Number(action.event === 'recall') * Math.max(0, 1 - (state.time - signals.damagedAt) / 3),
          Number(kind === 'monster') * Math.max(0, 1 - (state.time - signals.damagedAt) / 3),
          Number(!!target?.large) * Number((target?.hp ?? Infinity) <= Math.max(cfg.atkDmg, me.qCd <= 0 ? cfg.qDmg : 0)),
          Number(kind === 'tower') * hp, Number(kind === 'home') * hp];
        extras.forEach((v, i) => { x[85 + i] = clip(v); });
      }
      if(student){
        const camps=[...(model.tacticalPolicy.camps||[])].sort((a,b)=>sign*(a.x-b.x)||sign*(a.z-b.z));
        const killed=memory.student?.camps||{},farmed=c=>Object.hasOwn(killed,c.id);
        const owned=c=>!!ownZone&&(me.slot?c.z-c.x:c.x-c.z)<ownZone.boundary;
        const seen=memory.lastSeen?.opponent,age=seen?state.time-seen.seenAt:100;
        const friendly=state.robots.filter(r=>r.slot===me.slot&&!r.dead),hostile=state.robots.filter(r=>r.slot!==me.slot&&!r.dead);
        const radius=kind==='tower'?World.CFG.tower.radius:kind==='monster'?(target?.large?1.5:.65):target?.radius||0;
        const dx=home.x-me.x,dz=home.z-me.z,dest=me.inputs?.dest;
        const values=[...camps.map(c=>Number(farmed(c))),camps.slice(0,3).filter(farmed).length/3,camps.filter(c=>owned(c)&&!farmed(c)).length/3,
          Number(!!target&&farmed(target)),Number(owned(point)),Number(!!dest&&distance(dest,home)<2),
          Number(age<10),seen?(seen.x-me.x)*sign/30:0,seen?(seen.z-me.z)*sign/30:0,Math.min(10,age)/10,
          friendly.length/5,hostile.length/5,friendly.filter(r=>distance(r,point)<8).length/5,hostile.filter(r=>distance(r,point)<8).length/5,
          (ownZone?.energy||0)/280,(enemyZone?.energy||0)/280,
          Number(!!target&&distance(me,point)<=cfg.atkRange+radius),Number(!!target&&distance(me,point)<=cfg.qRange+radius),
          Number(!!target&&distance(me,point)<=(me.character==='mira'?cfg.magicRange:cfg.cRange||0)+radius),
          Number(!!dest&&distance(dest,point)<1),
          Number(camps.some(c=>c.id===target?.id)&&!state.monsters.some(m=>m.id===target?.id&&!m.dead)),
          Number(state.energy.some(e=>e.id===target?.id)),
          dest?(dest.x-me.x)*dx/1800+(dest.z-me.z)*dz/1800:0];
        values.forEach((v,i)=>{x[96+i]=clip(v);});
        if(bundles){const inputs=action.inputs||[action];['q','c','dash','leap'].forEach((e,i)=>{x[123+i]=Number(inputs.some(a=>a.event===e));});x[127]=inputs.filter(a=>['q','c','dash','leap'].includes(a.event)).length/4;}
      }
      result.push({ action, x });
    }
    const baseTarget = base?.event === 'chase' ? [...heroes.map(p => ({ ...p, kind: 'hero' })), ...state.robots.map(p => ({ ...p, kind: 'robot' })), ...state.monsters.map(p => ({ ...p, kind: 'monster' })), ...state.towers.map(p => ({ ...p, kind: 'tower' }))].find(p => p.id === base.data?.id) : null;
    add(base || { event: 'noop' }, baseTarget, baseTarget?.kind || 'point', true);
    if (holdRecall) return result;
    if (model.tacticalPolicy?.scope === 'visible-encounter/1' && !heroes.some(p => distance(me, p) <= Math.max(16, cfg.leapRange))) return result;
    if (state.phase !== 'playing' || me.dead || me.stun > 0 || me.air > 0 || me.warping || me.charging || me.grabbing || me.grabbed || me.flying) return result;
    add({ event: 'noop' }); add({ event: 'move', data: { x: home.x, z: home.z } }, home, 'home');
    add({ event: 'recall' }); if (me.aiming) add({ event: 'cancelLeap' });
    if (league) {
      // A retreat is an available input combination, scored by the learned policy.
      // In particular, E must not keep a stale offensive chase order alive.
      const escape = World.retreatInputs(state, actor, { retreat: true });
      if (escape) add({ ...escape[escape.length - 1], inputs: escape }, { ...home, ...escape[0].data }, 'home');
      if(bundles&&me.character==='lucia'&&me.cCd<=0){
        add({event:'c',inputs:[{event:'move',data:{x:home.x,z:home.z}},{event:'c'}]},home,'home');
        if(escape)add({...escape[escape.length-1],inputs:[{event:'c'},...escape]},{...home,...escape[0].data},'home');
      }
    }
    const directions = Array.from({ length: 8 }, (_, i) => ({ x: Math.sin(i * Math.PI / 4), z: Math.cos(i * Math.PI / 4) }));
    directions.forEach(data => add({ event: 'steer', data, cancelChase: true }));
    if (league) {
      for(const camp of model.tacticalPolicy.camps||[])if(!state.monsters.some(m=>m.id===camp.id&&!m.dead))
        add({event:'move',data:{x:camp.x,z:camp.z}},camp,'monster');
      if(student&&!heroes.length&&memory.lastSeen?.opponent&&state.time-memory.lastSeen.opponent.seenAt<10){
        const seen=memory.lastSeen.opponent;
        add({event:'move',data:{x:seen.x,z:seen.z}},seen);
        for(const bush of World.MAP.bushes)if(distance(bush,seen)<bush.r+.8)add({event:'move',data:{x:bush.x,z:bush.z}},bush);
      }
      [...state.energy].sort((a,b) => distance(me,a)-distance(me,b)).slice(0,4).forEach(p => add({event:'move',data:{x:p.x,z:p.z}},p));
      Object.values(memory.perception?.enemies || {}).filter(e => e.belief?.confidence > 0).slice(0,2).forEach(e => add({event:'move',data:{x:e.belief.x,z:e.belief.z}},e.belief));
    }
    const safe = World.MAP.spawns[1 - me.slot];
    let others = [...state.robots.map(p => ({ ...p, kind: 'robot' })), ...state.monsters.map(p => ({ ...p, kind: 'monster' })), ...state.towers.map(p => ({ ...p, kind: 'tower' }))]
      .filter(p => p.slot !== me.slot && !p.dead && Number.isFinite(p.x)).sort((a, b) => distance(me, a) - distance(me, b)).slice(0, 6);
    if (league) others = [...state.towers.filter(t => t.slot !== me.slot && !t.dead).map(t => ({ ...t, kind: 'tower' })),
      ...state.monsters.filter(t => t.large && !t.dead).map(t => ({ ...t, kind: 'monster' })),
      ...state.monsters.filter(t => !t.large && !t.dead).sort((a,b) => distance(me,a)-distance(me,b)).slice(0,6).map(t => ({ ...t, kind:'monster' })),
      ...state.robots.filter(t => t.slot !== me.slot && !t.dead).sort((a,b) => distance(me,a)-distance(me,b)).slice(0,3).map(t => ({ ...t, kind:'robot' }))];
    const targets = [...heroes.map(p => ({ ...p, kind: 'hero' })), ...others].filter(p => p.kind === 'tower' || p.kind === 'monster' || distance(p, safe) > World.CFG.safeRadius);
    const combatInputs=t=>{
      const d=distance(me,t),r=t.kind==='tower'?World.CFG.tower.radius:t.kind==='monster'?(t.large?1.5:.65):t.radius||0,inputs=[];
      if(me.cCd<=0&&(['alex','bastion','lucia'].includes(me.character)||me.character==='mira'&&d<=cfg.magicRange+r||me.character==='darius'&&t.kind!=='tower'&&d<=cfg.cRange+r))inputs.push({event:'c',data:{x:t.x,z:t.z}});
      if(me.qCd<=0&&d<=cfg.qRange+r&&!(me.character==='darius'&&t.kind==='tower'))inputs.push({event:'q',data:{x:t.x,z:t.z}});
      return inputs;
    };
    const combined=(t,skills,event,data)=>({event,data,inputs:[{event:'steer',data:{x:0,z:0}},{event:'chase',data:{id:t.id}},...skills]});
    for (const t of targets) {
      add({ event: 'chase', data: { id: t.id } }, t, t.kind);
      if(!bundles||!['tower','monster'].includes(t.kind))add({ event: 'move', data: { x: t.x, z: t.z } }, t, t.kind);
      const skill=event=>({event,data:{x:t.x,z:t.z},...(composed?{inputs:[{event:'steer',data:{x:0,z:0}},{event:'chase',data:{id:t.id}},{event,data:{x:t.x,z:t.z}}]}:{})});
      if (me.qCd <= 0) add(skill('q'), t, t.kind);
      if (me.cCd <= 0) add(skill('c'), t, t.kind);
      if(bundles){
        const skills=combatInputs(t);
        if(skills.length>1)add(combined(t,skills,skills[skills.length-1].event,{x:t.x,z:t.z}),t,t.kind);
        if(me.eCd<=0&&['mira','bastion'].includes(me.character)&&skills.length)
          add(combined(t,[...skills,{event:'dash'}],'dash',null),t,t.kind);
      }
    }
    if (me.cCd <= 0 && ['alex', 'bastion', 'lucia'].includes(me.character)) add({ event: 'c' });
    if (me.eCd <= 0) {
      if (['mira', 'bastion'].includes(me.character) || me.character === 'alex' && !me.aiming) add({ event: 'dash' });
      if (['alex', 'darius', 'lucia'].includes(me.character) && (me.character !== 'alex' || me.aiming || composed)) {
        const anchors = [{ ...home, kind: 'home' }, ...targets, ...directions.map(v => ({ x: me.x + v.x * cfg.leapRange * .9, z: me.z + v.z * cfg.leapRange * .9, kind: 'point' }))];
        const blocks = [...World.MAP.obst, ...state.towers.filter(t => !t.dead).map(t => ({ ...t, r: World.CFG.tower.radius }))];
        for (const t of anchors) {
          const length = distance(me, t), scale = Math.min(1, cfg.leapRange * .95 / (length || 1)), to = { x: me.x + (t.x - me.x) * scale, z: me.z + (t.z - me.z) * scale };
          if (length < .1 || !World.validLanding(me, to, { range: cfg.leapRange, radius: cfg.radius, half: World.MAP.half, blocks, safe: { ...safe, r: World.CFG.safeRadius }, travel: me.character === 'alex' })) continue;
          const action={ event: me.character === 'alex' ? 'leap' : 'dash', data: to };
          if(composed&&me.character==='alex'&&!me.aiming)action.inputs=[{event:'dash'},{event:'leap',data:to}];
          add(action, { ...t, ...to }, t.kind);
          if(bundles&&t.id){
            const skills=combatInputs(t).filter(s=>!(me.character==='darius'&&s.event==='q'));
            if(skills.length)add(combined(t,[...skills,...(action.inputs||[action])],action.event,to),{...t,...to},t.kind);
          }
        }
      }
    }
    return result;
  }
  function choose(model, state, actor, base, memory = {}, observation = null, draw = null) {
    const choices = candidates(model, state, actor, base, memory);
    const conditioning = context(model.tacticalPolicy,typeof observation==='function'?observation():observation);
    const best = select(choices.map(c => score(model.tacticalPolicy,c.x,conditioning)),temperature(model.tacticalPolicy),draw);
    return { ...choices[best].action, tacticalChoice: best };
  }
  const api = { VERSION, SIZE, LEAGUE_SIZE, STUDENT_SIZE, MAX, DEFAULT_INFERENCE_TEMPERATURE, validate, score, context, temperature, select, candidates, choose };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MinionDecisions = api;
})(globalThis);

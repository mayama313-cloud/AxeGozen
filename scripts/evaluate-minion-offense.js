const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const World = require('../game-world');
const Policy = require('../public/minion-policy');
const { readJSON } = require('./minion-input');
const { evaluate } = require('./minion-rl-env');
const arg = (key, fallback) => { const i = process.argv.indexOf('--' + key); return i < 0 ? fallback : process.argv[i + 1]; };
const output = path.resolve(arg('output', 'datas/models/minion-v1-v8-offense'));
const files = [arg('reference', 'datas/models/minion-v1-v7-objectives/model.json'), arg('model', path.join(output, 'model.json'))];
function run(model, character, scenario, slot = 0, seed = 17) {
  let ready = scenario === 'match';
  const control = Policy.controller({ ...model, init: { cfg: World.CFG, map: World.MAP, characters: World.CHARACTERS } }, { slot, actorId: 'eval-model', seed });
  const goals = {}, events = [], learner = state => {
    if (!ready) return [];
    const action = control(state);
    for (const input of action) if (input.event === 'chase') {
      const id = input.data?.id, monster = state.monsters.find(m => m.id === id);
      const kind = monster ? monster.large ? 'large' : 'small' : state.towers.some(t => t.id === id) ? 'tower' : 'enemy';
      goals[kind] = (goals[kind] || 0) + 1;
    }
    return action;
  };
  learner.observe = event => { if (ready) control.observe?.(event); };
  learner.observeState = state => { if (ready) control.observeState?.(state); };
  learner.reset = () => control.reset();
  const controllers = [null, null]; controllers[slot] = learner;
  if (scenario !== 'match') controllers[1 - slot] = () => [];
  const game = World.createMatch(false, false, { controllers, onCombat: e => { if (ready) events.push(e); } });
  const hooks = [{}, {}];
  for (let s = 0; s < 2; s++) game.connect({ id: s === slot ? 'eval-model' : 'eval-enemy', on(e, fn) { hooks[s][e] = fn; }, emit() {}, disconnect() {} });
  hooks[slot].selectCharacter({ id: character }); hooks[1 - slot].selectCharacter({ id: 'alex' }); hooks.forEach(h => h.confirmCharacter());
  const me = game.state.players['eval-model'], enemy = game.state.players['eval-enemy'];
  let target = null;
  if (scenario !== 'match') {
    while (game.observe(me.id).time < 5.2) game.tick();
    Object.assign(me, { x: 18, z: -6, hp: me.cfg.maxHp, qCd: 0, eCd: 0, cCd: 0, target: null, dest: null, keys: null });
    Object.assign(enemy, { dead: true, respawn: 30, hp: 0, target: null, dest: null, keys: null });
    game.state.environment.totals[slot] = 120;
    if (scenario.startsWith('tower')) {
      target = game.state.towers['t1-2']; target.hp = 150;
      for (const t of Object.values(game.state.towers)) if (t.slot === 1 && t !== target) { t.dead = true; t.hp = 0; }
      Object.assign(me, { x: target.x - 5, z: target.z + 1 });
      game.state.environment.totals[slot] = 280;
      if (scenario === 'tower-guarded') {
        game.state.environment.totals[slot] = 0;
        Object.assign(enemy, { dead: false, hp: enemy.cfg.maxHp, x: target.x - 1, z: target.z + 1 });
        me.hp = me.cfg.maxHp * .35;
      }
    } else {
      target = game.state.monsters['monster-4']; target.hp = scenario === 'steal' ? 50 : 35;
      Object.assign(me, { x: target.x - 5, z: target.z, hp: me.cfg.maxHp });
      if (scenario === 'steal') {
        Object.assign(enemy, { dead: false, hp: enemy.cfg.maxHp, x: target.x + 2.5, z: target.z });
        game.input(enemy.id, 'chase', { id: target.id });
      }
    }
    ready = true; control.reset();
  }
  const start = game.observe(me.id).time, max = scenario === 'match' ? 600 : 12;
  let firstGoal = null, targetStart = target?.hp;
  for (;;) {
    game.tick(); const state = game.observe(me.id);
    if (!firstGoal && Object.keys(goals).length) firstGoal = Object.keys(goals)[0];
    if (state.phase === 'finished' || state.time - start >= max || scenario !== 'match' && (me.dead || target?.dead)) break;
  }
  const state = game.observe(me.id), mine = events.filter(e => e.source === me.id || e.owner === me.id);
  return { scenario, character, slot, firstChaseTarget: firstGoal, targetOrders: goals, seconds: state.time - start, energy: me.energy,
    winner: state.phase === 'finished' ? state.winner === slot ? 'model' : 'algorithm' : null,
    towerDamage: mine.filter(e => e.kind === 'damage' && e.targetKind === 'tower').reduce((n, e) => n + e.amount, 0),
    targetDamage: target ? Math.max(0, targetStart - target.hp) : null,
    targetSecured: !!target && mine.some(e => e.kind === 'kill' && e.target === target.id),
    deaths: events.filter(e => e.kind === 'kill' && e.target === me.id).length, hp: me.hp };
}
const report = { method: 'ordinary input gameplay; fixed offensive scenarios and full matches vs algorithm', models: [], limitation: 'small diagnostic sample, not a human or general win-rate estimate' };
for (const file of files) {
  const model = Policy.validate(readJSON(file));
  const scenarios = model.characters.flatMap(c => ['tower-opening', 'enemy-camp', 'steal', 'tower-guarded'].map(s => run(model, c, s)));
  const matches = model.characters.map((c, i) => run(model, c, 'match', i % 2, 291331 + i * 137));
  const regression = evaluate(model, { episodes: 16, maxSeconds: 20, seed: 291331, gamma: .997, scenarios: ['retreat', 'defense', 'large-finish', 'large-contest'] });
  const summary = { towerOpeningsAttacked: scenarios.filter(s => s.scenario === 'tower-opening' && s.towerDamage > 0).length,
    enemyCampsSecured: scenarios.filter(s => s.scenario === 'enemy-camp' && s.targetSecured).length,
    stealsSecured: scenarios.filter(s => s.scenario === 'steal' && s.targetSecured).length,
    guardedLowHpDeaths: scenarios.filter(s => s.scenario === 'tower-guarded').reduce((n, s) => n + s.deaths, 0),
    matchWins: matches.filter(s => s.winner === 'model').length, matchLosses: matches.filter(s => s.winner === 'algorithm').length,
    matchUnfinished: matches.filter(s => s.winner === null).length, matchEnergy: matches.map(s => s.energy),
    retreatRecovered: regression.episodes.filter(e => e.scenario === 'retreat' && e.recovery).length,
    defenseStops: regression.episodes.filter(e => e.scenario === 'defense' && e.defenseStopped).length,
    largeSecured: regression.episodes.filter(e => e.scenario.startsWith('large-') && e.largeKills > 0).length };
  report.models.push({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), summary, scenarios, matches, regression });
  console.log(JSON.stringify({ file, ...summary }));
}
fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'offense-comparison.json'), JSON.stringify(report, null, 2));

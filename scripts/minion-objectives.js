const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const World = require('../game-world');
const Policy = require('../public/minion-policy');
const Goals = require('../public/minion-objectives');
const { readJSON, parseJSON } = require('./minion-input');
const arg = (key, fallback) => { const i = process.argv.indexOf('--' + key); return i < 0 ? fallback : process.argv[i + 1]; };
const offense = process.argv.includes('--offense');
const output = path.resolve(arg('output', offense ? 'datas/models/minion-v1-v8-offense' : 'datas/models/minion-v1-v7-objectives'));
const sourcePath = path.resolve(arg('model', process.argv[2] === 'evaluate' ? path.join(output, 'model.json') : offense ? 'datas/models/minion-v1-v7-objectives/model.json' : 'datas/models/minion-v1-rl-v6-defense/model.json'));
let seed = Number(arg('seed', '20261123')) >>> 0;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

function prepare() {
  const sourceBytes = fs.readFileSync(sourcePath), model = Policy.validate(parseJSON(sourceBytes.toString('utf8'), sourcePath));
  if (path.dirname(sourcePath) === output) throw Error('Use a separate output directory');
  fs.mkdirSync(output, { recursive: true });
  const camps = World.createMatch(true).state.camps.map(({ id, x, z, large }) => ({ id, x, z, large }));
  model.objectivePolicy = { camps, version: offense ? Goals.OFFENSE_VERSION : Goals.VERSION };
  const prototypes = model.characters.map(character => {
    const handlers = {}, game = World.createMatch(false, true, { policy: () => [] });
    game.connect({ id: 'opponent', on(e, fn) { handlers[e] = fn; }, emit() {}, disconnect() {} });
    handlers.selectCpuCharacter({ id: character }); handlers.selectCharacter({ id: 'alex' }); handlers.confirmCharacter();
    for (let i = 0; i < 165; i++) game.tick();
    return game.observe('cpu-player');
  });
  const groups = [], count = Number(arg('groups', offense ? '12000' : '6000'));
  if (!Number.isInteger(count) || count < 100 || count > 100000) throw Error('groups must be 100..100000');
  for (let i = 0; i < count; i++) {
    const state = structuredClone(prototypes[i % prototypes.length]), me = state.players.find(p => p.id === 'cpu-player'), enemy = state.players.find(p => p.id !== me.id);
    state.time = random() < .08 ? random() * 4.9 : 10 + random() * 180;
    Object.assign(me, { x: -25 + random() * 50, z: -25 + random() * 50, hp: me.maxHp * (.1 + random() * .9),
      qCd: random() < .6 ? 0 : 2, cCd: random() < .6 ? 0 : 2, recall: random() < .04 ? 1 : 0 });
    if (random() < .3) Object.assign(enemy, { x: me.x + random() * 10 - 5, z: me.z + random() * 10 - 5 });
    else if (random() < .5) Object.assign(enemy, { x: 2, z: 3 });
    enemy.vis = random() > .1;
    if (offense) {
      enemy.dead = random() < .25; enemy.hp = enemy.maxHp * (.1 + random() * .9);
      state.control.forEach(c => { c.boundary = -random() * 28; });
      state.towers.forEach(t => { t.dead = random() < .18; t.hp = t.dead ? 0 : 10 + random() * 290; });
      if (i % 6 === 0) { Object.assign(me, { x: -8, z: 6, hp: me.maxHp }); Object.assign(enemy, { x: 22, z: -24, vis: true, dead: false }); }
    }
    if (!enemy.vis) { delete enemy.x; delete enemy.z; }
    const history = { towers: {}, cues: [] }, memory = { samples: {} };
    if (random() < .2) history.towers['t1-2'] = { hp: 200, hitAt: state.time };
    for (const monster of state.monsters) {
      monster.hp = 1 + random() ** 2 * (monster.maxHp - 1);
      const rate = monster.large || offense ? [0, 10, 25, 50, 100][Math.floor(random() * 5)] : 0;
      memory.samples[monster.id] = [{ hp: Math.min(monster.maxHp, monster.hp + rate * .5), time: state.time - .5 }, { hp: monster.hp, time: state.time }];
    }
    if (offense && i % 5 === 0) state.monsters = [];
    if (offense && i % 5 === 1 && state.monsters.length) {
      const m = state.monsters[i % state.monsters.length];
      Object.assign(me, { x: m.x + 5, z: m.z + 1, hp: me.maxHp });
      Object.assign(enemy, { x: m.x - 3, z: m.z, hp: enemy.maxHp, vis: true, dead: false });
      m.hp = 20 + random() * 25; memory.samples[m.id] = [{ hp: m.hp + 15, time: state.time - .5 }, { hp: m.hp, time: state.time }];
    }
    if (state.time < 5) state.monsters = [];
    state.energy = Array.from({ length: Math.floor(random() * 4) }, (_, j) => ({ id: 'energy-' + j, amount: 5, x: random() < .5 ? me.x + random() * 8 - 4 : random() * 4 - 2, z: random() * 4 - 2 }));
    if (random() < .3) {
      memory.goal = state.monsters[Math.floor(random() * state.monsters.length)]?.id;
      memory.progressAt = state.time - random() * 4;
    }
    const choices = Goals.candidates(model, state, me.id, memory, history);
    groups.push({ id: i, split: (offense ? random() < .2 : i % 5 === 0) ? 'test' : 'train', x: choices.map(g => g.features), y: choices.map(Goals.teacher), kinds: choices.map(g => g.kind) });
  }
  const data = { version: offense ? Goals.OFFENSE_VERSION : Goals.VERSION, features: offense ? Goals.OFFENSE_NAMES : Goals.NAMES, camps, seed: Number(arg('seed', '20261123')), groups,
    source: sourcePath, sourceSha256: crypto.createHash('sha256').update(sourceBytes).digest('hex'),
    teacher: offense ? 'synthetic offensive opportunities: last-hit steals, enemy camps, tower openings, zone/tower cost, safety and defense' : 'focused synthetic demonstrations: useful farming, safety, and reachable low-HP large-monster last hits' };
  fs.writeFileSync(path.join(output, 'objective-prepared.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(output, 'initial-model.json'), sourceBytes);
  console.log(JSON.stringify({ groups: count, output }));
}

function evaluate() {
  const { evaluate: run } = require('./minion-rl-env');
  const options = { episodes: Number(arg('episodes', '48')), maxSeconds: Number(arg('max-seconds', '60')),
    seed: Number(arg('seed', '291331')), gamma: .997, scenarios: ['match', 'retreat', 'retreat-hard', 'defense', 'large-finish', 'large-contest'] };
  if (!Number.isInteger(options.episodes) || options.episodes < 6 || options.episodes > 200 || options.maxSeconds < 1 || options.maxSeconds > 1200) throw Error('Invalid evaluation options');
  const report = { options, models: [], limitation: 'fixed scenarios against the game engine; no human win-rate claim' }, snapshots = [];
  const reference = path.resolve(arg('reference', 'datas/models/minion-v1-rl-v6-defense/model.json'));
  for (const file of [reference, sourcePath]) {
    const bytes = fs.readFileSync(file), model = Policy.validate(parseJSON(bytes.toString('utf8'), file)), evaluation = run(model, options), e = evaluation.episodes;
    snapshots.push(model.weights);
    const subset = name => e.filter(e => e.scenario === name), sum = (items, key) => items.reduce((n, e) => n + (e[key] || 0), 0);
    const matches = subset('match'), retreat = e.filter(e => e.scenario.startsWith('retreat')), defense = subset('defense'), large = e.filter(e => e.scenario.startsWith('large-'));
    const summary = { normalMatchEnergy: sum(matches, 'energy') / Math.max(1, matches.length),
      normalUnproductiveSeconds: sum(matches, 'unproductiveSeconds') / Math.max(1, matches.length),
      emptyAttacks: sum(e, 'emptyAttacks'), rejectedAttacks: sum(e, 'rejectedAttacks'), commands: sum(e, 'commands'),
      retreatRecoveries: retreat.filter(e => e.recovery).length, retreatAttempts: retreat.length,
      defenseStops: defense.filter(e => e.defenseStopped).length, defenseAttempts: defense.length,
      defenseTowerDamage: sum(defense, 'ownTowerDamage') / Math.max(1, defense.length),
      largeSecured: sum(large, 'largeKills'), largeAttempts: large.length,
      contestedSecured: sum(subset('large-contest'), 'largeKills'), contestedAttempts: subset('large-contest').length,
      deaths: sum(e, 'deaths'), wins: matches.filter(e => e.winner === 1).length, losses: matches.filter(e => e.winner === 0).length };
    report.models.push({ file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), summary, evaluation });
    console.log(JSON.stringify({ file, ...summary }));
  }
  report.baseActorUnchanged = JSON.stringify(snapshots[0]) === JSON.stringify(snapshots[1]);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'comparison.json'), JSON.stringify(report, null, 2));
}

try {
  if (process.argv[2] === 'evaluate') { evaluate(); process.exit(0); }
  if ((process.argv[2] || 'train') !== 'train') throw Error('command: train | evaluate');
  prepare();
  const result = spawnSync(arg('python', 'python'), [path.join(__dirname, 'train-minion-objectives.py'), '--output', output, '--epochs', arg('epochs', '100')], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error || Error('Objective training failed');
  const model = Policy.validate(readJSON(path.join(output, 'model.json'))), parity = readJSON(path.join(output, 'objective-parity.json'));
  const error = Math.abs(Goals.forward(model.objectivePolicy, parity.x) - parity.score);
  if (error > 1e-5) throw Error('Objective inference parity failed: ' + error);
  console.log(JSON.stringify({ model: path.join(output, 'model.json'), objectiveParityError: error }));
  const parityPath = path.join(path.dirname(sourcePath), 'parity.json');
  if (fs.existsSync(parityPath)) fs.copyFileSync(parityPath, path.join(output, 'parity.json'));
  if (fs.existsSync(path.join(output, 'parity.json'))) {
    const smoke = spawnSync(process.execPath, [path.join(__dirname, 'minion-v1.js'), 'smoke', '--output', output], { stdio: 'inherit' });
    if (smoke.error || smoke.status !== 0) throw smoke.error || Error('Objective gameplay smoke failed');
  }
} catch (error) { console.error(error.stack); process.exitCode = 1; }

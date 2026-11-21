const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Policy = require('../public/minion-policy');
const { evaluate } = require('./minion-rl-env');
const { readJSON } = require('./minion-input');
const arg = (key, fallback) => { const i = process.argv.indexOf('--' + key); return i < 0 ? fallback : process.argv[i + 1]; };
const output = path.resolve(arg('output', 'datas/models/minion-v1-v9-ppo-retreat'));
const episodes = Number(arg('episodes', '64')), seed = Number(arg('seed', '90261121'));
if (!Number.isInteger(episodes) || episodes < 32 || episodes > 512 || episodes % 32 || !Number.isInteger(seed)) throw Error('episodes must be a multiple of 32, within 32..512');
const files = [arg('reference', 'datas/models/minion-v1-v8-offense/model.json'),
  arg('baseline', 'datas/models/minion-v1-v9-ppo/warm-start-model.json'), arg('model', path.join(output, 'model.json'))];
const scenarios = ['match', 'farm', 'retreat', 'retreat-hard', 'retreat-chase', 'defense', 'large-finish', 'large-contest'];
const report = { protocol: 'held-out-survival/1', options: { episodes, seed, maxSeconds: 30, scenarios, rewardProfile: 'survival/1' },
  models: [], limitation: 'fixed diagnostic starts; 30-second matches are not full-match win rates; no runtime tactical overrides for learned/1 models' };
for (const file of files) {
  const model = Policy.validate(readJSON(file)), measured = evaluate(model, report.options);
  const e = measured.episodes, retreat = e.filter(e => e.scenario.startsWith('retreat')), match = e.filter(e => e.scenario === 'match');
  const summary = { retreatAttempts: retreat.length, recoveries: retreat.filter(e => e.recovery).length,
    retreatDeaths: retreat.reduce((n, e) => n + e.deaths, 0), retreatTimeouts: retreat.filter(e => e.truncated).length,
    chaseAttempts: retreat.filter(e => e.scenario === 'retreat-chase').length,
    chaseRecoveries: retreat.filter(e => e.scenario === 'retreat-chase' && e.recovery).length,
    totalDeaths: e.reduce((n, e) => n + e.deaths, 0), normalMatchEnergy: match.reduce((n, e) => n + e.energy, 0) / match.length,
    defenseStops: e.filter(e => e.scenario === 'defense' && e.defenseStopped).length,
    largeSecured: e.filter(e => e.scenario.startsWith('large-') && e.largeKills).length };
  const perCharacter = model.characters.map(character => { const rows = retreat.filter(e => e.character === character); return { character, attempts: rows.length, recoveries: rows.filter(e => e.recovery).length, deaths: rows.reduce((n, e) => n + e.deaths, 0) }; });
  report.models.push({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    decisionMode: model.decisionMode || 'hybrid', selectedCheckpoint: model.selection?.tag, summary, perCharacter, evaluation: measured });
  console.log(JSON.stringify({ file, ...summary, perCharacter }));
}
fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'survival-comparison.json'), JSON.stringify(report, null, 2));

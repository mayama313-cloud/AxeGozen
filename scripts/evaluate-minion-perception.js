const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Policy = require('../public/minion-policy');
const { evaluate } = require('./minion-rl-env');
const { readJSON } = require('./minion-input');
const arg = (key, fallback) => { const i = process.argv.indexOf('--' + key); return i < 0 ? fallback : process.argv[i + 1]; };
const output = path.resolve(arg('output', 'datas/models/minion-v1-v10-bush-adapter'));
const episodes = Number(arg('episodes', '64'));
if (!Number.isInteger(episodes) || episodes < 16 || episodes > 256 || episodes % 16) throw Error('episodes must be a multiple of 16 within 16..256');
const options = { episodes, maxSeconds: 12, seed: Number(arg('seed', '90261125')), rewardProfile: 'survival/1',
  scenarios: ['bush-entry', 'bush-attack', 'bush-empty', 'bush-exit'] };
const report = { protocol: 'bush-perception-diagnostic/2', resetProtocol: 'randomized distance, angle and enemy HP in one bush area', options, models: [], limitation: 'small fixed-area diagnostic; memory evidence is not proof of current occupancy; no general win-rate claim' };
for (const file of [arg('baseline', 'datas/models/minion-v1-v9-ppo/model.json'), arg('model', path.join(output, 'model.json'))]) {
  const model = Policy.validate(readJSON(file)), evaluation = evaluate(model, options), episodes = evaluation.episodes;
  const results = options.scenarios.map(scenario => {
    const rows = episodes.filter(e => e.scenario === scenario);
    return { scenario, attempts: rows.length, beliefsAtStart: rows.filter(e => e.bushBeliefAtStart).length,
      hitEpisodes: rows.filter(e => e.damageDealt > 0).length, investigated: rows.filter(e => e.bushInvestigated).length,
      meanDamage: rows.reduce((n, e) => n + e.damageDealt, 0) / rows.length, deaths: rows.reduce((n, e) => n + e.deaths, 0) };
  });
  report.models.push({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    selectedCheckpoint: model.selection?.tag, featureVersion: model.featureVersion, results, evaluation });
  console.log(JSON.stringify({ file, results }));
}
fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'perception-comparison.json'), JSON.stringify(report, null, 2));

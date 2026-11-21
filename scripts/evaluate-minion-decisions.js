'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Policy = require('../public/minion-policy');
const { readJSON } = require('./minion-input');
const { evaluate } = require('./minion-rl-env');
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i < 0 ? fallback : process.argv[i + 1]; };
const scenarios = ['duel-retreat', 'duel-retreat-chase', 'finish-static', 'finish-flee', 'farm', 'match', 'bush-entry', 'bush-attack'];
function summarize(result) {
  const retreats = result.episodes.filter(e => e.scenario.startsWith('duel-retreat'));
  const finishes = result.episodes.filter(e => e.scenario.startsWith('finish-'));
  const normal = result.episodes.filter(e => e.scenario === 'match');
  return { retreats: retreats.length, recoveries: retreats.filter(e => e.recovery).length,
    retreatDeaths: retreats.reduce((s, e) => s + e.deaths, 0), finishes: finishes.length,
    finishKills: finishes.filter(e => e.kills > 0).length,
    normalEnergy: normal.reduce((s, e) => s + e.energy, 0) / Math.max(1, normal.length),
    perCharacter: result.characters.map(character => {
      const r = retreats.filter(e => e.character === character), f = finishes.filter(e => e.character === character);
      return { character, retreats: r.length, recoveries: r.filter(e => e.recovery).length, finishes: f.length, finishKills: f.filter(e => e.kills > 0).length };
    }) };
}
if (require.main === module) {
  const modelPath = path.resolve(arg('model', 'datas/models/minion-v1-v11-combat/model.json'));
  const baselinePath = path.resolve(arg('baseline', 'datas/models/minion-v1-v10-bush-adapter/model.json'));
  const output = path.resolve(arg('output', path.join(path.dirname(modelPath), 'combat-comparison.json')));
  const episodes = Number(arg('episodes', '128')), maxSeconds = Number(arg('seconds', '25')), seed = Number(arg('seed', '90261203'));
  if (!Number.isInteger(episodes) || episodes < 32 || episodes > 1024 || episodes % 32 || !Number.isFinite(maxSeconds) || maxSeconds <= 0 || !Number.isInteger(seed)) throw Error('Invalid evaluation options');
  const options = { episodes, maxSeconds, seed, scenarios, rewardProfile: 'survival/1', decisionTraining: true };
  const report = { options, limitation: 'Randomized starts within a small encounter curriculum; not full-match win rate or general combat mastery', models: [] };
  for (const file of [baselinePath, modelPath]) {
    const model = Policy.validate(readJSON(file));
    const modelSha256 = crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex');
    const result = evaluate(model, options), summary = summarize(result);
    report.models.push({ file, modelSha256, selection: model.selection, summary, result }); console.log(JSON.stringify({ file, modelSha256, summary }));
  }
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
}
module.exports = { summarize };

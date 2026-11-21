'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Policy = require('../public/minion-policy');
const Decisions = require('../public/minion-decisions');
const { readJSON } = require('./minion-input');
const { Pool, LeagueEnvironment } = require('./minion-league-env');
const arg = (name,fallback) => {const i=process.argv.indexOf('--'+name);return i<0?fallback:process.argv[i+1];};
const modelPath=path.resolve(arg('model','datas/models/minion-v1-v12-activity/model.json'));
const reference=path.resolve(arg('reference','datas/models/minion-v1-v11-combat/model.json'));
const history=process.argv.flatMap((v,i)=>v==='--history'?[path.resolve(process.argv[i+1])]:[]);
if(!history.length)history.push(path.resolve('datas/models/minion-v1-v10-bush-adapter/model.json'),path.resolve('datas/models/minion-v1-v8-offense/model.json'));
const games=Number(arg('games','16')),maxSeconds=Number(arg('max-seconds','900')),seed=Number(arg('seed','90261205'));
const sample=process.argv.includes('--sample');
const temperatureOverride=process.argv.includes('--temperature')?Number(arg('temperature',null)):sample?1:undefined;
if(temperatureOverride!==undefined)Decisions.temperature({},temperatureOverride);
if(!Number.isInteger(games)||games<4||games>512||!Number.isInteger(seed))throw Error('Invalid evaluation settings');
const poolConfig={latest:reference,history,weights:{latest:4,history:3,algorithm:3}};
const report={protocol:'full-match-league/12',seed,games,maxSeconds,pool:poolConfig,inference:{temperatureOverride:temperatureOverride??null},
  definition:'Wins require actual tower destruction; time limits count as draws. This is a limited evaluation, not a strength guarantee.',models:[]};
for(const file of [reference,modelPath]){
  const model=Policy.validate(readJSON(file)),pool=new Pool(poolConfig),episodes=[];
  for(let i=0;i<games;i++){
    let rng=(seed+i*997 ^ 12345)>>>0;const rand=()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng/4294967296;};
    const env=new LeagueEnvironment(model,pool,{seed:seed+i*997,maxSeconds,intervalTicks:model.decisionIntervalTicks||3});
    let observation=env.reset({character:model.characters[i%model.characters.length],slot:Math.floor(i/model.characters.length)%2});
    for(;;){
      const conditioning=Decisions.context(model.tacticalPolicy,observation.x);
      const scores=env.choices.map(c=>Decisions.score(model.tacticalPolicy,c.x,conditioning));
      const best=Decisions.select(scores,Decisions.temperature(model.tacticalPolicy,temperatureOverride),rand());
      const r=env.step(best,false);if(r.episode){episodes.push(r.episode);console.log(JSON.stringify({file,game:i+1,...r.episode}));break;}observation=r.observation;
    }
  }
  const wins=episodes.filter(e=>e.winner===1).length,losses=episodes.filter(e=>e.winner===0).length;
  report.models.push({file,sha256:crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex'),
    inferenceTemperature:Decisions.temperature(model.tacticalPolicy,temperatureOverride),wins,losses,draws:games-wins-losses,winRateAllGames:wins/games,winRateDecided:wins+losses?wins/(wins+losses):null,episodes});
}
const output=path.resolve(arg('output',path.join(path.dirname(modelPath),'league-evaluation.json')));
fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({output,models:report.models.map(({episodes,...m})=>m)}));

'use strict';
// On-policy state collection: learned choices visit states; engine forks supply returns, not expert labels.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const World=require('../game-world'),Policy=require('../public/minion-policy'),Decisions=require('../public/minion-decisions');
const {Pool,LeagueEnvironment,REWARD_VERSION}=require('./minion-league-env');
const {readJSON}=require('./minion-input');
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i<0?d:process.argv[i+1];};
const file=path.resolve(arg('model','datas/models/minion-v1-v14-balanced/model.json'));
const output=path.resolve(arg('output','datas/lookahead/v14-trajectory.jsonl'));
const horizon=Number(arg('horizon','10')),seed=Number(arg('seed','20261227'));
const model=Policy.validate(readJSON(file)),characters=arg('characters',model.characters.join(',')).split(',');
if(!Number.isFinite(horizon)||horizon<1||horizon>30||characters.some(c=>!model.characters.includes(c)))throw Error('Invalid collection settings');
const poolConfig={latest:file,history:[path.resolve('datas/models/minion-v1-v12-activity/model.json')],weights:{latest:4,history:3,algorithm:3}};
const pool=new Pool(poolConfig);fs.mkdirSync(path.dirname(output),{recursive:true});const fd=fs.openSync(output,'wx');
fs.writeFileSync(output+'.meta.json',JSON.stringify({model:file,sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),cfg:World.CFG,map:World.MAP,rewardProfile:REWARD_VERSION,characters,seed,horizon,pool:poolConfig},null,2));
let states=0,rollouts=0;
try{
  for(const character of characters)for(const slot of [0,1]){
    const env=new LeagueEnvironment(model,pool,{seed:seed+states*137,maxSeconds:600});
    let observation=env.reset({character,slot,scenario:'match'}),ended=false;
    for(const time of [8,20,40,65,95,140]){
      while(env.elapsed<time){
        const context=Decisions.context(model.tacticalPolicy,observation.x);
        const i=Decisions.select(env.choices.map(c=>Decisions.score(model.tacticalPolicy,c.x,context)),Decisions.temperature(model.tacticalPolicy),env.random());
        const r=env.step(i,false);if(r.episode){ended=true;break;}observation=r.observation;
      }
      if(ended)break;
      const me=env.state.players.find(p=>p.id==='league-learner');
      if(me.dead||me.stun||me.air||me.charging||me.warping||me.grabbing||me.grabbed||me.flying)continue;
      observation=env.observation();const snapshot=env.snapshot(),choices=structuredClone(env.choices),returns=[],outcomes=[];
      for(let i=0;i<choices.length;i++){
        env.restore(snapshot);returns.push(env.lookahead(i,horizon));
        outcomes.push({seconds:env.elapsed-snapshot.data.elapsed,smallKills:env.metrics.smallKills-snapshot.data.metrics.smallKills,
          towerDamage:env.metrics.towerDamage-snapshot.data.metrics.towerDamage,deaths:env.metrics.deaths-snapshot.data.metrics.deaths});rollouts++;
      }
      env.restore(snapshot);
      const row={state:states++,scenario:'on-policy',character,slot,prefix:time,hpScale:me.hp/me.maxHp,horizon,rewardProfile:REWARD_VERSION,x:observation.x,decisionX:observation.decisionX,returns,actions:choices.map(c=>c.action),outcomes};
      fs.writeSync(fd,JSON.stringify(row)+'\n');const best=returns.indexOf(Math.max(...returns));
      console.log(JSON.stringify({states,rollouts,character,slot,time,best:choices[best].action,value:returns[best]}));
    }
  }
}finally{fs.closeSync(fd);}
console.log(JSON.stringify({complete:true,states,rollouts,output}));

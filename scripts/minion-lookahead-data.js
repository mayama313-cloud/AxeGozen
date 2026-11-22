'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const World=require('../game-world'),Policy=require('../public/minion-policy');
const {Pool,LeagueEnvironment,REWARD_VERSION}=require('./minion-league-env');
const {readJSON}=require('./minion-input');
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i<0?d:process.argv[i+1];};
const file=path.resolve(arg('model','datas/models/minion-v1-v14-balanced/model.json'));
const output=path.resolve(arg('output','datas/lookahead-v14.jsonl'));
const seeds=Number(arg('seeds','1')),horizon=Number(arg('horizon','12')),seed=Number(arg('seed','20261220'));
const rolloutSettings=process.argv.includes('--follow-policy-after')?{followPolicyAfter:Number(arg('follow-policy-after','.2'))}:{};
if(!Number.isInteger(seeds)||seeds<1||seeds>32||!Number.isFinite(horizon)||horizon<1||horizon>30)throw Error('Invalid lookahead settings');
if(fs.existsSync(output))throw Error('Use a new lookahead dataset path');
fs.mkdirSync(path.dirname(output),{recursive:true});const fd=fs.openSync(output,'wx');
const model=Policy.validate(readJSON(file)),pool=new Pool({latest:file,history:[file]});let states=0,rollouts=0;
if(process.argv.includes('--composed'))model.tacticalPolicy={...model.tacticalPolicy,actionProtocol:'composed-inputs/14'};
const characters=arg('characters',model.characters.join(',')).split(',');
if(characters.some(c=>!model.characters.includes(c)))throw Error('Unsupported dataset character');
fs.writeFileSync(output+'.meta.json',JSON.stringify({model:file,sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),cfg:World.CFG,map:World.MAP,rewardProfile:REWARD_VERSION,characters,seed,horizon,rolloutSettings,encounter:process.argv.includes('--encounter'),composed:!!model.tacticalPolicy.actionProtocol},null,2));
const scenarios=arg('scenarios','farm-spawn,farm-start,push-spawn-9,push-9').split(',');
const prefixes=arg('prefixes','0,3').split(',').map(Number);
if(prefixes.some(n=>!Number.isFinite(n)||n<0||n>30))throw Error('Invalid prefix duration');
try{
  for(let k=0;k<seeds;k++)for(const character of characters)for(const slot of [0,1])for(const scenario of scenarios){
    const env=new LeagueEnvironment(model,pool,{seed:seed+k*7919+states*137,maxSeconds:600});
    env.reset({character,slot,scenario,entry:null,category:'algorithm',opponentCharacter:World.CHARACTERS[(k+states)%World.CHARACTERS.length].id});
    for(const prefix of prefixes){
      if(prefix){
        const eligible=env.choices.map((c,i)=>({c,i})).filter(({c})=>c.action.event==='chase');
        if(!eligible.length)continue;
        const choice=eligible[Math.floor(env.random()*eligible.length)].i;env.lookahead(choice,prefix);env.observation();
      }
      const me=env.state.players.find(p=>p.id==='league-learner');
      if(me.dead||me.stun||me.air||me.charging||me.warping||me.grabbing||me.grabbed||me.flying)continue;
      const stage=env.snapshot();
      for(const hpScale of process.argv.includes('--wounded')?[1,.35]:[1]){
      for(const enemyHpScale of process.argv.includes('--encounter')?[1,.2]:[null]){
      env.restore(stage);const player=env.game.state.players['league-learner'];player.hp*=hpScale;
      if(enemyHpScale!==null){
        const enemy=env.game.state.players['league-opponent'];
        const blocks=[...World.MAP.obst,...Object.values(env.game.state.towers).filter(t=>!t.dead).map(t=>({...t,r:World.CFG.tower.radius}))];
        let position;
        for(let n=0;n<24;n++){
          const angle=n*Math.PI/12,to={x:player.x+Math.sin(angle)*5.5,z:player.z+Math.cos(angle)*5.5};
          if(World.MAP.bushes.some(b=>Math.hypot(to.x-b.x,to.z-b.z)<b.r+enemy.cfg.radius))continue;
          if(World.validLanding(player,to,{range:5.51,radius:enemy.cfg.radius,half:World.MAP.half,blocks,safe:{...World.MAP.spawns[player.slot],r:World.CFG.safeRadius}})){position=to;break;}
        }
        if(!position)throw Error('Missing valid encounter position');
        Object.assign(enemy,{...position,hp:enemy.cfg.maxHp*enemyHpScale,target:null,keys:null,dest:null});
      }
      env.state=env.game.observe(player.id);delete env.memory.leagueSignals;env.previousPotential=env.potential();
      const observation=env.observation(),snapshot=env.snapshot(),choices=structuredClone(env.choices),returns=[],outcomes=[];
      for(let i=0;i<choices.length;i++){
        env.restore(snapshot);const reward=env.lookahead(i,horizon,rolloutSettings);returns.push(reward);
        outcomes.push({seconds:env.elapsed-snapshot.data.elapsed,smallKills:env.metrics.smallKills-snapshot.data.metrics.smallKills,
          towerDamage:env.metrics.towerDamage-snapshot.data.metrics.towerDamage,
          directTowerDamage:env.metrics.directTowerDamage-snapshot.data.metrics.directTowerDamage,
          summonTowerDamage:env.metrics.summonTowerDamage-snapshot.data.metrics.summonTowerDamage,
          directSmallKills:env.metrics.directSmallKills-snapshot.data.metrics.directSmallKills,
          smallMonsterReward:env.metrics.rewardComponents.smallMonster-snapshot.data.metrics.rewardComponents.smallMonster,
          forwardSeconds:env.metrics.forwardSeconds-snapshot.data.metrics.forwardSeconds,
          deaths:env.metrics.deaths-snapshot.data.metrics.deaths});rollouts++;
      }
      env.restore(snapshot);const row={state:states++,scenario:enemyHpScale===null?scenario:'encounter-'+scenario,character,slot,prefix,hpScale,enemyHpScale,horizon,rolloutSettings,rewardProfile:REWARD_VERSION,x:observation.x,decisionX:observation.decisionX,
        returns,actions:choices.map(c=>c.action),outcomes};
      fs.writeSync(fd,JSON.stringify(row)+'\n');
      const best=returns.indexOf(Math.max(...returns));console.log(JSON.stringify({states,rollouts,scenario,character,slot,prefix,best:choices[best].action,value:returns[best]}));
      }
      }
      env.restore(stage);
    }
  }
}finally{fs.closeSync(fd);}
console.log(JSON.stringify({complete:true,states,rollouts,output}));

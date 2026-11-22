'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const World=require('../game-world'),Policy=require('../public/minion-policy'),D=require('../public/minion-decisions');
const {Pool,LeagueEnvironment}=require('./minion-league-env'),{teacherChoice,captureSkills}=require('./collect-minion-teacher'),{readJSON}=require('./minion-input');
const arg=(key,fallback)=>{const i=process.argv.indexOf('--'+key);return i<0?fallback:process.argv[i+1];};

function queryTeacher(env,skills){
  const saved=env.snapshot(),p=env.game.state.players['league-learner'],controller=p.controller;
  try{
    p.controller=null;p.thinkTime=0;skills.length=0;env.game.tick();
    return teacherChoice(saved.data.choices,env.state,'league-learner',p,skills);
  }finally{p.controller=controller;env.restore(saved);}
}

function collect(options){
  const model=Policy.validate(readJSON(options.model)),characters=options.characters||model.characters;
  if(characters.some(c=>!model.characters.includes(c))||!Number.isFinite(options.seconds)||options.seconds<1||options.seconds>600)throw Error('Invalid DAgger collection options');
  if(fs.existsSync(options.output))throw Error('Use a new DAgger dataset path');
  fs.mkdirSync(path.dirname(options.output),{recursive:true});const fd=fs.openSync(options.output,'wx');
  const pool=new Pool({latest:options.model,history:[options.model]});let rows=0;const episodes=[],modes={},events={};let camps;
  try{
    for(const character of characters)for(const slot of [0,1])for(const opponentCharacter of World.CHARACTERS.map(c=>c.id)){
      const env=new LeagueEnvironment(model,pool,{seed:options.seed+episodes.length*997,maxSeconds:options.seconds});
      env.reset({character,slot,opponentCharacter,category:'algorithm',entry:null});
      const p=env.game.state.players['league-learner'],skills=[],batch=[];
      camps=env.game.state.camps.filter(c=>!c.large).map(c=>({id:c.id,x:c.x,z:c.z}));
      captureSkills(p,skills);
      let step=0,result;
      for(;;){
        const context=D.context(model.tacticalPolicy,model.tacticalPolicy.contextSize?Policy.features(env.state,p.id,model.init,env.memory,model.featureVersion):null);
        const scores=env.choices.map(c=>D.score(model.tacticalPolicy,c.x,context));
        const selected=D.select(scores,D.temperature(model.tacticalPolicy),env.random());
        if(step%2===0&&env.choices.length>1){
          const state=env.state,me=state.players.find(e=>e.id===p.id);
          if(!me.dead&&!me.stun&&!me.air&&!me.warping&&!me.charging&&!me.grabbing&&!me.grabbed&&!me.flying){
            const label=queryTeacher(env,skills);
            if(label.mode==='retreat')p.retreating=true;
            else if(p.hp>=p.cfg.maxHp*.9)p.retreating=false;
            if(label.index>=0){
              const positive=env.choices[label.index];
              const negatives=scores.map((score,i)=>({score,i})).filter(v=>v.i!==label.index).sort((a,b)=>b.score-a.score).map(v=>v.i);
              const random=negatives.map(i=>({i,r:env.random()})).sort((a,b)=>a.r-b.r).map(v=>v.i);
              const subset=[label.index,...new Set([...negatives.slice(0,12),...random])].slice(0,24);
              batch.push(JSON.stringify({game:episodes.length,character,slot,opponentCharacter,time:state.time,mode:label.mode,event:positive.action.event,weight:2,
                x:subset.map(i=>env.choices[i].x)}));
              rows++;modes[label.mode]=(modes[label.mode]||0)+1;events[positive.action.event]=(events[positive.action.event]||0)+1;
            }
          }
        }
        const before=env.state;result=env.step(selected,false);step++;
        for(const e of env.combat)if(e.kind==='kill'&&e.targetKind==='monster'&&!e.large&&(e.source===p.id||e.owner===p.id)){
          const camp=env.game.state.camps.find(c=>c.id===e.target),own=before.control.find(c=>c.slot===p.slot);
          if(camp&&own&&(p.slot?camp.z-camp.x:camp.x-camp.z)<own.boundary)p.cpuFarmed.add(camp.id);
        }
        if(result.episode)break;
      }
      fs.writeSync(fd,zlib.gzipSync(batch.join('\n')+'\n'));episodes.push(result.episode);
      process.stdout.write(JSON.stringify({games:episodes.length,rows,character,slot,opponentCharacter,winner:result.episode.winner})+'\n');
    }
  }finally{fs.closeSync(fd);}
  const meta={format:'minion-teacher-candidates/1',source:options.model,sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(options.model)).digest('hex'),
    cfg:World.CFG,map:World.MAP,characters:World.CHARACTERS,camps,featureVersion:model.tacticalPolicy.featureVersion,rows,modes,events,episodes,options,
    method:'Student visits states. A snapshot fork queries the algorithm for one tick, then restores the exact game/controller state. Only ordinary inputs label candidates. No runtime teacher in the student.'};
  fs.writeFileSync(options.output+'.meta.json',JSON.stringify(meta,null,2));return meta;
}
if(require.main===module){
  const options={model:path.resolve(arg('model','datas/models/minion-v1-v15-teacher-student/model.json')),output:path.resolve(arg('output','datas/teacher-dagger.jsonl.gz')),
    seconds:Number(arg('seconds','300')),seed:Number(arg('seed','20261202'))};
  if(arg('characters',null))options.characters=arg('characters',null).split(',');
  const report=collect(options);process.stdout.write(JSON.stringify({complete:true,rows:report.rows,output:options.output})+'\n');
}
module.exports={queryTeacher,collect};

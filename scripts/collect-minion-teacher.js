'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const World=require('../game-world'),Policy=require('../public/minion-policy'),D=require('../public/minion-decisions');
const {readJSON}=require('./minion-input');
const arg=(key,fallback)=>{const i=process.argv.indexOf('--'+key);return i<0?fallback:process.argv[i+1];};
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);

function captureSkills(p,skills){
  for(const [event,fn] of Object.entries(p.commands))p.commands[event]=data=>{
    const before={q:p.qCd,c:p.cCd,e:p.eCd,aiming:p.aiming},target=p.target,result=fn(data);
    const used=event==='q'?p.qCd>before.q:event==='c'?p.cCd>before.c:
      ['dash','leap'].includes(event)?p.eCd>before.e||p.aiming!==before.aiming:false;
    if(used)skills.push({event,data:data&&{x:data.x,z:data.z},target});
    return result;
  };
}

function teacherChoice(choices,state,actor,after,skills){
  const me=state.players.find(p=>p.id===actor),home=World.MAP.spawns[me.slot];
  const wanted=after.retreating?null:skills.find(s=>s.target)?.target||after.target;
  const find=(event,id)=>choices.findIndex(c=>c.action.event===event&&
    (id?c.action.data?.id===id||c.action.inputs?.some(a=>a.event==='chase'&&a.data?.id===id):true));
  const used=skills.filter(s=>['q','c','dash','leap'].includes(s.event)).map(s=>s.event);
  if(used.length>1){
    const matches=choices.map((c,i)=>({c,i})).filter(({c})=>{
      const inputs=c.action.inputs;if(!inputs)return false;
      if(after.retreating&&c.x[46]!==1)return false;
      const events=inputs.filter(s=>['q','c','dash','leap'].includes(s.event)).map(s=>s.event);
      return JSON.stringify(events)===JSON.stringify(used)&&(!wanted||inputs.some(s=>s.event==='chase'&&s.data?.id===wanted));
    });
    const last=skills[skills.length-1];
    if(Number.isFinite(last.data?.x))matches.sort((a,b)=>distance(a.c.action.data||after,last.data)-distance(b.c.action.data||after,last.data));
    if(matches.length)return {index:matches[0].i,mode:after.retreating?'retreat':'skill'};
  }
  for(const event of ['leap','dash','q','c']){
    const skill=skills.find(s=>s.event===event);if(!skill)continue;
    let options=choices.map((c,i)=>({c,i})).filter(({c})=>c.action.event===event);
    if(after.retreating)options=options.filter(({c})=>c.x[46]===1);
    else if(wanted&&['q','c'].includes(event))options=options.filter(({c})=>c.action.inputs?.some(a=>a.event==='chase'&&a.data?.id===wanted));
    if(!options.length)continue;
    if(Number.isFinite(skill.data?.x)&&['leap','dash'].includes(event)){
      options=options.filter(({c})=>Number.isFinite(c.action.data?.x));
      options.sort((a,b)=>distance(a.c.action.data,skill.data)-distance(b.c.action.data,skill.data));
      if(!options.length||distance(options[0].c.action.data,skill.data)>4)continue;
    }
    return {index:options[0].i,mode:after.retreating?'retreat':wanted?'skill':'support'};
  }
  if(after.retreating){const i=choices.findIndex(c=>c.action.event==='move'&&c.x[46]===1);if(i>=0)return {index:i,mode:'retreat'};}
  if(wanted){const i=find('chase',wanted);if(i>=0)return {index:i,mode:choices[i].x[44]?'farm':choices[i].x[45]?'siege':'fight'};}
  if(after.dest){
    const moves=choices.map((c,i)=>({c,i})).filter(({c})=>c.action.event==='move');
    moves.sort((a,b)=>distance(a.c.action.data,after.dest)-distance(b.c.action.data,after.dest));
    if(moves.length&&distance(moves[0].c.action.data,after.dest)<2)return {index:moves[0].i,mode:'travel'};
    const goal=after.dest,dx=goal.x-me.x,dz=goal.z-me.z;
    if(Math.hypot(dx,dz)>1){
      const steering=choices.map((c,i)=>({c,i})).filter(({c})=>c.action.event==='steer');
      steering.sort((a,b)=>(b.c.action.data.x*dx+b.c.action.data.z*dz)-(a.c.action.data.x*dx+a.c.action.data.z*dz));
      if(steering.length)return {index:steering[0].i,mode:'steer'};
    }
  }
  return {index:find('noop'),mode:distance(me,home)<6?'home':'wait'};
}

function collect(options){
  const base=Policy.validate(readJSON(options.model)),characters=options.characters||base.characters;
  if(characters.some(c=>!base.characters.includes(c)))throw Error('Unknown teacher character');
  if(fs.existsSync(options.output))throw Error('Use a new teacher dataset path');
  fs.mkdirSync(path.dirname(options.output),{recursive:true});
  const fd=fs.openSync(options.output,'wx');let rows=0,rng=options.seed>>>0;const episodes=[],modes={},events={};
  const random=()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng/4294967296;};
  let camps;
  try{
    for(const character of characters)for(const slot of [0,1])for(const opponentCharacter of World.CHARACTERS.map(c=>c.id)){
      const game=World.createMatch(false,false,{teamSizes:[1,1]});const cues=[];
      for(let side=0;side<2;side++)game.connect({id:side===slot?'teacher':'opponent',on(){},emit(event,data){if(side===slot&&event!=='state')cues.push({event,data});},disconnect(){}},
        {team:side,member:0,bot:true,character:side===slot?character:opponentCharacter});
      camps=game.state.camps.filter(c=>!c.large).map(c=>({id:c.id,x:c.x,z:c.z}));
      const model={...base,init:{cfg:World.CFG,map:World.MAP,characters:World.CHARACTERS},tacticalPolicy:{...base.tacticalPolicy,inputSize:options.featureSize||128,featureVersion:options.featureSize===96?undefined:options.featureVersion||'minion-student-state/24',actionProtocol:'composed-inputs/14',camps}};
      const p=game.state.players.teacher,skills=[],memory={},batch=[];
      captureSkills(p,skills);
      let lastSample=-1,gameRows=0;
      while(game.observe(p.id).phase==='playing'&&game.observe(p.id).time<options.seconds){
        const state=game.observe(p.id),me=state.players.find(e=>e.id===p.id);
        const sample=p.thinkTime<=1/World.TICK+1e-8&&state.time-lastSample>=options.sampleSeconds-1e-8&&!me.dead&&!me.stun&&!me.air&&!me.charging&&!me.warping&&!me.grabbing&&!me.grabbed&&!me.flying;
        let choices;
        if(sample){Policy.updateMemory(memory,state,p.id,cues.splice(0),model.featureVersion,model.init);choices=D.candidates(model,state,p.id,{event:'noop'},memory);lastSample=state.time;}
        skills.length=0;game.tick();
        if(!sample||choices.length<2)continue;
        const label=teacherChoice(choices,state,p.id,p,skills);if(label.index<0)continue;
        const negatives=choices.map((c,i)=>i).filter(i=>i!==label.index);
        // Include same-event and same-target alternatives before random negatives.
        const positive=choices[label.index],same=negatives.filter(i=>choices[i].action.event===positive.action.event||choices[i].action.data?.id&&choices[i].action.data.id===positive.action.data?.id);
        const shuffled=negatives.map(i=>({i,r:random()})).sort((a,b)=>a.r-b.r).map(v=>v.i);
        const selected=[label.index,...new Set([...same,...shuffled])].slice(0,options.candidates);
        const row={game:episodes.length,character,slot,opponentCharacter,time:state.time,mode:label.mode,event:positive.action.event,x:selected.map(i=>choices[i].x)};
        batch.push(JSON.stringify(row));rows++;gameRows++;modes[label.mode]=(modes[label.mode]||0)+1;events[row.event]=(events[row.event]||0)+1;
      }
      fs.writeSync(fd,zlib.gzipSync(batch.join('\n')+'\n'));
      const state=game.observe(p.id);episodes.push({character,slot,opponentCharacter,seconds:state.time,winner:state.winner===null?null:Number(state.winner===slot),rows:gameRows});
      process.stdout.write(JSON.stringify({games:episodes.length,rows,character,slot,opponentCharacter})+'\n');
    }
  }finally{fs.closeSync(fd);}
  const metadata={format:'minion-teacher-candidates/1',source:options.model,sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(options.model)).digest('hex'),
    cfg:World.CFG,map:World.MAP,characters:World.CHARACTERS,camps,featureVersion:options.featureSize===96?undefined:options.featureVersion||'minion-student-state/24',rows,modes,events,episodes,options,
    method:'Offline imitation of existing algorithm CPU. Inputs are reconstructed into ordinary candidate actions; no algorithm fallback runs in the exported student.'};
  fs.writeFileSync(options.output+'.meta.json',JSON.stringify(metadata,null,2));return metadata;
}
if(require.main===module){
  const options={model:path.resolve(arg('model','datas/models/minion-v1-v15-balanced-ppo/model.json')),output:path.resolve(arg('output','datas/teacher-candidates.jsonl.gz')),
    seconds:Number(arg('seconds','300')),sampleSeconds:Number(arg('sample-seconds','.4')),candidates:Number(arg('candidates','24')),featureSize:Number(arg('feature-size','128')),seed:Number(arg('seed','20261130'))};
  if(arg('characters',null))options.characters=arg('characters',null).split(',');
    if(!(options.seconds>0&&options.seconds<=600&&options.sampleSeconds>=.2&&options.candidates>=8&&options.candidates<=128&&[96,128].includes(options.featureSize)))throw Error('Invalid teacher collection options');
  const report=collect(options);process.stdout.write(JSON.stringify({complete:true,rows:report.rows,output:options.output})+'\n');
}
module.exports={teacherChoice,captureSkills,collect};

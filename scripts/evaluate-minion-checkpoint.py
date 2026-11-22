"""Evaluate an immutable checkpoint against a PPO run's frozen evaluation opponents."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    p=argparse.ArgumentParser();p.add_argument('--run',type=Path,required=True);p.add_argument('--model',type=Path,required=True)
    p.add_argument('--node',required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--seed',type=int);p.add_argument('--games',type=int);p.add_argument('--seconds',type=float)
    p.add_argument('--temperature',type=float)
    args=p.parse_args();root=Path(__file__).resolve().parent.parent
    if args.output.exists():raise ValueError('Choose a new evaluation output file')
    run=json.loads((args.run/'league-training.json').read_text(encoding='utf8'))
    source=args.model.read_bytes();model=json.loads(source.decode('utf-8-sig'))
    if args.model.name=='latest-model.json' and run['status']=='training':raise ValueError('Use an immutable checkpoint while training is running')
    games=args.games or len(model['characters'])*2;seconds=args.seconds or run['config']['eval_seconds'];seed=args.seed if args.seed is not None else run['seed']+1000000
    if not 1<=games<=128 or games%(2*len(model['characters'])) or not 1<=seconds<=86400:raise ValueError('Evaluation must cover each character on both sides')
    if args.temperature is not None and not 0<=args.temperature<=5:raise ValueError('Invalid inference temperature')
    world=root/'game-world.js';world_hash=hashlib.sha256(world.read_bytes()).hexdigest()
    if run['codeSha256'].get(str(world.resolve()))!=world_hash:raise ValueError('Game rules changed since training started; evaluate the new rules explicitly before comparing results')
    def chunk(offset,count):
        request={'op':'evaluate','model':str(args.model.resolve()),'pool':run['evaluationPool'],'episodes':count,'offset':offset,
                 'options':{'seed':seed,'maxSeconds':seconds,'intervalTicks':model.get('decisionIntervalTicks',6)}}
        if args.temperature is not None:request['temperature']=args.temperature
        r=subprocess.run([args.node,str(root/'scripts/minion-league-env.js')],input=json.dumps(request)+'\n{"op":"close"}\n',capture_output=True,text=True,encoding='utf8',timeout=3600)
        if r.returncode:raise RuntimeError(r.stderr)
        value=json.loads(r.stdout.splitlines()[0])
        if 'error' in value:raise RuntimeError(value['error'])
        return offset,value['episodes']
    chunks={};size=max(1,(games+3)//4)
    with ThreadPoolExecutor(max_workers=4) as executor:
        for future in as_completed([executor.submit(chunk,i,min(size,games-i)) for i in range(0,games,size)]):
            i,rows=future.result();chunks[i]=rows;print(json.dumps({'completed':sum(len(v) for v in chunks.values()),'games':games}),flush=True)
    rows=[r for i in sorted(chunks) for r in chunks[i]]
    if len(rows)!=games or hashlib.sha256(world.read_bytes()).hexdigest()!=world_hash or hashlib.sha256(args.model.read_bytes()).hexdigest()!=hashlib.sha256(source).hexdigest():raise RuntimeError('Evaluation inputs changed or evaluation was incomplete')
    total=sum(r['seconds'] for r in rows)
    summary={'games':games,'wins':sum(r['winner']==1 for r in rows),'losses':sum(r['winner']==0 for r in rows),'draws':sum(r['winner'] is None for r in rows),
             'perMinute':{k:sum(r[k] for r in rows)/total*60 for k in ['ownSmallKills','smallKills','towerDamage','towers','deaths','idleSeconds']},
             'characters':{c:{'wins':sum(r['winner']==1 for r in rows if r['character']==c),'losses':sum(r['winner']==0 for r in rows if r['character']==c),'draws':sum(r['winner'] is None for r in rows if r['character']==c)} for c in model['characters']}}
    report={'model':str(args.model.resolve()),'modelSha256':hashlib.sha256(source).hexdigest(),'worldSha256':world_hash,'seed':seed,'maxSeconds':seconds,'temperatureOverride':args.temperature,
            'pool':run['evaluationPool'],'definition':'Normal spawn starts; wins require actual tower destruction, time limits count as draws. Limited character/opponent coverage.',
            'summary':summary,'episodes':rows}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with args.output.open('x',encoding='utf8') as f:json.dump(report,f,indent=2)
    print(json.dumps(summary),flush=True)


if __name__=='__main__':main()

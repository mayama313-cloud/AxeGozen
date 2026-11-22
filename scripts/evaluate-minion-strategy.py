"""Paired farm/push encounter diagnostics; normal full matches remain a separate evaluation."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    p=argparse.ArgumentParser();p.add_argument('--node',required=True);p.add_argument('--model',type=Path,action='append',required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--games',type=int,default=8);p.add_argument('--seconds',type=float,default=60);p.add_argument('--seed',type=int,default=90261216)
    p.add_argument('--scenarios',nargs='+',choices=['match','farm-start','push-9','retreat-duel','finish-duel'],default=['farm-start','push-9'])
    p.add_argument('--temperature',type=float)
    args=p.parse_args()
    if not 8<=args.games<=128 or not 1<=args.seconds<=900:raise ValueError('Invalid strategy diagnostic')
    for file in args.model:
        characters=json.loads(file.read_text(encoding='utf-8-sig'))['characters']
        if args.games%(2*len(characters)):raise ValueError('games must cover every model character on both sides equally')
    root=Path(__file__).resolve().parent.parent
    pool={'latest':str(root/'datas/models/minion-v1-v12-activity/model.json'),'history':[str(root/'datas/models/minion-v1-v11-combat/model.json'),str(root/'datas/models/minion-v1-v8-offense/model.json')],'weights':{'latest':4,'history':3,'algorithm':3}}
    def evaluate(file,scenario):
        interval=json.loads(file.read_text(encoding='utf-8-sig')).get('decisionIntervalTicks',6)
        request={'op':'evaluate','model':str(file.resolve()),'pool':pool,'episodes':args.games,'scenarios':[scenario],
                 'options':{'seed':args.seed,'maxSeconds':args.seconds,'intervalTicks':interval}}
        if args.temperature is not None:request['temperature']=args.temperature
        r=subprocess.run([args.node,str(root/'scripts/minion-league-env.js')],input=json.dumps(request)+'\n'+json.dumps({'op':'close'})+'\n',capture_output=True,text=True,encoding='utf8',timeout=3600)
        if r.returncode:raise RuntimeError(r.stderr)
        value=json.loads(r.stdout.splitlines()[0])
        if 'error' in value:raise RuntimeError(value['error'])
        rows=value['episodes'];n=len(rows)
        summary={'model':str(file.resolve()),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'intervalTicks':interval,'temperatureOverride':args.temperature,'scenario':scenario,'games':n,
                 'wins':sum(e['winner']==1 for e in rows),'losses':sum(e['winner']==0 for e in rows),'draws':sum(e['winner'] is None for e in rows),
                 'farmSuccesses':sum(e['ownSmallKills']>0 for e in rows),'towerAttackSuccesses':sum(e['towerDamage']>0 for e in rows),
                 'recoveries':sum(e.get('recovered',False) for e in rows),'finishSuccesses':sum(e['kills']>0 for e in rows),
                 'mean':{k:sum(e[k] for e in rows)/n for k in ['kills','ownSmallKills','smallDamage','towerDamage','towers','energy','enemyZoneSeconds','deaths','idleSeconds']}}
        print(json.dumps(summary),flush=True);return {**summary,'episodes':rows}
    rows=[]
    with ThreadPoolExecutor(max_workers=4) as executor:
        for future in as_completed([executor.submit(evaluate,file,scenario) for file in args.model for scenario in args.scenarios]):rows.append(future.result())
    args.output.write_text(json.dumps({'seed':args.seed,'seconds':args.seconds,'pool':pool,
        'limitation':'match starts at spawn; wins require actual tower destruction and time limits count as draws. Other scenarios are targeted diagnostics, not normal-match win rates.',
        'results':rows},ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'output':str(args.output.resolve())}),flush=True)


if __name__=='__main__':main()

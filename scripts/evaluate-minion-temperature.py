"""Compare inference temperatures with identical fixtures; activity diagnostic, not a win-rate certification."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--node',required=True);p.add_argument('--model',type=Path,default=Path('datas/models/minion-v1-v12-activity/model.json'))
    p.add_argument('--temperatures',default='0,0.1,0.25,0.5,1');p.add_argument('--games',type=int,default=8)
    p.add_argument('--seconds',type=float,default=90);p.add_argument('--seed',type=int,default=90261212)
    p.add_argument('--output',type=Path);args=p.parse_args()
    temperatures=[float(t) for t in args.temperatures.split(',')]
    if not temperatures or any(not 0<=t<=5 for t in temperatures) or not 8<=args.games<=128 or args.games%8 or not 1<=args.seconds<=3600:raise ValueError('Invalid diagnostic settings')
    root=Path(__file__).resolve().parent.parent
    pool={'latest':str(root/'datas/models/minion-v1-v11-combat/model.json'),'history':[str(root/'datas/models/minion-v1-v10-bush-adapter/model.json'),str(root/'datas/models/minion-v1-v8-offense/model.json')],'weights':{'latest':4,'history':3,'algorithm':3}}
    def evaluate(t):
        request={'op':'evaluate','model':str(args.model.resolve()),'pool':pool,'episodes':args.games,'temperature':t,
                 'options':{'seed':args.seed,'maxSeconds':args.seconds,'intervalTicks':6}}
        result=subprocess.run([args.node,str(root/'scripts/minion-league-env.js')],input=json.dumps(request)+'\n'+json.dumps({'op':'close'})+'\n',capture_output=True,text=True,encoding='utf8',timeout=3600)
        if result.returncode:raise RuntimeError(result.stderr)
        value=json.loads(result.stdout.splitlines()[0])
        if 'error' in value:raise RuntimeError(value['error'])
        rows=value['episodes'];seconds=sum(e['seconds'] for e in rows)
        summary={'temperature':t,'games':len(rows),'finished':sum(not e['truncated'] for e in rows),
                 'perMinute':{k:sum(e.get(k,0) for e in rows)/seconds*60 for k in ['idleSeconds','fieldIdleSeconds','spawnLoiterSeconds','energy','smallKills','emptySkills','deaths','towerDamage']}}
        print(json.dumps(summary),flush=True);return {**summary,'episodes':rows}
    results=[]
    with ThreadPoolExecutor(max_workers=4) as executor:
        for future in as_completed([executor.submit(evaluate,t) for t in temperatures]):results.append(future.result())
    report={'model':str(args.model.resolve()),'sha256':hashlib.sha256(args.model.read_bytes()).hexdigest(),'seed':args.seed,'seconds':args.seconds,'gamesPerTemperature':args.games,'pool':pool,
            'limitation':'Short fixed-seed activity diagnostic, covering four characters and both sides. Not full-match win rate or proof of improved strength.',
            'results':sorted(results,key=lambda r:r['temperature'])}
    output=args.output or args.model.parent/'temperature-comparison.json';output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({'output':str(output.resolve())}),flush=True)


if __name__=='__main__':main()

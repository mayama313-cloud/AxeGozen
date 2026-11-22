"""Full-match PPO with frozen latest/history/algorithm opponents and character/side rotation."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import shutil
import time
import numpy as np
import torch
from torch import nn
from torch.distributions import Categorical

spec = importlib.util.spec_from_file_location('ppo', Path(__file__).with_name('reinforce-minion.py'))
ppo = importlib.util.module_from_spec(spec); spec.loader.exec_module(ppo)
WIDTH, MAX = 96, 128


class LeagueActor(nn.Module):
    def __init__(self, model):
        super().__init__()
        p = model.get('tacticalPolicy');hidden=p['hiddenSize'] if p else 32
        w=p['weights'] if p else None
        self.bootstrap=p is None
        p=p or {'inferenceTemperature':1,'actionProtocol':'composed-inputs/14'}
        self.inference_temperature = p.get('inferenceTemperature')
        self.action_protocol=p.get('actionProtocol')
        self.hidden = nn.Linear(WIDTH, hidden)
        self.context = nn.Linear(model['inputSize'], hidden, bias=False)
        self.output = nn.Linear(hidden, 1)
        self.critic = nn.Sequential(nn.Linear(model['inputSize'], 64), nn.Tanh(), nn.Linear(64, 1))
        nn.init.zeros_(self.context.weight); nn.init.zeros_(self.critic[-1].weight); nn.init.zeros_(self.critic[-1].bias)
        with torch.no_grad():
            if w:
                source = torch.tensor(w['hiddenW']); self.hidden.weight.zero_(); self.hidden.weight[:, :source.shape[1]].copy_(source)
                self.hidden.bias.copy_(torch.tensor(w['hiddenB'])); self.output.weight.copy_(torch.tensor([w['outputW']]))
                self.output.bias.copy_(torch.tensor([w['outputB']]))
                if 'contextW' in w:self.context.weight.copy_(torch.tensor(w['contextW']))
            else:
                # Trainable prior for the BC proposal; no target/HP strategy override.
                self.hidden.weight[0].zero_();self.hidden.weight[0,63]=4;self.hidden.bias[0]=-2
                self.output.weight.zero_();self.output.weight[0,0]=3;self.output.bias.zero_()

    def forward(self, x, choices, mask):
        scores = self.output(torch.tanh(self.hidden(choices) + self.context(x)[:, None, :])).squeeze(-1)
        return Categorical(logits=scores.masked_fill(~mask, -1e9)), self.critic(x).flatten()

    def export(self):
        result = {'version': 'minion-player-decisions/11', 'inputSize': WIDTH, 'contextSize': self.context.in_features,
                'hiddenSize': self.hidden.out_features, 'weights': {'hiddenW': self.hidden.weight.detach().tolist(),
                'hiddenB': self.hidden.bias.detach().tolist(), 'contextW': self.context.weight.detach().tolist(),
                'outputW': self.output.weight.detach().flatten().tolist(), 'outputB': float(self.output.bias.detach()[0])}}
        if self.inference_temperature is not None: result['inferenceTemperature'] = self.inference_temperature
        if self.action_protocol is not None:result['actionProtocol']=self.action_protocol
        return result


def tensors(observations):
    x = torch.tensor(np.asarray([o['x'] for o in observations], dtype=np.float32))
    choices = np.zeros((len(observations), MAX, WIDTH), dtype=np.float32)
    mask = np.zeros((len(observations), MAX), dtype=np.bool_)
    for i, o in enumerate(observations):
        n = len(o['decisionX'])
        if not 1 <= n <= MAX or any(len(c) != WIDTH for c in o['decisionX']): raise ValueError('Invalid league candidates')
        choices[i, :n] = o['decisionX']; mask[i, :n] = True
    return x, torch.from_numpy(choices), torch.from_numpy(mask)


class Engine(ppo.Engine):
    def __init__(self, node):
        self.process = subprocess.Popen([node, str(Path(__file__).with_name('minion-league-env.js'))], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, text=True, encoding='utf8')


def summarize(episodes):
    groups = {}
    for key in ['latest', 'history', 'algorithm']:
        rows = [e for e in episodes if e['opponent'] == key]
        wins = sum(e['winner'] == 1 for e in rows); losses = sum(e['winner'] == 0 for e in rows)
        groups[key] = {'games': len(rows), 'wins': wins, 'losses': losses, 'draws': len(rows)-wins-losses,
                       'winRateAllGames': wins/len(rows) if rows else None, 'winRateDecided': wins/(wins+losses) if wins+losses else None}
    n = max(1, len(episodes))
    return {'games': len(episodes), 'wins': sum(e['winner'] == 1 for e in episodes), 'losses': sum(e['winner'] == 0 for e in episodes),
            'draws': sum(e['winner'] is None for e in episodes), 'opponents': groups,
            'mean': {key: sum(e.get(key,0) for e in episodes)/n for key in ['seconds','towerDamage','towers','energy','usefulEnergy','smallKills','ownSmallKills','enemySmallKills','smallDamage','enemyZoneSeconds','largeKills','deaths',
                'unnecessaryRecalls','repeatRecalls','interruptedRecalls','emptySkills','spawnLoiterSeconds','idleSeconds','attackedFarmSeconds','ignoredBossSeconds']},
            'rewardComponents': {key: sum(e.get('rewardComponents',{}).get(key,0) for e in episodes)/n for key in ['smallMonster','smallMonsterDamage','energy','emptySkill','invalidSkill','spawnLoiter','idle']}}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--model', required=True, type=Path); p.add_argument('--output', required=True, type=Path)
    p.add_argument('--history', action='append', required=True, type=Path); p.add_argument('--node', required=True)
    p.add_argument('--updates', type=int, default=128); p.add_argument('--steps', type=int, default=128)
    p.add_argument('--envs', type=int, default=8); p.add_argument('--max-seconds', type=float, default=600)
    p.add_argument('--interval-ticks', type=int, default=6); p.add_argument('--snapshot-every', type=int, default=8)
    p.add_argument('--history-size', type=int, default=6); p.add_argument('--seed', type=int, default=20261204)
    p.add_argument('--eval-games', type=int, default=8); p.add_argument('--eval-seconds', type=float, default=900)
    p.add_argument('--latest-weight', type=int, default=4); p.add_argument('--history-weight', type=int, default=3)
    p.add_argument('--algorithm-weight', type=int, default=3); p.add_argument('--learning-rate', type=float, default=.0003)
    p.add_argument('--farm-start-fraction',type=float,default=.25);p.add_argument('--push-start-fraction',type=float,default=.25)
    p.add_argument('--retreat-start-fraction',type=float,default=0.);p.add_argument('--finish-start-fraction',type=float,default=0.)
    args = p.parse_args()
    if args.model.parent.resolve() == args.output.resolve(): raise ValueError('Use a separate output directory')
    if not (1 <= args.updates <= 100000 and 8 <= args.steps <= 512 and 1 <= args.envs <= 16 and 1 <= args.max_seconds <= 86400
            and 3 <= args.interval_ticks <= 9 and 1 <= args.snapshot_every and 1 <= args.history_size <= 32 and 4 <= args.eval_games <= 128
            and 1 <= args.eval_seconds <= 86400 and 0 <= args.seed <= 4294967295 and args.learning_rate > 0): raise ValueError('Invalid league settings')
    if any(not 1 <= w <= 20 for w in [args.latest_weight,args.history_weight,args.algorithm_weight]): raise ValueError('Invalid opponent weights')
    fractions=[args.farm_start_fraction,args.push_start_fraction,args.retreat_start_fraction,args.finish_start_fraction]
    if not all(0<=v<=1 for v in fractions) or sum(fractions)>1:raise ValueError('Invalid strategic start fractions')
    torch.manual_seed(args.seed); np.random.seed(args.seed); torch.set_num_threads(4)
    if any((args.output/name).exists() for name in ['initial-model.json','model.json','latest-model.json','league-training.json']):
        raise ValueError('Output already contains a run; choose a new directory and resume with --model previous/latest-model.json')
    args.output.mkdir(parents=True, exist_ok=True)
    source = args.model.read_bytes(); base = json.loads(source.decode('utf-8-sig'))
    if args.envs%len(base['characters']):raise ValueError('envs must be a multiple of the number of characters for equal training experience')
    (args.output/'initial-model.json').write_bytes(source)
    actor = LeagueActor(base); optimizer = torch.optim.Adam(actor.parameters(), lr=args.learning_rate)
    if actor.bootstrap:base.setdefault('controlProtocol','release-before-chase/1')
    resume = args.model.parent/'league-state.pt'
    if base.get('leagueTraining') and resume.exists():
        state = torch.load(resume, map_location='cpu', weights_only=True)
        if state['modelSha256'] != hashlib.sha256(source).hexdigest(): raise ValueError('Resume state does not match model; use latest-model.json')
        actor.load_state_dict(state['actor']); optimizer.load_state_dict(state['optimizer'])
        for group in optimizer.param_groups: group['lr'] = args.learning_rate
    for key in ['objectivePolicy','selection','perceptionAdapter','defenseAdapter']: base.pop(key,None)
    base['decisionMode'] = 'learned/1'; base['decisionIntervalTicks'] = args.interval_ticks
    base['modelName'] = 'ミニオン v1（v15 5キャラPPO）' if len(base['characters'])==5 else 'ミニオン v1（リーグPPO）'
    report = {'algorithm':'PPO','protocol':'full-match-league/12','status':'training','source':str(args.model.resolve()),'sourceSha256':hashlib.sha256(source).hexdigest(),
              'seed':args.seed,'config':vars(args).copy(),'history':[],'episodes':[],'snapshots':[],
              'bootstrapFromImitation':actor.bootstrap,'trainingCharacters':base['characters'],
              'initialization':'Trainable BC-proposal prior; full-observation context and candidate head learn from PPO rewards' if actor.bootstrap else 'Existing candidate-policy weights',
              'opponentRule':'Frozen latest 40%, recent/history 30%, algorithm 30% by default; active matches retain their original opponent',
              'limitation':'Training checkpoints are not automatically certified as stronger; time limits count as draws, not wins.'}
    report['config'] = {k: str(v) if isinstance(v,Path) else [str(x) for x in v] if isinstance(v,list) else v for k,v in report['config'].items()}
    code = [Path(__file__),Path(__file__).with_name('minion-league-env.js'),Path(__file__).parent.parent/'public/minion-decisions.js',Path(__file__).parent.parent/'public/minion-policy.js',Path(__file__).parent.parent/'game-world.js']
    report['codeSha256'] = {str(f.resolve()):hashlib.sha256(f.read_bytes()).hexdigest() for f in code}
    report['scheduler'] = 'Independent per-opponent character and side rotation; evaluation covers every learner character on both sides'
    weights = dict(latest=args.latest_weight,history=args.history_weight,algorithm=args.algorithm_weight)
    historical = [str(f.resolve()) for f in args.history]; snapshots = []
    prior_report = args.model.parent/'league-training.json'
    if base.get('leagueTraining') and prior_report.exists():
        previous = json.loads(prior_report.read_text(encoding='utf8'))
        snapshots = [s['file'] for s in previous.get('snapshots',[])[-args.history_size:] if Path(s['file']).is_file()]
        report['resume'] = {'optimizerRestored':resume.exists(),'environmentRestarted':True,'parentUpdates':base['leagueTraining']['updates'],
                            'parentTransitions':base['leagueTraining']['transitions'],'inheritedSnapshots':snapshots.copy()}
    for file in historical:
        json.loads(Path(file).read_text(encoding='utf-8-sig'))
    def save(name, update):
        model = copy.deepcopy(base); model['tacticalPolicy'] = actor.export()
        model['leagueTraining'] = {'protocol':'full-match-league/12','updates':update,'transitions':update*args.steps*args.envs,
                                  'sourceSha256':report['sourceSha256'],'seed':args.seed,'report':'league-training.json','opponentWeights':weights,
                                  'rewardProfile':report.get('rewardProfile')}
        dest = args.output/name; temp = args.output/(name+'.tmp')
        temp.write_text(json.dumps(model,ensure_ascii=False),encoding='utf8');temp.replace(dest);return dest
    def pool(latest):
        return {'latest':str(latest.resolve()),'history':historical + snapshots[-args.history_size:],'weights':weights}
    def write_report():
        temp = args.output/'league-training.tmp'; temp.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8');temp.replace(args.output/'league-training.json')
    engine = Engine(args.node); started = time.monotonic(); gamma, lam = .9997, .97
    try:
        rules=engine.call({'op':'rules'})
        base['init'].update({k:rules[k] for k in ['cfg','map','characters']})
        report['engineRules']=rules
        warm = save('warm-start-model.json',0); current_pool = pool(warm)
        initialized = engine.call({'op':'init','model':str(warm.resolve()),'pool':current_pool,'envs':args.envs,
                                   'balancedCharacters':True,'options':{'seed':args.seed,'maxSeconds':args.max_seconds,'intervalTicks':args.interval_ticks,'gamma':gamma,
                                              'farmStartFraction':args.farm_start_fraction,'pushStartFraction':args.push_start_fraction,
                                              'retreatStartFraction':args.retreat_start_fraction,'finishStartFraction':args.finish_start_fraction}})
        obs = initialized['observations']; report['rewards'] = initialized['rewards']; report['rewardProfile'] = initialized['rewardProfile']; report['gamma'] = gamma; report['gaeLambda'] = lam
        frozen_evaluation_pool = copy.deepcopy(current_pool)
        frozen_evaluation_pool['latest'] = str(args.model.resolve())
        report['evaluationPool'] = frozen_evaluation_pool
        write_report(); print(json.dumps({'started':True,'pool':current_pool,'characters':base['characters'],'maxSeconds':args.max_seconds}),flush=True)
        for update in range(1,args.updates+1):
            rows = {k:[] for k in ['x','choices','mask','action','logp','value','reward','next','terminal','done']}
            for _ in range(args.steps):
                x,c,m = tensors(obs)
                with torch.no_grad(): distribution,value=actor(x,c,m); action=distribution.sample(); logp=distribution.log_prob(action)
                results=engine.call({'op':'step','actions':action.tolist()})['results']
                bx,bc,bm=tensors([r['bootstrap'] for r in results])
                with torch.no_grad(): _,nv=actor(bx,bc,bm)
                values={'x':x,'choices':c,'mask':m,'action':action,'logp':logp,'value':value,'reward':torch.tensor([r['reward'] for r in results]),
                        'next':nv,'terminal':torch.tensor([float(r['terminal']) for r in results]),'done':torch.tensor([float(r['terminal'] or r['truncated']) for r in results])}
                for k,v in values.items(): rows[k].append(v)
                for r in results:
                    if 'episode' in r: report['episodes'].append(r['episode']); print(json.dumps({'episode':r['episode']}),flush=True)
                obs=[r['observation'] for r in results]
            stack={k:torch.stack(v) for k,v in rows.items()}
            adv,returns=ppo.advantages(stack['reward'],stack['value'],stack['next'],stack['terminal'],stack['done'],gamma,lam)
            adv=adv.flatten();adv=(adv-adv.mean())/(adv.std(unbiased=False)+1e-8);returns=returns.flatten()
            batch={k:v.flatten(0,1) for k,v in stack.items()};losses=[]
            for _ in range(4):
                for idx in torch.randperm(len(adv)).split(128):
                    distribution,value=actor(batch['x'][idx],batch['choices'][idx],batch['mask'][idx]);ratio=(distribution.log_prob(batch['action'][idx])-batch['logp'][idx]).exp()
                    loss=-torch.minimum(ratio*adv[idx],ratio.clamp(.8,1.2)*adv[idx]).mean()+.5*nn.functional.smooth_l1_loss(value,returns[idx])-.01*distribution.entropy().mean()
                    if not torch.isfinite(loss): raise RuntimeError('Non-finite league loss')
                    optimizer.zero_grad();loss.backward();nn.utils.clip_grad_norm_(actor.parameters(),.5);optimizer.step();losses.append(float(loss.detach()))
            latest=save('latest-model.json',update)
            state_temp=args.output/'league-state.tmp'
            torch.save({'actor':actor.state_dict(),'optimizer':optimizer.state_dict(),'modelSha256':hashlib.sha256(latest.read_bytes()).hexdigest()},state_temp)
            state_temp.replace(args.output/'league-state.pt')
            if update%args.snapshot_every==0 or update==args.updates:
                snapshot=save(f'checkpoint-{update:05}.json',update)
                current_pool=pool(snapshot); snapshots.append(str(snapshot.resolve()))
                report['snapshots'].append({'update':update,'file':str(snapshot.resolve()),'pool':current_pool})
                obs=engine.call({'op':'refresh','model':str(latest.resolve()),'pool':current_pool})['observations']
            stats={'update':update,'transitions':update*args.steps*args.envs,'completedGames':len(report['episodes']),
                   'loss':sum(losses)/len(losses),'seconds':time.monotonic()-started}
            report['history'].append(stats);report['trainingSummary']=summarize(report['episodes']);write_report();print(json.dumps(stats),flush=True)
        # Identical opponents, seeds, and time caps for before/after. Training latest snapshots cannot leak into this pool.
        evaluation={'episodes':args.eval_games,'pool':frozen_evaluation_pool,'options':{'seed':args.seed+1000000,'maxSeconds':args.eval_seconds,'intervalTicks':args.interval_ticks}}
        report['status']='evaluating';write_report()
        for label,file in [('before',warm),('after',args.output/'latest-model.json')]:
            def evaluate_chunk(offset, count):
                worker=Engine(args.node)
                try:return offset,worker.call({'op':'evaluate','model':str(file.resolve()),**evaluation,'offset':offset,'episodes':count})['episodes']
                finally:worker.close()
            chunks={};chunk_size=max(1,(args.eval_games+3)//4)
            with ThreadPoolExecutor(max_workers=4) as executor:
                futures=[executor.submit(evaluate_chunk,offset,min(chunk_size,args.eval_games-offset)) for offset in range(0,args.eval_games,chunk_size)]
                for future in as_completed(futures):
                    offset,rows=future.result();chunks[offset]=rows
                    print(json.dumps({'evaluation':label,'completedGames':sum(len(r) for r in chunks.values()),'totalGames':args.eval_games}),flush=True)
            report[label]=[r for offset in sorted(chunks) for r in chunks[offset]]
            report[label+'Summary']=summarize(report[label]);write_report();print(json.dumps({label:report[label+'Summary']}),flush=True)
        # Export the trained candidate explicitly; preserve the earlier source and all evaluation evidence.
        (args.output/'model.json').write_bytes((args.output/'latest-model.json').read_bytes())
        x,c,m=tensors(obs[:1]);selected=actor.export()
        with torch.no_grad(): conditioning=actor.context(x)[0];score=float(actor.output(torch.tanh(actor.hidden(c[0,0])+conditioning)).detach()[0])
        (args.output/'league-parity.json').write_text(json.dumps({'x':x[0].tolist(),'candidate':c[0,0].tolist(),'score':score}),encoding='utf8')
        if (args.model.parent/'parity.json').exists(): shutil.copyfile(args.model.parent/'parity.json',args.output/'parity.json')
        report['elapsedSeconds']=time.monotonic()-started;report['status']='complete';write_report()
        print(json.dumps({'complete':True,'model':str((args.output/'model.json').resolve()),'games':len(report['episodes'])}),flush=True)
    finally:engine.close()


if __name__=='__main__':main()

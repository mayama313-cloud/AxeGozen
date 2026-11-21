"""PPO over actual player input candidates; no HP-based action override or teacher labels."""
import argparse
import copy
import hashlib
import importlib.util
import json
import shutil
from pathlib import Path
import time
import numpy as np
import torch
from torch import nn
from torch.distributions import Categorical

spec = importlib.util.spec_from_file_location('minion_ppo', Path(__file__).with_name('reinforce-minion.py'))
ppo = importlib.util.module_from_spec(spec); spec.loader.exec_module(ppo)
MAX, WIDTH = 128, 66

class DecisionActor(nn.Module):
    def __init__(self, base_prior=0.):
        super().__init__()
        self.hidden = nn.Linear(WIDTH, 32)
        self.output = nn.Linear(32, 1)
        self.value_hidden = nn.Linear(32, 32)
        self.value = nn.Linear(32, 1)
        nn.init.zeros_(self.output.weight); nn.init.zeros_(self.output.bias)
        nn.init.zeros_(self.value.weight); nn.init.zeros_(self.value.bias)
        if base_prior:
            with torch.no_grad():
                self.hidden.weight[0].zero_(); self.hidden.weight[0, 63] = 1.; self.hidden.bias[0] = 0.
                self.output.weight[0, 0] = base_prior / np.tanh(1.)

    def forward(self, x, mask):
        logits = self.output(torch.tanh(self.hidden(x))).squeeze(-1).masked_fill(~mask, -1e9)
        value = self.value(torch.tanh(self.value_hidden(x[:, 0, :32]))).flatten()
        return Categorical(logits=logits), value

    def export(self):
        return {'version': 'minion-player-decisions/11', 'inputSize': WIDTH, 'hiddenSize': 32, 'weights': {
            'hiddenW': self.hidden.weight.detach().tolist(), 'hiddenB': self.hidden.bias.detach().tolist(),
            'outputW': self.output.weight.detach().flatten().tolist(), 'outputB': float(self.output.bias.detach()[0])}}

def tensors(obs):
    x = np.zeros((len(obs), MAX, WIDTH), dtype=np.float32)
    mask = np.zeros((len(obs), MAX), dtype=np.bool_)
    for i, o in enumerate(obs):
        n = len(o['decisionX'])
        if not 1 <= n <= MAX:
            raise ValueError('Invalid input candidate count')
        width = len(o['decisionX'][0])
        if width not in [64, WIDTH]: raise ValueError('Invalid candidate feature width')
        x[i, :n, :width] = o['decisionX']; mask[i, :n] = True
    return torch.from_numpy(x), torch.from_numpy(mask)

def summary(evaluation):
    rows = evaluation['episodes']
    retreats = [r for r in rows if r['scenario'].startswith('duel-retreat')]
    finishes = [r for r in rows if r['scenario'].startswith('finish-')]
    matches = [r for r in rows if r['scenario'] == 'match']
    per_character = []
    for c in evaluation['characters']:
        r = [r for r in retreats if r['character'] == c]; f = [r for r in finishes if r['character'] == c]
        per_character.append({'character': c, 'retreats': len(r), 'recoveries': sum(x['recovery'] for x in r),
                              'finishes': len(f), 'kills': sum(x['kills'] > 0 for x in f)})
    return {'retreats': len(retreats), 'recoveries': sum(r['recovery'] for r in retreats),
            'retreatDeaths': sum(r['deaths'] for r in retreats), 'finishes': len(finishes),
            'finishKills': sum(r['kills'] > 0 for r in finishes), 'deaths': sum(r['deaths'] for r in rows),
            'normalEnergy': sum(r['energy'] for r in matches) / max(1, len(matches)), 'perCharacter': per_character}

def selection_score(s):
    retreat = s['recoveries'] / max(1, s['retreats']); finish = s['finishKills'] / max(1, s['finishes'])
    worst = min((min(c['recoveries'] / max(1, c['retreats']), c['kills'] / max(1, c['finishes'])) for c in s['perCharacter']), default=0)
    return (worst, min(retreat, finish), retreat + finish, -s['retreatDeaths'], s['normalEnergy'])

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--model', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    p.add_argument('--node', required=True); p.add_argument('--updates', type=int, default=100)
    p.add_argument('--steps', type=int, default=96); p.add_argument('--envs', type=int, default=8)
    p.add_argument('--max-seconds', type=float, default=25); p.add_argument('--eval-every', type=int, default=20)
    p.add_argument('--eval-episodes', type=int, default=64); p.add_argument('--eval-seconds', type=float, default=25)
    p.add_argument('--seed', type=int, default=20261127); p.add_argument('--decision-fraction', type=float, default=.75)
    p.add_argument('--base-prior', type=float, default=0.)
    p.add_argument('--scope-encounter', action='store_true')
    p.add_argument('--focus-character')
    args = p.parse_args()
    if args.model.parent.resolve() == args.output.resolve(): raise ValueError('Use a separate output directory')
    if not (1 <= args.updates <= 100000 and 8 <= args.steps <= 1024 and 1 <= args.envs <= 16 and 0 <= args.decision_fraction <= 1 and 16 <= args.eval_episodes <= 128 and args.eval_episodes % 16 == 0 and args.eval_every > 0): raise ValueError('Invalid training settings')
    torch.manual_seed(args.seed); np.random.seed(args.seed); torch.set_num_threads(4)
    args.output.mkdir(parents=True, exist_ok=True)
    data = args.model.read_bytes(); base = json.loads(data.decode('utf-8-sig'))
    args.scope_encounter = args.scope_encounter or base.get('tacticalPolicy', {}).get('scope') == 'visible-encounter/1'
    (args.output/'initial-model.json').write_bytes(data)
    base['decisionMode'] = 'learned/1'; base.pop('objectivePolicy', None)
    base.pop('selection', None)
    base['modelName'] = 'ミニオン v1（v11 戦闘判断 PPO）'
    actor = DecisionActor(args.base_prior); optimizer = torch.optim.Adam(actor.parameters(), lr=.001)
    if base.get('tacticalPolicy'):
        w = base['tacticalPolicy']['weights']
        source_w = torch.tensor(w['hiddenW']); actor.hidden.weight.data.zero_(); actor.hidden.weight.data[:, :source_w.shape[1]].copy_(source_w); actor.hidden.bias.data.copy_(torch.tensor(w['hiddenB']))
        actor.output.weight.data.copy_(torch.tensor([w['outputW']])); actor.output.bias.data.copy_(torch.tensor([w['outputB']]))
    engine = ppo.Engine(args.node); started = time.monotonic(); gamma, lam = .997, .95
    report = {'algorithm': 'PPO', 'method': 'learned categorical policy over legal player input candidates; no action overrides or supervised lessons',
              'source': str(args.model), 'sourceSha256': hashlib.sha256(data).hexdigest(), 'seed': args.seed,
              'updates': args.updates, 'steps': args.steps, 'envs': args.envs, 'learningRate': .001,
              'gamma': gamma, 'gaeLambda': lam, 'decisionFraction': args.decision_fraction, 'history': [], 'selection': [], 'episodes': [],
              'initialSnapshot': str(args.output/'initial-model.json')}
    report['resumedTacticalPolicy'] = bool(base.get('tacticalPolicy'))
    report['initialBasePriorLogit'] = None if report['resumedTacticalPolicy'] else args.base_prior
    report['scope'] = 'visible-encounter/1' if args.scope_encounter else None
    report['focusCharacter'] = args.focus_character
    def save(name):
        model = copy.deepcopy(base); model['tacticalPolicy'] = actor.export()
        if args.scope_encounter:model['tacticalPolicy']['scope']='visible-encounter/1'
        model['tacticalPolicy']['training'] = {k:v for k,v in report.items() if k not in ['history','selection','before','after','episodes']}
        model['tacticalPolicy']['training']['completedUpdates'] = len(report['history'])
        dest = args.output/name; tmp = args.output/(name+'.tmp'); tmp.write_text(json.dumps(model, ensure_ascii=False), encoding='utf8'); tmp.replace(dest)
        return dest
    scenarios = ['duel-retreat', 'duel-retreat-chase', 'finish-static', 'finish-flee', 'farm', 'match', 'bush-entry', 'bush-attack']
    options = {'episodes': args.eval_episodes, 'maxSeconds': args.eval_seconds, 'seed': args.seed + 200000,
               'scenarios': scenarios, 'rewardProfile': 'survival/1', 'decisionTraining': True}
    best = None; baseline = None
    def consider(file, tag):
        nonlocal best, baseline
        evaluated = engine.call({'op':'evaluate','model':str(file.resolve()),'options':options}); s = summary(evaluated)
        if baseline is None: baseline = s
        eligible = (s['normalEnergy'] >= .8*baseline['normalEnergy'] and s['recoveries'] >= baseline['recoveries'] and s['finishKills'] >= baseline['finishKills'])
        score = selection_score(s); accepted = eligible and (best is None or score > best)
        report['selection'].append({'tag':tag,'summary':s,'score':list(score),'eligible':eligible,'accepted':accepted})
        if accepted:
            best = score; selected = json.loads(file.read_text(encoding='utf8')); selected['selection']={'tag':tag,'validationSummary':s}
            (args.output/'selected.tmp').write_text(json.dumps(selected, ensure_ascii=False),encoding='utf8'); (args.output/'selected.tmp').replace(args.output/'model.json')
        print(json.dumps({'selection':tag,'accepted':accepted,'summary':s}),flush=True)
    try:
        warm = save('warm-start-model.json')
        initialized = engine.call({'op':'init','model':str(warm.resolve()),'envs':args.envs,'options':{
            'seed':args.seed,'maxSeconds':args.max_seconds,'gamma':gamma,'rewardProfile':'survival/1','decisionTraining':True,'decisionFraction':args.decision_fraction,'focusCharacter':args.focus_character}})
        report['init'] = initialized['init']; base['init']=initialized['init']
        consider(warm,'warm-start'); obs=initialized['observations']; report['before']=report['selection'][0]['summary']
        for update in range(args.updates):
            rows={k:[] for k in ['x','mask','action','logp','value','reward','next','terminal','done']}
            for step in range(args.steps):
                x,mask=tensors(obs)
                with torch.no_grad(): distribution,value=actor(x,mask); action=distribution.sample(); logp=distribution.log_prob(action)
                results=engine.call({'op':'decision-step','actions':action.tolist()})['results']
                bx,bm=tensors([r['bootstrap'] for r in results])
                with torch.no_grad(): _,nv=actor(bx,bm)
                values={'x':x,'mask':mask,'action':action,'logp':logp,'value':value,'reward':torch.tensor([r['reward'] for r in results]),
                        'next':nv,'terminal':torch.tensor([float(r['terminal']) for r in results]),'done':torch.tensor([float(r['terminal'] or r['truncated']) for r in results])}
                for k,v in values.items():rows[k].append(v)
                report['episodes'].extend(r['episode'] for r in results if 'episode' in r)
                obs=[r['observation'] for r in results]
            stack={k:torch.stack(v) for k,v in rows.items()}
            adv,returns=ppo.advantages(stack['reward'],stack['value'],stack['next'],stack['terminal'],stack['done'],gamma,lam)
            adv=adv.flatten();adv=(adv-adv.mean())/(adv.std(unbiased=False)+1e-8);returns=returns.flatten()
            batch={k:v.flatten(0,1) for k,v in stack.items()}; losses=[]
            for epoch in range(4):
                for idx in torch.randperm(len(adv)).split(128):
                    distribution,value=actor(batch['x'][idx],batch['mask'][idx]); ratio=(distribution.log_prob(batch['action'][idx])-batch['logp'][idx]).exp()
                    loss=-torch.minimum(ratio*adv[idx],ratio.clamp(.8,1.2)*adv[idx]).mean()+.5*nn.functional.smooth_l1_loss(value,returns[idx])-.01*distribution.entropy().mean()
                    if not torch.isfinite(loss):raise RuntimeError('Non-finite PPO loss')
                    optimizer.zero_grad();loss.backward();nn.utils.clip_grad_norm_(actor.parameters(),.5);optimizer.step();losses.append(float(loss.detach()))
            stats={'update':update+1,'steps':(update+1)*args.steps*args.envs,'loss':sum(losses)/len(losses),'meanStepReward':float(stack['reward'].mean()),'completedEpisodes':len(report['episodes']),'seconds':time.monotonic()-started};report['history'].append(stats)
            latest=save('latest-model.json')
            if (update+1)%args.eval_every==0 or update+1==args.updates:consider(latest,'update-'+str(update+1))
            (args.output/'decision-training.json').write_text(json.dumps(report,indent=2),encoding='utf8');print(json.dumps(stats),flush=True)
        report['elapsedSeconds']=time.monotonic()-started
        final_options={**options,'seed':args.seed+300000}
        report['after']=engine.call({'op':'evaluate','model':str((args.output/'model.json').resolve()),'options':final_options})
        report['afterSummary']=summary(report['after'])
        (args.output/'decision-training.json').write_text(json.dumps(report,indent=2),encoding='utf8')
        x,mask=tensors(obs[:1]); probe=x[0,0]
        selected=json.loads((args.output/'model.json').read_text(encoding='utf8'))['tacticalPolicy']['weights']
        with torch.no_grad():score=float(torch.tensor(selected['outputW']) @ torch.tanh(torch.tensor(selected['hiddenW']) @ probe + torch.tensor(selected['hiddenB'])) + selected['outputB'])
        (args.output/'decision-parity.json').write_text(json.dumps({'x':probe.tolist(),'score':score}),encoding='utf8')
        if (args.model.parent/'parity.json').exists():shutil.copyfile(args.model.parent/'parity.json',args.output/'parity.json')
        print(json.dumps({'after':report['afterSummary'],'model':str(args.output/'model.json')}),flush=True)
    finally:engine.close()

if __name__=='__main__':main()

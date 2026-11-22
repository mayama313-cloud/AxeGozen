"""Model-based RL: fit action values from real, counterfactual engine rollouts. No expert action labels."""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import time
import numpy as np
import torch
from torch import nn

spec=importlib.util.spec_from_file_location('league',Path(__file__).with_name('train-minion-league.py'))
league=importlib.util.module_from_spec(spec);spec.loader.exec_module(league)


def expand_actor(actor,hidden=64):
    old=actor.hidden.out_features
    if old>=hidden:return
    candidate=nn.Linear(actor.hidden.in_features,hidden);context=nn.Linear(actor.context.in_features,hidden,bias=False);output=nn.Linear(hidden,1)
    with torch.no_grad():
        candidate.weight[:old].copy_(actor.hidden.weight);candidate.bias[:old].copy_(actor.hidden.bias)
        context.weight.zero_();context.weight[:old].copy_(actor.context.weight)
        output.weight.zero_();output.weight[:,:old].copy_(actor.output.weight);output.bias.copy_(actor.output.bias)
    actor.hidden=candidate;actor.context=context;actor.output=output


def main():
    p=argparse.ArgumentParser();p.add_argument('--model',type=Path,required=True);p.add_argument('--data',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--epochs',type=int,default=160);p.add_argument('--seed',type=int,default=20261221);p.add_argument('--temperature',type=float,default=.15)
    p.add_argument('--hidden',type=int,default=64);p.add_argument('--composed',action='store_true')
    p.add_argument('--on-policy-weight',type=float,default=1)
    p.add_argument('--prior-strength',type=float,default=0)
    args=p.parse_args()
    if not 1<=args.on_policy_weight<=10:raise ValueError('Invalid on-policy sample weight')
    if not 0<=args.prior_strength<=5:raise ValueError('Invalid learned policy regularization')
    if args.output.exists():raise ValueError('Use a new output directory')
    torch.manual_seed(args.seed);np.random.seed(args.seed);torch.set_num_threads(4)
    rows=[json.loads(line) for line in args.data.read_text(encoding='utf8').splitlines() if line.strip()]
    if len(rows)<16:raise ValueError('Not enough simulated states')
    for row in rows:
        if len(row['returns'])!=len(row['decisionX']) or not 1<=len(row['returns'])<=128 or not all(np.isfinite(v) for v in row['returns']):
            raise ValueError('Invalid simulated action returns')
    source=args.model.read_bytes();base=json.loads(source.decode('utf-8-sig'))
    metadata_file=Path(str(args.data)+'.meta.json')
    if metadata_file.exists():
        metadata=json.loads(metadata_file.read_text(encoding='utf8'))
        for key in ['cfg','map']:
            if key in metadata:base['init'][key]=metadata[key]
    actor=league.LeagueActor(base);expand_actor(actor,args.hidden)
    if args.composed:actor.action_protocol='composed-inputs/14'
    actor.context.requires_grad_(False);actor.critic.requires_grad_(False)
    optimizer=torch.optim.Adam([v for v in actor.parameters() if v.requires_grad],lr=.001)
    x,c,mask=league.tensors(rows);returns=torch.zeros(len(rows),128)
    for i,row in enumerate(rows):returns[i,:len(row['returns'])]=torch.tensor(row['returns'])
    with torch.no_grad():prior_logits=actor(x,c,mask)[0].logits
    targets=returns+args.prior_strength*prior_logits
    centered=targets-(targets*mask).sum(1,keepdim=True)/mask.sum(1,keepdim=True)
    sample_weight=torch.tensor([args.on_policy_weight if r['scenario']=='on-policy' else 1 for r in rows])
    groups=sorted(set((r['scenario'],r['character'],r['slot']) for r in rows));rng=np.random.default_rng(args.seed);rng.shuffle(groups)
    validation=set(groups[:max(2,len(groups)//5)])
    train=torch.tensor([i for i,r in enumerate(rows) if (r['scenario'],r['character'],r['slot']) not in validation])
    valid=torch.tensor([i for i,r in enumerate(rows) if (r['scenario'],r['character'],r['slot']) in validation])
    args.output.mkdir(parents=True);(args.output/'initial-model.json').write_bytes(source)
    report={'algorithm':'simulated-action-value/1','source':str(args.model.resolve()),'sourceSha256':hashlib.sha256(source).hexdigest(),
            'dataset':str(args.data.resolve()),'datasetSha256':hashlib.sha256(args.data.read_bytes()).hexdigest(),'states':len(rows),
            'rollouts':sum(len(r['returns']) for r in rows),'trainStates':len(train),'validationStates':len(valid),'seed':args.seed,
            'rewardProfiles':sorted(set(r['rewardProfile'] for r in rows)),'hiddenSize':actor.hidden.out_features,'actionProtocol':getattr(actor,'action_protocol',None),
            'onPolicyWeight':args.on_policy_weight,
            'priorStrength':args.prior_strength,
            'method':'Actual game outcome returns, with all candidate actions tried from identical snapshots; frozen base and full-observation context. Optional regularization uses the source learned policy. No heuristic teacher labels.',
            'history':[],'limitation':'Finite-horizon fitted values; held-out game behavior must be tested separately.'}
    def assess(indices):
        with torch.no_grad():
            distribution,_=actor(x[indices],c[indices],mask[indices]);choice=distribution.logits.argmax(1)
            actual=returns[indices,choice];best=returns[indices].masked_fill(~mask[indices],-1e9).max(1).values
        weights=sample_weight[indices]
        return {'meanReturn':float((actual*weights).sum()/weights.sum()),'unweightedMeanReturn':float(actual.mean()),
                'regret':float((best-actual).mean()),'nearBestFraction':float((best-actual<.1).float().mean())}
    def save(name,epoch):
        model=copy.deepcopy(base)
        for key in ['leagueTraining','selection']:model.pop(key,None)
        model['modelName']=base.get('modelName','ミニオン v1')+' / シミュレーション価値学習';model['decisionMode']='learned/1'
        model['tacticalPolicy']=actor.export();model['tacticalPolicy']['inferenceTemperature']=args.temperature
        model['lookaheadTraining']={'algorithm':report['algorithm'],'epochs':epoch,'datasetSha256':report['datasetSha256'],'report':'lookahead-training.json'}
        (args.output/name).write_text(json.dumps(model,ensure_ascii=False),encoding='utf8')
    report['before']=assess(valid);best=report['before']['meanReturn'];save('model.json',0);started=time.monotonic()
    for epoch in range(1,args.epochs+1):
        losses=[]
        for indices in train[torch.randperm(len(train))].split(8):
            distribution,_=actor(x[indices],c[indices],mask[indices]);logits=distribution.logits
            target=torch.softmax(targets[indices].masked_fill(~mask[indices],-1e9)/.3,1)
            weights=sample_weight[indices];cross_entropy=(-(target*torch.log_softmax(logits/.3,1)).sum(1)*weights).sum()/weights.sum()
            prediction=logits-(logits*mask[indices]).sum(1,keepdim=True)/mask[indices].sum(1,keepdim=True)
            error=nn.functional.smooth_l1_loss(prediction,centered[indices],reduction='none')
            regression=(((error*mask[indices]).sum(1)/mask[indices].sum(1))*weights).sum()/weights.sum()
            loss=cross_entropy+.1*regression
            if not torch.isfinite(loss):raise RuntimeError('Non-finite fitted value loss')
            optimizer.zero_grad();loss.backward();nn.utils.clip_grad_norm_(actor.parameters(),1);optimizer.step();losses.append(float(loss.detach()))
        if epoch%10==0 or epoch==args.epochs:
            score=assess(valid);accepted=score['meanReturn']>best+1e-6
            if accepted:best=score['meanReturn'];save('model.json',epoch)
            row={'epoch':epoch,'loss':sum(losses)/len(losses),'validation':score,'accepted':accepted};report['history'].append(row);print(json.dumps(row),flush=True)
    save('latest-model.json',args.epochs);report['seconds']=time.monotonic()-started
    (args.output/'lookahead-training.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    selected=json.loads((args.output/'model.json').read_text(encoding='utf8'));w=selected['tacticalPolicy']['weights']
    probe=valid[0].item()
    with torch.no_grad():value=float(torch.tensor(w['outputW'])@torch.tanh(torch.tensor(w['hiddenW'])@c[probe,0]+torch.tensor(w['hiddenB'])+torch.tensor(w['contextW'])@x[probe])+w['outputB'])
    (args.output/'league-parity.json').write_text(json.dumps({'x':x[probe].tolist(),'candidate':c[probe,0].tolist(),'score':value}),encoding='utf8')
    print(json.dumps({'complete':True,'model':str((args.output/'model.json').resolve()),'before':report['before'],'bestValidationReturn':best}),flush=True)


if __name__=='__main__':main()

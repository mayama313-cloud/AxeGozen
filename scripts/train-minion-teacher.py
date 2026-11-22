"""Distill ordinary algorithm inputs into a neural candidate scorer; no runtime teacher."""
import argparse
import copy
import gzip
import hashlib
import json
from pathlib import Path
import time
import numpy as np
import torch
from torch import nn


def folded_weights(network, mean, scale):
    w = network[0].weight.detach() / scale[None, :]
    b = network[0].bias.detach() - (w * mean[None, :]).sum(1)
    return {'hiddenW': w.tolist(), 'hiddenB': b.tolist(),
            'outputW': network[2].weight.detach().flatten().tolist(),
            'outputB': float(network[2].bias.detach()[0])}


def load_data(files):
    arrays, records, metadata = [], [], []
    for file in files:
        metadata.append(json.loads(Path(str(file) + '.meta.json').read_text(encoding='utf8')))
        with gzip.open(file, 'rt', encoding='utf8') as stream:
            for line in stream:
                row = json.loads(line)
                x = np.asarray(row.pop('x'), dtype=np.float32)
                if x.ndim != 2 or x.shape[1] not in [96,128] or not 2 <= len(x) <= 128 or not np.isfinite(x).all():
                    raise ValueError('Invalid teacher candidates')
                if metadata[-1].get('featureVersion')=='minion-student-state/24':
                    if row.get('mode')=='retreat' and x[0,46]!=1:continue
                    if row.get('event')=='move' and (x[0,45] or x[0,44] and x[0,48]>0):continue
                row['group'] = (row['character'], row['slot'], row['opponentCharacter'])
                arrays.append(x); records.append(row)
    width = max(len(x) for x in arrays)
    feature_size=arrays[0].shape[1]
    if any(x.shape[1]!=feature_size for x in arrays):raise ValueError('Mixed teacher feature versions')
    if feature_size==128 and len(set(m.get('featureVersion','minion-student-state/23') for m in metadata))!=1:raise ValueError('Mixed student observation semantics')
    data = np.zeros((len(arrays), width, feature_size), dtype=np.float32)
    mask = np.zeros((len(arrays), width), dtype=np.bool_)
    for i, x in enumerate(arrays):
        data[i, :len(x)] = x; mask[i, :len(x)] = True
    return torch.from_numpy(data), torch.from_numpy(mask), records, metadata


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--data', type=Path, action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--epochs', type=int, default=80)
    parser.add_argument('--hidden', type=int, default=128)
    parser.add_argument('--seed', type=int, default=20261201)
    parser.add_argument('--snapshot-every',type=int,default=0)
    args = parser.parse_args()
    if args.output.exists(): raise ValueError('Use a new output directory')
    if not 1 <= args.epochs <= 1000 or not 8 <= args.hidden <= 128 or args.snapshot_every<0: raise ValueError('Invalid teacher training settings')
    torch.manual_seed(args.seed); np.random.seed(args.seed); torch.set_num_threads(4)
    source = args.model.read_bytes(); base = json.loads(source.decode('utf-8-sig'))
    data, mask, records, metadata = load_data(args.data)
    if any(m['cfg'] != metadata[0]['cfg'] or m['map'] != metadata[0]['map'] for m in metadata): raise ValueError('Mixed teacher game rules')
    characters = base['characters']
    if set(r['character'] for r in records) != set(characters): raise ValueError('Every character needs teacher data')
    validation = {tuple([c, side, characters[(i + args.seed) % len(characters)]])
                  for i, c in enumerate(characters) for side in [0, 1]}
    train = torch.tensor([i for i, r in enumerate(records) if r['group'] not in validation])
    valid = torch.tensor([i for i, r in enumerate(records) if r['group'] in validation])
    if not len(train) or not len(valid): raise ValueError('Empty teacher split')
    # Statistics use training games only. Fold normalization into the exported layer.
    values = data[train][mask[train]]
    mean = values.mean(0); scale = values.std(0, unbiased=False).clamp_min(.05)
    del values
    char_counts = {c: sum(r['character'] == c for r in records) for c in characters}
    mode_counts = {m: sum(r['mode'] == m for r in records) for m in set(r['mode'] for r in records)}
    weights = torch.tensor([len(records) / (len(characters) * char_counts[r['character']])
                            * (max(mode_counts.values()) / mode_counts[r['mode']]) ** .5 * r.get('weight',1) for r in records]).clamp(.25, 8)
    weights /= weights[train].mean()
    feature_size=data.shape[2]
    network = nn.Sequential(nn.Linear(feature_size, args.hidden), nn.Tanh(), nn.Linear(args.hidden, 1))
    optimizer = torch.optim.Adam(network.parameters(), lr=.001)
    args.output.mkdir(parents=True); (args.output / 'initial-model.json').write_bytes(source)
    base['init'] = {'cfg': metadata[0]['cfg'], 'map': metadata[0]['map'], 'characters': metadata[0]['characters']}
    for key in ['objectivePolicy', 'selection', 'leagueTraining', 'lookaheadTraining', 'reinforcementLearning']: base.pop(key, None)
    base.update(decisionMode='learned/1', decisionIntervalTicks=6, controlProtocol='release-before-chase/1')
    report = {'algorithm': 'algorithm-input-distillation/1', 'sourceSha256': hashlib.sha256(source).hexdigest(),
              'data': [{'file': str(p.resolve()), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in args.data],
              'rows': len(records), 'filteredRows':sum(m.get('rows',0) for m in metadata)-len(records),'trainRows': len(train), 'validationRows': len(valid), 'seed': args.seed,
              'hiddenSize': args.hidden, 'featureSize':feature_size,'characters': characters, 'modes': mode_counts,
              'validationGroups': sorted(validation), 'history': [],'snapshots':[],
              'method': 'Offline CPU input imitation. Whole character/side/opponent matches held out. Candidate-only network with training-only feature normalization; no runtime algorithm fallback.',
              'limitation': 'Teacher accuracy does not certify match performance; ordinary full matches must be evaluated.'}
    def logits(indices):
        return network((data[indices] - mean) / scale).squeeze(-1).masked_fill(~mask[indices], -1e9)
    def assess(indices):
        correct=[]
        with torch.no_grad():
            for batch in indices.split(512): correct.extend((logits(batch).argmax(1) == 0).tolist())
        rows=[records[i] for i in indices.tolist()]
        by_char={c:sum(ok for ok,r in zip(correct,rows) if r['character']==c)/max(1,sum(r['character']==c for r in rows)) for c in characters}
        by_mode={m:sum(ok for ok,r in zip(correct,rows) if r['mode']==m)/max(1,sum(r['mode']==m for r in rows)) for m in mode_counts}
        return {'accuracy':sum(correct)/len(correct),'characters':by_char,'modes':by_mode}
    def save(name, epoch):
        model=copy.deepcopy(base); model['modelName']='Minion v1 (v15 neural teacher student)'
        model['tacticalPolicy']={'version':'minion-player-decisions/11','inputSize':feature_size,'hiddenSize':args.hidden,
                                 'inferenceTemperature':0,'actionProtocol':'composed-inputs/14','baseProposal':False,
                                 'camps':metadata[0]['camps'],'weights':folded_weights(network,mean,scale)}
        if feature_size==128:model['tacticalPolicy']['featureVersion']=metadata[0].get('featureVersion','minion-student-state/23')
        model['teacherTraining']={'algorithm':report['algorithm'],'epochs':epoch,'rows':len(records),'report':'teacher-training.json'}
        (args.output/name).write_text(json.dumps(model,ensure_ascii=False),encoding='utf8')
    best=(-1.,-1.); started=time.monotonic()
    for epoch in range(1,args.epochs+1):
        losses=[]
        for batch in train[torch.randperm(len(train))].split(256):
            loss=(-(torch.log_softmax(logits(batch),1)[:,0])*weights[batch]).mean()
            if not torch.isfinite(loss):raise RuntimeError('Non-finite teacher loss')
            optimizer.zero_grad();loss.backward();nn.utils.clip_grad_norm_(network.parameters(),2);optimizer.step();losses.append(float(loss.detach()))
        if epoch%5==0 or epoch==args.epochs:
            score=assess(valid); key=(min(score['characters'].values()),score['accuracy']); accepted=key>best
            if accepted:best=key;save('model.json',epoch)
            row={'epoch':epoch,'loss':sum(losses)/len(losses),'validation':score,'accepted':accepted,'seconds':time.monotonic()-started}
            report['history'].append(row);print(json.dumps(row),flush=True)
        if args.snapshot_every and epoch%args.snapshot_every==0:
            name=f'checkpoint-{epoch:05}.json';save(name,epoch);report['snapshots'].append({'epoch':epoch,'file':name})
    save('latest-model.json',args.epochs)
    report['seconds']=time.monotonic()-started;report['status']='complete'
    (args.output/'teacher-training.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    model=json.loads((args.output/'model.json').read_text(encoding='utf8')); w=model['tacticalPolicy']['weights']; probe=data[valid[0],0]
    score=float(torch.tensor(w['outputW'])@torch.tanh(torch.tensor(w['hiddenW'])@probe+torch.tensor(w['hiddenB']))+w['outputB'])
    (args.output/'teacher-parity.json').write_text(json.dumps({'candidate':probe.tolist(),'score':score}),encoding='utf8')
    print(json.dumps({'complete':True,'model':str(args.output/'model.json'),'best':best}),flush=True)


if __name__=='__main__': main()

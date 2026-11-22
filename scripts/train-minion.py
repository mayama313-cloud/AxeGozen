"""Small behavior-cloning baseline; imports no simulator internals or hidden state."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
import random
from pathlib import Path

import numpy as np
import torch
from torch import nn


def split_by_character(rows, seed=17):
    """Keep whole matches together and never hold out a character's only match."""
    by_episode=defaultdict(set)
    for row in rows:by_episode[row['episodeId']].add(row['character'])
    episodes=sorted(by_episode);characters=sorted({r['character'] for r in rows})
    if len(episodes)==1:
        boundary=max(r['time'] for r in rows)*.8
        train=[i for i,r in enumerate(rows) if r['time']<boundary-3]
        validation=[i for i,r in enumerate(rows) if r['time']>=boundary]
        kind='same-match chronological diagnostic; 3-second gap; NOT generalization evaluation'
        held_out=[]
    else:
        counts=Counter(c for cs in by_episode.values() for c in cs)
        protected={e for e,cs in by_episode.items() if any(counts[c]==1 for c in cs)}
        eligible=[e for e in episodes if e not in protected]
        target=max(1,round(len(episodes)*.2));best=None
        # Try seeded tie orders: rare multi-character matches can constrain each other.
        for attempt in range(128):
            rng=random.Random(seed+attempt);order=eligible.copy();rng.shuffle(order)
            chosen=set();remaining=counts.copy();covered=set()
            while True:
                options=[e for e in order if e not in chosen and all(remaining[c]>1 for c in by_episode[e])]
                if not options:break
                candidate=max(options,key=lambda e:(sum(1/counts[c] for c in by_episode[e]-covered),-abs(len(chosen)+1-target)))
                gain=by_episode[candidate]-covered
                if not gain and len(chosen)>=target:break
                chosen.add(candidate);covered.update(by_episode[candidate])
                remaining.subtract(by_episode[candidate])
            score=(len(covered),-abs(len(chosen)-target))
            if best is None or score>best[0]:best=(score,chosen)
        held_out=sorted(best[1]);held_set=set(held_out)
        train=[i for i,r in enumerate(rows) if r['episodeId'] not in held_set]
        validation=[i for i,r in enumerate(rows) if r['episodeId'] in held_set]
        kind='character-aware independent episode holdout; singleton characters remain in training'
    if len(train)<10 or not validation:raise ValueError('Not enough independent matches or chronological examples for validation; add another match.')
    missing=set(characters)-{rows[i]['character'] for i in train}
    if missing:raise ValueError('Split would omit training characters: '+', '.join(sorted(missing)))
    missing_diagnostic=sorted(set(characters)-{rows[i]['character'] for i in validation})
    return train,validation,{'kind':kind,'validationEpisodes':held_out,'charactersWithoutDiagnostic':missing_diagnostic,
                             'charactersWithoutIndependentValidation':characters if len(episodes)==1 else missing_diagnostic}


def balanced_epoch(rows, train, seed):
    """Equal character draws, then uniform matches within each character."""
    groups=defaultdict(lambda:defaultdict(list))
    for i in train:groups[rows[i]['character']][rows[i]['episodeId']].append(i)
    rng=random.Random(seed);characters=sorted(groups)
    episodes={c:sorted(groups[c]) for c in characters}
    result=[]
    for _ in range((len(train)+len(characters)-1)//len(characters)):
        order=characters.copy();rng.shuffle(order)
        for c in order:
            episode=rng.choice(episodes[c]);result.append(rng.choice(groups[c][episode]))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--epochs', type=int, default=30)
    parser.add_argument('--prepared', type=Path)
    parser.add_argument('--seed',type=int,default=17)
    args = parser.parse_args()
    if not 1 <= args.epochs <= 1000:
        raise ValueError('epochs must be between 1 and 1000')
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(min(4, torch.get_num_threads()))
    args.output.mkdir(parents=True,exist_ok=True)
    if any((args.output/f).exists() for f in ['model.json','training.json','parity.json']):raise ValueError('Choose a new output directory; existing models are not overwritten.')
    prepared_file=args.prepared or args.output/'prepared.json'
    prepared = json.loads(prepared_file.read_text(encoding='utf-8-sig'))
    rows = prepared.pop('rows')
    x = torch.tensor(np.asarray([r['x'] for r in rows], dtype=np.float32))
    y = torch.tensor([r['y'] for r in rows], dtype=torch.long)
    xy = torch.tensor([r['xy'] for r in rows], dtype=torch.float32)
    point = torch.tensor([r['point'] for r in rows], dtype=torch.bool)
    if not torch.isfinite(x).all() or not torch.isfinite(xy).all():
        raise ValueError('non-finite training input')
    episodes = sorted(set(r['episodeId'] for r in rows))
    train,validation,split_info=split_by_character(rows,args.seed)
    split=split_info['kind']
    train_characters = sorted(set(rows[i]['character'] for i in train))
    diagnostic_characters = sorted(set(rows[i]['character'] for i in validation))
    hidden_size = 64
    hidden = nn.Linear(prepared['inputSize'], hidden_size)
    type_head = nn.Linear(hidden_size, len(prepared['events']))
    point_head = nn.Linear(hidden_size, len(prepared['events']) * 2)
    parameters = list(hidden.parameters()) + list(type_head.parameters()) + list(point_head.parameters())
    optimizer = torch.optim.AdamW(parameters, lr=.001, weight_decay=.0001)
    counts = torch.bincount(y[train], minlength=len(prepared['events'])).float()
    # Action weights should reflect the balanced distribution, not Alex's raw majority.
    balanced_counts=torch.zeros(len(prepared['events']))
    for character in train_characters:
        games=defaultdict(list)
        for i in train:
            if rows[i]['character']==character:games[rows[i]['episodeId']].append(i)
        for indices in games.values():
            balanced_counts+=torch.bincount(y[indices],minlength=len(prepared['events']))/len(indices)/len(games)/len(train_characters)
    weights = torch.where(balanced_counts > 0, balanced_counts.clamp(min=1e-12).rsqrt(), torch.zeros_like(counts))
    weights /= weights[balanced_counts > 0].mean()
    criterion = nn.CrossEntropyLoss(weight=weights)

    def forward(inputs):
        h = torch.tanh(hidden(inputs))
        return type_head(h), torch.tanh(point_head(h)).reshape(-1, len(prepared['events']), 2)

    def evaluate(indices):
        with torch.no_grad():
            logits, points = forward(x[indices])
            predictions = logits.argmax(dim=1)
            true = y[indices]
            accuracy = (predictions == true).float().mean().item()
            errors = []
            for t in true.unique():
                mask = true == t
                errors.append((predictions[mask] == t).float().mean().item())
            mask = point[indices]
            predicted_xy = points[torch.arange(len(indices)), true]
            mae = (predicted_xy[mask] - xy[indices][mask]).abs().mean().item() if mask.any() else 0
            return {'actionAccuracy': accuracy, 'macroActionRecall': sum(errors) / len(errors), 'normalizedCoordinateMae': mae,
                    'classificationLoss': criterion(logits, true).item()}

    initial = evaluate(train)
    train_by_character={c:[i for i in train if rows[i]['character']==c] for c in train_characters}
    valid_by_character={c:[i for i in validation if rows[i]['character']==c] for c in train_characters}
    initial_by_character={c:evaluate(indices) for c,indices in train_by_character.items()}
    print(json.dumps({'started':True,'characters':train_characters,'split':split_info,'trainCounts':{c:len(v) for c,v in train_by_character.items()},'sampling':'equal characters, uniform matches within character'}),flush=True)
    history = []
    for epoch in range(args.epochs):
        sampled=balanced_epoch(rows,train,args.seed+epoch)
        order = torch.tensor(sampled)
        for indices in order.split(128):
            logits, points = forward(x[indices])
            predicted_xy = points[torch.arange(len(indices)), y[indices]]
            mask = point[indices]
            coordinate_loss = nn.functional.smooth_l1_loss(predicted_xy[mask], xy[indices][mask]) if mask.any() else predicted_xy.sum() * 0
            loss = criterion(logits, y[indices]) + coordinate_loss * 5
            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(parameters, 5)
            optimizer.step()
        if epoch == 0 or (epoch + 1) % 10 == 0 or epoch == args.epochs - 1:
            metrics = {'epoch': epoch + 1, 'train': evaluate(train), 'diagnostic': evaluate(validation),
                       'sampledCharacterCounts':dict(Counter(rows[i]['character'] for i in sampled)),
                       'characters':{c:{'train':evaluate(train_by_character[c]),'diagnostic':evaluate(valid_by_character[c]) if valid_by_character[c] else None} for c in train_characters}}
            history.append(metrics)
            print(json.dumps(metrics), flush=True)
    final = evaluate(train)
    if final['classificationLoss'] >= initial['classificationLoss']:
        raise RuntimeError('training did not reduce classification loss')
    report = {'model': '\u30df\u30cb\u30aa\u30f3 v1 (balanced imitation)', 'seed': args.seed, 'epochs': args.epochs, 'runtime': str(torch.__version__),
              'prepared':str(prepared_file.resolve()),'preparedSha256':hashlib.sha256(prepared_file.read_bytes()).hexdigest(),
              'splitDetails':split_info,'sampling':'equal characters, uniform matches within character; replacement sampling',
              'drawsPerCharacterPerEpoch':(len(train)+len(train_characters)-1)//len(train_characters),
              'characters':{c:{'trainExamples':len(train_by_character[c]),'trainEpisodes':sorted({rows[i]['episodeId'] for i in train_by_character[c]}),
                              'diagnosticExamples':len(valid_by_character[c]),'initialTrain':initial_by_character[c],'finalTrain':evaluate(train_by_character[c]),
                              'diagnostic':evaluate(valid_by_character[c]) if valid_by_character[c] else None} for c in train_characters},
              'device': 'cpu', 'split': split, 'episodes': episodes, 'trainExamples': len(train), 'diagnosticExamples': len(validation),
              'trainCharacters': train_characters, 'diagnosticCharacters': diagnostic_characters,
              'unseenDiagnosticCharacters': sorted(set(diagnostic_characters) - set(train_characters)),
              'initialTrain': initial, 'finalTrain': final, 'diagnostic': evaluate(validation),
              'classCounts': {name: int(counts[i]) for i, name in enumerate(prepared['events'])}, 'history': history,
              'limitations': ['one-command decisions at approximately 10Hz', 'lossy feature hashing with collisions',
                              'feed-forward policy with explicit last-seen and recent-cue features',
                              'characters with only one match cannot have independent-match validation; collect more matches',
                              'one match cannot establish playing strength or generalization', 'no reinforcement learning']}
    def layer(layer, prefix):
        return {prefix + 'W': layer.weight.detach().tolist(), prefix + 'B': layer.bias.detach().tolist()}
    model = {'format': prepared['format'], 'modelName': report['model'], 'inputSize': prepared['inputSize'], 'hiddenSize': hidden_size,
             'events': prepared['events'], 'characters': train_characters, 'rulesVersion': prepared['rulesVersion'],
             'init': prepared['init'], 'training': report, 'data': prepared['audit']['files'],
             'weights': {**layer(hidden, 'hidden'), **layer(type_head, 'type'), **layer(point_head, 'point')}}
    probe = x[train[0]].unsqueeze(0)
    with torch.no_grad():
        logits, points = forward(probe)
    parity = {'x': probe[0].tolist(), 'logits': logits[0].tolist(), 'points': points[0].flatten().tolist()}
    for filename, content in [('model.json', model), ('training.json', report), ('parity.json', parity)]:
        (args.output / filename).write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'model': str(args.output / 'model.json'), 'report': str(args.output / 'training.json')}))


if __name__ == '__main__':
    main()

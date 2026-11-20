"""Small behavior-cloning baseline; imports no simulator internals or hidden state."""
import argparse
import json
import random
from pathlib import Path

import numpy as np
import torch
from torch import nn


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--epochs', type=int, default=30)
    args = parser.parse_args()
    if not 1 <= args.epochs <= 1000:
        raise ValueError('epochs must be between 1 and 1000')
    random.seed(17)
    np.random.seed(17)
    torch.manual_seed(17)
    torch.set_num_threads(min(4, torch.get_num_threads()))
    prepared = json.loads((args.output / 'prepared.json').read_text(encoding='utf-8'))
    rows = prepared.pop('rows')
    x = torch.tensor(np.asarray([r['x'] for r in rows], dtype=np.float32))
    y = torch.tensor([r['y'] for r in rows], dtype=torch.long)
    xy = torch.tensor([r['xy'] for r in rows], dtype=torch.float32)
    point = torch.tensor([r['point'] for r in rows], dtype=torch.bool)
    if not torch.isfinite(x).all() or not torch.isfinite(xy).all():
        raise ValueError('non-finite training input')
    episodes = sorted(set(r['episodeId'] for r in rows))
    if len(episodes) > 1:
        validation_episodes = set(episodes[-max(1, len(episodes) // 5):])
        train = [i for i, r in enumerate(rows) if r['episodeId'] not in validation_episodes]
        validation = [i for i, r in enumerate(rows) if r['episodeId'] in validation_episodes]
        split = 'independent episode holdout'
    else:
        boundary = max(r['time'] for r in rows) * .8
        train = [i for i, r in enumerate(rows) if r['time'] < boundary - 3]
        validation = [i for i, r in enumerate(rows) if r['time'] >= boundary]
        split = 'same-match chronological diagnostic; 3-second gap; NOT generalization evaluation'
    if len(train) < 10 or not validation:
        raise ValueError('not enough examples for a training/diagnostic split')
    train_characters = sorted(set(rows[i]['character'] for i in train))
    diagnostic_characters = sorted(set(rows[i]['character'] for i in validation))
    hidden_size = 64
    hidden = nn.Linear(prepared['inputSize'], hidden_size)
    type_head = nn.Linear(hidden_size, len(prepared['events']))
    point_head = nn.Linear(hidden_size, len(prepared['events']) * 2)
    parameters = list(hidden.parameters()) + list(type_head.parameters()) + list(point_head.parameters())
    optimizer = torch.optim.AdamW(parameters, lr=.001, weight_decay=.0001)
    counts = torch.bincount(y[train], minlength=len(prepared['events'])).float()
    weights = torch.where(counts > 0, counts.clamp(min=1).rsqrt(), torch.zeros_like(counts))
    weights /= weights[counts > 0].mean()
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
    history = []
    for epoch in range(args.epochs):
        order = torch.tensor(train)[torch.randperm(len(train))]
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
            metrics = {'epoch': epoch + 1, 'train': evaluate(train), 'diagnostic': evaluate(validation)}
            history.append(metrics)
            print(json.dumps(metrics), flush=True)
    final = evaluate(train)
    if final['classificationLoss'] >= initial['classificationLoss']:
        raise RuntimeError('training did not reduce classification loss')
    report = {'model': '\u30df\u30cb\u30aa\u30f3 v1', 'seed': 17, 'epochs': args.epochs, 'runtime': str(torch.__version__),
              'device': 'cpu', 'split': split, 'episodes': episodes, 'trainExamples': len(train), 'diagnosticExamples': len(validation),
              'trainCharacters': train_characters, 'diagnosticCharacters': diagnostic_characters,
              'unseenDiagnosticCharacters': sorted(set(diagnostic_characters) - set(train_characters)),
              'initialTrain': initial, 'finalTrain': final, 'diagnostic': evaluate(validation),
              'classCounts': {name: int(counts[i]) for i, name in enumerate(prepared['events'])}, 'history': history,
              'limitations': ['one-command decisions at approximately 10Hz', 'lossy feature hashing with collisions',
                              'feed-forward policy with explicit last-seen and recent-cue features',
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

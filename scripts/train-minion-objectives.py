"""Imitate narrow goal-choice demonstrations; the existing motor/defense actor is preserved."""
import argparse
import copy
import json
from pathlib import Path

import torch
from torch import nn

parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--epochs', type=int, default=100)
args = parser.parse_args()
if not 1 <= args.epochs <= 2000:
    raise ValueError('epochs must be 1..2000')
torch.set_num_threads(4)
torch.manual_seed(20261123)
data = json.loads((args.output / 'objective-prepared.json').read_text(encoding='utf-8-sig'))
groups = data['groups']
width = max(len(g['x']) for g in groups)
x = torch.zeros(len(groups), width, 24)
y = torch.zeros(len(groups), width)
mask = torch.zeros(len(groups), width, dtype=torch.bool)
for i, group in enumerate(groups):
    n = len(group['x'])
    x[i, :n] = torch.tensor(group['x'])
    y[i, :n] = torch.tensor(group['y'])
    mask[i, :n] = True
train = torch.tensor([i for i, g in enumerate(groups) if g['split'] == 'train'])
test = torch.tensor([i for i, g in enumerate(groups) if g['split'] == 'test'])
target = y.masked_fill(~mask, -1e9).argmax(1)
network = nn.Sequential(nn.Linear(24, 32), nn.Tanh(), nn.Linear(32, 1))
optimizer = torch.optim.Adam(network.parameters(), lr=.003)
for epoch in range(args.epochs):
    for indices in train[torch.randperm(len(train))].split(128):
        prediction = network(x[indices]).squeeze(-1)
        regression = ((prediction - y[indices]).square() * mask[indices]).sum() / mask[indices].sum()
        ranking = nn.functional.cross_entropy(prediction.masked_fill(~mask[indices], -1e9) / .08, target[indices])
        loss = regression + .08 * ranking
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
    if (epoch + 1) % 25 == 0:
        print(json.dumps({'epoch': epoch + 1, 'loss': float(loss.detach())}), flush=True)
with torch.no_grad():
    scores = network(x).squeeze(-1).masked_fill(~mask, -1e9)
    selected = scores.argmax(1)
    accuracy = float((selected[test] == target[test]).float().mean())
    safety = test[(x[test, 0, 6] > 0) | (x[test, 0, 7] > 0) | (x[test, 0, 22] > 0)]
    safety_accuracy = float((selected[safety] == 0).float().mean())
    boss = torch.tensor([i for i in test.tolist() if groups[i]['kinds'][int(target[i])] == 'large'])
    boss_accuracy = float((selected[boss] == target[boss]).float().mean())
if accuracy < .95 or safety_accuracy < .999 or boss_accuracy < .97:
    raise RuntimeError(f'Goal-policy validation failed: {accuracy=}, {safety_accuracy=}, {boss_accuracy=}')
model = json.loads((args.output / 'initial-model.json').read_text(encoding='utf-8-sig'))
original_weights = copy.deepcopy(model['weights'])
model['objectivePolicy'] = {'version': data['version'], 'features': data['features'], 'hiddenSize': 32, 'camps': data['camps'],
    'weights': {'hiddenW': network[0].weight.detach().tolist(), 'hiddenB': network[0].bias.detach().tolist(),
                'outputW': network[2].weight.detach().tolist(), 'outputB': network[2].bias.detach().tolist()}}
report = {'method': 'goal-utility imitation; algorithmic navigation and skill execution; existing actor unchanged',
          'source': data['source'], 'sourceSha256': data['sourceSha256'], 'teacher': data['teacher'], 'seed': data['seed'],
          'epochs': args.epochs, 'trainContexts': len(train), 'testContexts': len(test), 'goalAccuracy': accuracy,
          'safetyContexts': len(safety), 'safetyAccuracy': safety_accuracy, 'largePriorityContexts': len(boss),
          'largePriorityAccuracy': boss_accuracy, 'limitations': ['synthetic imitation scores are not game win rates', 'execution uses ordinary player inputs']}
model['objectivePolicy']['training'] = report
assert model['weights'] == original_weights
(args.output / 'model.json').write_text(json.dumps(model, ensure_ascii=False), encoding='utf-8')
(args.output / 'objective-training.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
probe = x[test[0], 0]
with torch.no_grad():
    score = float(network(probe).squeeze())
(args.output / 'objective-parity.json').write_text(json.dumps({'x': probe.tolist(), 'score': score}), encoding='utf-8')
print(json.dumps(report), flush=True)

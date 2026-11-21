"""PPO fine-tuning against the real Node.js game engine (CPU, no rendered screen)."""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import random
import subprocess
import sys
import time

import numpy as np
import torch
from torch import nn
from torch.distributions import Categorical, Normal, kl_divergence


class ActorCritic(nn.Module):
    def __init__(self, model):
        super().__init__()
        size, hidden = model['inputSize'], model['hiddenSize']
        count = len(model['events'])
        self.hidden = nn.Linear(size, hidden)
        self.types = nn.Linear(hidden, count)
        self.points = nn.Linear(hidden, count * 2)
        self.direction = nn.Linear(hidden, 9)
        self.order = nn.Linear(hidden, 2)
        self.critic_hidden = nn.Linear(size, hidden)
        self.value = nn.Linear(hidden, 1)
        self.log_std = nn.Parameter(torch.full((count, 2), math.log(0.25)))
        self.defense = nn.Linear(16, 41, bias=False) if size in [1040, 1072] else None
        self.perception = nn.Linear(32, 41, bias=False) if size == 1072 else None
        if self.perception is not None:
            nn.init.zeros_(self.perception.weight)
            if 'perceptionW' in model['weights']:
                self.perception.weight.data.copy_(torch.tensor(model['weights']['perceptionW']))
        if self.defense is not None:
            nn.init.zeros_(self.defense.weight)
            if 'defenseW' in model['weights']:
                self.defense.weight.data.copy_(torch.tensor(model['weights']['defenseW']))
        for layer, prefix in [(self.hidden, 'hidden'), (self.types, 'type'), (self.points, 'point')]:
            layer.weight.data.copy_(torch.tensor(model['weights'][prefix + 'W']))
            layer.bias.data.copy_(torch.tensor(model['weights'][prefix + 'B']))
        self.critic_hidden.load_state_dict(self.hidden.state_dict())
        nn.init.zeros_(self.direction.weight)
        nn.init.zeros_(self.direction.bias)
        nn.init.zeros_(self.order.weight)
        self.order.bias.data.copy_(torch.tensor([1., 0.]))
        if 'directionW' in model['weights']:
            self.direction.weight.data.copy_(torch.tensor(model['weights']['directionW']))
            self.direction.bias.data.copy_(torch.tensor(model['weights']['directionB']))
        if 'orderW' in model['weights']:
            self.order.weight.data.copy_(torch.tensor(model['weights']['orderW']))
            self.order.bias.data.copy_(torch.tensor(model['weights']['orderB']))
        nn.init.zeros_(self.value.weight)
        nn.init.zeros_(self.value.bias)
        resume = model.get('reinforcementLearning', {})
        self.temperature = resume.get('temperature', 1.)
        if 'valueW' in resume:
            self.value.weight.data.copy_(torch.tensor(resume['valueW']))
            self.value.bias.data.copy_(torch.tensor(resume['valueB']))
            self.log_std.data.copy_(torch.tensor(resume['logStd']))
        if 'valueHiddenW' in resume:
            self.critic_hidden.weight.data.copy_(torch.tensor(resume['valueHiddenW']))
            self.critic_hidden.bias.data.copy_(torch.tensor(resume['valueHiddenB']))
        if model.get('defenseAdapter') == 'frozen-base/1':
            for layer in [self.hidden, self.types, self.points, self.direction, self.order]:
                for parameter in layer.parameters():
                    parameter.requires_grad_(False)
        if model.get('perceptionAdapter') == 'frozen-base/1':
            for layer in [self.hidden, self.types, self.points, self.direction, self.order, self.defense]:
                if layer is not None:
                    for parameter in layer.parameters():
                        parameter.requires_grad_(False)
        self.register_buffer('direction_vectors', torch.tensor([[0, 0], [1, 0], [2 ** -.5, 2 ** -.5], [0, 1], [-2 ** -.5, 2 ** -.5], [-1, 0], [-2 ** -.5, -2 ** -.5], [0, -1], [2 ** -.5, -2 ** -.5]], dtype=torch.float32))

    def forward(self, x):
        hidden = torch.tanh(self.hidden(x))
        extra = self.defense(x[:, 1024:1040]) if self.defense is not None else x.new_zeros((len(x), 41))
        if self.perception is not None:
            extra = extra + self.perception(x[:, 1040:1072])
        points = (self.points(hidden) + extra[:, 10:30]).reshape(-1, self.log_std.shape[0], 2)
        directions = (self.direction(hidden) + extra[:, 30:39] + 1.5 * torch.tanh(points[:, 1]) @ self.direction_vectors.T) / self.temperature
        value = self.value(torch.tanh(self.critic_hidden(x))).flatten()
        return (self.types(hidden) + extra[:, :10]) / self.temperature, points, value, directions, (self.order(hidden) + extra[:, 39:41]) / self.temperature

    def distribution(self, x, mask):
        logits, means, values, directions, orders = self(x)
        return Categorical(logits=logits.masked_fill(~mask, -1e9)), means, values, Categorical(logits=directions), Categorical(logits=orders)

    def sample(self, x, mask, coordinates):
        categorical, means, value, steering, orders = self.distribution(x, mask)
        types = categorical.sample()
        index = torch.arange(len(x))
        normal = Normal(means[index, types], self.log_std.exp()[types])
        latent = normal.sample()
        direction = steering.sample()
        cancel_order = orders.sample()
        point = coordinates[index, types]
        # The environment receives latent coordinates and applies tanh itself.
        # PPO therefore scores the unsquashed latent action without a Jacobian.
        order_used = (types == 1) & (direction != 0)
        log_prob = categorical.log_prob(types) + normal.log_prob(latent).sum(-1) * point + steering.log_prob(direction) * (types == 1) + orders.log_prob(cancel_order) * order_used
        return types, latent, direction, cancel_order, log_prob, value

    def score(self, x, mask, coordinates, types, latent, direction, cancel_order):
        categorical, means, values, steering, orders = self.distribution(x, mask)
        index = torch.arange(len(x))
        normal = Normal(means[index, types], self.log_std.exp()[types])
        point = coordinates[index, types]
        order_used = (types == 1) & (direction != 0)
        log_prob = categorical.log_prob(types) + normal.log_prob(latent).sum(-1) * point + steering.log_prob(direction) * (types == 1) + orders.log_prob(cancel_order) * order_used
        entropy = categorical.entropy() + normal.entropy().sum(-1) * point + steering.entropy() * (types == 1) + orders.entropy() * order_used
        return log_prob, entropy, values, categorical, means, steering, orders


class Engine:
    def __init__(self, node):
        self.process = subprocess.Popen([node, str(Path(__file__).with_name('minion-rl-env.js'))],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8')

    def call(self, request):
        self.process.stdin.write(json.dumps(request, separators=(',', ':')) + '\n')
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError('Game engine stopped unexpectedly')
        result = json.loads(line)
        if 'error' in result:
            raise RuntimeError(result['error'])
        return result

    def close(self):
        if self.process.poll() is None:
            try:
                self.call({'op': 'close'})
            except (OSError, RuntimeError):
                pass
            finally:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=5)
        for stream in [self.process.stdin, self.process.stdout]:
            if stream:
                stream.close()


def tensors(observations):
    return (torch.tensor(np.asarray([o['x'] for o in observations], dtype=np.float32)),
            torch.tensor([o['mask'] for o in observations], dtype=torch.bool),
            torch.tensor([o['coordinates'] for o in observations], dtype=torch.float32))


def advantages(rewards, values, next_values, terminal, done, gamma, lam):
    result = torch.zeros_like(rewards)
    carry = torch.zeros(rewards.shape[1])
    for step in reversed(range(len(rewards))):
        delta = rewards[step] + gamma * next_values[step] * (1 - terminal[step]) - values[step]
        carry = delta + gamma * lam * (1 - done[step]) * carry
        result[step] = carry
    return result, result + values


def summarize(evaluation):
    episodes = evaluation['episodes']
    retreat = [e for e in episodes if e['scenario'].startswith('retreat')]
    matches = [e for e in episodes if e['scenario'] == 'match']
    defense = [e for e in episodes if e['scenario'] == 'defense']
    return {'episodes': len(episodes), 'meanReturn': sum(e['return'] for e in episodes) / max(1, len(episodes)),
            'bushAttempts': sum(e['scenario'] in ['bush-entry', 'bush-attack'] for e in episodes),
            'bushHitEpisodes': sum(e['scenario'] in ['bush-entry', 'bush-attack'] and e.get('damageDealt', 0) > 0 for e in episodes),
            'bushFalseVisits': sum(e['scenario'] == 'bush-empty' and e.get('bushInvestigated', False) for e in episodes),
            'wins': sum(e['winner'] == 1 for e in episodes), 'losses': sum(e['winner'] == 0 for e in episodes),
            'timeouts': sum(e['truncated'] for e in episodes), 'deaths': sum(e['deaths'] for e in episodes),
            'retreatAttempts': len(retreat), 'retreatRecoveries': sum(e['recovery'] for e in retreat),
            'defenseAttempts': len(defense), 'defenseStops': sum(e.get('defenseStopped', False) for e in defense),
            'defenseTowerDamage': sum(e.get('ownTowerDamage', 0) for e in defense) / max(1, len(defense)),
            'defenseInterventions': sum(e.get('defenseDamage', 0) >= 20 for e in defense),
            'lowHpChaseCommands': sum(e.get('lowHpChaseCommands', 0) for e in episodes),
            'lowHpStepsTowardHome': sum(e.get('lowHpStepsTowardHome', 0) for e in episodes),
            'lowHpStepsAwayFromHome': sum(e.get('lowHpStepsAwayFromHome', 0) for e in episodes),
            'normalMatchEnergy': sum(e.get('energy', 0) for e in matches) / max(1, len(matches)),
            'attackAttempts': sum(e.get('attackAttempts', 0) for e in episodes),
            'emptyAttacks': sum(e.get('emptyAttacks', 0) for e in episodes),
            'rejectedAttacks': sum(e.get('rejectedAttacks', 0) for e in episodes),
            'meanEnergy': sum(e.get('energy', 0) for e in episodes) / max(1, len(episodes))}


def selection_score(stats, baseline=None):
    farm = min(2., stats.get('normalMatchEnergy', 0) / max(1., (baseline or stats).get('normalMatchEnergy', 0)))
    waste = (stats.get('emptyAttacks', 0) + stats.get('rejectedAttacks', 0)) / max(1, stats.get('attackAttempts', 0))
    defend = stats.get('defenseStops', 0) / max(1, stats.get('defenseAttempts', 0))
    return (stats['wins'] - stats['losses'], stats['retreatRecoveries'] / max(1, stats['retreatAttempts']) + defend + .5 * farm - .1 * waste,
            -stats['deaths'] / max(1, stats['episodes']), stats['meanReturn'])


def eligible_for_selection(stats, baseline):
    recovery = stats.get('retreatRecoveries', 0) / max(1, stats.get('retreatAttempts', 0))
    baseline_recovery = baseline.get('retreatRecoveries', 0) / max(1, baseline.get('retreatAttempts', 0))
    return (stats['normalMatchEnergy'] >= baseline['normalMatchEnergy'] * .85 and recovery >= baseline_recovery - .125) or stats['wins'] > baseline['wins']


def survival_selection_score(stats):
    return (stats['retreatRecoveries'] / max(1, stats['retreatAttempts']),
            -stats['deaths'] / max(1, stats['episodes']), stats['wins'] - stats['losses'],
            stats['normalMatchEnergy'], stats['defenseStops'], stats['meanReturn'])


def upgrade_features(model):
    previous = model.get('featureVersion')
    if previous == 'minion-bush-memory/10':
        return
    if previous in ['minion-defense-adapter/5', 'minion-defense-alarm/6']:
        model['featureVersion'] = 'minion-defense-alarm/6'
        return
    if previous == 'minion-tactical/4':
        raise ValueError('Start the defense adapter from a v3 farming model or an existing v5 adapter')
    for row in model['weights']['hiddenW']:
        if previous not in ['minion-tactical/3']:
            row[-48:-32] = [0.] * 16
        if previous not in ['minion-tactical/2', 'minion-tactical/3']:
            row[-32:] = [0.] * 32
        row.extend([0.] * 16)
    for row in model.get('reinforcementLearning', {}).get('valueHiddenW', []):
        row.extend([0.] * 16)
    model['inputSize'] = 1040
    model['featureVersion'] = 'minion-defense-alarm/6'
    model['defenseAdapter'] = 'frozen-base/1'


def upgrade_perception(model):
    upgrade_features(model)
    if model.get('featureVersion') == 'minion-bush-memory/10':
        return
    for row in model['weights']['hiddenW']:
        row.extend([0.] * 32)
    for row in model.get('reinforcementLearning', {}).get('valueHiddenW', []):
        row.extend([0.] * 32)
    model['inputSize'] = 1072
    model['featureVersion'] = 'minion-bush-memory/10'


def defense_lesson_loss(categorical, means, lesson, mask):
    active = lesson[:, 0] * mask[:, 3].float()
    return ((-categorical.log_prob(torch.full_like(active, 3, dtype=torch.long))
             + 10 * (torch.tanh(means[:, 3]) - lesson[:, 1:]).square().mean(dim=1)) * active).mean()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--node', required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--reference-model', type=Path)
    parser.add_argument('--train-base', action='store_true')
    parser.add_argument('--pure-rl', action='store_true', help='Train the whole actor without runtime tactical overrides or supervised defense lessons')
    parser.add_argument('--bush-memory', action='store_true')
    parser.add_argument('--perception-adapter', action='store_true')
    parser.add_argument('--bush-fraction', type=float, default=0.)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--updates', type=int, default=100)
    parser.add_argument('--steps', type=int, default=128)
    parser.add_argument('--envs', type=int, default=4)
    parser.add_argument('--max-seconds', type=float, default=120)
    parser.add_argument('--retreat-fraction', type=float, default=0.25)
    parser.add_argument('--farm-fraction', type=float, default=0.2)
    parser.add_argument('--defense-fraction', type=float, default=0.3)
    parser.add_argument('--eval-episodes', type=int, default=16)
    parser.add_argument('--eval-seconds', type=float, default=60)
    parser.add_argument('--eval-every', type=int, default=25)
    parser.add_argument('--seed', type=int, default=17)
    args = parser.parse_args()
    if args.bush_memory:
        args.pure_rl = True
    if args.perception_adapter and not args.bush_memory:
        raise ValueError('--perception-adapter requires --bush-memory')
    if not 0 <= args.bush_fraction <= 1 or args.retreat_fraction + args.farm_fraction + args.defense_fraction + args.bush_fraction > 1:
        raise ValueError('Scenario fractions must total at most 1')
    if not (1 <= args.updates <= 100000 and 8 <= args.steps <= 2048 and 1 <= args.envs <= 32 and 1 <= args.max_seconds <= 1200 and 0 <= args.retreat_fraction <= 1 and 0 <= args.farm_fraction <= 1 and 0 <= args.defense_fraction <= 1 and args.retreat_fraction + args.farm_fraction + args.defense_fraction <= 1 and 2 <= args.eval_episodes <= 100 and 1 <= args.eval_seconds <= 1200 and args.eval_every >= 1):
        raise ValueError('Invalid RL training parameters')
    args.output.mkdir(parents=True, exist_ok=True)
    if args.model.parent.resolve() == args.output.resolve():
        raise ValueError('Use a separate output directory to preserve the input checkpoint')
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(min(4, torch.get_num_threads()))
    base_bytes = args.model.read_bytes()
    base = json.loads(base_bytes.decode('utf-8-sig'))
    initial_snapshot = args.output / 'initial-model.json'
    initial_snapshot.write_text(json.dumps(base, ensure_ascii=False), encoding='utf-8')
    # Keep existing models unchanged. New RL models reserve explicit tactical inputs
    # and get a categorical steering head that can explore the opposite direction.
    base = copy.deepcopy(base)
    upgrade_features(base)
    if args.bush_memory:
        upgrade_perception(base)
    if args.perception_adapter:
        base['perceptionAdapter'] = 'frozen-base/1'
    if args.train_base or args.pure_rl:
        base['defenseAdapter'] = 'trainable-base/1'
    if args.pure_rl:
        base['decisionMode'] = 'learned/1'
        base.pop('objectivePolicy', None)
        base['modelName'] = 'ミニオン v1（v9 PPO）'
        if args.bush_memory:
            base['modelName'] = 'ミニオン v1（v10 ブッシュ認識 PPO）'
    base.setdefault('reinforcementLearning', {})['temperature'] = 1.
    base['movementOrder'] = 'learned-chase-order/1'
    base['controlProtocol'] = 'release-before-chase/1'
    base['aimProtocol'] = 'release-invalid-leap/1'
    warm_start = args.output / 'warm-start-model.json'
    actor = ActorCritic(base)
    initial_actor_state = {key: value.clone() for key, value in actor.state_dict().items()}
    reference_bytes = args.reference_model.read_bytes() if args.reference_model else base_bytes
    reference_model = json.loads(reference_bytes.decode('utf-8-sig'))
    if not set(base['characters']).issubset(reference_model['characters']):
        raise ValueError('Reference model must support every training character')
    upgrade_features(reference_model)
    if args.bush_memory:
        upgrade_perception(reference_model)
    reference_model.setdefault('reinforcementLearning', {})['temperature'] = actor.temperature
    reference = ActorCritic(reference_model).eval()
    if reference.hidden.weight.shape != actor.hidden.weight.shape:
        raise ValueError('Reference model architecture does not match the input model')
    reference_snapshot = args.output / 'imitation-reference.json'
    reference_snapshot.write_bytes(reference_bytes)
    for p in reference.parameters():
        p.requires_grad_(False)
    adapter_parameters = list(actor.defense.parameters()) if actor.defense is not None else []
    if actor.perception is not None:
        adapter_parameters += list(actor.perception.parameters())
    adapter_ids = {id(p) for p in adapter_parameters}
    optimizer = torch.optim.Adam([{'params': [p for p in actor.parameters() if id(p) not in adapter_ids], 'lr': .0003 if args.pure_rl else .0001},
                                  {'params': adapter_parameters, 'lr': .001}])
    gamma, lam = .997, .99
    engine = Engine(args.node)
    start = time.monotonic()
    report = {'algorithm': 'PPO', 'initialModel': str(args.model), 'initialSnapshot': str(initial_snapshot), 'initialSha256': hashlib.sha256(base_bytes).hexdigest(),
              'seed': args.seed, 'gamma': gamma, 'gaeLambda': lam, 'clip': .2, 'updates': args.updates,
              'referenceModel': str(args.reference_model or args.model), 'referenceSha256': hashlib.sha256(reference_bytes).hexdigest(),
              'envs': args.envs, 'stepsPerUpdate': args.steps, 'maxSeconds': args.max_seconds, 'retreatFraction': args.retreat_fraction, 'farmFraction': args.farm_fraction, 'defenseFraction': args.defense_fraction,
              'temperature': actor.temperature, 'evaluationProtocol': 'balanced-tactics/4', 'referenceKlWeight': .02, 'healthyReferenceKlExtra': .2, 'learningRate': .0001,
              'defenseLesson': 'training-only visible-attacker chase demonstrations in defense resets',
              'evalEvery': args.eval_every, 'selectionHistory': [], 'history': [], 'episodes': [],
              'limitations': ['short runs do not establish improvement', 'the reference algorithm opponent is not a human',
                              'truncated games are timeouts, not wins', 'checkpoint resume resets the optimizer',
                              'coordinate exploration is used for training; deployment uses predicted mean coordinates']}
    if args.pure_rl:
        report.update({'decisionMode': 'learned/1', 'rewardProfile': 'survival/1', 'defenseLesson': None,
                       'learningRate': .0003, 'runtimeOverrides': False, 'selectionPriority': 'recovery, survival, wins, farming',
                       'referenceKlWeight': .005, 'healthyReferenceKlExtra': .25, 'trainingResetProfile': 'retreat-persistent-orders/1'})
    if args.bush_memory:
        report.update({'perceptionVersion': 'minion-bush-memory/10', 'bushFraction': args.bush_fraction})
    if args.perception_adapter:
        report['policyTraining'] = 'PPO bush-observation residual; previously PPO-trained base frozen; no runtime action override'
    def save_model():
        model = copy.deepcopy(base)
        model.pop('selection', None)
        model['init'] = initialized['init']
        model['reinforcementLearning'] = {k: v for k, v in report.items() if k not in ['history', 'episodes', 'before', 'after', 'warmStart', 'latestAfter', 'selectionHistory', 'selectedCheckpoint']}
        model['reinforcementLearning']['completedUpdates'] = len(report['history'])
        model['reinforcementLearning'].update({'valueW': actor.value.weight.detach().tolist(), 'valueB': actor.value.bias.detach().tolist(),
                                             'valueHiddenW': actor.critic_hidden.weight.detach().tolist(), 'valueHiddenB': actor.critic_hidden.bias.detach().tolist(),
                                             'logStd': actor.log_std.detach().tolist()})
        for layer, prefix in [(actor.hidden, 'hidden'), (actor.types, 'type'), (actor.points, 'point'), (actor.direction, 'direction'), (actor.order, 'order')]:
            model['weights'][prefix + 'W'] = layer.weight.detach().tolist()
            model['weights'][prefix + 'B'] = layer.bias.detach().tolist()
        if actor.defense is not None:
            model['weights']['defenseW'] = actor.defense.weight.detach().tolist()
        if actor.perception is not None:
            model['weights']['perceptionW'] = actor.perception.weight.detach().tolist()
        checkpoint = args.output / 'latest-model.json'
        temporary = args.output / 'model.tmp'
        temporary.write_text(json.dumps(model, ensure_ascii=False), encoding='utf-8')
        temporary.replace(checkpoint)
        return checkpoint

    selected_score = None
    validation_baseline = None
    def consider(checkpoint, tag):
        nonlocal selected_score, validation_baseline
        measured = engine.call({'op': 'evaluate', 'model': str(checkpoint.resolve()), 'options': selection_options})
        stats = summarize(measured)
        if validation_baseline is None:
            validation_baseline = stats
        score = ((stats['bushHitEpisodes'] / max(1, stats['bushAttempts']), -stats['bushFalseVisits']) + survival_selection_score(stats)) if args.bush_memory else survival_selection_score(stats) if args.pure_rl else selection_score(stats, validation_baseline)
        eligible = eligible_for_selection(stats, validation_baseline)
        accepted = eligible and (selected_score is None or score > selected_score)
        report['selectionHistory'].append({'tag': tag, 'summary': stats, 'score': list(score), 'eligible': eligible, 'accepted': accepted})
        if accepted:
            selected_score = score
            report['selectedCheckpoint'] = tag
            temporary = args.output / 'selected.tmp'
            selected = json.loads(checkpoint.read_text(encoding='utf-8'))
            selected['selection'] = {'tag': tag, 'validationSummary': stats}
            temporary.write_text(json.dumps(selected, ensure_ascii=False), encoding='utf-8')
            temporary.replace(args.output / 'model.json')
        print(json.dumps({'selection': tag, 'accepted': accepted, 'summary': stats}), flush=True)

    try:
        warm = copy.deepcopy(base)
        warm['weights']['directionW'] = actor.direction.weight.detach().tolist()
        warm['weights']['directionB'] = actor.direction.bias.detach().tolist()
        warm['weights']['orderW'] = actor.order.weight.detach().tolist()
        warm['weights']['orderB'] = actor.order.bias.detach().tolist()
        warm_start.write_text(json.dumps(warm, ensure_ascii=False), encoding='utf-8')
        initialized = engine.call({'op': 'init', 'model': str(warm_start.resolve()), 'envs': args.envs,
                                   'options': {'gamma': gamma, 'maxSeconds': args.max_seconds, 'retreatFraction': args.retreat_fraction, 'farmFraction': args.farm_fraction, 'defenseFraction': args.defense_fraction, 'bushFraction': args.bush_fraction, 'seed': args.seed, 'rewardProfile': 'survival/1' if args.pure_rl else None}})
        report['rewardConfig'] = initialized['rewards']
        report['potentialConfig'] = initialized['shaping']
        evaluation_options = {'episodes': args.eval_episodes, 'maxSeconds': args.eval_seconds, 'seed': args.seed + 100000, 'gamma': gamma, 'characters': base['characters'], 'rewardProfile': 'survival/1' if args.pure_rl else None}
        if args.bush_memory:
            evaluation_options['scenarios'] = ['match', 'farm', 'retreat', 'defense', 'bush-entry', 'bush-attack', 'bush-empty', 'bush-exit']
        selection_options = {**evaluation_options, 'seed': args.seed + 200000}
        report['before'] = engine.call({'op': 'evaluate', 'model': str(initial_snapshot.resolve()), 'options': evaluation_options})
        print(json.dumps({'before': summarize(report['before'])}), flush=True)
        report['warmStart'] = engine.call({'op': 'evaluate', 'model': str(warm_start.resolve()), 'options': evaluation_options})
        print(json.dumps({'warmStart': summarize(report['warmStart'])}), flush=True)
        if not args.pure_rl:
            consider(initial_snapshot, 'initial')
            consider(reference_snapshot, 'imitation-reference')
        consider(warm_start, 'warm-start')
        observations = initialized['observations']
        for update in range(args.updates):
            rollout = {key: [] for key in ['x', 'mask', 'coordinates', 'lesson', 'types', 'latent', 'direction', 'cancelOrder', 'oldLogProb', 'value', 'nextValue', 'reward', 'terminal', 'done']}
            for step in range(args.steps):
                x, mask, coordinates = tensors(observations)
                with torch.no_grad():
                    types, latent, direction, cancel_order, log_prob, value = actor.sample(x, mask, coordinates)
                response = engine.call({'op': 'step', 'actions': [{'type': int(t), 'latent': z, 'direction': int(d), 'cancelOrder': int(c)} for t, z, d, c in zip(types.tolist(), latent.tolist(), direction.tolist(), cancel_order.tolist())]})
                results = response['results']
                boot_x, _, _ = tensors([r['bootstrap'] for r in results])
                with torch.no_grad():
                    _, _, next_value, _, _ = actor(boot_x)
                entries = {'x': x, 'mask': mask, 'coordinates': coordinates, 'lesson': torch.tensor([o['lesson'] for o in observations]), 'types': types, 'latent': latent, 'direction': direction, 'cancelOrder': cancel_order, 'oldLogProb': log_prob,
                           'value': value, 'nextValue': next_value, 'reward': torch.tensor([r['reward'] for r in results]),
                           'terminal': torch.tensor([float(r['terminal']) for r in results]),
                           'done': torch.tensor([float(r['terminal'] or r['truncated']) for r in results])}
                for key, v in entries.items():
                    rollout[key].append(v)
                for result in results:
                    if 'episode' in result:
                        report['episodes'].append(result['episode'])
                observations = [r['observation'] for r in results]
            stacked = {key: torch.stack(v) for key, v in rollout.items()}
            advantage, returns = advantages(stacked['reward'], stacked['value'], stacked['nextValue'], stacked['terminal'], stacked['done'], gamma, lam)
            advantage = advantage.flatten()
            advantage = (advantage - advantage.mean()) / (advantage.std(unbiased=False) + 1e-8)
            returns = returns.flatten()
            batch = {key: v.flatten(0, 1) for key, v in stacked.items()}
            losses = []
            for epoch in range(4):
                for indices in torch.randperm(len(advantage)).split(128):
                    score, entropy, value, categorical, means, steering, orders = actor.score(batch['x'][indices], batch['mask'][indices], batch['coordinates'][indices], batch['types'][indices], batch['latent'][indices], batch['direction'][indices], batch['cancelOrder'][indices])
                    ratio = (score - batch['oldLogProb'][indices]).exp()
                    policy_loss = -torch.minimum(ratio * advantage[indices], ratio.clamp(.8, 1.2) * advantage[indices]).mean()
                    value_loss = nn.functional.smooth_l1_loss(value, returns[indices])
                    with torch.no_grad():
                        reference_cat, reference_means, _, reference_steering, reference_orders = reference.distribution(batch['x'][indices], batch['mask'][indices])
                    anchor = kl_divergence(reference_cat, categorical) + .1 * (means - reference_means).square().mean(dim=(1, 2)) + .1 * kl_divergence(reference_steering, steering) + .1 * kl_divergence(reference_orders, orders)
                    hp = batch['x'][indices, 992].clamp(0, 1)
                    threat = batch['x'][indices, 1024].clamp(0, 1)
                    anchor_weight = (.005 + .25 * hp.square()) if args.pure_rl else (.02 + .2 * hp.square()) * (1 - .9 * threat)
                    lesson = batch['lesson'][indices]
                    lesson_loss = categorical.logits.sum() * 0 if args.pure_rl else defense_lesson_loss(categorical, means, lesson, batch['mask'][indices])
                    loss = policy_loss + .5 * value_loss - .005 * entropy.mean() + (anchor_weight * anchor).mean() + lesson_loss
                    if not torch.isfinite(loss):
                        raise RuntimeError('Non-finite PPO loss')
                    optimizer.zero_grad()
                    loss.backward()
                    nn.utils.clip_grad_norm_(actor.parameters(), .5)
                    optimizer.step()
                    actor.log_std.data.clamp_(math.log(.05), math.log(.6))
                    losses.append(float(loss.detach()))
            stats = {'update': update + 1, 'environmentSteps': (update + 1) * args.steps * args.envs,
                     'meanStepReward': float(stacked['reward'].mean()), 'loss': sum(losses) / len(losses),
                     'completedEpisodes': len(report['episodes']), 'elapsedSeconds': time.monotonic() - start}
            report['history'].append(stats)
            checkpoint = save_model()
            if (update + 1) % args.eval_every == 0 or update == args.updates - 1:
                consider(checkpoint, 'update-' + str(update + 1))
            (args.output / 'rl-training.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
            print(json.dumps(stats), flush=True)
        checkpoint = save_model()
        selected_checkpoint = args.output / 'model.json'
        report['after'] = engine.call({'op': 'evaluate', 'model': str(selected_checkpoint.resolve()), 'options': evaluation_options})
        report['latestAfter'] = engine.call({'op': 'evaluate', 'model': str(checkpoint.resolve()), 'options': evaluation_options})
        report['beforeSummary'] = summarize(report['before'])
        report['warmStartSummary'] = summarize(report['warmStart'])
        report['afterSummary'] = summarize(report['after'])
        report['latestSummary'] = summarize(report['latestAfter'])
        report['elapsedSeconds'] = time.monotonic() - start
        report['actorWeightChangeL1'] = sum((actor.state_dict()[key] - initial_actor_state[key]).abs().sum().item()
                                          for key in actor.state_dict() if not key.startswith(('value.', 'critic_hidden.')) and key not in ['log_std', 'direction_vectors'])
        if not math.isfinite(report['actorWeightChangeL1']) or report['actorWeightChangeL1'] <= 0:
            raise RuntimeError('Actor parameters did not update')
        save_model()
        # Common inference parity format used by the existing smoke command.
        probe_x, _, _ = tensors(observations[:1])
        with torch.no_grad():
            selected_model = json.loads(selected_checkpoint.read_text(encoding='utf-8'))
            selected_actor = ActorCritic(selected_model)
            probe_x = probe_x[:, :selected_model['inputSize']]
            logits, points, _, directions, orders = selected_actor(probe_x)
        parity = {'x': probe_x[0].tolist(), 'logits': (logits[0] * selected_actor.temperature).tolist(), 'points': torch.tanh(points[0]).flatten().tolist()}
        if 'directionW' in selected_model['weights']:
            parity['directions'] = (directions[0] * selected_actor.temperature).tolist()
        if 'orderW' in selected_model['weights']:
            parity['orders'] = (orders[0] * selected_actor.temperature).tolist()
        (args.output / 'parity.json').write_text(json.dumps(parity), encoding='utf-8')
        (args.output / 'rl-training.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps({'model': str(selected_checkpoint), 'latestModel': str(checkpoint), 'selectedCheckpoint': report['selectedCheckpoint'],
                          'before': report['beforeSummary'], 'warmStart': report['warmStartSummary'], 'after': report['afterSummary'], 'latest': report['latestSummary'],
                          'actorWeightChangeL1': report['actorWeightChangeL1']}), flush=True)
    finally:
        engine.close()


if __name__ == '__main__':
    main()

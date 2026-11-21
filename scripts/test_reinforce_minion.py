import unittest
import importlib.util
from pathlib import Path

import torch

spec = importlib.util.spec_from_file_location('reinforce_minion', Path(__file__).with_name('reinforce-minion.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
advantages = module.advantages


class AdvantageTests(unittest.TestCase):
    def test_timeout_bootstraps_but_does_not_carry_next_episode(self):
        rewards = torch.tensor([[1.], [10.]])
        value = torch.zeros_like(rewards)
        next_value = torch.tensor([[5.], [6.]])
        terminal = torch.tensor([[0.], [1.]])
        done = torch.ones_like(rewards)
        advantage, returns = advantages(rewards, value, next_value, terminal, done, .9, 1.)
        torch.testing.assert_close(advantage, torch.tensor([[5.5], [10.]]))
        torch.testing.assert_close(returns, advantage)

    def test_continuing_trajectory_carries_discounted_future_advantage(self):
        reward = torch.tensor([[1.], [2.]])
        zeros = torch.zeros_like(reward)
        terminal = torch.tensor([[0.], [1.]])
        advantage, _ = advantages(reward, zeros, zeros, terminal, terminal, .9, 1.)
        torch.testing.assert_close(advantage, torch.tensor([[2.8], [2.]]))


class SteeringTests(unittest.TestCase):
    def test_bush_adapter_updates_only_its_learned_residual_and_preserves_no_evidence_outputs(self):
        model = self.model(); model['inputSize'] = 1040; model['featureVersion'] = 'minion-defense-alarm/6'
        model['weights']['hiddenW'] = [[0.] * 1040 for _ in range(2)]
        module.upgrade_perception(model); model['perceptionAdapter'] = 'frozen-base/1'
        actor = module.ActorCritic(model)
        x = torch.zeros(2, 1072); base = actor(x)[0].detach().clone(); x[:, 1040] = 1
        actor(x)[0].sum().backward()
        self.assertIsNone(actor.hidden.weight.grad)
        self.assertIsNone(actor.defense.weight.grad)
        self.assertGreater(float(actor.perception.weight.grad.abs().sum()), 0.)
        with torch.no_grad():
            actor.perception.weight.add_(1)
        torch.testing.assert_close(actor(torch.zeros(2, 1072))[0], base)

    def test_perception_upgrade_preserves_base_and_is_trainable_and_idempotent(self):
        model = self.model()
        model['inputSize'] = 1040
        model['featureVersion'] = 'minion-defense-alarm/6'
        model['weights']['hiddenW'] = [[1.] * 1040 for _ in range(2)]
        model['weights']['typeW'][0] = [1., 1.]
        module.upgrade_perception(model)
        self.assertEqual(model['inputSize'], 1072)
        self.assertEqual(model['weights']['hiddenW'][0][:1040], [1.] * 1040)
        self.assertEqual(model['weights']['hiddenW'][0][1040:], [0.] * 32)
        module.upgrade_perception(model)
        self.assertEqual(len(model['weights']['hiddenW'][0]), 1072)
        actor = module.ActorCritic(model)
        x = torch.zeros(2, 1072); x[:, 1040:] = 1
        actor(x)[0].sum().backward()
        self.assertGreater(float(actor.hidden.weight.grad[:, 1040:].abs().sum()), 0.)

    def test_survival_selection_does_not_trade_recovery_for_farming(self):
        safe = {'retreatRecoveries': 7, 'retreatAttempts': 8, 'wins': 0, 'losses': 0,
                'deaths': 1, 'episodes': 12, 'normalMatchEnergy': 8, 'defenseStops': 1, 'meanReturn': 0}
        reckless = {**safe, 'retreatRecoveries': 1, 'deaths': 7, 'normalMatchEnergy': 100, 'meanReturn': 10}
        self.assertGreater(module.survival_selection_score(safe), module.survival_selection_score(reckless))

    def model(self):
        hidden, size, actions = 2, 32, 10
        return {'inputSize': size, 'hiddenSize': hidden, 'events': list(range(actions)), 'weights': {
            'hiddenW': [[0.] * size for _ in range(hidden)], 'hiddenB': [0.] * hidden,
            'typeW': [[0.] * hidden for _ in range(actions)], 'typeB': [0.] * actions,
            'pointW': [[0.] * hidden for _ in range(actions * 2)], 'pointB': [0.] * (actions * 2)}}

    def test_joint_steering_log_probability_matches_sampling(self):
        actor = module.ActorCritic(self.model())
        x = torch.zeros(64, 32)
        mask = torch.zeros(64, 10, dtype=torch.bool)
        mask[:, 1] = True
        coordinates = torch.zeros(64, 10)
        types, latent, direction, cancel_order, old_logp, _ = actor.sample(x, mask, coordinates)
        logp, _, _, _, _, _, _ = actor.score(x, mask, coordinates, types, latent, direction, cancel_order)
        torch.testing.assert_close(old_logp, logp)
        self.assertGreater(len(set(direction.tolist())), 3)
        self.assertTrue((types == 1).all())

    def test_critic_gradients_do_not_change_actor_backbone(self):
        actor = module.ActorCritic(self.model())
        _, _, value, _, _ = actor(torch.ones(4, 32))
        (value - 2).square().mean().backward()
        self.assertIsNone(actor.hidden.weight.grad)
        self.assertIsNotNone(actor.value.weight.grad)

    def test_selection_prioritizes_real_recovery_over_farming_return(self):
        safe = {'retreatRecoveries': 3, 'retreatAttempts': 8, 'wins': 0, 'losses': 0, 'deaths': 5, 'episodes': 12, 'meanReturn': -3}
        reckless = {**safe, 'retreatRecoveries': 1, 'deaths': 8, 'meanReturn': 10}
        self.assertGreater(module.selection_score(safe), module.selection_score(reckless))

    def test_selection_rejects_a_policy_that_stops_normal_farming(self):
        baseline = {'normalMatchEnergy': 8, 'wins': 0}
        self.assertFalse(module.eligible_for_selection({'normalMatchEnergy': 0, 'wins': 0}, baseline))
        self.assertFalse(module.eligible_for_selection({'normalMatchEnergy': 4, 'wins': 0}, baseline))
        self.assertTrue(module.eligible_for_selection({'normalMatchEnergy': 7, 'wins': 0}, baseline))

    def test_farming_improvement_cannot_erase_learned_retreat(self):
        baseline = {'normalMatchEnergy': 8, 'wins': 0, 'retreatRecoveries': 7, 'retreatAttempts': 8}
        self.assertFalse(module.eligible_for_selection({**baseline, 'normalMatchEnergy': 16, 'retreatRecoveries': 0}, baseline))

    def test_feature_upgrade_preserves_existing_tactical_weights(self):
        model = {'featureVersion': 'minion-tactical/2', 'weights': {'hiddenW': [[1.] * 1024]}}
        module.upgrade_features(model)
        self.assertEqual(model['weights']['hiddenW'][0][992:1024], [1.] * 32)
        self.assertEqual(model['weights']['hiddenW'][0][976:992], [0.] * 16)
        model['weights']['hiddenW'][0][-40] = .5
        module.upgrade_features(model)
        self.assertEqual(model['weights']['hiddenW'][0][-40], .5)

    def test_defense_lesson_does_not_demand_actions_while_locked(self):
        actor = module.ActorCritic(self.model())
        x = torch.zeros(2, 32)
        mask = torch.zeros(2, 10, dtype=torch.bool)
        mask[:, 0] = True
        categorical, means, _, _, _ = actor.distribution(x, mask)
        lesson = torch.tensor([[1., .1, .1], [0., 0., 0.]])
        loss = module.defense_lesson_loss(categorical, means, lesson, mask)
        self.assertEqual(float(loss.detach()), 0.)

    def test_adapter_upgrade_preserves_all_existing_input_weights(self):
        model = {'featureVersion': 'minion-tactical/3', 'weights': {'hiddenW': [[1.] * 1024]}}
        module.upgrade_features(model)
        self.assertEqual(model['weights']['hiddenW'][0][:1024], [1.] * 1024)
        self.assertEqual(model['weights']['hiddenW'][0][1024:], [0.] * 16)

    def test_adapter_training_keeps_existing_actor_weights_frozen(self):
        model = self.model()
        model['inputSize'] = 1040
        model['weights']['hiddenW'] = [[0.] * 1040 for _ in range(2)]
        model['weights']['typeW'][3] = [1., 1.]
        model['defenseAdapter'] = 'frozen-base/1'
        actor = module.ActorCritic(model)
        x = torch.ones(2, 1040)
        logits, _, _, _, _ = actor(x)
        logits.sum().backward()
        self.assertIsNone(actor.hidden.weight.grad)
        self.assertGreater(float(actor.defense.weight.grad.abs().sum()), 0.)
        self.assertIsNone(actor.types.weight.grad)


if __name__ == '__main__':
    unittest.main()

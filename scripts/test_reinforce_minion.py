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
        self.assertTrue(module.eligible_for_selection({'normalMatchEnergy': 4, 'wins': 0}, baseline))


if __name__ == '__main__':
    unittest.main()

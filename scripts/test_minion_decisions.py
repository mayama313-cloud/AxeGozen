import importlib.util
from pathlib import Path
import unittest
import torch

spec = importlib.util.spec_from_file_location('decisions', Path(__file__).with_name('train-minion-decisions.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CandidatePolicyTests(unittest.TestCase):
    def test_padding_is_impossible_and_single_candidate_has_no_policy_gradient(self):
        actor = module.DecisionActor()
        x, mask = module.tensors([{'decisionX': [[.2] * 64]}])
        distribution, _ = actor(x, mask)
        self.assertEqual(distribution.probs[0, 0], 1)
        self.assertEqual(float(distribution.probs[0, 1:].detach().sum()), 0)
        (-distribution.log_prob(torch.tensor([0]))).backward()
        self.assertEqual(float(actor.output.weight.grad.abs().sum()), 0)

    def test_reward_gradient_can_change_relative_choices_and_exported_score_matches(self):
        torch.manual_seed(23)
        actor = module.DecisionActor()
        x, mask = module.tensors([{'decisionX': [[0.] * 64, [1.] * 64]}])
        optimizer = torch.optim.Adam(actor.parameters(), lr=.01)
        for _ in range(5):
            distribution, _ = actor(x, mask)
            loss = -distribution.log_prob(torch.tensor([1]))
            optimizer.zero_grad(); loss.backward(); optimizer.step()
        distribution, _ = actor(x, mask)
        self.assertGreater(float(distribution.probs[0, 1].detach()), .5)
        w = actor.export()['weights']
        scores = torch.tensor(w['outputW']) @ torch.tanh(torch.tensor(w['hiddenW']) @ x[0, :2].T + torch.tensor(w['hiddenB'])[:, None]) + w['outputB']
        torch.testing.assert_close(torch.softmax(scores, 0), distribution.probs[0, :2])

    def test_invalid_candidate_count_fails_before_engine_step(self):
        for candidates in [[], [[0.] * 64] * 129]:
            with self.assertRaises(ValueError):
                module.tensors([{'decisionX': candidates}])


if __name__ == '__main__':
    unittest.main()

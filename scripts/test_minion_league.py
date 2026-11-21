import importlib.util
from pathlib import Path
import unittest
import torch
spec=importlib.util.spec_from_file_location('league',Path(__file__).with_name('train-minion-league.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class LeagueTests(unittest.TestCase):
    def model(self):
        row=[0.]*64;row[0]=1
        return {'inputSize':1072,'tacticalPolicy':{'hiddenSize':1,'weights':{'hiddenW':[row],'hiddenB':[0.],'outputW':[1.],'outputB':0.}}}

    def test_upgrade_preserves_existing_weights_and_initial_context_has_no_effect(self):
        actor=module.LeagueActor(self.model())
        self.assertEqual(float(actor.hidden.weight[:,64:].detach().abs().sum()),0)
        x=torch.ones(1,1072);choices=torch.zeros(1,128,96);choices[0,0,0]=1;mask=torch.zeros(1,128,dtype=torch.bool);mask[0,:2]=True
        d,_=actor(x,choices,mask);expected=torch.softmax(torch.tensor([torch.tanh(torch.tensor(1.)),0.]),0)
        torch.testing.assert_close(d.probs[0,:2],expected);self.assertEqual(float(d.probs[0,2:].detach().sum()),0)

    def test_reward_gradient_updates_global_context_and_export_reproduces_the_score(self):
        actor=module.LeagueActor(self.model());x=torch.ones(1,1072);c=torch.zeros(1,128,96);c[0,1,0]=1
        mask=torch.zeros(1,128,dtype=torch.bool);mask[0,:2]=True
        d,_=actor(x,c,mask);(-d.log_prob(torch.tensor([1]))).backward()
        self.assertGreater(float(actor.context.weight.grad.abs().sum()),0)
        w=actor.export()['weights'];condition=torch.tensor(w['contextW'])@x[0]
        score=torch.tensor(w['outputW'])@torch.tanh(torch.tensor(w['hiddenW'])@c[0,1]+torch.tensor(w['hiddenB'])+condition)+w['outputB']
        torch.testing.assert_close(score,actor.output(torch.tanh(actor.hidden(c[0,1])+actor.context(x)[0]))[0])

    def test_no_decided_games_is_not_reported_as_a_win(self):
        report=module.summarize([])
        self.assertEqual(report['wins'],0);self.assertIsNone(report['opponents']['algorithm']['winRateDecided'])


if __name__=='__main__':unittest.main()

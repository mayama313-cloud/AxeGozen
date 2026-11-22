import importlib.util
from pathlib import Path
import unittest
import torch
spec=importlib.util.spec_from_file_location('fitted',Path(__file__).with_name('fit-minion-lookahead.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class LookaheadTests(unittest.TestCase):
    def test_capacity_upgrade_keeps_existing_action_scores(self):
        row=[0.]*64;row[0]=1.
        model={'inputSize':1072,'tacticalPolicy':{'hiddenSize':1,'weights':{'hiddenW':[row],'hiddenB':[0.],'outputW':[1.],'outputB':0.}}}
        actor=module.league.LeagueActor(model);x=torch.randn(2,1072);choices=torch.randn(2,128,96);mask=torch.ones(2,128,dtype=torch.bool)
        before=actor(x,choices,mask)[0].logits.detach();module.expand_actor(actor,64)
        torch.testing.assert_close(actor(x,choices,mask)[0].logits,before)
        self.assertEqual(float(actor.output.weight[:,1:].detach().abs().sum()),0.)


if __name__=='__main__':unittest.main()

import importlib.util
from pathlib import Path
import unittest
import torch
spec=importlib.util.spec_from_file_location('league',Path(__file__).with_name('train-minion-league.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class LeagueTests(unittest.TestCase):
    def test_student_observations_and_protocol_survive_league_export(self):
        row=[0.]*128;row[127]=1
        model={'inputSize':1024,'tacticalPolicy':{'inputSize':128,'hiddenSize':1,'baseProposal':False,
            'featureVersion':'minion-student-state/23','camps':[{'id':'known','x':1,'z':2}],
            'weights':{'hiddenW':[row],'hiddenB':[0.],'outputW':[1.],'outputB':0.}}}
        actor=module.LeagueActor(model);export=actor.export()
        self.assertEqual(export['inputSize'],128);self.assertFalse(export['baseProposal'])
        self.assertEqual(export['camps'],model['tacticalPolicy']['camps']);self.assertEqual(export['featureVersion'],'minion-student-state/23')
        x,c,mask=module.tensors([{'x':[0.]*1024,'decisionX':[row]}])
        self.assertEqual(c.shape[-1],128);distribution,_=actor(x,c,mask)
        self.assertEqual(float(distribution.probs[0,0]),1)

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

    def test_explicit_inference_temperature_survives_additional_training_exports(self):
        model=self.model();model['tacticalPolicy']['inferenceTemperature']=.25
        self.assertEqual(module.LeagueActor(model).export()['inferenceTemperature'],.25)

    def test_plain_imitation_model_bootstraps_a_trainable_proposal_prior(self):
        model={'inputSize':1024};actor=module.LeagueActor(model)
        x=torch.ones(1,1024);c=torch.zeros(1,128,96);c[0,0,63]=1
        mask=torch.zeros(1,128,dtype=torch.bool);mask[0,:2]=True
        distribution,_=actor(x,c,mask)
        self.assertTrue(actor.bootstrap)
        self.assertGreater(float(distribution.probs[0,0].detach()),.9)
        self.assertGreater(float(distribution.probs[0,1].detach()),0)
        (-distribution.log_prob(torch.tensor([1]))).backward()
        self.assertGreater(float(actor.hidden.weight.grad.abs().sum()),0)
        optimizer=torch.optim.Adam(actor.parameters(),lr=.001);optimizer.step();optimizer.zero_grad()
        distribution,_=actor(x,c,mask)
        (-distribution.log_prob(torch.tensor([1]))).backward()
        self.assertGreater(float(actor.context.weight.grad.abs().sum()),0)
        self.assertNotIn('tacticalPolicy',model)
        self.assertEqual(actor.export()['actionProtocol'],'composed-inputs/14')
        self.assertEqual(actor.export()['inferenceTemperature'],1)


if __name__=='__main__':unittest.main()

import importlib.util
from pathlib import Path
import unittest
import torch
import tempfile
import gzip
import json

spec=importlib.util.spec_from_file_location('teacher',Path(__file__).with_name('train-minion-teacher.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class TeacherTests(unittest.TestCase):
    def test_folded_export_preserves_normalized_network_scores(self):
        for width in [96,128]:
            torch.manual_seed(3)
            network=torch.nn.Sequential(torch.nn.Linear(width,128),torch.nn.Tanh(),torch.nn.Linear(128,1))
            mean=torch.randn(width);scale=torch.rand(width)+.05;x=torch.randn(23,width)
            weights=module.folded_weights(network,mean,scale)
            actual=torch.tanh(x@torch.tensor(weights['hiddenW']).T+torch.tensor(weights['hiddenB']))@torch.tensor(weights['outputW'])+weights['outputB']
            expected=network((x-mean)/scale).flatten()
            torch.testing.assert_close(actual,expected,atol=2e-6,rtol=2e-5)

    def test_equal_width_but_different_observation_semantics_cannot_be_mixed(self):
        with tempfile.TemporaryDirectory() as folder:
            files=[]
            for version in [23,24]:
                file=Path(folder)/f'{version}.jsonl.gz';files.append(file)
                with gzip.open(file,'wt',encoding='utf8') as stream:
                    stream.write(json.dumps({'x':[[0.]*128]*2,'character':'alex','slot':0,'opponentCharacter':'mira'})+'\n')
                Path(str(file)+'.meta.json').write_text(json.dumps({'featureVersion':f'minion-student-state/{version}'}),encoding='utf8')
            with self.assertRaisesRegex(ValueError,'Mixed student observation semantics'):module.load_data(files)


if __name__=='__main__':unittest.main()

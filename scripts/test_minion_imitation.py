import importlib.util
from pathlib import Path
from collections import Counter
import unittest

spec=importlib.util.spec_from_file_location('imitation',Path(__file__).with_name('train-minion.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


def samples(episode,character,n=30):
    return [{'episodeId':episode,'character':character,'time':i} for i in range(n)]


class ImitationTests(unittest.TestCase):
    def test_rare_character_stays_in_training_and_matches_do_not_leak(self):
        rows=sum([samples('alex-'+str(i),'alex') for i in range(10)],[])+samples('mira-a','mira')+samples('mira-b','mira')+samples('only-lucia','lucia')
        train,valid,info=module.split_by_character(rows)
        self.assertEqual({rows[i]['character'] for i in train},{'alex','mira','lucia'})
        self.assertEqual({rows[i]['character'] for i in valid},{'alex','mira'})
        self.assertFalse({rows[i]['episodeId'] for i in train}&{rows[i]['episodeId'] for i in valid})
        self.assertEqual(info['charactersWithoutDiagnostic'],['lucia'])
        self.assertEqual(module.split_by_character(rows),(train,valid,info))

    def test_shared_match_with_singleton_is_protected_as_a_whole(self):
        rows=samples('shared','lucia')+samples('shared','alex')+samples('other','alex')+samples('third','alex')
        train,valid,_=module.split_by_character(rows)
        self.assertTrue(all(rows[i]['episodeId']!='shared' for i in valid))
        self.assertEqual(sum(rows[i]['episodeId']=='shared' for i in train),60)

    def test_characters_are_exactly_balanced_and_short_matches_get_equal_draws(self):
        rows=samples('long','alex',10000)+samples('short','alex',10)+samples('rare','lucia',10)
        selected=module.balanced_epoch(rows,list(range(len(rows))),17)
        counts=Counter(rows[i]['character'] for i in selected)
        self.assertEqual(counts['alex'],counts['lucia'])
        games=Counter(rows[i]['episodeId'] for i in selected)
        self.assertLess(abs(games['long']-games['short']),counts['alex']*.1)
        self.assertEqual(selected,module.balanced_epoch(rows,list(range(len(rows))),17))

    def test_single_match_diagnostic_has_time_gap_and_is_explicitly_not_independent(self):
        rows=samples('one','alex',100)
        train,valid,info=module.split_by_character(rows)
        self.assertGreater(min(rows[i]['time'] for i in valid)-max(rows[i]['time'] for i in train),3)
        self.assertIn('NOT generalization',info['kind'])

    def test_unseparable_matches_fail_instead_of_dropping_a_character(self):
        rows=samples('one','alex')+samples('two','lucia')
        with self.assertRaisesRegex(ValueError,'Not enough independent'):module.split_by_character(rows)


if __name__=='__main__':unittest.main()

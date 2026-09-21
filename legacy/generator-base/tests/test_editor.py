import copy
import unittest
from editor_server import Clip, Draft, output_document, timeline_document


class TimelineTests(unittest.TestCase):
    def test_reordered_cuts_shift_words_without_mutating_source(self):
        cue={'speech_start_ms':1000,'speech_end_ms':4000,'words':[
            {'text':'one','start_ms':1000,'end_ms':2000},
            {'text':'two','start_ms':3000,'end_ms':4000}]}
        original=copy.deepcopy(cue)
        draft=Draft(clips=[Clip(id='b',in_ms=3200,out_ms=3900),Clip(id='a',in_ms=1000,out_ms=1800)],captions=[cue])
        out=timeline_document(draft)
        self.assertEqual(out['project']['scene_duration_ms'],1500)
        self.assertEqual([(c['words'][0]['text'],c['words'][0]['start_ms'],c['words'][0]['end_ms']) for c in out['cues']], [('two',0,700),('one',700,1500)])
        self.assertEqual(cue,original)

    def test_pt_group_survives_cut_after_lead(self):
        draft=Draft(language='pt',clips=[Clip(id='a',in_ms=2000,out_ms=3000)],captions=[{
            'speech_start_ms':1000,'speech_end_ms':3000,'words':[
                {'text':'give','pt':'desistir','start_ms':1000,'end_ms':2000,'pt_group':'g1','pt_group_role':'lead'},
                {'text':'up','pt':'','start_ms':2000,'end_ms':3000,'pt_group':'g1','pt_group_role':'member'}]}])
        out=output_document(draft)
        self.assertEqual(out['cues'][0]['words'][0]['text'],'desistir')
        self.assertEqual(out['cues'][0]['words'][0]['start_ms'],0)
        self.assertEqual(out['cues'][0]['words'][0]['end_ms'],1000)

if __name__=='__main__':unittest.main()

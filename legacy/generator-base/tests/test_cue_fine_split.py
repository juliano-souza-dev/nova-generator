from app import _fine_split_word_index


WORDS = [
    {'text': 'And', 'start_ms': 1000, 'end_ms': 1200},
    {'text': 'then', 'start_ms': 1210, 'end_ms': 1500},
    {'text': 'a', 'start_ms': 1700, 'end_ms': 1800},
    {'text': 'person', 'start_ms': 1810, 'end_ms': 2200},
]


def test_marker_before_a_person_moves_phrase_to_new_cue():
    assert _fine_split_word_index(WORDS, 1600) == 2


def test_explicit_first_word_of_new_cue_is_respected():
    assert _fine_split_word_index(WORDS, 1750, 2) == 2


def test_invalid_edge_split_is_rejected():
    try:
        _fine_split_word_index(WORDS, 1000, 0)
    except ValueError:
        pass
    else:
        raise AssertionError('The first word cannot start an empty left cue')


def test_selected_pooch_stays_before_the_cut():
    phrase = [
        {'text': text, 'start_ms': index * 100, 'end_ms': (index + 1) * 100}
        for index, text in enumerate('Previously on Peter Screws the Pooch I tell you'.split())
    ]
    assert _fine_split_word_index(phrase, 600, 6) == 6
    assert ' '.join(word['text'] for word in phrase[:6]) == 'Previously on Peter Screws the Pooch'

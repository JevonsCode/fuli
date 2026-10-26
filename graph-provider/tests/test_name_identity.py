"""G5-2: one identity normalization, idempotent and never merging different meanings.

Property-style: a seeded generator mixes ASCII, CJK, full-width forms, combining
marks, emoji with ZWJ, non-BMP ideographs and every kind of line break, so the
same inputs run on every machine. Synthetic strings only.
"""
import random
import unicodedata

import pytest

from fuli_graph.name_identity import display_name, identity_key

ALPHABET = (
    'abcXYZ019 -_.+#'            # ASCII, including punctuation that carries meaning
    '户外学习野外教学自然笔记表达简洁不提供解释學习'  # CJK, simplified and traditional
    'ＡＢＣ１２３　'               # full-width letters, digits and ideographic space
    'ééïß'                 # precomposed and combining accents, sharp s
    '😀😃👨‍👩‍👧'      # emoji and a ZWJ family sequence
    '𠀀𠀁𪚥'                      # non-BMP ideographs
    '\t\n\r  ﻿​'  # tabs, line breaks, no-break space, BOM, ZWSP
)


def samples(count=2000, seed=20261020):
    generator = random.Random(seed)
    for _ in range(count):
        yield ''.join(generator.choice(ALPHABET) for _ in range(generator.randint(1, 24)))


def test_normalizing_twice_never_changes_the_key():
    for value in samples():
        key = identity_key(value)
        assert identity_key(key) == key, repr(value)
        assert identity_key(display_name(value)) == key, repr(value)
        assert display_name(display_name(value)) == display_name(value), repr(value)


@pytest.mark.parametrize('variants', [
    ['户外学习', ' 户外学习 ', '户外学习\n', '﻿户外学习'],
    ['户外 学习', '户外\r\n学习', '户外\t\t学习', '户外　学习', '户外 学习', ' 户外 \n 学习 '],
    ['UI design', 'ui DESIGN', 'ＵＩ　ｄｅｓｉｇｎ', 'UI design'],
    ['café', 'café', 'CAFÉ'],
])
def test_spacing_line_breaks_case_and_compatibility_forms_name_one_identity(variants):
    assert len({identity_key(value) for value in variants}) == 1, variants


@pytest.mark.parametrize('different', [
    ['表达简洁', '不提供解释', '简洁表达'],
    ['学习', '學习'],                     # simplified and traditional stay apart
    ['C', 'C++', 'C#', 'c-sharp'],        # punctuation is meaning, not noise
    ['Maße', 'Masse'],                     # no aggressive case folding of ß
    ['naive', 'naïve'],                    # accents are kept
    ['𠀀笔记', '𠀁笔记', '笔记'],           # non-BMP ideographs survive
    ['😀', '😃', '👨‍👩‍👧', '👨👩👧'],  # a ZWJ sequence is not its parts
    ['户外学习', '户外 学习'],              # a space inside a name is kept
])
def test_legitimately_different_names_never_collide(different):
    assert len({identity_key(value) for value in different}) == len(different), different


def test_distinct_ideograph_strings_keep_distinct_keys():
    generator = random.Random(7)
    pool = '户外学习野外教学自然笔记表达简洁不提供解释陶瓷釉色实验𠀀𠀁𪚥0123456789'
    seen = {}
    for _ in range(3000):
        value = ''.join(generator.choice(pool) for _ in range(generator.randint(1, 6)))
        key = identity_key(value)
        assert seen.setdefault(key, value) == value, (seen[key], value)


def test_non_bmp_characters_are_kept_whole():
    key = identity_key(' 𠀀\n笔记 ')
    assert key == '𠀀 笔记'
    assert [unicodedata.name(character, '?') for character in key][0].startswith('CJK UNIFIED IDEOGRAPH-20000')


def test_display_name_keeps_the_writers_characters():
    assert display_name('  ＵＩ\n 设计 ') == 'ＵＩ 设计'
    assert display_name('café') == 'café'


def test_shared_vectors_match_the_node_rule():
    # The same pairs test src/text/name-identity.js, so the two rules cannot drift apart.
    import json
    from pathlib import Path

    fixture = Path(__file__).resolve().parents[2] / 'test' / 'fixtures' / 'name-identity-vectors.json'
    for value, key in json.loads(fixture.read_text(encoding='utf-8'))['vectors']:
        assert identity_key(value) == key, value

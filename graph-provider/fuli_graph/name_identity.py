"""The one identity rule for names people type: tags today, other vocabularies later.

identity_key decides when two spellings are the same name. It applies NFKC
(full-width and compatibility forms), lowercases without aggressive folding
(Maße stays apart from Masse), drops a BOM or zero-width space pasted in, and
collapses every run of whitespace or line breaks to one space. It never strips
punctuation, accents, ZWJ sequences or non-BMP characters, and it never removes
a space inside a name. Applying it again changes nothing.
"""
import unicodedata

_INVISIBLE = dict.fromkeys(map(ord, '﻿​'))
# NFKC and lowercasing settle within two passes; the bound only stops a
# pathological input from looping.
_MAX_PASSES = 4


def display_name(value: str) -> str:
    """The writer's own characters, composed, with spacing tidied."""
    return ' '.join(unicodedata.normalize('NFC', value).translate(_INVISIBLE).split())


def identity_key(value: str) -> str:
    key = value
    for _ in range(_MAX_PASSES):
        normalized = ' '.join(
            unicodedata.normalize('NFKC', key).lower().translate(_INVISIBLE).split())
        if normalized == key:
            break
        key = normalized
    return key

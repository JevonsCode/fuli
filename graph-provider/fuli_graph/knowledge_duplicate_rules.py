"""When two current knowledge items are one (rec#88, after #839): the pair
rules of automatic duplicate merging, with no graph and no model.

A false merge hides knowledge, a missed one only costs a recall slot, so
every rule is strict:
- same_text: the same words once case, spacing and the order inside a list of
  code literals are ignored;
- covers: the same sentence whose longer copy lists every code literal
  (`npm test`, a URL) of the shorter copy and more, as checks that ran clean
  grow from `a`, `b` to `a`, `b`, `c`, while the longer copy is the one said
  last (its latest source is not older than the shorter's). A shorter list
  said last may say something was removed, so that pair is left to the
  staleness check;
- same_meaning: different wording under the same name, with the same
  literals, numbers and negations, whose stored meaning vectors of one model
  are nearly identical.
Numbers and negations stay in the compared words, so 3 attempts and 4
attempts, or "use X" and "never use X", are never one item: that is a
conflict for a person, not a duplicate.
"""
import math
import re
from dataclasses import dataclass

from .knowledge_search import _terms
from .knowledge_semantic import usable_vector
from .provider_values import native_datetime, normalized_text

SAME_MEANING_COSINE = 0.97
# A sentence around a list needs some words of its own before a longer list
# can stand in for a shorter one.
MIN_TEMPLATE_TERMS = 3
_LITERAL = r'`[^`\n]+`|https?://[^\s,，、;；)`]*[^\s,，、;；)`.。]'
_LITERAL_RE = re.compile(_LITERAL)
# A run of literals is one list: separated by commas, 、, semicolons, spaces or "and".
_RUN_RE = re.compile(rf'(?:{_LITERAL})(?:(?:[\s,，、;；]|\band\b|和|及)+(?:{_LITERAL}))*')
_NEGATION_RE = re.compile(
    r"\b(?:not|no|never|don't|doesn't|isn't|aren't|cannot|can't|won't|without|avoid)\b|不|没|别|勿|禁止|无需|非")
_NUMBER_RE = re.compile(r'\d+(?:\.\d+)?')
CONFIRMATION_RANK = {'pending': 0, 'agent_confirmed': 1, 'confirmed': 2}


@dataclass(frozen=True)
class Shape:
    """An item's words as the rules compare them: the sentence with each list
    of literals replaced by one placeholder, and the literals of each list."""
    template: str
    runs: tuple[frozenset[str], ...]


@dataclass(frozen=True)
class Merge:
    rule: str
    keep: dict
    drop: dict


def shape(text: str) -> Shape:
    runs: list[frozenset[str]] = []

    def placeholder(match):
        runs.append(frozenset(_LITERAL_RE.findall(match.group())))
        return '§'

    template = _RUN_RE.sub(placeholder, normalized_text(text))
    return Shape(' '.join(template.rstrip(' .。').split()), tuple(runs))


def duplicate_merge(first: dict, second: dict) -> Merge | None:
    """The merge of two current items of one kind, type and scope, or None.
    Each is {'item_id', 'text', 'created_at', 'confirmation_status', ...}
    (with 'name' and the stored meaning fields for same_meaning, and
    'said_at', its latest source, for covers). The one kept is the stronger
    confirmed, then the older; for covers, the longer list."""
    if first['item_id'] == second['item_id'] or _blocked(first) or _blocked(second):
        return None
    older, newer = sorted((first, second), key=_age)
    old_shape, new_shape = shape(older['text']), shape(newer['text'])
    if not old_shape.template or not new_shape.template:
        return None
    if old_shape.template == new_shape.template:
        if old_shape.runs == new_shape.runs:
            return _by_confirmation('same_text', older, newer)
        if _covers(new_shape, old_shape):
            longer, shorter = newer, older
        elif _covers(old_shape, new_shape):
            longer, shorter = older, newer
        else:
            return None
        if _said(longer) >= _said(shorter) and _rank(longer) >= _rank(shorter):
            return Merge('covers', longer, shorter)
        return None
    if _same_meaning(older, newer, old_shape, new_shape):
        return _by_confirmation('same_meaning', older, newer)
    return None


def _covers(longer: Shape, shorter: Shape) -> bool:
    if len(longer.runs) != len(shorter.runs) or len(_terms(longer.template)) < MIN_TEMPLATE_TERMS:
        return False
    pairs = list(zip(shorter.runs, longer.runs, strict=True))
    return all(short <= long for short, long in pairs) and any(short < long for short, long in pairs)


def _same_meaning(older, newer, old_shape: Shape, new_shape: Shape) -> bool:
    name = normalized_text(older.get('name'))
    if not name or name != normalized_text(newer.get('name')):
        return False
    if set(old_shape.runs) != set(new_shape.runs):
        return False
    if _marks(_NUMBER_RE, old_shape.template) != _marks(_NUMBER_RE, new_shape.template):
        return False
    if _marks(_NEGATION_RE, old_shape.template) != _marks(_NEGATION_RE, new_shape.template):
        return False
    return (_cosine(older, newer) or 0.0) >= SAME_MEANING_COSINE


def _cosine(first: dict, second: dict) -> float | None:
    model = first.get('semantic_model')
    if not model or model != second.get('semantic_model'):
        return None
    length = len(first.get('semantic_vector') or [])
    one = usable_vector('entity', first, length)
    other = usable_vector('entity', second, length)
    if not one or not other:
        return None
    norms = math.sqrt(sum(value * value for value in one)) * math.sqrt(sum(value * value for value in other))
    return sum(a * b for a, b in zip(one, other)) / norms if norms else None


def _marks(pattern, text: str) -> list[str]:
    return sorted(pattern.findall(text))


def _by_confirmation(rule: str, older: dict, newer: dict) -> Merge:
    keep = newer if _rank(newer) > _rank(older) else older
    return Merge(rule, keep, older if keep is newer else newer)


def _rank(item: dict) -> int:
    return CONFIRMATION_RANK.get(item.get('confirmation_status') or 'pending', 0)


def _blocked(item: dict) -> bool:
    """A person's rejection or an open conflict is theirs to settle."""
    return bool(item.get('blocked'))


def _said(item: dict) -> float:
    """When the item was last said: its newest source, else its creation."""
    said = native_datetime(item.get('said_at')) or native_datetime(item.get('created_at'))
    return said.timestamp() if said else float('-inf')


def _age(item: dict):
    created = native_datetime(item.get('created_at'))
    return (created.timestamp() if created else float('inf'), item['item_id'])

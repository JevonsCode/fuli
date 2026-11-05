"""Search by meaning (rec#88): the text a vector stands for, whether a stored
vector still fits, the relevance floor and the fusion with the lexical result.

FULI ships no embedding model. Node computes vectors with a model a person
connected and stores them through knowledge_semantic_index; a query brings its
own vector. A stored vector counts only for its model, at the query's length,
while its hash is still the sha256 of the item's text: an edit or a version
copy that changed the text leaves it pending, never stale.
"""
import math
from statistics import fmean, pstdev

from .provider_values import sha256_text

# Reciprocal rank fusion constant (Cormack et al.).
RRF_K = 60
# Under this many in-scope items with a vector the floor means nothing.
MIN_IN_SCOPE_ITEMS = 12
# Kept: a cosine at least this many standard deviations above the mean of
# every in-scope item for this query. No model-specific number is needed.
FLOOR_STANDARD_DEVIATIONS = 3


def semantic_text(item_kind: str, record: dict) -> str:
    """The text embedded: an entity's name and summary, a relationship's fact."""
    if item_kind == 'entity':
        return '\n'.join(part for part in (record.get('name'), record.get('summary')) if part)
    return record.get('fact') or ''


def semantic_hash(text: str) -> str:
    return sha256_text(text)


def usable_vector(item_kind: str, record: dict, length: int) -> list[float] | None:
    """The record's stored vector (already read for the query's model) when it
    has the query's length and was computed from the item's current text."""
    vector = record.get('semantic_vector')
    if not vector or len(vector) != length:
        return None
    if record.get('semantic_hash') != semantic_hash(semantic_text(item_kind, record)):
        return None
    return vector


def meaning_matches(candidates: dict, query_vector: list[float], limit: int) -> dict:
    """{key: cosine} of the candidates ({key: vector}, every in-scope item with
    a usable vector) that stand out for this query, best first, at most limit."""
    query_norm = math.sqrt(sum(value * value for value in query_vector))
    if not query_norm:
        return {}
    scores = {}
    for key, vector in candidates.items():
        norm = math.sqrt(sum(value * value for value in vector))
        if norm:
            scores[key] = sum(a * b for a, b in zip(query_vector, vector)) / (query_norm * norm)
    if len(scores) < MIN_IN_SCOPE_ITEMS:
        return {}
    mean = fmean(scores.values())
    deviation = pstdev(scores.values(), mean)
    if not deviation:
        return {}
    floor = mean + FLOOR_STANDARD_DEVIATIONS * deviation
    kept = sorted((key for key, score in scores.items() if score >= floor),
                  key=lambda key: (-scores[key], key))[:limit]
    return {key: scores[key] for key in kept}


def fused_ranking(lexical_ids: list[str], semantic_ids: list[str]) -> dict[str, tuple[float, str]]:
    """{item id: (reciprocal rank fusion score, matched_by)} over the lexical
    and the semantic order of one kind."""
    lexical = {item_id: rank for rank, item_id in enumerate(lexical_ids, 1)}
    semantic = {item_id: rank for rank, item_id in enumerate(semantic_ids, 1)}
    fused = {}
    for item_id in dict.fromkeys([*lexical_ids, *semantic_ids]):
        score = sum(1 / (RRF_K + ranks[item_id]) for ranks in (lexical, semantic) if item_id in ranks)
        matched_by = ('both' if item_id in lexical and item_id in semantic
                      else 'lexical' if item_id in lexical else 'semantic')
        fused[item_id] = (round(score, 6), matched_by)
    return fused

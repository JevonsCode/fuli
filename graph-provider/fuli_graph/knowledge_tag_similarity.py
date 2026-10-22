"""Which visible tags a word may mean (rec#5 section 3, G4-3).

Exact name first, then alias, then similar; each tag once, at its strongest
match. Similar is lexical only: one name contained in another, the word inside
a description, or the Provider's local lexical-hash embedding (character
n-grams) at the configured threshold. A synonym that shares no characters is
never found here; it becomes the same tag only through an alias. A candidate is
a proposal and never merges anything. A word of a tag the person merged is
found as the live tag it leads to, naming the merged tag it came through.
"""
from dataclasses import dataclass

from .knowledge_tag_models import KnowledgeTagCandidate, KnowledgeTagDecisionCandidate
from .knowledge_tag_redirects import live_target
from .name_identity import identity_key

# Bounds the similarity scan; exact and alias matches are looked up by key and
# never truncated. A truncated scan is reported, so absence proves nothing.
MAX_SCANNED_TAGS = 2000
MIN_CONTAINED_NAME = 2
LEXICAL_HASH = 'lexical-hash'
_MATCH_ORDER = {'exact': 0, 'alias': 1, 'similar': 2}


@dataclass(frozen=True)
class TagCandidates:
    found: list[KnowledgeTagCandidate]
    truncated: bool


def similarity_version(store) -> str:
    """Names the hashing, its size and the threshold that judged a candidate."""
    embedder = store.runtime.embedder
    threshold = store.settings.tag_similarity_threshold
    return f'{LEXICAL_HASH}/{embedder.version}/{embedder.dimensions}@{threshold:g}'


async def find_candidates(store, reader, key: str, *, key_namespaces: list[str],
                          scan_namespaces: list[str]) -> TagCandidates:
    found = {}
    for tag in await reader.find_by_key(key_namespaces, key):
        found[tag['id']] = (tag_candidate(tag, 'exact', 'name') if tag['name_key'] == key
                            else tag_candidate(tag, 'alias', 'alias', _alias_status(tag, key)))
    for merged, target in await _redirected(reader, key_namespaces, key):
        if target['id'] not in found:
            found[target['id']] = (
                tag_candidate(target, 'exact', 'name', redirected_from=merged['id'])
                if merged['name_key'] == key else
                tag_candidate(target, 'alias', 'alias', _alias_status(merged, key), merged['id']))
    listed = await reader.list_visible(scan_namespaces, MAX_SCANNED_TAGS + 1)
    scanned = [tag for tag in listed[:MAX_SCANNED_TAGS] if tag['id'] not in found]
    for tag, basis in await _similar(store, key, scanned):
        found[tag['id']] = tag_candidate(tag, 'similar', basis)
    ordered = sorted(found.values(), key=lambda candidate: (
        _MATCH_ORDER[candidate.match], candidate.status != 'active', identity_key(candidate.name)))
    return TagCandidates(ordered, len(listed) > MAX_SCANNED_TAGS)


def tag_candidate(tag: dict, match: str, basis: str, alias_status=None,
                  redirected_from=None) -> KnowledgeTagCandidate:
    return KnowledgeTagCandidate(
        id=tag['id'], name=tag['name'], namespace=tag['namespace_kind'], status=tag['status'],
        match=match, basis=basis, description=tag.get('description'),
        aliases=list(tag.get('aliases') or []), alias_status=alias_status,
        redirected_from=redirected_from)


async def word_holders(reader, namespace_keys, key: str) -> list[dict]:
    """Every live tag a reader in these namespaces resolves the word to,
    directly or through a merged tag's redirect."""
    holders = {tag['id']: tag for tag in await reader.find_by_key(namespace_keys, key)}
    for _, target in await _redirected(reader, namespace_keys, key):
        holders.setdefault(target['id'], target)
    return list(holders.values())


async def _redirected(reader, namespace_keys, key: str):
    pairs = []
    for merged in await reader.find_redirects(namespace_keys, key):
        target = await live_target(reader, merged)
        if target is not None:
            pairs.append((merged, target))
    return pairs


def decision_candidate(candidate: KnowledgeTagCandidate) -> KnowledgeTagDecisionCandidate:
    return KnowledgeTagDecisionCandidate(
        id=candidate.id, name=candidate.name, namespace=candidate.namespace,
        status=candidate.status, match=candidate.match, basis=candidate.basis)


def _alias_status(tag: dict, key: str) -> str:
    return tag['alias_statuses'][tag['alias_keys'].index(key)]


async def _similar(store, key: str, tags: list[dict]):
    lexical = [(tag, basis) for tag in tags if (basis := _lexical_basis(key, tag))]
    described = {tag['id'] for tag, _ in lexical}
    rest = [tag for tag in tags if tag['id'] not in described]
    if not rest:
        return lexical
    texts = [key, *(' '.join([tag['name_key'], *tag['alias_keys']]) for tag in rest)]
    query, *vectors = await store.runtime.embedder.create_batch(texts)
    threshold = store.settings.tag_similarity_threshold
    hashed = [(tag, LEXICAL_HASH) for tag, vector in zip(rest, vectors)
              if sum(left * right for left, right in zip(query, vector)) >= threshold]
    return lexical + hashed


def _lexical_basis(key: str, tag: dict) -> str | None:
    if any(min(len(key), len(name)) >= MIN_CONTAINED_NAME and (key in name or name in key)
           for name in [tag['name_key'], *tag['alias_keys']]):
        return 'name'
    return 'description' if key in identity_key(tag.get('description') or '') else None

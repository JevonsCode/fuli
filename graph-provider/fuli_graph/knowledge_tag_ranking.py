"""Bounded tag signals over already authorized, filtered search candidates (D-31).

The vocabulary never supplies a candidate. Relations expand once from an active
query tag, not recursively, and multiple tags contribute their maximum signal.
"""
from .name_identity import identity_key
from .knowledge_tag_redirects import live_target

DIRECT = 1.25
NEIGHBOR = 1.10
PROVISIONAL = 1.08


class ScopedRedirectReader:
    def __init__(self, reader, namespaces):
        self.reader, self.namespaces = reader, namespaces

    async def get_any(self, tag_id):
        return await self.reader.ranking_target(self.namespaces, tag_id)


def query_keys(query):
    normalized = identity_key(query)
    words = normalized.split()
    # Preserve whole phrases as well as their contiguous terms. No fuzzy/LLM match.
    return sorted({normalized, *(" ".join(words[start:end])
                   for start in range(len(words))
                   for end in range(start + 1, min(len(words), start + 6) + 1))})


def _confirmed_word(tag, keys):
    if tag['name_key'] in keys:
        return True
    return any(key in keys and status == 'active'
               for key, status in zip(tag.get('alias_keys', []), tag.get('alias_statuses', [])))


def _signal(tag, root, method, weak=False):
    provisional = tag['status'] == 'provisional' or weak
    multiplier = PROVISIONAL if provisional else DIRECT if method in ('direct', 'redirect_from') else NEIGHBOR
    return {'tag_id': tag['id'], 'name': tag['name'], 'status': tag['status'],
            'method': method, 'query_tag_id': root['id'], 'query_tag_name': root['name'],
            'tier': 'provisional' if provisional else 'direct' if multiplier == DIRECT else 'one_hop',
            'inferred': method in ('child_of', 'related_to'), 'unconfirmed': provisional,
            'multiplier': multiplier}


class TagRanking:
    def __init__(self, reader=None, signals=None):
        self.reader = reader
        self.signals = signals or {}

    @classmethod
    async def for_search(cls, store, space, request, project_scopes):
        port = getattr(store, 'knowledge_tag_vocabulary', None)
        if space is None or not callable(port):
            return cls()
        reader = port().reader(space['id'])
        namespaces = ['personal', *(f'project:{project_id}' for project_id in project_scopes)]
        keys = query_keys(request.query)
        roots = await reader.ranking_roots(namespaces, keys)
        signals, active_roots = {}, {}
        for root in roots:
            confirmed = _confirmed_word(root, keys)
            # An unconfirmed alias is at most a provisional direct signal.
            target = await live_target(ScopedRedirectReader(reader, namespaces), root)
            if target is None:
                continue
            method = 'redirect_from' if root['status'] == 'merged' else 'direct'
            signals.setdefault(target['id'], []).append(_signal(target, root, method, not confirmed))
            if target['status'] == 'active' and confirmed:
                active_roots[target['id']] = target
        if active_roots:
            neighbors = await reader.ranking_neighbors(namespaces, list(active_roots))
            for neighbor in neighbors:
                for root_id, root in active_roots.items():
                    if root_id in neighbor.get('parent_ids', []):
                        signals.setdefault(neighbor['id'], []).append(_signal(neighbor, root, 'child_of'))
                    if (root_id in neighbor.get('related_ids', [])
                            or neighbor['id'] in root.get('related_ids', [])):
                        signals.setdefault(neighbor['id'], []).append(_signal(neighbor, root, 'related_to'))
        return cls(reader, signals)

    async def rerank(self, candidates, kind, explanations=None):
        """Candidates are (id, post-authority score, payload) in original rank order."""
        matches = {}
        if candidates and self.signals:
            links = await self.reader.ranking_links(
                list(self.signals), kind, [item_id for item_id, _, _ in candidates])
            for link in links:
                matches.setdefault(link['item_id'], []).extend(self.signals[link['tag_id']])
        ranked = []
        for rank, (item_id, score, payload) in enumerate(candidates, 1):
            signals = sorted(matches.get(item_id, []), key=lambda match: (
                -match['multiplier'], match['tag_id'], match['method'], match['query_tag_id']))
            multiplier = max((match['multiplier'] for match in signals), default=1.0)
            final_score = score * multiplier
            ranked.append((item_id, final_score, payload, rank))
            if explanations is not None:
                explanations[kind, item_id] = {
                    'original_rank': rank, 'final_rank': None, 'original_score': score,
                    'final_score': final_score, 'multiplier': multiplier, 'matches': signals,
                    'no_signal_reason': None if signals else (
                        'no_matching_tag_on_candidate' if self.signals else 'no_visible_query_tag')}
        ranked.sort(key=lambda row: (-row[1], row[3]))
        if explanations is not None:
            for rank, (item_id, _, _, _) in enumerate(ranked, 1):
                explanations[kind, item_id]['final_rank'] = rank
        return [(item_id, score, payload) for item_id, score, payload, _ in ranked]

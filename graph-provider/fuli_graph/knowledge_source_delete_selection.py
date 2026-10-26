"""Deterministic two-layer selection of a source deletion (D-31.B1).

The graph planner supplies one row per complete version lineage and the
current dependent/attached lineages. This module chooses only among them;
no text matching, graph writes or automatic expansion into conclusions.
"""


def source_delete_selection(items, episode_ids, *, include=(), exclude=()):
    by_key = {row['key']: row for row in items}
    aliases = {version: row['key'] for row in items for version in row['version_keys']}
    scope = set(episode_ids)
    touched = {key for key, row in by_key.items() if scope.intersection(row['source_episode_ids'])}
    sole = {key for key in touched if set(by_key[key]['source_episode_ids']) <= scope}
    included, excluded = set(include), set(exclude)
    if included & excluded:
        raise ValueError('an item cannot be both included and excluded')

    def reachable(roots, field):
        seen, frontier = set(roots), list(roots)
        while frontier:
            row = by_key[frontier.pop()]
            for key in row[field]:
                canonical = aliases.get(key, key)
                if canonical not in by_key:
                    raise ValueError('source deletion graph is incomplete')
                if canonical not in seen:
                    seen.add(canonical)
                    frontier.append(canonical)
        return seen

    defaults = reachable(sole, 'attached_keys')
    if not excluded <= defaults:
        raise ValueError('excluded items are outside the default deletion layer')
    deleted = defaults - excluded

    # Checking a newly affected item can reveal another layer. Accept such a
    # selection only when every included row is reachable from this scope.
    pending = included.copy()
    while True:
        forced = reachable(deleted, 'attached_keys')
        if forced & excluded:
            raise ValueError('an attached relationship cannot survive its deleted endpoint')
        deleted |= forced
        affected = reachable(sole | deleted, 'dependent_keys') | touched
        added = pending & affected
        if not added:
            break
        deleted |= added
        pending -= added
    if pending:
        raise ValueError('included items are outside the affected layer')
    review = reachable(sole | deleted, 'dependent_keys') - deleted
    retained_sources = {
        key: sorted(set(by_key[key]['source_episode_ids']) - scope)
        for key in sorted(touched - deleted)
    }
    return {
        'default_keys': sorted(defaults),
        'affected_keys': sorted(affected - defaults),
        'selected_keys': sorted(deleted),
        'deleted_keys': sorted({version for key in deleted for version in by_key[key]['version_keys']}),
        'review_keys': sorted(review),
        'retained_sources': retained_sources,
    }

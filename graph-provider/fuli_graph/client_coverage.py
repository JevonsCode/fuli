"""Which client a stored client or source list covers (rec#11 D-64).

OpenCode used the generic ``other`` source until it got its own ``opencode``.
A list written before that names ``other`` for it, so at read time a list
that contains ``other`` and lacks ``opencode`` covers ``opencode`` too. No
stored list is rewritten. The Node side applies the same rule in
``src/agents/source-applications.js``.
"""

LEGACY_ALIASES = {'opencode': 'other'}


def covers_client(clients, client):
    """Whether ``clients`` (a stored list, possibly None) includes ``client``."""
    listed = clients or ()
    if client in listed:
        return True
    legacy = LEGACY_ALIASES.get(client)
    return legacy is not None and legacy in listed

"""Tonborg's confirmation of a pending item for the person (rec#96).

With 「交给 Tonborg 确认」 on, an applied Tonborg review also makes the item
agent_confirmed, so recall uses it. The basis names Tonborg as an agent
confirmer with its own policy version: never a person's confirmation, which
only a user or an authoritative source may give (models.py). The person's undo
of that review returns the item to pending, but only while the basis is still
the one Tonborg wrote.
"""

import json
from datetime import datetime

from .provider_values import json_object

TONBORG_CONFIRMATION_POLICY_VERSION = 'tonborg-review-v1'
TONBORG_CONFIRMER = {'kind': 'agent', 'label': 'Tonborg'}


def basis_json(basis: dict) -> str:
    return json.dumps(basis, ensure_ascii=False, sort_keys=True)


def tonborg_confirmation_basis(value, confirmed_at: datetime) -> dict:
    """The pending basis with Tonborg as its agent confirmer."""
    basis = json_object(value)
    return {
        **basis,
        'existence_reason': basis.get('existence_reason')
        or 'The knowledge was retained from an earlier Agent proposal.',
        'quadrant_reason': basis.get('quadrant_reason')
        or 'The discovery quadrant remains the immutable capture-time label.',
        'proposed_by': basis.get('proposed_by') or {'kind': 'agent', 'label': 'Fuli'},
        'confirmed_by': dict(TONBORG_CONFIRMER),
        'confirmed_at': confirmed_at.isoformat(),
        'agent_policy_version': TONBORG_CONFIRMATION_POLICY_VERSION,
    }


def withdrawn_tonborg_basis(value) -> dict | None:
    """The pending basis an undo restores, or None when Tonborg did not confirm it."""
    basis = json_object(value)
    if basis.get('agent_policy_version') != TONBORG_CONFIRMATION_POLICY_VERSION:
        return None
    restored = {key: item for key, item in basis.items() if key != 'agent_policy_version'}
    restored['confirmed_by'] = None
    restored['confirmed_at'] = None
    return restored

"""One evidence-backed display policy for knowledge and preference read views."""
from .models import _validate_confirmation_state, stored_confirmation_basis


def effective_confirmation_status(metadata: dict) -> str:
    status = metadata.get('confirmation_status', 'pending')
    basis = stored_confirmation_basis(metadata.get('confirmation_basis_json'))
    if basis is None:
        return 'pending'
    try:
        _validate_confirmation_state(status, basis)
    except ValueError:
        return 'pending'
    return status


def knowledge_weight(record, *, evidence_ids=()) -> dict:
    """Derive a bounded weight from persisted, qualified use and actual sources.

    No stored confidence, caller-supplied weight or discovery score establishes
    human authority. The existing auditable confirmation policy alone does.
    Only real source IDs supplied by the authorized read query count as support.
    """
    status = effective_confirmation_status(record)
    if status == 'confirmed':
        basis = stored_confirmation_basis(record.get('confirmation_basis_json'))
        return {'weight_percent': 100, 'confirmed_by_person': basis.confirmed_by.kind == 'user'}
    uses = max(0, int(record.get('qualified_use_count') or 0))
    tasks = max(0, int(record.get('distinct_task_count') or 0))
    negatives = max(0, int(record.get('negative_evidence_count') or 0))
    support = len(set(evidence_ids))
    strength = max(0, min(100,
        min(50, uses * 2) + min(25, tasks * 5) + min(25, support * 5)
        - min(100, negatives * 10),
    ))
    lower, upper = (70, 95) if status == 'agent_confirmed' else (10, 69)
    return {
        'weight_percent': lower + (upper - lower) * strength // 100,
        'confirmed_by_person': False,
    }

import json
import re
from typing import Any


_CREDENTIAL_PATTERNS = (
    re.compile(r'-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----', re.I),
    re.compile(
        r'\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|'
        r'github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|'
        r'AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b'
    ),
    re.compile(r'\bBearer\s+[A-Za-z0-9._~+/=-]{16,}', re.I),
    re.compile(r'\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b'),
    re.compile(
        r'\b(?:password|passwd|passphrase|secret|api[-_ ]?key|access[-_ ]?token|'
        r'auth[-_ ]?token)\b\s*[:=]\s*(?:"[^"]+"|\'[^\']+\'|[^\s,]+)',
        re.I,
    ),
)


def reject_credentials(model: Any, label: str) -> None:
    searchable = json.dumps(model.model_dump(mode='json'), ensure_ascii=False)
    if any(pattern.search(searchable) for pattern in _CREDENTIAL_PATTERNS):
        raise ValueError(f'{label} contains credentials')


def normalize_provider_url(value: str) -> str:
    if not value.startswith(('https://', 'http://127.0.0.1:', 'http://localhost:')):
        raise ValueError('provider_url must use HTTPS or a loopback HTTP address')
    return value.rstrip('/')


def complete_epistemic_state(
    *,
    origin_quadrant: str,
    current_quadrant: str | None,
    epistemic_status: str,
    reasoning_summary: str | None,
    profile_aspect: str | None,
) -> str:
    current = current_quadrant or origin_quadrant
    if origin_quadrant != 'known_known' and not reasoning_summary:
        raise ValueError('non-known-known knowledge requires a reasoning summary')
    if profile_aspect and epistemic_status == 'exploratory':
        raise ValueError('personal profile knowledge cannot be exploratory')
    return current


def require_public_eligible_episode(episode: Any) -> None:
    items = [*episode.entities, *episode.relationships]
    if any(item.profile_aspect for item in items):
        raise ValueError('Personal profile knowledge cannot enter public review')
    if any(item.confirmation_status != 'confirmed' for item in items):
        raise ValueError(
            'Only knowledge with an auditable confirmation can enter public review'
        )

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

# Keep this deliberately small and provider-local instead of depending on a
# third-party emoji database.  The supplementary-plane range covers current
# pictographs and the explicit BMP ranges cover the common text-presentation
# symbols that become emoji with a variation selector (for example, ``❤️``).
_EMOJI_BASE_RANGES = (
    (0x1F000, 0x1FAFF),
    (0x2600, 0x27BF),
)
_EMOJI_BASE_CODEPOINTS = frozenset({
    0x00A9, 0x00AE,
    0x203C, 0x2049,
    0x2122, 0x2139,
    0x2194, 0x2195, 0x2196, 0x2197, 0x2198, 0x2199,
    0x21A9, 0x21AA,
    0x231A, 0x231B, 0x2328, 0x23CF,
    0x23E9, 0x23EA, 0x23EB, 0x23EC, 0x23ED, 0x23EE,
    0x23EF, 0x23F0, 0x23F1, 0x23F2, 0x23F3,
    0x23F8, 0x23F9, 0x23FA,
    0x24C2,
    0x25AA, 0x25AB, 0x25B6, 0x25C0,
    0x25FB, 0x25FC, 0x25FD, 0x25FE,
    0x2934, 0x2935,
    0x2B05, 0x2B06, 0x2B07, 0x2B1B, 0x2B1C, 0x2B50, 0x2B55,
    0x3030, 0x303D, 0x3297, 0x3299,
})
_EMOJI_VARIATION_SELECTORS = frozenset({0xFE0E, 0xFE0F})
_EMOJI_SKIN_TONES = range(0x1F3FB, 0x1F400)
_EMOJI_TAG_RANGE = range(0xE0020, 0xE0080)
_EMOJI_KEYCAP_MARK = 0x20E3
_EMOJI_ZWJ = 0x200D


def _is_emoji_base(character: str) -> bool:
    codepoint = ord(character)
    return (
        codepoint not in _EMOJI_SKIN_TONES
        and any(
            start <= codepoint <= end
            for start, end in _EMOJI_BASE_RANGES
        )
    ) or codepoint in _EMOJI_BASE_CODEPOINTS


def _is_regional_indicator(character: str) -> bool:
    return 0x1F1E6 <= ord(character) <= 0x1F1FF


def _is_keycap_base(character: str) -> bool:
    return character in '#*' or '0' <= character <= '9'


def _valid_emoji_sequence(value: str) -> bool:
    """Accept one emoji grapheme, including common composed sequences."""

    index = 0
    saw_base = False
    expect_base = True
    while index < len(value):
        character = value[index]
        codepoint = ord(character)
        if expect_base:
            if _is_keycap_base(character):
                index += 1
                if (
                    index < len(value)
                    and ord(value[index]) in _EMOJI_VARIATION_SELECTORS
                ):
                    index += 1
                if index >= len(value) or ord(value[index]) != _EMOJI_KEYCAP_MARK:
                    return False
                index += 1
                saw_base = True
                expect_base = False
                continue
            if not _is_emoji_base(character):
                return False
            index += 1
            saw_base = True
            # A pair of regional indicators is one flag grapheme.
            if (
                _is_regional_indicator(character)
                and index < len(value)
                and _is_regional_indicator(value[index])
            ):
                index += 1
            expect_base = False
            continue

        if codepoint in _EMOJI_SKIN_TONES:
            index += 1
            continue
        if codepoint in _EMOJI_VARIATION_SELECTORS:
            index += 1
            continue
        if codepoint in _EMOJI_TAG_RANGE:
            index += 1
            continue
        if codepoint == _EMOJI_ZWJ:
            index += 1
            if index >= len(value):
                return False
            expect_base = True
            continue
        # A second standalone base would be two graphemes.  Occupation
        # markers intentionally accept one grapheme only.
        return False
    return saw_base and not expect_base


def validate_emoji_sequence(
    value: str | None,
    label: str = 'emoji',
) -> str | None:
    """Normalize and validate a conservative emoji-only field value."""

    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f'{label} must be an emoji')
    normalized = value.strip()
    if not normalized:
        raise ValueError(f'{label} must be an emoji')
    if len(normalized) > 32:
        raise ValueError(f'{label} must contain at most 32 characters')
    if any(character.isspace() for character in normalized):
        raise ValueError(f'{label} must not contain whitespace')
    if not _valid_emoji_sequence(normalized):
        raise ValueError(f'{label} must contain one valid emoji sequence')
    return normalized


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
    if any(item.origin_quadrant != 'known_known' for item in items):
        raise ValueError(
            'Only knowledge originally captured as known-known can enter public review'
        )

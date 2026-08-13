from types import SimpleNamespace

import pytest

from fuli_graph.model_validation import require_public_eligible_episode


def confirmed_item(origin_quadrant: str = 'known_known') -> SimpleNamespace:
    return SimpleNamespace(
        origin_quadrant=origin_quadrant,
        profile_aspect=None,
        confirmation_status='confirmed',
    )


def episode_with(item: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(entities=[item], relationships=[])


def test_public_review_accepts_confirmed_known_known_knowledge():
    require_public_eligible_episode(episode_with(confirmed_item()))


@pytest.mark.parametrize('origin_quadrant', [
    'known_unknown',
    'unknown_known',
    'unknown_unknown',
])
def test_public_review_rejects_other_confirmed_origin_quadrants(origin_quadrant):
    with pytest.raises(ValueError, match='originally captured as known-known'):
        require_public_eligible_episode(
            episode_with(confirmed_item(origin_quadrant))
        )

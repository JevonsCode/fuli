"""When two current items are one (automatic duplicate merging): exact
repeats, a newer longer list of code literals, and the same meaning under the
same name. Contradictions, removals and anything a person must settle are
never merged. Synthetic items only; needs no graph."""
from datetime import datetime, timedelta, timezone

import pytest

from fuli_graph.knowledge_duplicate_rules import SAME_MEANING_COSINE, duplicate_merge, shape
from fuli_graph.knowledge_semantic import semantic_hash, semantic_text

T0 = datetime(2026, 11, 1, tzinfo=timezone.utc)


def item(item_id, text, *, minutes=0, status='pending', name=None, **extra):
    return {'item_id': item_id, 'text': text, 'name': name, 'created_at': T0 + timedelta(minutes=minutes),
            'confirmation_status': status, **extra}


def checks(*scripts):
    listed = ', '.join(f'`{script}`' for script in scripts)
    return (f'Project checks: {listed}\n'
            f'These project scripts ran clean at the end of a finished task: {listed}.')


def ids(merge):
    return merge and (merge.rule, merge.keep['item_id'], merge.drop['item_id'])


def test_a_longer_newer_list_of_checks_covers_the_older_one():
    # The #839 live-check miss: both took a recall slot.
    older = item('a', checks('npm run check', 'npm test'))
    newer = item('b', checks('npm run check', 'npm run fixtures', 'npm test'), minutes=5)
    assert ids(duplicate_merge(older, newer)) == ('covers', 'b', 'a')
    assert ids(duplicate_merge(newer, older)) == ('covers', 'b', 'a')


def test_a_newer_shorter_list_may_say_something_was_removed_and_is_not_merged():
    older = item('a', checks('npm run check', 'npm run fixtures', 'npm test'))
    newer = item('b', checks('npm run check', 'npm test'), minutes=5)
    assert duplicate_merge(older, newer) is None


def test_a_pending_longer_list_never_absorbs_a_confirmed_shorter_one():
    older = item('a', checks('npm run check', 'npm test'), status='confirmed')
    newer = item('b', checks('npm run check', 'npm run fixtures', 'npm test'), minutes=5)
    assert duplicate_merge(older, newer) is None
    newer['confirmation_status'] = 'confirmed'
    assert ids(duplicate_merge(older, newer)) == ('covers', 'b', 'a')


@pytest.mark.parametrize('older_status, newer_status, kept', [
    ('pending', 'pending', 'a'),        # two pending items stay pending: the older is kept
    ('confirmed', 'confirmed', 'a'),
    ('pending', 'confirmed', 'b'),      # a pending copy goes into the confirmed one
    ('confirmed', 'pending', 'a'),
    ('agent_confirmed', 'confirmed', 'b'),
])
def test_the_same_words_keep_the_stronger_confirmation_then_the_older_item(older_status, newer_status, kept):
    older = item('a', 'Deploy Aurora  to staging with `make ship`', status=older_status)
    newer = item('b', 'deploy aurora to staging with `make ship`.', minutes=1, status=newer_status)
    merge = duplicate_merge(older, newer)
    assert merge.rule == 'same_text' and merge.keep['item_id'] == kept
    assert merge.drop['item_id'] == ({'a', 'b'} - {kept}).pop()


def test_list_order_does_not_make_two_items():
    assert ids(duplicate_merge(item('a', 'Run `npm test`, `npm run lint` before a push'),
                               item('b', 'Run `npm run lint`, `npm test` before a push', minutes=1))) == (
        'same_text', 'a', 'b')


@pytest.mark.parametrize('older, newer', [
    # Different numbers are a conflict, not a duplicate.
    ('Retry at most 3 attempts with `fetch`', 'Retry at most 4 attempts with `fetch`'),
    # A negation flips the meaning.
    ('Use `npm ci` in CI', 'Never use `npm ci` in CI'),
    # Different literals in the same sentence.
    ('The sandbox base URL is https://sandbox.one.example/v2', 'The sandbox base URL is https://sandbox.two.example/v2'),
    # Overlapping but neither list holds the other.
    (checks('npm run check', 'npm test'), checks('npm run lint', 'npm run check', 'npm run fixtures')),
    # A bare list has no sentence of its own to be the same in.
    ('`a`, `b`', '`a`, `b`, `c`'),
    # Similar words only (the staleness check's business, not a merge).
    ('restart the aurora service and check its logs afterwards', 'restart aurora service then check the logs'),
])
def test_contradictions_and_mere_similarity_are_never_merged(older, newer):
    assert duplicate_merge(item('a', older), item('b', newer, minutes=1)) is None


def test_a_rejected_item_or_one_waiting_for_review_is_left_to_the_person():
    assert duplicate_merge(item('a', 'Deploy with `make ship`', blocked=True),
                           item('b', 'Deploy with `make ship`', minutes=1)) is None


def meaning(item_id, name, summary, vector, *, minutes=0, model='synthetic-embed'):
    record = {'name': name, 'summary': summary, 'retrieval_terms': None, 'retrieval_context': None}
    return item(item_id, f'{name}\n{summary}', minutes=minutes, name=name, summary=summary,
                semantic_vector=vector, semantic_model=model,
                semantic_hash=semantic_hash(semantic_text('entity', record)))


def test_the_same_meaning_under_the_same_name_needs_nearly_identical_vectors():
    older = meaning('a', 'Release day', 'We release on Thursdays after the standup', [1.0, 0.0, 0.0])
    newer = meaning('b', 'Release day', 'Releases go out every Thursday once standup ends', [0.999, 0.01, 0.0], minutes=1)
    assert ids(duplicate_merge(older, newer)) == ('same_meaning', 'a', 'b')
    far = meaning('c', 'Release day', 'Releases go out every Thursday once standup ends', [0.8, 0.6, 0.0], minutes=1)
    assert duplicate_merge(older, far) is None, f'cosine 0.8 is below {SAME_MEANING_COSINE}'


@pytest.mark.parametrize('change', [
    {'name': 'Release window'},                      # a different name
    {'model': 'another-model'},                      # vectors of two models are not comparable
    {'summary': 'We never release on Thursdays after the standup'},  # a negation
    {'summary': 'We release on Thursdays at 3 after the standup'},   # a number only one says
])
def test_the_same_meaning_rule_refuses_any_difference_it_can_see(change):
    older = meaning('a', 'Release day', 'We release on Thursdays after the standup', [1.0, 0.0, 0.0])
    newer = meaning('b', change.get('name', 'Release day'),
                    change.get('summary', 'Releases go out every Thursday once standup ends'),
                    [1.0, 0.0, 0.0], minutes=1, model=change.get('model', 'synthetic-embed'))
    assert duplicate_merge(older, newer) is None


def test_a_stale_vector_does_not_count():
    older = meaning('a', 'Release day', 'We release on Thursdays after the standup', [1.0, 0.0])
    newer = meaning('b', 'Release day', 'Releases go out every Thursday once standup ends', [1.0, 0.0], minutes=1)
    newer['semantic_hash'] = 'stale'
    assert duplicate_merge(older, newer) is None


def test_shape_keeps_numbers_and_negations_in_the_sentence():
    found = shape('Never retry more than 3 times: `a`, `b` and `c`')
    assert found.template == 'never retry more than 3 times: §'
    assert found.runs == (frozenset({'`a`', '`b`', '`c`'}),)

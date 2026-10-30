"""Deterministic folding and recovery; all fixtures are synthetic test data."""
import json

from fuli_graph.conversation_context import (
    DIGEST_VERSION, ENTRY_BYTES, add_task_result, fold_messages, note_compaction, pack_context, refold_digest,
)


def message(sequence, role, content, kind='message'):
    return {'sequence': sequence, 'role': role, 'content': content, 'kind': kind}


def summary(sequence, content):
    return message(sequence, 'summary', content, 'compaction_summary')


def texts(digest):
    return [entry['text'] for entry in digest['entries']]


def packed_bytes(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())


def test_keeps_only_user_request_titles_not_marker_lines():
    digest = fold_messages({}, [
        message(1, 'user', 'Synthetic login redirect\nWe decided to keep the session cookie.\nunrelated chatter'),
        message(2, 'assistant', 'Sure.\nDecision: replay the redirect.\nTODO: check the fixture.\nok'),
        message(3, 'tool', 'Decision: tool output is never retained'),
        message(4, 'summary', 'Synthetic checkpoint', 'checkpoint'),
    ])
    assert digest['entries'] == [{'kind': 'request', 'text': 'Synthetic login redirect',
                                  'sources': [{'role': 'user', 'sequence': 1}]}]
    # Two later user lines and four assistant lines are left out; tool and checkpoint events are not lines.
    assert digest['omitted'] == 6
    assert digest['version'] == DIGEST_VERSION


def test_client_compaction_summary_folds_to_one_bounded_preview():
    text = 'This session continues an earlier synthetic conversation.\n\n1. Primary request: ' + '保留原始记录' * 60
    digest = fold_messages({}, [message(1, 'user', 'Synthetic title'), summary(2, text)])
    entry = digest['entries'][1]
    assert entry['kind'] == 'compaction' and entry['sources'] == [{'role': 'summary', 'sequence': 2}]
    assert entry['text'].startswith('This session continues an earlier synthetic conversation. 1. Primary request:')
    assert len(entry['text'].encode()) <= ENTRY_BYTES and entry['truncated'] is True
    entry['text'].encode().decode()  # never splits a code point
    assert digest['omitted'] == 0


def test_summaries_with_a_shared_opening_stay_separate():
    opening = 'This session continues an earlier synthetic conversation. ' * 6
    digest = fold_messages({}, [summary(3, opening + 'first window'), summary(9, opening + 'second window')])
    assert [entry['sources'] for entry in digest['entries']] == [[{'role': 'summary', 'sequence': 3}],
                                                                [{'role': 'summary', 'sequence': 9}]]


def test_repeated_titles_dedup_additively_and_stay_bounded():
    digest = {}
    for round_index in range(30):
        base = round_index * 10
        digest = fold_messages(digest, [
            message(base + 1, 'user', 'Rerun the synthetic suite'),
            message(base + 2, 'user', f'Synthetic round {round_index} ' + 'context ' * 25),
        ])
    repeated = [entry for entry in digest['entries'] if entry['text'] == 'Rerun the synthetic suite']
    assert len(repeated) == 1
    assert repeated[0]['sources'][0] == {'role': 'user', 'sequence': 1}
    assert repeated[0]['sources'][-1] == {'role': 'user', 'sequence': 291}
    assert len(repeated[0]['sources']) <= 4
    assert sum(len(entry['text'].encode()) for entry in digest['entries']) <= 6000
    assert digest['omitted'] > 0
    assert not any(text.startswith('Synthetic round 0 ') for text in texts(digest))
    assert any(text.startswith('Synthetic round 29 ') for text in texts(digest))


def test_compaction_previews_outlive_request_titles_under_eviction():
    events = [message(index, 'user', f'Synthetic title {index} ' + 'x' * 200) for index in range(1, 40)]
    events.append(summary(50, 'Synthetic client summary that must survive byte eviction.'))
    events.append(message(51, 'user', 'Newest title ' + 'y' * 200))
    digest = fold_messages({}, events)
    kept = texts(digest)
    assert 'Synthetic client summary that must survive byte eviction.' in kept
    assert kept[-1] == 'Newest title ' + 'y' * 200
    assert kept[0] != 'Synthetic title 1 ' + 'x' * 200
    assert sum(len(text.encode()) for text in kept) <= 6000
    assert digest['omitted'] == 41 - len(kept)


def test_fenced_code_is_omitted_and_never_a_title():
    digest = fold_messages({}, [message(3, 'user', '```\nprint(1)\n```\nSynthetic title after code')])
    assert texts(digest) == ['Synthetic title after code']
    assert digest['omitted'] == 1  # the code line; fence markers are not content


def test_dedup_keeps_case_and_internal_whitespace_distinct():
    digest = fold_messages({}, [
        message(1, 'user', 'Use synthetic key ABC'),
        message(2, 'user', 'Use synthetic key abc'),
        message(3, 'user', 'Set value "a  b"'),
        message(4, 'user', 'Set value "a b"'),
        message(5, 'user', 'Use synthetic key ABC'),
    ])
    assert texts(digest) == ['Use synthetic key ABC', 'Use synthetic key abc', 'Set value "a  b"', 'Set value "a b"']
    assert digest['entries'][0]['sources'] == [{'role': 'user', 'sequence': 1}, {'role': 'user', 'sequence': 5}]


def test_refold_keeps_tasks_and_the_compaction_pointer_and_drops_marker_entries():
    older = add_task_result({}, '2026-10-01T00:00:00+00:00', 'completed', 'Synthetic result')
    older = note_compaction(older, 7, 1200)
    older = {**older, 'version': 2, 'entries': [
        {'kind': 'decision', 'text': 'Sure, I decided to look first.', 'sources': [{'role': 'assistant', 'sequence': 2}]}]}
    rebuilt = refold_digest(older, [message(1, 'user', 'Synthetic title\nI decided to look first.'),
                                    message(2, 'assistant', 'Sure, I decided to look first.')])
    assert rebuilt['tasks'] == older['tasks']
    assert rebuilt['compaction'] == {'sequence': 7, 'bytes': 1200}
    assert texts(rebuilt) == ['Synthetic title']
    assert rebuilt['version'] == DIGEST_VERSION


def test_recovery_carries_the_whole_compaction_summary_when_it_fits():
    events = [message(1, 'user', 'Synthetic question'), message(2, 'assistant', 'Synthetic answer')]
    packed = pack_context('', events, 4000, compaction={'sequence': 5, 'content': 'Synthetic client summary'})
    assert packed['compaction_summary'] == {'sequence': 5, 'bytes': 24, 'content': 'Synthetic client summary'}
    assert [item['sequence'] for item in packed['messages']] == [1, 2]
    assert packed_bytes(packed) <= 4000


def test_recent_raw_wins_and_an_oversized_summary_leaves_only_its_pointer():
    events = [message(index, 'user', f'Synthetic turn {index} ' + 'x' * 300) for index in range(1, 6)]
    text = '摘要' * 2000
    packed = pack_context('', events, 2000, compaction={'sequence': 9, 'content': text})
    assert packed['compaction_summary'] == {'sequence': 9, 'bytes': len(text.encode())}
    assert packed['messages'] and packed['messages'][-1]['sequence'] == 5
    assert packed_bytes(packed) <= 2000
    without = pack_context('', events, 2000)
    assert 'compaction_summary' not in without
    # The pointer may cost one older message, never the newest.
    assert len(without['messages']) - len(packed['messages']) <= 1


def test_a_budget_too_tight_for_the_pointer_drops_it():
    packed = pack_context('', [], 300, {'status': 'completed', 'summary': 'Synthetic checkpoint ' * 40},
                          compaction={'sequence': 9, 'content': 'Synthetic client summary'})
    assert 'compaction_summary' not in packed
    assert packed_bytes(packed) <= 300

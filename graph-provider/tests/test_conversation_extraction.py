"""Deterministic extractive compaction; all fixtures are synthetic test data."""
import json

from fuli_graph.conversation_context import (
    ENTRY_BYTES, ASSISTANT_LINES, add_task_result, assistant_positions, fold_messages, pack_context, render_digest,
)


def message(sequence, role, content, kind='message'):
    return {'sequence': sequence, 'role': role, 'content': content, 'kind': kind}


def texts(digest):
    return [entry['text'] for entry in digest['entries']]


def test_keeps_decision_after_title_line_and_assistant_method():
    digest = fold_messages({}, [
        message(1, 'user', 'Synthetic login redirect\nWe decided to keep the session cookie.\nunrelated chatter'),
        message(2, 'assistant', 'Sure.\nMethod: replay the redirect with a fixture token.\nok'),
        message(3, 'tool', 'Decision: tool output is never retained'),
    ])
    assert 'Synthetic login redirect' in texts(digest)
    decision = next(entry for entry in digest['entries'] if entry['text'].startswith('We decided'))
    assert decision['kind'] == 'decision'
    assert decision['sources'] == [{'role': 'user', 'sequence': 1}]
    method = next(entry for entry in digest['entries'] if entry['kind'] == 'method')
    assert method['text'] == 'Method: replay the redirect with a fixture token.'
    assert method['sources'] == [{'role': 'assistant', 'sequence': 2}]
    assert not any('tool output' in text for text in texts(digest))
    assert not any(text in ('Sure.', 'ok', 'unrelated chatter') for text in texts(digest))
    assert digest['omitted'] == 3


def test_later_correction_and_unresolved_work_do_not_erase_older_sources():
    digest = fold_messages({}, [message(1, 'user', 'Plan\nDecision: use port 3000.')])
    digest = fold_messages(digest, [
        message(5, 'user', 'Status\nCorrection: actually use port 4000 instead.'),
        message(6, 'assistant', 'Done\nTODO: migrate the remaining fixture config.'),
    ])
    kinds = {entry['text']: entry['kind'] for entry in digest['entries']}
    assert kinds['Decision: use port 3000.'] == 'decision'
    assert kinds['Correction: actually use port 4000 instead.'] == 'correction'
    assert kinds['TODO: migrate the remaining fixture config.'] == 'open'
    text = render_digest(digest)
    assert text.index('port 3000') < text.index('port 4000')
    assert 'user #1' in text and 'user #5' in text and 'assistant #6' in text


def test_repeated_compaction_dedups_additively_and_stays_bounded():
    digest = {}
    for round_index in range(30):
        base = round_index * 10
        digest = fold_messages(digest, [
            message(base + 1, 'user', f'Synthetic round {round_index} ' + 'context ' * 25 + '\nDecision: keep raw history.'),
            message(base + 2, 'assistant', f'Note {round_index}\nUnresolved: verify round {round_index}.'),
        ])
    decision = [entry for entry in digest['entries'] if entry['text'] == 'Decision: keep raw history.']
    assert len(decision) == 1
    assert decision[0]['sources'][-1] == {'role': 'user', 'sequence': 291}
    assert len(decision[0]['sources']) <= 4
    size = sum(len(entry['text'].encode()) for entry in digest['entries'])
    assert size <= 6000
    assert digest['omitted'] > 0
    # Open work outranks request titles, so old titles are evicted first.
    assert 'Unresolved: verify round 29.' in texts(digest)
    assert 'Unresolved: verify round 0.' in texts(digest)
    assert not any(text.startswith('Synthetic round 0 ') for text in texts(digest))
    assert any(text.startswith('Synthetic round 29 ') for text in texts(digest))


def test_unicode_lines_are_bounded_by_utf8_bytes_and_marked_truncated():
    digest = fold_messages({}, [message(1, 'user', '决定：' + '保留原始记录' * 100)])
    entry = digest['entries'][0]
    assert entry['kind'] == 'decision'
    assert len(entry['text'].encode()) <= ENTRY_BYTES
    assert entry['text'].endswith('…') and entry['truncated'] is True
    entry['text'].encode().decode()  # never splits a code point


def test_legacy_digest_remains_readable_and_new_entries_append():
    legacy = {'tasks': [], 'notes': ['修复登录跳转']}
    legacy = add_task_result(legacy, '2026-10-01T00:00:00+00:00', 'completed', 'Synthetic result')
    digest = fold_messages(legacy, [message(9, 'user', 'Next: confirm the 待办 list')])
    assert digest['notes'] == ['修复登录跳转']
    text = render_digest(digest)
    assert text.startswith('[2026-10-01 completed] Synthetic result')
    assert 'Earlier requests:\n- 修复登录跳转' in text
    assert '- Next: confirm the 待办 list [open, user #9]' in text
    assert 'not verified' in text


def test_render_budget_prefers_decisions_and_reports_omissions():
    events = [message(index, 'user', f'Context line number {index} ' + 'x' * 120) for index in range(1, 30)]
    events.append(message(40, 'assistant', 'Final\nDecision: ship the extractive digest.'))
    digest = fold_messages({}, events)
    text = render_digest(digest, 600)
    assert len(text.encode()) <= 600
    assert 'Decision: ship the extractive digest. [decision, assistant #40]' in text
    assert 'omitted' in text
    packed = pack_context(render_digest(digest, 1000), [], 2000)
    assert len(json.dumps(packed, ensure_ascii=False, separators=(',', ':')).encode()) <= 2000


def test_truncated_lines_with_shared_prefix_are_not_conflated():
    prefix = 'Decision: ' + 'shared synthetic prefix ' * 12
    digest = fold_messages({}, [
        message(1, 'user', f'Title\n{prefix} keep the A path'),
        message(2, 'assistant', f'Title two\n{prefix} keep the B path'),
    ])
    decisions = [entry for entry in digest['entries'] if entry['kind'] == 'decision']
    assert len(decisions) == 2
    assert [entry['sources'] for entry in decisions] == [[{'role': 'user', 'sequence': 1}],
                                                        [{'role': 'assistant', 'sequence': 2}]]


def test_same_source_is_not_repeated_and_fenced_code_counts_as_omitted():
    digest = fold_messages({}, [message(3, 'user', 'Decision: keep it.\nDecision: keep it.\n```\nprint(1)\n```')])
    assert digest['entries'][0]['sources'] == [{'role': 'user', 'sequence': 3}]
    assert digest['omitted'] == 1  # the code line; fence markers are not content
    digest = fold_messages(digest, [message(3, 'user', 'Decision: keep it.')])
    assert digest['entries'][0]['sources'] == [{'role': 'user', 'sequence': 3}]


def test_render_budget_bounds_oversized_tasks_and_keeps_newer_decisions():
    oversized = {'tasks': [{'at': '2026-10-01', 'status': 'completed', 'summary': 'Synthetic long summary ' * 100}]}
    text = render_digest(oversized, 600)
    assert len(text.encode()) <= 600
    assert 'Synthetic long summary' in text and '…' in text
    assert 'truncated' in text
    mixed = add_task_result({}, '2026-10-01T00:00:00+00:00', 'completed', 'Synthetic result ' * 60)
    for index in range(10):
        mixed = add_task_result(mixed, f'2026-10-{index + 2:02d}T00:00:00+00:00', 'completed', f'Task {index} ' * 20)
    mixed = fold_messages({**mixed, 'notes': ['Legacy synthetic note']}, [
        message(50, 'assistant', 'Wrap\nDecision: keep the newest decision visible.')])
    text = render_digest(mixed, 800)
    assert len(text.encode()) <= 800
    assert 'Decision: keep the newest decision visible. [decision, assistant #50]' in text
    assert '[2026-10-11 completed] Task 9' in text
    assert 'omitted' in text


def test_dedup_keeps_case_and_internal_whitespace_distinct():
    digest = fold_messages({}, [
        message(1, 'user', 'Decision: use case-sensitive key ABC'),
        message(2, 'user', 'Decision: use case-sensitive key abc'),
        message(3, 'assistant', 'Decision: set value "a  b"'),
        message(4, 'assistant', 'Decision: set value "a b"'),
        message(5, 'user', 'Decision: use case-sensitive key ABC'),
    ])
    assert texts(digest) == ['Decision: use case-sensitive key ABC', 'Decision: use case-sensitive key abc',
                             'Decision: set value "a  b"', 'Decision: set value "a b"']
    assert digest['entries'][0]['sources'] == [{'role': 'user', 'sequence': 1}, {'role': 'user', 'sequence': 5}]


def test_large_batch_evicts_by_priority_and_recency_and_counts_omissions():
    # Synthetic batch: one message with thousands of unique open-work lines.
    lines = '\n'.join(f'TODO: synthetic item {index:05d}' for index in range(20000))
    digest = fold_messages({}, [
        message(1, 'user', 'Synthetic title\nDecision: keep the oldest decision.'),
        message(2, 'assistant', 'Method: an early method.'),
        message(3, 'user', lines),
    ])
    kept = texts(digest)
    assert len(kept) == 80
    assert sum(len(text.encode()) for text in kept) <= 6000
    # Title and method are evicted first; then the oldest equal-priority lines, so the decision too.
    assert kept == [f'TODO: synthetic item {index:05d}' for index in range(19920, 20000)]
    assert digest['omitted'] == 20003 - 80


def test_eviction_keeps_display_order_and_high_priority_when_bytes_bound():
    events = [message(index, 'user', f'Synthetic title {index} ' + 'x' * 200) for index in range(1, 40)]
    events.append(message(50, 'assistant', 'Decision: survive byte eviction.'))
    events.append(message(51, 'user', 'Newest title ' + 'y' * 200))
    digest = fold_messages({}, events)
    kept = texts(digest)
    assert kept[-2:] == ['Decision: survive byte eviction.', 'Newest title ' + 'y' * 200]
    assert kept[:-2] == [f'Synthetic title {index} ' + 'x' * 200 for index in range(42 - len(kept), 40)]
    assert sum(len(text.encode()) for text in kept) <= 6000
    assert digest['omitted'] == 41 - len(kept)


def test_interim_narration_is_dropped_and_only_labelled_interim_lines_survive():
    digest = fold_messages({}, [
        message(1, 'user', 'Synthetic: shrink the hook entry'),
        message(2, 'assistant', 'Writing the file directly instead.\nNow rerunning the tests.'),
        message(3, 'tool', '{"call_id":"t1"}', kind='tool_result'),
        message(4, 'assistant', 'Checking the transcript next.\nRoot cause: the entry check compares link and real paths.'),
        message(5, 'assistant', 'Done.\n- Fixed the entry check for linked installs.\n'
                                '| Item | Before | After |\n|---|---|---|\n| Entry | 14,794 | 8,180 |\n'
                                '**Kept unchanged:** the Codex tool profile.\nThanks for waiting.'),
    ])
    kinds = {entry['text']: entry['kind'] for entry in digest['entries']}
    assert 'Writing the file directly instead.' not in kinds
    assert 'Now rerunning the tests.' not in kinds
    assert kinds['Root cause: the entry check compares link and real paths.'] == 'outcome'
    assert kinds['Fixed the entry check for linked installs.'] == 'outcome'
    assert kinds['| Entry | 14,794 | 8,180 |'] == 'outcome'
    assert kinds['**Kept unchanged:** the Codex tool profile.'] == 'outcome'
    assert '|---|---|---|' not in kinds
    assert 'Done.' not in kinds and 'Thanks for waiting.' not in kinds
    assert '[outcome, assistant #5]' in render_digest(digest)


def test_each_user_message_starts_a_new_turn_and_a_fold_boundary_ends_one():
    digest = fold_messages({}, [
        message(1, 'user', 'First request'),
        message(2, 'assistant', '- Interim list item is narration.'),
        message(3, 'assistant', '- First turn conclusion.'),
        message(4, 'user', 'Second request'),
        message(5, 'assistant', '- Cut by the fold boundary, so treated as final.'),
    ])
    found = texts(digest)
    assert 'Interim list item is narration.' not in found
    assert 'First turn conclusion.' in found
    assert 'Cut by the fold boundary, so treated as final.' in found


def test_a_tight_budget_keeps_the_lead_points_of_a_long_reply():
    reply = '\n'.join(['**Key finding:** the hook never ran on linked installs.']
                      + [f'- Detail {index}: ' + 'measured value ' * 6 for index in range(40)])
    digest = fold_messages({}, [message(1, 'user', 'Synthetic report'), message(2, 'assistant', reply)])
    text = render_digest(digest, 600)
    assert '**Key finding:** the hook never ran on linked installs.' in text
    assert 'Detail 0:' in text and 'Detail 39:' not in text


def test_long_development_session_keeps_its_decisions_not_its_narration():
    # Synthetic replay of the failure found in a real session: many progress
    # messages between tool calls, then one summarising reply.
    narration = ['Checking why the console fails to start.', 'Writing the file directly instead.',
                 'Next: tests for the session dedupe.', 'Partial apply (escape issue). Finishing the edits.',
                 'Rerunning the full suite in the background.'] * 6
    events = [message(1, 'user', 'Continue the P0 and P1 work on this branch.')]
    for index, text in enumerate(narration, start=2):
        events.append(message(index, 'assistant', text))
        events.append(message(index, 'tool', '{}', kind='tool_result'))
    events.append(message(100, 'assistant', '\n'.join([
        '**Most important finding: hooks never ran on this machine**',
        '- Linked installs failed the entry check, so no context was injected. Fixed.',
        '- Unchanged rules and preferences are referenced only with transcript proof.',
        '- The Codex tool profile stays full: both profiles cost 22,995 input tokens.',
        '- Usage bundling into the checkpoint was reverted after review.',
        '1. **Trust the hooks in Codex** with /hooks; this needs the user.',
    ])))
    digest = fold_messages({}, events)
    text = render_digest(digest, 2000)
    for kept in ('hooks never ran', 'Linked installs', 'transcript proof', '22,995', 'reverted', '/hooks'):
        assert kept in text, kept
    for dropped in ('Checking why', 'directly instead', 'session dedupe', 'escape issue', 'full suite'):
        assert dropped not in text, dropped


def test_packed_context_rerenders_instead_of_cutting_the_lead_point():
    # Windows paths double in JSON; a pre-rendered text would lose its first lines.
    lead = r'**Root finding:** C:\nvm4w\nodejs\node_modules\fuli-context hooks never ran.'
    details = [rf'- Detail {index}: C:\Users\synthetic\AppData\Local\Fuli\file-{index}.md' for index in range(30)]
    digest = fold_messages({}, [message(1, 'user', 'Synthetic report'), message(2, 'assistant', '\n'.join([lead, *details]))])
    packed = pack_context(lambda limit: render_digest(digest, limit), [], 2000,
                          {'status': 'completed', 'summary': 'Synthetic checkpoint'})
    assert lead in packed['summary']
    assert packed['summary'].startswith('Extracted from earlier messages')
    assert len(json.dumps(packed, ensure_ascii=False, separators=(',', ':')).encode()) <= 2000
    assert packed['latest_checkpoint']['summary'] == 'Synthetic checkpoint'


def test_long_lists_are_capped_per_reply_and_user_corrections_outrank_them():
    events = [message(1, 'user', 'Synthetic task\nCorrection: never touch the production config.')]
    for turn in range(12):
        base = 10 + turn * 2
        events.append(message(base, 'user', f'Continue part {turn}'))
        events.append(message(base + 1, 'assistant', '\n'.join(f'- Part {turn} note {index}' for index in range(100))))
    digest = fold_messages({}, events)
    found = texts(digest)
    assert 'Correction: never touch the production config.' in found
    assert not any(text.startswith(f'Part 11 note {ASSISTANT_LINES} ') for text in found)
    assert sum(text.startswith('Part 11 ') for text in found) == ASSISTANT_LINES
    assert len(found) <= 80


def test_labels_survive_list_numbering_and_bold_in_interim_messages():
    digest = fold_messages({}, [
        message(1, 'user', 'Synthetic'),
        message(2, 'assistant', '1. TODO: rebuild the provider image.\n- **Decision**: keep raw history.\nworking on it'),
        message(3, 'assistant', 'Final.'),
    ])
    kinds = {entry['text']: entry['kind'] for entry in digest['entries']}
    assert kinds['1. TODO: rebuild the provider image.'] == 'open'
    assert kinds['**Decision**: keep raw history.'] == 'decision'
    assert 'working on it' not in kinds


def test_table_headers_are_not_outcomes():
    digest = fold_messages({}, [message(1, 'user', 'Synthetic'), message(2, 'assistant',
                                '| Item | Before | After |\n|---|---|---|\n| Entry | 14,794 | 8,180 |')])
    assert texts(digest) == ['Synthetic', '| Entry | 14,794 | 8,180 |']


def test_a_fold_boundary_uses_the_messages_kept_after_it():
    events = [message(1, 'user', 'Synthetic'), message(2, 'assistant', '- Progress list before the cut.'),
              message(3, 'assistant', '- The real conclusion after the cut.')]
    folded = fold_messages({}, events[:2], assistant_positions(events))
    assert 'Progress list before the cut.' not in texts(folded)


def test_a_user_statement_keeps_its_priority_after_its_source_list_is_trimmed():
    events = [message(1, 'user', 'Synthetic'), message(2, 'assistant', 'Decision: keep the raw history.'),
              message(3, 'user', 'Decision: keep the raw history.')]
    for turn in range(4):
        events += [message(10 + turn * 2, 'user', f'Turn {turn}'),
                   message(11 + turn * 2, 'assistant', 'Decision: keep the raw history.')]
    for turn in range(5):
        events += [message(40 + turn * 2, 'user', f'List {turn}'),
                   message(41 + turn * 2, 'assistant', '\n'.join(f'- List {turn} item {index}' for index in range(30)))]
    digest = fold_messages({}, events)
    entry = next(entry for entry in digest['entries'] if entry['text'] == 'Decision: keep the raw history.')
    assert entry['user'] is True
    assert all(source['role'] == 'assistant' for source in entry['sources'][1:])


def test_every_assistant_line_counts_toward_the_reply_limit():
    digest = fold_messages({}, [message(1, 'user', 'Synthetic'), message(2, 'assistant',
                                '\n'.join(f'**Result**: item {index}' for index in range(100)))])
    assert sum(text.startswith('**Result**') for text in texts(digest)) == ASSISTANT_LINES


def test_table_headers_with_keywords_are_not_classified():
    digest = fold_messages({}, [message(1, 'user', 'Synthetic'), message(2, 'assistant',
                                '| Decision | Before | After |\n|---|---|---|\n| Entry | 14,794 | 8,180 |')])
    assert texts(digest) == ['Synthetic', '| Entry | 14,794 | 8,180 |']


def test_a_cut_checkpoint_borrows_what_the_summary_left_unused():
    checkpoint = {'status': 'incomplete', 'summary': 'Synthetic outcome. ' * 120}
    packed = pack_context(lambda limit: 'Short digest.', [], 4000, checkpoint)
    assert packed['latest_checkpoint']['truncated'] is False
    assert packed['truncated'] is False
    assert len(json.dumps(packed, ensure_ascii=False, separators=(',', ':')).encode()) <= 4000
    crowded = pack_context(lambda limit: 'x' * limit, [], 4000, checkpoint)
    assert crowded['latest_checkpoint']['truncated'] is True
    assert crowded['truncated'] is True


def test_an_older_digest_keeps_user_priority_when_its_user_source_is_trimmed():
    legacy = {'entries': [{'kind': 'decision', 'text': 'Decision: keep the raw history.', 'sources': [
        {'role': 'assistant', 'sequence': 1}, {'role': 'user', 'sequence': 2},
        {'role': 'assistant', 'sequence': 3}, {'role': 'assistant', 'sequence': 4}]}]}
    digest = fold_messages(legacy, [message(5, 'assistant', 'Decision: keep the raw history.')])
    entry = digest['entries'][0]
    assert entry['user'] is True
    assert {'role': 'user', 'sequence': 2} not in entry['sources']


def test_checkpoint_borrowing_shrinks_to_fit_instead_of_giving_up():
    checkpoint = {'status': 'incomplete', 'summary': '中' * 2000}
    packed = pack_context(lambda limit: 'Short digest.', [], 4000, checkpoint)
    borrowed = len(packed['latest_checkpoint']['summary'].encode())
    plain = len(pack_context('Short digest.' * 80, [], 4000, checkpoint)['latest_checkpoint']['summary'].encode())
    assert borrowed > plain
    assert len(json.dumps(packed, ensure_ascii=False, separators=(',', ':')).encode()) <= 4000

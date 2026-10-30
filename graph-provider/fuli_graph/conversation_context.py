"""Deterministic conversation compaction and recovery: no model calls.

Older messages fold into a bounded digest once the unfolded text passes a size
threshold; raw events are always retained. Folding is an index, not a summary:
it keeps the first line of each user request and points at each compaction
summary the Agent client wrote for its own context, with source role and
sequence. Keyword-picked lines were dropped: on blind-labelled sessions
they were almost all chatter. Default recovery carries the latest checkpoint,
recent raw and the latest client compaction summary, bounded in UTF-8 bytes.
"""
import json

from .provider_values import sha256_text

# Bump when the folding rules change; an older digest is rebuilt from raw events.
DIGEST_VERSION = 3
DIGEST_TASKS = 12
DIGEST_BYTES = 6000
DIGEST_ENTRIES = 80
ENTRY_BYTES = 240
ENTRY_SOURCES = 4
COMPACTION_KIND = 'compaction_summary'

# Lower value is evicted first; within a priority, the least recently seen goes first.
PRIORITY = {'request': 0, 'compaction': 1}


def message_bytes(event):
    if event['role'] not in ('user', 'assistant') or event.get('kind', 'message') != 'message':
        return 0
    return len(event['content'].encode())


def bounded_text(text, limit=ENTRY_BYTES):
    raw = text.encode()
    if len(raw) <= limit:
        return text, False
    # Drop any partial code point rather than emitting invalid UTF-8.
    return raw[:limit - len('…'.encode())].decode(errors='ignore') + '…', True


def add_task_result(digest, at, status, summary):
    tasks = [*digest.get('tasks', []), {'at': at, 'status': status, 'summary': summary}]
    return {**digest, 'tasks': tasks[-DIGEST_TASKS:]}


def note_compaction(digest, sequence, size):
    """Point at the newest client compaction summary; recovery reads it by sequence."""
    return {**digest, 'compaction': {'sequence': sequence, 'bytes': size}}


def extract_lines(event):
    """Yield (kind, line) candidates and the count of lines left out."""
    if event['role'] == 'summary' and event.get('kind') == COMPACTION_KIND:
        # One preview per summary; its full text stays in the raw event.
        return [('compaction', ' '.join(event['content'].split()))], 0
    if event['role'] not in ('user', 'assistant') or event.get('kind', 'message') != 'message':
        return [], 0
    lines, fenced, omitted = [], False, 0
    for part in event['content'].splitlines():
        line = part.strip()
        if line.startswith('```'):
            fenced = not fenced
            continue
        if line and fenced:
            omitted += 1  # code is never extracted, but it is still left out
        elif line:
            lines.append(line)
    if event['role'] == 'user' and lines:
        return [('request', lines[0])], omitted + len(lines) - 1
    return [], omitted + len(lines)


def last_sequence(entry):
    return entry['sources'][-1]['sequence']


def evict_order(entries):
    return sorted(range(len(entries)), key=lambda i: (PRIORITY.get(entries[i]['kind'], 0), last_sequence(entries[i])))


def fold_messages(digest, events):
    entries = [{**entry, 'sources': list(entry['sources'])} for entry in digest.get('entries', [])]
    # Lines are already trimmed; exact equality keeps case and inner spacing significant.
    # Truncated text is only a prefix, so it never identifies a line for dedup.
    index = {entry['text']: entry for entry in entries if not entry.get('truncated')}
    omitted = digest.get('omitted', 0)
    for event in events:
        found, skipped = extract_lines(event)
        omitted += skipped
        source = {'role': event['role'], 'sequence': event['sequence']}
        for kind, line in found:
            text, truncated = bounded_text(line)
            existing = None if truncated else index.get(text)
            if existing:
                if source not in existing['sources']:
                    # Additive dedup: keep the first source and the newest ones.
                    sources = [*existing['sources'], source]
                    existing['sources'] = sources[:1] + sources[1:][-(ENTRY_SOURCES - 1):]
                continue
            entry = {'kind': kind, 'text': text, 'sources': [source]}
            if truncated:
                entry['truncated'] = True
            else:
                index[text] = entry
            entries.append(entry)
    # One eviction order and a running byte total; display order is kept.
    total = sum(len(entry['text'].encode()) for entry in entries)
    count, dropped = len(entries), set()
    for position in evict_order(entries):
        if count <= DIGEST_ENTRIES and total <= DIGEST_BYTES:
            break
        dropped.add(position)
        count -= 1
        total -= len(entries[position]['text'].encode())
    omitted += len(dropped)
    entries = [entry for position, entry in enumerate(entries) if position not in dropped]
    return {**digest, 'entries': entries, 'omitted': omitted, 'version': DIGEST_VERSION}


def refold_digest(digest, events):
    """Rebuild extracted entries with the current rules from the raw events they came from.

    Task results come from checkpoints and the compaction pointer from appends,
    not from the folded events, so both are kept.
    """
    kept = {key: digest[key] for key in ('tasks', 'compaction') if key in digest}
    return fold_messages(kept, events)


def json_bytes(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode())


def _fit_prefix(text, target, key, fits):
    """Measure the complete JSON after each Unicode-safe prefix candidate."""
    low, high, best = 0, len(text), ''
    while low <= high:
        middle = (low + high) // 2
        target[key] = text[:middle] + '…'
        if fits():
            best, low = target[key], middle + 1
        else:
            high = middle - 1
    target[key] = best


def pack_context(summary, events, budget, checkpoint=None, *, conversation_id=None, revision=None,
                 omitted_sequence=None, scan_truncated=False, compaction=None):
    # Keep the old empty summary fields for readers; digests remain in history,
    # never compete with the latest checkpoint and visible raw messages here.
    # `compaction` is the newest client compaction summary ({sequence, content}):
    # its pointer goes in first, its text only into what recent raw leaves free.
    latest = ({'status': checkpoint['status'], 'summary': checkpoint['summary'], 'truncated': False}
              if checkpoint and checkpoint.get('summary') else None)
    result = {'summary': '', 'messages': [], 'truncated': omitted_sequence is not None or scan_truncated,
              'summary_role': 'historical', 'latest_checkpoint': latest,
              'conversation_id': conversation_id, 'revision': revision,
              'omitted_sequence': omitted_sequence, 'scan_truncated': scan_truncated}
    messages = [event for event in events if message_bytes(event)]

    def fits():
        return json_bytes(result) <= budget

    if compaction:
        result['compaction_summary'] = {'sequence': compaction['sequence'],
                                        'bytes': len(compaction['content'].encode())}
        if not fits():
            del result['compaction_summary']

    def fit_checkpoint():
        if latest and not fits():
            result['truncated'] = latest['truncated'] = True
            _fit_prefix(checkpoint['summary'], latest, 'summary', fits)

    if not fits():
        if messages:
            result['omitted_sequence'] = messages[-1].get('sequence')
        fit_checkpoint()
        return result
    for event in reversed(messages):
        item = {'sequence': event.get('sequence'), 'role': event['role'], 'content': event['content']}
        result['messages'].insert(0, item)
        if fits():
            continue
        result['messages'].pop(0)
        result['truncated'] = True
        result['omitted_sequence'] = event.get('sequence')
        # A longer numeric omission anchor also counts against the same budget.
        while result['messages'] and not fits():
            result['omitted_sequence'] = result['messages'].pop(0)['sequence']
        if not result['messages']:
            # A huge newest message must not be skipped in favor of older small
            # messages. Keep its prefix if possible, with an exact event anchor.
            newest = messages[-1]
            result['omitted_sequence'] = newest.get('sequence')
            fit_checkpoint()
            item = {'sequence': newest.get('sequence'), 'role': newest['role'], 'content': '', 'truncated': True}
            result['messages'].append(item)
            if fits():
                _fit_prefix(newest['content'], item, 'content', fits)
            else:
                result['messages'].clear()
        break
    if 'compaction_summary' in result:
        result['compaction_summary']['content'] = compaction['content']
        if not fits():
            del result['compaction_summary']['content']
    return result


def add_delivery_proofs(context, events, source_application, session_id):
    """Host-only proofs for the asking session, added after packing so they never
    spend the recovery budget: each message's full-content SHA-256 (a truncated
    prefix keeps the hash of the whole message) and, for that session's own
    native events, the event ID that names its native record."""
    by_sequence = {event['sequence']: event for event in events}
    for item in context['messages']:
        event = by_sequence[item['sequence']]
        item['content_sha256'] = sha256_text(event['content'])
        if (event.get('source_application'), event.get('session_id')) == (source_application, session_id):
            item['own_event'] = event['event_id']
    return context

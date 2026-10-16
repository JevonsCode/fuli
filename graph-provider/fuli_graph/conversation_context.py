"""Deterministic conversation compaction and recovery: no model calls.

Older messages fold into a bounded digest once the unfolded text passes a size
threshold; raw events are always retained. Folding is extractive: it keeps the
first line of each user request plus user/assistant lines that match explicit
decision, correction, open-work or method markers, each with its source role
and sequence. It does not understand meaning, so it can miss unmarked content
and mislabel marked lines; omissions are counted and the raw history remains the
authority. Default recovery carries the latest checkpoint and recent raw, not
the digest; its whole serialized JSON is bounded in UTF-8 bytes.
"""
import json
import re

DIGEST_TASKS = 12
DIGEST_BYTES = 6000
DIGEST_ENTRIES = 80
ENTRY_BYTES = 240
ENTRY_SOURCES = 4

# Checked in order: a correction that also names a method stays a correction.
MARKERS = (
    ('correction', re.compile(r'\b(correction|actually|instead|rather than|no longer|was wrong)\b'
                              r'|更正|纠正|改为|改成|不再|其实', re.I)),
    ('decision', re.compile(r'\b(decided?|decision|agreed|we will|chose)\b|决定|决策|确定|采用|约定', re.I)),
    ('open', re.compile(r'\b(todo|unresolved|open question|pending|blocked|remaining|follow[- ]up|not yet)\b'
                        r'|\bnext(\s+steps?)?\s*:|待办|未解决|待确认|下一步|遗留|阻塞|未完成', re.I)),
    ('method', re.compile(r'\b(method|approach|steps?|workaround|procedure|how to)\b|方法|步骤|方案|做法', re.I)),
)
# Lower value is evicted first; within a priority, the least recently seen goes first.
PRIORITY = {'request': 0, 'method': 1, 'decision': 2, 'correction': 2, 'open': 2}


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


def extract_lines(event):
    """Yield (kind, line) candidates and the count of lines left out."""
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
    found = []
    for index, line in enumerate(lines):
        kind = next((name for name, pattern in MARKERS if pattern.search(line)), None)
        if kind is None and index == 0 and event['role'] == 'user':
            kind = 'request'
        if kind is None:
            omitted += 1
        else:
            found.append((kind, line))
    return found, omitted


def last_sequence(entry):
    return entry['sources'][-1]['sequence']


def evict_order(entries):
    return sorted(range(len(entries)), key=lambda i: (PRIORITY[entries[i]['kind']], last_sequence(entries[i])))


def fold_messages(digest, events):
    entries = [{**entry, 'sources': list(entry['sources'])} for entry in digest.get('entries', [])]
    # Lines are already trimmed; exact equality keeps case and inner spacing significant.
    # Truncated text is only a prefix, so it never identifies a line for dedup.
    index = {entry['text']: entry for entry in entries if not entry.get('truncated')}
    omitted = digest.get('omitted', 0)
    for event in events:
        if event['role'] not in ('user', 'assistant') or event.get('kind', 'message') != 'message':
            continue
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
    return {**digest, 'entries': entries, 'omitted': omitted}


def entry_line(entry):
    sources = ', '.join(f"{source['role']} #{source['sequence']}" for source in entry['sources'])
    return f"- {entry['text']} [{entry['kind']}, {sources}]"


def render_digest(digest, budget=None):
    """Render recovery text; a byte budget bounds the whole text, dropping
    legacy notes, request titles and methods, then the oldest task results,
    and only then decisions, corrections and open work."""
    tasks = list(digest.get('tasks', []))
    notes = list(digest.get('notes', []))
    entries = list(digest.get('entries', []))
    omitted = digest.get('omitted', 0)
    truncated = 0

    def task_line(task):
        nonlocal truncated
        summary = task['summary']
        if budget is not None:
            summary, cut = bounded_text(summary)
            truncated += cut
        return f"[{task['at'][:10]} {task['status']}] {summary}"

    def text():
        nonlocal truncated
        truncated = 0
        lines = [task_line(task) for task in tasks]
        if notes:
            lines += ['Earlier requests:', *(f'- {note}' for note in notes)]
        if entries:
            lines += ['Extracted from earlier messages (not verified working memory; originals retained):',
                      *map(entry_line, entries)]
        if omitted or truncated:
            lines.append(f'({omitted} earlier lines omitted, {truncated} task results truncated; '
                         'read the original history for details)')
        return '\n'.join(lines)

    if budget is None:
        return text()
    while len(text().encode()) > budget:
        low = [i for i in evict_order(entries) if PRIORITY[entries[i]['kind']] < PRIORITY['decision']]
        if notes:
            notes.pop(0)
        elif low:
            entries.pop(low[0])
        elif tasks:
            tasks.pop(0)
        elif entries:
            entries.pop(evict_order(entries)[0])
        else:
            return bounded_text(text(), budget)[0]
        omitted += 1
    return text()


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
                 omitted_sequence=None, scan_truncated=False):
    # Keep the old empty summary fields for readers; digests remain in history,
    # never compete with the latest checkpoint and visible raw messages here.
    latest = ({'status': checkpoint['status'], 'summary': checkpoint['summary'], 'truncated': False}
              if checkpoint and checkpoint.get('summary') else None)
    result = {'summary': '', 'messages': [], 'truncated': omitted_sequence is not None or scan_truncated,
              'summary_role': 'historical', 'latest_checkpoint': latest,
              'conversation_id': conversation_id, 'revision': revision,
              'omitted_sequence': omitted_sequence, 'scan_truncated': scan_truncated}
    messages = [event for event in events if message_bytes(event)]

    def fits():
        return json_bytes(result) <= budget

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
    return result

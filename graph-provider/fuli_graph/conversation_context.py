"""Deterministic conversation compaction and recovery: no model calls.

Older messages fold into a bounded digest once the unfolded text passes a size
threshold; raw events are always retained. Folding is extractive: it keeps the
first line of each user request plus user/assistant lines that match explicit
decision, correction, open-work or method markers, each with its source role
and sequence. An assistant turn is read by position: the final reply before the
next user message is the turn's conclusion, so its structured summary lines
(list items, table rows, bold-led lines) are kept as outcomes; interim messages
written while tools run are progress narration, so only explicitly labelled
lines survive from them. It does not understand meaning, so it can miss
unmarked content and mislabel marked lines; omissions are counted and the raw
history remains the authority. Sizes are conservative UTF-8 bytes.
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
# Interim narration keeps only lines that name their kind explicitly.
LABELLED = re.compile(
    r'^\W{0,4}(decision|decided|correction|root cause|conclusion|result|todo|open question|unresolved|blocked'
    r'|决定|决策|结论|根因|原因|更正|纠正|待办|未解决|阻塞)\s*[:：]', re.I)
LIST_PREFIX = re.compile(r'^([-*•]\s+|\d+[.)、]\s*)')
# Structured lines of a final reply: list items, table rows and bold-led lines.
# An assistant message contributes at most its leading lines, so ordinary lists
# cannot crowd out other turns.
STRUCTURED = re.compile(r'^([-*•]\s+|\d+[.)、]\s*|\|.*\||\*\*)')
TABLE_ROW = re.compile(r'^\|.*\|$')
TABLE_RULE = re.compile(r'^\|[\s|:-]+\|$')
ASSISTANT_LINES = 20
# Lower value is evicted first; within a priority, the least recently seen goes
# first. Within one assistant reply the later lines go first, because a reply
# leads with its most important points. A user's own decisions, corrections and
# open work outrank anything an Agent wrote.
PRIORITY = {'request': 0, 'method': 1, 'decision': 2, 'correction': 2, 'open': 2, 'outcome': 2}
USER_STATEMENTS = ('decision', 'correction', 'open')


def is_labelled(line):
    # "1. TODO: x", "- **Decision**: x" and "Decision: x" name their kind alike.
    return bool(LABELLED.search(LIST_PREFIX.sub('', line).replace('**', '')))


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


def extract_lines(event, position='final'):
    """Yield (kind, line) candidates and the count of lines left out.
    position applies to assistant messages: 'final' or 'interim'."""
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
    assistant = event['role'] == 'assistant'
    for index, line in enumerate(lines):
        # Table rules and header rows state nothing on their own.
        header = TABLE_ROW.match(line) and index + 1 < len(lines) and TABLE_RULE.match(lines[index + 1])
        if TABLE_RULE.match(line) or header:
            omitted += 1
            continue
        labelled = assistant and is_labelled(line)
        if assistant and position == 'interim' and not labelled:
            omitted += 1  # progress narration
            continue
        kind = next((name for name, pattern in MARKERS if pattern.search(line)), None)
        if kind is None and index == 0 and event['role'] == 'user':
            kind = 'request'
        if kind is None and assistant and (labelled or (position == 'final' and STRUCTURED.search(line))):
            kind = 'outcome'
        if kind is not None and assistant and len(found) >= ASSISTANT_LINES:
            kind = None  # one reply cannot fill the digest
        if kind is None:
            omitted += 1
        else:
            found.append((kind, re.sub(r'^[-*•]\s+', '', line)))
    return found, omitted


def assistant_positions(events):
    """Map each assistant message's sequence to 'interim' when another assistant
    message follows it before the next user message; the last one is 'final'.
    Pass every known event, including those not yet folded, so a turn cut by a
    fold boundary is judged with what followed it."""
    positions, pending = {}, None
    for event in events:
        if event.get('kind', 'message') != 'message' or event['role'] not in ('user', 'assistant'):
            continue
        if event['role'] == 'assistant':
            if pending is not None:
                positions[pending] = 'interim'
            pending = event['sequence']
            positions[pending] = 'final'
        else:
            pending = None
    return positions


def last_sequence(entry):
    return entry['sources'][-1]['sequence']


def evict_order(entries):
    def key(i):
        entry = entries[i]
        order = -i if entry['sources'][-1]['role'] == 'assistant' else i
        user = entry['kind'] in USER_STATEMENTS and (
            entry.get('user', False) or any(source['role'] == 'user' for source in entry['sources']))
        return PRIORITY[entry['kind']] + user, last_sequence(entry), order
    return sorted(range(len(entries)), key=key)


def fold_messages(digest, events, positions=None):
    entries = [{**entry, 'sources': list(entry['sources'])} for entry in digest.get('entries', [])]
    # Lines are already trimmed; exact equality keeps case and inner spacing significant.
    # Truncated text is only a prefix, so it never identifies a line for dedup.
    index = {entry['text']: entry for entry in entries if not entry.get('truncated')}
    omitted = digest.get('omitted', 0)
    positions = positions or assistant_positions(events)
    for event in events:
        if event['role'] not in ('user', 'assistant') or event.get('kind', 'message') != 'message':
            continue
        found, skipped = extract_lines(event, positions.get(event['sequence'], 'final'))
        omitted += skipped
        source = {'role': event['role'], 'sequence': event['sequence']}
        for kind, line in found:
            text, truncated = bounded_text(line)
            existing = None if truncated else index.get(text)
            if existing:
                if event['role'] == 'user':
                    existing['user'] = True  # survives the bounded source list below
                if source not in existing['sources']:
                    # Additive dedup: keep the first source and the newest ones.
                    sources = [*existing['sources'], source]
                    existing['sources'] = sources[:1] + sources[1:][-(ENTRY_SOURCES - 1):]
                continue
            entry = {'kind': kind, 'text': text, 'sources': [source]}
            if event['role'] == 'user':
                entry['user'] = True
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


def latest_checkpoint(checkpoint, limit):
    """The caller's latest task result, kept from its start so completed work
    and named artifacts survive; its serialized text stays within limit."""
    if not checkpoint or not checkpoint.get('summary'):
        return None
    summary, cut = checkpoint['summary'], False
    allowed = len(summary.encode())
    # Escapes make JSON larger than UTF-8; shrink in proportion to the measured size.
    while json_bytes(summary) > limit:
        allowed = min(allowed - 1, allowed * limit // json_bytes(summary))
        if allowed <= len('…'.encode()):
            summary, cut = '', True
            break
        summary, cut = bounded_text(checkpoint['summary'], allowed)
    return {'status': checkpoint['status'], 'summary': summary, 'truncated': cut}


def pack_context(summary, events, budget, checkpoint=None):
    # The digest is historical excerpts; latest_checkpoint is the current result.
    result = {'summary': '', 'messages': [], 'truncated': False, 'summary_role': 'historical',
              'latest_checkpoint': latest_checkpoint(checkpoint, budget // 4)}
    cut = False
    def size():
        return json_bytes(result)
    # Reserve half for recent messages, measured as serialized JSON so escapes
    # count. The checkpoint comes out of the other half.
    def too_large():
        return result['summary'] and (len(json.dumps(result['summary'], ensure_ascii=False).encode()) > budget // 2
                                      or size() > budget * 3 // 4)
    if callable(summary):
        # A renderer re-selects lines by priority at a smaller byte budget, so
        # escapes never cost the lead points of a reply.
        limit = budget // 2
        result['summary'] = summary(limit) or ''
        while too_large():
            limit -= max(64, limit // 8)
            result['summary'] = summary(limit) or '' if limit > 64 else ''
            cut = True
    else:
        # A pre-rendered text can only lose its oldest characters.
        result['summary'] = summary or ''
        while too_large():
            result['summary'] = result['summary'][64:]
            cut = True
    # A cut checkpoint may borrow what the historical summary left unused.
    current = result['latest_checkpoint']
    if current and current['truncated'] and size() < budget * 3 // 4:
        result['latest_checkpoint'] = latest_checkpoint(checkpoint, budget // 4 + budget * 3 // 4 - size())
        if size() > budget * 3 // 4:
            result['latest_checkpoint'] = current
    for event in reversed(events):
        if not message_bytes(event):
            continue
        item = {'role': event['role'], 'content': event['content']}
        result['messages'].insert(0, item)
        if size() > budget:
            result['messages'].pop(0)
            cut = True
            break
    result['truncated'] = cut or bool(result['latest_checkpoint'] and result['latest_checkpoint']['truncated'])
    return result

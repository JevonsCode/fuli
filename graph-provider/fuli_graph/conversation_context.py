"""Deterministic conversation compaction and recovery: no model calls.

Older messages fold into a bounded digest once the unfolded text passes a size
threshold; raw events are always retained. Sizes are conservative UTF-8 bytes.
"""
import json

DIGEST_TASKS = 12
DIGEST_NOTES = 40
NOTE_CHARS = 160


def message_bytes(event):
    if event['role'] not in ('user', 'assistant') or event.get('kind', 'message') != 'message':
        return 0
    return len(event['content'].encode())


def request_note(content):
    """The first line of a user request, bounded; enough to recall what was asked."""
    line = next((part.strip() for part in content.splitlines() if part.strip()), '')
    return line if len(line) <= NOTE_CHARS else line[:NOTE_CHARS - 1] + '…'


def add_task_result(digest, at, status, summary):
    tasks = [*digest.get('tasks', []), {'at': at, 'status': status, 'summary': summary}]
    return {**digest, 'tasks': tasks[-DIGEST_TASKS:]}


def fold_messages(digest, events):
    notes = [request_note(event['content']) for event in events
             if event['role'] == 'user' and event.get('kind', 'message') == 'message']
    return {**digest, 'notes': [*digest.get('notes', []), *filter(None, notes)][-DIGEST_NOTES:]}


def render_digest(digest):
    lines = [f"[{task['at'][:10]} {task['status']}] {task['summary']}" for task in digest.get('tasks', [])]
    if digest.get('notes'):
        lines += ['Earlier requests:', *(f'- {note}' for note in digest['notes'])]
    return '\n'.join(lines)


def pack_context(summary, events, budget):
    result = {'summary': '', 'messages': [], 'truncated': False}
    def size():
        return len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode())
    result['summary'] = summary or ''
    # Reserve half for recent messages; keep the newest digest lines.
    while len(result['summary'].encode()) > budget // 2:
        result['summary'] = result['summary'][64:]
        result['truncated'] = True
    for event in reversed(events):
        if not message_bytes(event):
            continue
        item = {'role': event['role'], 'content': event['content']}
        result['messages'].insert(0, item)
        if size() > budget:
            result['messages'].pop(0)
            result['truncated'] = True
            break
    return result

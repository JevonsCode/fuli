"""Deterministic recovery: no model calls, conservative UTF-8 byte accounting."""
import json
from datetime import datetime, timezone


def archived(last_activity, idle_days, *, now=None):
    current = datetime.fromisoformat(now) if now else datetime.now(timezone.utc)
    previous = datetime.fromisoformat(last_activity)
    return (current - previous).total_seconds() >= idle_days * 86400


def pack_context(summary, events, budget):
    result = {'summary': '', 'messages': [], 'truncated': False}
    def size():
        return len(json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode())
    result['summary'] = summary or ''
    # Reserve half for recent messages; Unicode slicing never splits codepoints.
    while len(result['summary'].encode()) > budget // 2:
        result['summary'] = result['summary'][:max(0, len(result['summary']) - 64)]
        result['truncated'] = True
    for event in reversed(events):
        if event['role'] not in ('user', 'assistant') or event.get('kind', 'message') != 'message':
            continue
        item = {'role': event['role'], 'content': event['content']}
        result['messages'].insert(0, item)
        if size() > budget:
            result['messages'].pop(0)
            result['truncated'] = True
            break
    return result

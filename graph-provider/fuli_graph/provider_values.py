import json
import re
from datetime import datetime, timezone
from uuid import NAMESPACE_URL, uuid5


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def stable_uuid(*parts: str) -> str:
    return str(uuid5(NAMESPACE_URL, ':'.join(parts)))


def graphiti_group_id(provider_id: str, kind: str, space_id: str) -> str:
    value = f'{provider_id}-{kind}-{space_id}'
    return re.sub(r'[^A-Za-z0-9_-]', '_', value)


def native_datetime(value):
    if value is None or isinstance(value, datetime):
        return value
    to_native = getattr(value, 'to_native', None)
    return to_native() if callable(to_native) else value


def json_object(value) -> dict:
    if not value:
        return {}
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def normalized_text(value) -> str:
    return ' '.join(str(value or '').strip().casefold().split())

"""Read the local runner's enrollment while holding its installation read lock."""
from collections import Counter
from contextlib import closing, contextmanager
import json
from pathlib import Path
import re
import sqlite3
from threading import Lock


# One managed personal Provider serves this installation. Writes started before
# first pairing have no SQLite file to lock. Count them until their commit.
_single_writers = Counter()
_single_lock = Lock()

from fastapi import HTTPException


def unavailable():
    raise HTTPException(409, detail={'code': 'project_installation_unavailable'})


@contextmanager
def installation(settings, *, inspecting=False, writing=False):
    root = getattr(settings, 'project_installation_directory', None)
    if not root or getattr(settings, 'provider_mode', 'personal') != 'personal':
        yield settings, None
        return
    root = Path(root)
    if not root.is_absolute():
        unavailable()
    path = root / 'project-installation.sqlite'
    with _single_lock:
        single = not path.exists()
        if single:
            if (root / 'project-registry.json').exists() or (root / 'project-gates').exists():
                unavailable()
            if writing:
                _single_writers[root] += 1
        elif inspecting and _single_writers[root]:
            unavailable()
    if single:
        try:
            yield settings.model_copy(update={'project_installation_directory': None}), {'phase': 'single'}
        finally:
            if writing:
                with _single_lock:
                    _single_writers[root] -= 1
                    if not _single_writers[root]:
                        del _single_writers[root]
        return
    with closing(sqlite_connection(root)) as db:
        try:
            result = read_installation(db, root, settings, inspecting)
        except (sqlite3.Error, OSError, ValueError, AttributeError) as exc:
            raise HTTPException(409, detail={'code': 'project_installation_unavailable'}) from exc
        yield result


def sqlite_connection(root):
    try:
        return sqlite3.connect((root / 'project-installation.sqlite').as_uri() + '?mode=ro', uri=True, timeout=0)
    except sqlite3.Error as exc:
        raise HTTPException(409, detail={'code': 'project_installation_unavailable'}) from exc


def read_installation(db, root, settings, inspecting):
    db.execute('BEGIN')
    if db.execute('PRAGMA user_version').fetchone()[0] != 1 or db.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
        unavailable()
    row = db.execute('SELECT phase,space,device,authority FROM installation WHERE id=1').fetchone()
    descriptor = root / 'project-registry.json'
    if row is None:
        if descriptor.exists():
            unavailable()
        return settings.model_copy(update={'project_installation_directory': None}), {'phase': 'single'}
    phase, space, device, authority = row
    if (not isinstance(space, str) or not space or len(space) > 128 or
            not all(isinstance(v, str) and re.fullmatch(r'[a-f0-9]{64}', v) for v in (device, authority))):
        unavailable()
    status = {'phase': phase, 'spaceId': space, 'device': device, 'authority': authority}
    if phase == 'preparing' and inspecting:
        return settings, status
    if phase != 'active':
        unavailable()
    record = json.loads(descriptor.read_text(encoding='utf-8'))
    if (record.get('version') != 1 or record.get('spaceId') != space or
            record.get('device') != device or record.get('authority') != authority):
        unavailable()
    return settings.model_copy(update={
        'project_installation_directory': None, 'project_registry_path': str(root / 'host.sqlite'),
        'project_registry_version': 12, 'project_gate_space': space, 'project_gate_directory': str(root / 'project-gates'),
        'project_device_fingerprint': device, 'project_authority_fingerprint': authority,
        'project_move_control_path': str(root / 'project-moves.sqlite'),
    }), status


def resolved_installation(settings):
    with installation(settings) as (resolved, _):
        return resolved

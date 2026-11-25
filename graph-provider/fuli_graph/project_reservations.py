"""Admit project creation using the registry for this Provider's installation."""
import asyncio
from contextlib import closing
from pathlib import Path
import re
import sqlite3

from fastapi import HTTPException


def _read_reservation(settings, space, project):
    # The path and fingerprint are supplied by the service that starts this
    # Provider. Neither is accepted from an HTTP request or a graph record.
    path = Path(settings.project_registry_path)
    device = settings.project_device_fingerprint
    authority = settings.project_authority_fingerprint
    if settings.project_registry_version != 11:
        raise HTTPException(503, detail={'code': 'project_registry_format'})
    if not path.is_absolute() or not all(re.fullmatch(r'[a-f0-9]{64}', value or '') for value in (device, authority)):
        raise HTTPException(503, detail={'code': 'project_registry_unavailable'})
    try:
        with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=0.25)) as db:
            db.execute('BEGIN')
            if db.execute('PRAGMA user_version').fetchone()[0] != settings.project_registry_version:
                raise HTTPException(503, detail={'code': 'project_registry_format'})
            if authority == device:
                row = db.execute('SELECT owner,state FROM project_owners WHERE space=? AND project=?',
                                 (space, project)).fetchone()
            else:
                row = db.execute('SELECT owner,state FROM project_permits WHERE authority=? AND space=? AND project=?',
                                 (authority, space, project)).fetchone()
    except sqlite3.Error as exc:
        raise HTTPException(503, detail={'code': 'project_registry_unavailable'}) from exc
    if not row or row[0] != device or row[1] not in ('reserved', 'owned'):
        raise HTTPException(409, detail={'code': 'project_reservation_required'})


async def require_project_reservation(store, space, project):
    settings = getattr(store, 'settings', None)
    if getattr(settings, 'project_registry_path', None) is not None:
        await asyncio.to_thread(_read_reservation, settings, space, project)

"""Validate the host's live pairing and generation across the graph commit."""
from contextlib import contextmanager
from pathlib import Path
import sqlite3

from fastapi import HTTPException


@contextmanager
def confirm_copy_commit(settings, scope, space, owner, generation, pairing):
    path = getattr(settings, 'project_registry_path', None)
    if not scope.startswith('project:') or path is None:
        if generation is not None or pairing is not None:
            raise HTTPException(409, detail={'code': 'project_copy_authority_unavailable'})
        yield
        return
    if (generation is None or not pairing or not Path(path).is_absolute()
            or settings.project_device_fingerprint != settings.project_authority_fingerprint):
        raise HTTPException(409, detail={'code': 'project_copy_authority_unavailable'})
    # A short writer reservation works with either WAL or rollback journals.
    # The actual graph import is already staged in a single open transaction.
    # A revoke, re-pair or move committed first wins; a later one waits until
    # Neo4j commits. Never create or update the ownership database here.
    db = None
    try:
        db = sqlite3.connect(Path(path).as_uri() + '?mode=rw', uri=True, timeout=0)
        db.execute('BEGIN IMMEDIATE')
        if settings.project_registry_version != 11 or db.execute('PRAGMA user_version').fetchone()[0] != 11:
            raise HTTPException(409, detail={'code': 'project_registry_format'})
        row = db.execute("SELECT 1 FROM project_owners WHERE space=? AND project=? AND owner=? AND generation=? AND state='owned'",
                         (space, scope[len('project:'):], owner, generation)).fetchone()
        active = db.execute("SELECT 1 FROM runners WHERE grant_space=? AND fingerprint=? AND grant_pairing=? AND revoked_at IS NULL",
                            (space, owner, pairing)).fetchone()
        verified = db.execute("SELECT 1 FROM owner_inventory WHERE space=? AND fingerprint=? AND checked_at IS NOT NULL",
                              (space, owner)).fetchone()
        if not row or not active or not verified:
            raise HTTPException(409, detail={'code': 'project_generation_changed'})
        yield
    except sqlite3.Error as exc:
        raise HTTPException(409, detail={'code': 'project_copy_authority_unavailable'}) from exc
    finally:
        if db is not None:
            db.close()

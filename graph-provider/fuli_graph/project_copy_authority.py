"""Validate the host's live pairing and generation across the graph commit."""
from contextlib import ExitStack, closing, contextmanager
from pathlib import Path
import sqlite3

from fastapi import HTTPException

from .project_installation import PROJECT_MOVE_FORMATS, resolved_installation


def _moved_copy(registry, settings, space, project, owner):
    if owner != settings.project_authority_fingerprint or owner == settings.project_device_fingerprint:
        return None
    return registry.execute("""SELECT generation,operation FROM project_permits
        WHERE authority=? AND space=? AND project=? AND owner=? AND state='revoked'""",
        (owner, space, project, settings.project_device_fingerprint)).fetchone()


@contextmanager
def follower_copy_authority(settings, space, project, owner, generation=None, pairing=None):
    """Prove the local handoff, retired permit and still-paired authority together."""
    root = Path(settings.project_registry_path).parent
    with ExitStack() as held:
        def reserve(file, versions):
            db = held.enter_context(closing(sqlite3.connect(file.as_uri() + '?mode=rw', uri=True, timeout=0)))
            db.execute('BEGIN IMMEDIATE')
            if db.execute('PRAGMA user_version').fetchone()[0] not in versions:
                raise HTTPException(409, detail={'code': 'project_registry_format'})
            return db
        try:
            registry = reserve(Path(settings.project_registry_path), (settings.project_registry_version,))
            permit = _moved_copy(registry, settings, space, project, owner)
            if not permit or (generation is not None and permit[0] != generation):
                raise HTTPException(409, detail={'code': 'project_generation_changed'})
            moves = reserve(root / 'project-moves.sqlite', PROJECT_MOVE_FORMATS)
            receipt = moves.execute("""SELECT pairing FROM move_participants WHERE space=? AND project=? AND
                move_id=? AND source=? AND target=? AND generation=? AND step='forwarded' AND gate_role='owner'""",
                (space, project, permit[1], settings.project_device_fingerprint, owner, permit[0] - 1)).fetchone()
            if not receipt or (pairing is not None and receipt[0] != pairing):
                raise HTTPException(409, detail={'code': 'project_generation_changed'})
            runner = reserve(root / 'runner.sqlite', (6, 7, 8))
            live = runner.execute("""SELECT 1 FROM host WHERE id=1 AND fingerprint=? AND revoked_at IS NULL
                AND project_pairing=?""", (owner, receipt[0])).fetchone()
            if not live:
                raise HTTPException(409, detail={'code': 'project_generation_changed'})
            yield permit[0]
        except sqlite3.Error as exc:
            raise HTTPException(409, detail={'code': 'project_copy_authority_unavailable'}) from exc


@contextmanager
def confirm_copy_commit(settings, scope, space, owner, generation, pairing):
    settings = resolved_installation(settings)
    path = getattr(settings, 'project_registry_path', None)
    if not scope.startswith('project:') or path is None:
        if generation is not None or pairing is not None:
            raise HTTPException(409, detail={'code': 'project_copy_authority_unavailable'})
        yield
        return
    if generation is None or not pairing or not Path(path).is_absolute():
        raise HTTPException(409, detail={'code': 'project_copy_authority_unavailable'})
    if settings.project_device_fingerprint != settings.project_authority_fingerprint:
        with follower_copy_authority(settings, space, scope[len('project:'):], owner, generation, pairing):
            yield
        return
    # A short writer reservation works with either WAL or rollback journals.
    # The actual graph import is already staged in a single open transaction.
    # A revoke, re-pair or move committed first wins; a later one waits until
    # Neo4j commits. Never create or update the ownership database here.
    db = None
    try:
        db = sqlite3.connect(Path(path).as_uri() + '?mode=rw', uri=True, timeout=0)
        db.execute('BEGIN IMMEDIATE')
        if settings.project_registry_version not in (11, 12) or db.execute('PRAGMA user_version').fetchone()[0] != settings.project_registry_version:
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

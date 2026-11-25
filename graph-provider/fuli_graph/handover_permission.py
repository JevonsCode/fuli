"""An installation-owned phase receipt and a closed project gate authorize graph changes."""
import asyncio
from contextlib import asynccontextmanager, closing, contextmanager
from contextvars import ContextVar
from pathlib import Path
import sqlite3

from fastapi import HTTPException

from .project_installation import resolved_installation

from .project_write_gate import gate_space_directory, hold_writes


_active = ContextVar('active_project_handover', default=None)


def in_handover():
    active = _active.get()
    return active is not None and active is asyncio.current_task()


@asynccontextmanager
async def handover_transaction(driver):
    if not in_handover():
        raise HTTPException(409, detail={'code': 'project_move_phase_unconfirmed'})
    async with driver.replica_import_transaction() as tx:
        yield tx


@contextmanager
def authorized_phase(settings, space, project, move_id, action):
    def denied():
        raise HTTPException(409, detail={'code': 'project_move_phase_unconfirmed'})
    settings = resolved_installation(settings)
    control = getattr(settings, 'project_move_control_path', None)
    directory = gate_space_directory(settings, space)
    if not control or not Path(control).is_absolute() or directory is None:
        denied()
    try:
        with closing(sqlite3.connect(Path(control).as_uri() + '?mode=ro', uri=True, timeout=0)) as db:
            db.row_factory = sqlite3.Row
            db.execute('BEGIN')
            if db.execute('PRAGMA user_version').fetchone()[0] not in (1, 2) or db.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
                denied()
            row = db.execute("""SELECT source,target,generation,allowed_action,graph_digest,baseline_digest,gate_role
                                FROM move_participants WHERE space=? AND project=? AND move_id=?""",
                             (space, project, move_id)).fetchone()
            if not row or row['allowed_action'] != action:
                denied()
            side = 'source' if action in ('seal','demote') else 'target'
            if settings.project_device_fingerprint != row[side]:
                denied()
            with hold_writes(directory, [project], row['generation'], role=row['gate_role'], move_id=move_id):
                reset = _active.set(asyncio.current_task())
                try:
                    yield dict(row)
                finally:
                    _active.reset(reset)
    except sqlite3.Error as exc:
        raise HTTPException(409, detail={'code': 'project_move_control_unavailable'}) from exc

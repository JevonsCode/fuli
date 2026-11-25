"""Shared read locks on the coordinator's rollback-journal gate files."""
import asyncio
from contextlib import ExitStack, asynccontextmanager, closing, contextmanager
from contextvars import ContextVar
from hashlib import sha256
from pathlib import Path
import sqlite3
import sys

from fastapi import HTTPException

from .project_installation import resolved_installation


_target = ContextVar('project_write_targets', default=None)
_copy = ContextVar('project_copy_target', default=None)
# What the open transaction of this task was admitted for: a tuple of
# projects, or one of the kinds below. Set by write_admission until it exits.
_admitted = ContextVar('project_write_admitted', default=None)
# Every gate was owner and open when it was admitted (an unresolved write).
EVERY_PROJECT = 'every_project'
# Its effects are compared before commit (project_maintenance_gate.py), or a
# fixed handler owns it (an import, a handover phase, a format change).
CHECKED = 'checked'
# Only derived properties (vectors): copies too, while no project is frozen.
DERIVED = 'derived'


def _refuse(code, **detail):
    raise HTTPException(409, detail={'code': code, **detail})


# The modules a write passes through on its way to the graph; the entry a
# refusal names is the first caller outside them.
_PASSAGE = {'project_write_gate', 'runtime', 'store_transactions', 'project_installation', 'knowledge_group_lock'}


def _entry():
    frame = sys._getframe(1)
    while frame is not None:
        module = frame.f_globals.get('__name__', '')
        name = module.rpartition('.')[2]
        if module.startswith('fuli_graph.') and name not in _PASSAGE and not name.endswith('_gate'):
            return f'{name}.{frame.f_code.co_name}'
        frame = frame.f_back
    return None


def _within(admitted, projects, kind):
    if admitted in (EVERY_PROJECT, CHECKED):
        return True
    if kind == DERIVED:
        # Only an admission that saw no project frozen covers a copy's vectors.
        return admitted == DERIVED
    if admitted == DERIVED:
        return not projects
    return set(projects) <= set(admitted)


@contextmanager
def project_targets(space, projects, *, kind=None):
    """Only a local store method that has resolved every target may narrow a write.

    Before its transaction opens this selects the gates write_admission takes.
    Inside an open transaction nothing can be taken any more: the projects
    must be ones the transaction was admitted for, else it is refused."""
    owner = asyncio.current_task()
    admitted = _admitted.get()
    if admitted and admitted[0] is owner:
        if admitted[1] != space:
            _refuse('project_scope_unknown', entry=_entry())
        if not _within(admitted[2], projects, kind):
            _refuse('project_scope_changed', entry=_entry())
        yield
        return
    current = _target.get()
    selected = set(projects)
    if current and current[0] is owner:
        if current[1] != space or current[3] != kind:
            _refuse('project_scope_unknown', entry=_entry())
        selected.update(current[2])
    reset = _target.set((owner, space, tuple(sorted(selected)), kind))
    try:
        yield
    finally:
        _target.reset(reset)


@contextmanager
def effects_compared(space):
    """While a maintenance transaction compares its protected records before
    commit, writes nested in it are checked by that comparison."""
    reset = _admitted.set((asyncio.current_task(), space, CHECKED))
    try:
        yield
    finally:
        _admitted.reset(reset)


@contextmanager
def _admitting(space, admitted):
    reset = _admitted.set((asyncio.current_task(), space, admitted))
    try:
        yield
    finally:
        _admitted.reset(reset)


def _hash(value):
    return sha256(value.encode('utf-8')).hexdigest()


def _gate_snapshot(held, file):
    if not file.is_file():
        _refuse('project_gate_missing')
    db = held.enter_context(closing(sqlite3.connect(file.as_uri() + '?mode=ro', uri=True, timeout=0)))
    db.execute('BEGIN')
    if db.execute('PRAGMA user_version').fetchone()[0] != 1 or db.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
        _refuse('project_gate_format')
    ledger = db.execute("SELECT 1 FROM sqlite_schema WHERE name='fuli_format_ledger' AND type='table'").fetchone()
    if ledger and db.execute('''SELECT 1 FROM fuli_format_ledger AS e WHERE e.status='started'
            AND e.seq=(SELECT max(seq) FROM fuli_format_ledger WHERE migration_id=e.migration_id) LIMIT 1''').fetchone():
        _refuse('project_gate_format')
    return db


@contextmanager
def protected_projects(directory):
    """Pin the index while a classified graph transaction verifies its actual effects."""
    with ExitStack() as held:
        try:
            db = _gate_snapshot(held, directory / 'index.sqlite')
            rows = db.execute("SELECT project FROM gates WHERE role<>'owner' OR state<>'open'").fetchall()
        except sqlite3.Error as exc:
            raise HTTPException(409, detail={'code': 'project_gate_unavailable'}) from exc
        yield {row[0] for row in rows}


@contextmanager
def hold_writes(directory, projects, generation=None, *, maintenance=False, role='owner', move_id=None):
    """Locks stay open until the actual transaction exits, including its commit."""
    with ExitStack() as held:
        for project in [None] if projects is None else sorted(set(projects)):
            if project is not None and (not isinstance(project, str) or not project):
                _refuse('project_scope_unknown')
            file = directory / ('index.sqlite' if project is None else _hash(project) + '.sqlite')
            try:
                db = _gate_snapshot(held, file)
                if project is None:
                    # A write that did not name its projects (project_targets)
                    # must be safe in every one; the refusal names its entry.
                    if db.execute("SELECT 1 FROM gates WHERE state<>'open' LIMIT 1").fetchone():
                        _refuse('project_scope_unknown', entry=_entry())
                    if not maintenance and db.execute("SELECT 1 FROM gates WHERE role<>'owner' LIMIT 1").fetchone():
                        _refuse('project_write_requires_owner_scope', entry=_entry())
                else:
                    row = db.execute('SELECT role,generation,state,move_id FROM gates WHERE project=?', (project,)).fetchone()
                    expected_state = 'closed' if move_id else 'open'
                    if not row or row[0] != role or row[2] != expected_state or (move_id and row[3] != move_id):
                        _refuse('project_write_blocked')
                    if generation is not None and row[1] != generation:
                        _refuse('project_generation_changed')
            except sqlite3.Error as exc:
                raise HTTPException(409, detail={'code': 'project_gate_unavailable'}) from exc
        yield


@contextmanager
def copying(space, scope, owner):
    """Private to the verified import route. All ordinary writes stay fenced."""
    reset = _copy.set((asyncio.current_task(), space, scope, owner))
    try:
        yield
    finally:
        _copy.reset(reset)


@contextmanager
def _copy_admission(settings, directory, space, scope, owner):
    # Imports may establish shared references; hold the index across them so
    # a freeze cannot race the classification and the graph commit.
    with hold_writes(directory, None, maintenance=True):
        if scope == 'global':
            if not settings.global_replica or owner != settings.project_authority_fingerprint:
                _refuse('project_generation_changed')
            yield
            return
        registry = getattr(settings, 'project_registry_path', None)
        if not scope.startswith('project:') or not registry or not Path(registry).is_absolute():
            _refuse('project_gate_missing')
        project = scope[len('project:'):]
        if settings.project_device_fingerprint != settings.project_authority_fingerprint:
            from .project_copy_authority import follower_copy_authority
            # Only sample the receipt here. confirm_copy_commit rechecks it under
            # write reservations just before commit, after graph staging.
            with follower_copy_authority(settings, space, project, owner) as generation:
                pass
            with hold_writes(directory, [project], generation, role='replica'):
                yield
            return
        try:
            with closing(sqlite3.connect(Path(registry).as_uri() + '?mode=ro', uri=True, timeout=0)) as db:
                row = db.execute("SELECT owner,generation,state FROM project_owners WHERE space=? AND project=?",
                                 (space, project)).fetchone()
        except sqlite3.Error as exc:
            raise HTTPException(409, detail={'code': 'project_gate_unavailable'}) from exc
        if not row or row[0] != owner or row[2] != 'owned':
            _refuse('project_generation_changed')
        with hold_writes(directory, [project], row[1], role='replica'):
            yield


def gate_space_directory(settings, requested_space=None):
    settings = resolved_installation(settings)
    root = getattr(settings, 'project_gate_directory', None)
    space = getattr(settings, 'project_gate_space', None)
    if root is None and space is None:
        return None
    if not space or not root or not Path(root).is_absolute():
        _refuse('project_gate_missing')
    if requested_space is not None and requested_space != space:
        _refuse('project_scope_unknown')
    return Path(root) / _hash(space)


def write_admission(settings, *, maintenance=False):
    @asynccontextmanager
    async def enter():
        from .project_installation import installation
        with installation(settings, writing=True) as (resolved, _):
            async with _admit(resolved):
                yield

    @asynccontextmanager
    async def _admit(settings):
        directory = gate_space_directory(settings)
        if directory is None:
            yield
            return
        space = settings.project_gate_space
        from .handover_permission import in_handover
        if not maintenance and in_handover():
            # The fixed phase handler owns the closed move gate through this commit.
            yield
            return
        copy = _copy.get()
        if copy and copy[0] is asyncio.current_task() and not maintenance:
            if copy[1] != space:
                _refuse('project_scope_unknown')
            with _copy_admission(settings, directory, space, copy[2], copy[3]):
                yield
            return
        target = _target.get()
        projects, kind = None, None
        if target and target[0] is asyncio.current_task():
            if target[1] != space:
                _refuse('project_scope_unknown')
            projects, kind = target[2], target[3]
        if maintenance or kind == DERIVED:
            # Copies may change here; a frozen project may not.
            with hold_writes(directory, None, maintenance=True), _admitting(
                    space, CHECKED if maintenance else DERIVED):
                yield
            return
        with hold_writes(directory, projects), _admitting(space, EVERY_PROJECT if projects is None else projects):
            yield
    return enter

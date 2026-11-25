"""Shared read locks on the coordinator's rollback-journal gate files."""
import asyncio
from contextlib import ExitStack, asynccontextmanager, closing, contextmanager
from contextvars import ContextVar
from hashlib import sha256
from pathlib import Path
import sqlite3

from fastapi import HTTPException


_target = ContextVar('project_write_targets', default=None)
_copy = ContextVar('project_copy_target', default=None)


def _refuse(code):
    raise HTTPException(409, detail={'code': code})


@contextmanager
def project_targets(space, projects):
    """Only a local store method that has resolved every target may narrow a write."""
    owner = asyncio.current_task()
    current = _target.get()
    selected = set(projects)
    if current and current[0] is owner:
        if current[1] != space:
            _refuse('project_scope_unknown')
        selected.update(current[2])
    reset = _target.set((owner, space, tuple(sorted(selected))))
    try:
        yield
    finally:
        _target.reset(reset)


def _hash(value):
    return sha256(value.encode('utf-8')).hexdigest()


@contextmanager
def hold_writes(directory, projects, generation=None, *, maintenance=False, role='owner'):
    """Locks stay open until the actual transaction exits, including its commit."""
    with ExitStack() as held:
        for project in [None] if projects is None else sorted(set(projects)):
            if project is not None and (not isinstance(project, str) or not project):
                _refuse('project_scope_unknown')
            file = directory / ('index.sqlite' if project is None else _hash(project) + '.sqlite')
            if not file.is_file():
                _refuse('project_gate_missing')
            try:
                db = held.enter_context(closing(sqlite3.connect(file.as_uri() + '?mode=ro', uri=True, timeout=0)))
                db.execute('BEGIN')
                if db.execute('PRAGMA user_version').fetchone()[0] != 1 or db.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
                    _refuse('project_gate_format')
                ledger = db.execute("SELECT 1 FROM sqlite_schema WHERE name='fuli_format_ledger' AND type='table'").fetchone()
                if ledger and db.execute('''SELECT 1 FROM fuli_format_ledger AS e WHERE e.status='started'
                        AND e.seq=(SELECT max(seq) FROM fuli_format_ledger WHERE migration_id=e.migration_id) LIMIT 1''').fetchone():
                    _refuse('project_gate_format')
                if project is None:
                    if db.execute("SELECT 1 FROM gates WHERE state<>'open' LIMIT 1").fetchone():
                        _refuse('project_scope_unknown')
                    if not maintenance and db.execute("SELECT 1 FROM gates WHERE role<>'owner' LIMIT 1").fetchone():
                        _refuse('project_write_requires_owner_scope')
                else:
                    row = db.execute('SELECT role,generation,state FROM gates WHERE project=?', (project,)).fetchone()
                    if not row or row[0] != role or row[2] != 'open':
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
        directory = gate_space_directory(settings)
        if directory is None:
            yield
            return
        space = settings.project_gate_space
        copy = _copy.get()
        if copy and copy[0] is asyncio.current_task() and not maintenance:
            if copy[1] != space:
                _refuse('project_scope_unknown')
            with _copy_admission(settings, directory, space, copy[2], copy[3]):
                yield
            return
        target = _target.get()
        projects = None
        if target and target[0] is asyncio.current_task():
            if target[1] != space:
                _refuse('project_scope_unknown')
            projects = target[2]
        with hold_writes(directory, None if maintenance else projects, maintenance=maintenance):
            yield
    return enter

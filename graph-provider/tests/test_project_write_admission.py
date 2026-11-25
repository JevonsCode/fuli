import asyncio
from contextlib import closing
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
import sqlite3
import subprocess

from fastapi import HTTPException
import pytest

from fuli_graph.project_write_gate import copying, project_targets, write_admission


@pytest.mark.asyncio
async def test_provider_uses_the_same_files_and_generation_as_the_node_coordinator(tmp_path):
    root = Path(__file__).resolve().parents[2]
    uri = (root / 'src/runner/project-write-gate.js').as_uri()
    space = 'synthetic'
    directory = tmp_path / sha256(space.encode()).hexdigest()
    settings = SimpleNamespace(project_gate_directory=tmp_path, project_gate_space=space)
    # Runtime under test is Node 24, as in the application itself.
    def node(action):
        subprocess.run(['node', '--input-type=module', '-e',
            "import { initializeProjectGate, freezeProject } from '" + uri + "';\n"
            "const dir = process.argv[1];\n" + action, str(directory)], check=True)

    node("initializeProjectGate(dir, 'first', 'owner', 1); initializeProjectGate(dir, 'other', 'owner', 1);")
    enter = write_admission(settings)
    freeze = "freezeProject(dir, 'first', { generation: 1, moveId: 'move', role: 'owner' })"
    with project_targets(space, ['first']):
        async with enter():
            node("try { " + freeze + "; } catch (e) { if (e.code === 'project_writes_in_flight') process.exit(0); throw e; } process.exit(1)")
    node(freeze)
    with project_targets(space, ['other']):
        async with enter():
            # Detached child tasks do not inherit their parent's narrowing.
            async def background():
                async with enter():
                    pytest.fail('an unresolved background write was admitted')
            with pytest.raises(HTTPException, match='project_scope_unknown'):
                await asyncio.create_task(background())
    with project_targets(space, ['other', 'first']), pytest.raises(HTTPException, match='project_write_blocked'):
        async with enter():
            pytest.fail('a mixed batch entered its business transaction')


@pytest.mark.asyncio
async def test_project_copy_requires_the_current_local_owner_and_generation(tmp_path):
    space = 'synthetic'
    owner = 'a' * 64
    directory = tmp_path / sha256(space.encode()).hexdigest()
    directory.mkdir()
    for file in [directory / 'index.sqlite', directory / (sha256(b'project').hexdigest() + '.sqlite')]:
        with closing(sqlite3.connect(file)) as db, db:
            db.execute('CREATE TABLE gates(project,role,generation,state,move_id)')
            db.execute("INSERT INTO gates VALUES('project','replica',2,'open',NULL)")
    registry = tmp_path / 'authority.sqlite'
    with closing(sqlite3.connect(registry)) as db, db:
        db.execute('CREATE TABLE project_owners(space,project,owner,generation,state)')
        db.execute("INSERT INTO project_owners VALUES(?,'project',?,2,'owned')", (space, owner))
    settings = SimpleNamespace(project_gate_directory=tmp_path, project_gate_space=space, project_registry_path=registry)
    enter = write_admission(settings)
    with copying(space, 'project:project', owner):
        async with enter():
            pass
    with copying(space, 'project:project', 'b' * 64), pytest.raises(HTTPException, match='project_generation_changed'):
        async with enter():
            pytest.fail('stale owner admitted')
    with closing(sqlite3.connect(registry)) as db, db:
        db.execute('UPDATE project_owners SET generation=3')
    with copying(space, 'project:project', owner), pytest.raises(HTTPException, match='project_generation_changed'):
        async with enter():
            pytest.fail('stale local replica generation admitted')

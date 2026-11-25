"""A managed personal Provider drains writes that predate its first pairing."""
from contextlib import closing
import json
import sqlite3

from fastapi import HTTPException
import pytest

from fuli_graph.config import Settings
from fuli_graph.project_installation import installation
from fuli_graph.project_write_gate import write_admission


@pytest.mark.asyncio
async def test_first_pair_drains_standalone_writes_and_verifies_the_installed_descriptor(tmp_path):
    root = tmp_path / 'runner'
    settings = Settings(project_installation_directory=str(root), bootstrap_token='synthetic-local-bootstrap-token',
                        neo4j_password='synthetic-password')
    async with write_admission(settings)():
        assert not root.exists()
        root.mkdir()
        with closing(sqlite3.connect(root / 'project-installation.sqlite')) as db, db:
            db.executescript('PRAGMA user_version=1; CREATE TABLE installation(id,phase,space,device,authority);')
            db.execute("INSERT INTO installation VALUES(1,'preparing','space',?,?)", ('a'*64, 'b'*64))
        with pytest.raises(HTTPException):
            with installation(settings, inspecting=True):
                pass
    with installation(settings, inspecting=True) as (_, record):
        assert record['phase'] == 'preparing'
    with pytest.raises(HTTPException):
        async with write_admission(settings)():
            pass
    with closing(sqlite3.connect(root / 'project-installation.sqlite')) as db, db:
        db.execute("UPDATE installation SET phase='active'")
    with pytest.raises(HTTPException):
        with installation(settings):
            pass
    descriptor = {'version': 1, 'spaceId': 'space', 'device': 'a'*64, 'authority': 'b'*64}
    (root / 'project-registry.json').write_text(json.dumps(descriptor))
    with installation(settings) as (resolved, record):
        assert record['phase'] == 'active' and resolved.project_gate_space == 'space'
        assert resolved.project_authority_fingerprint == descriptor['authority']
    (root / 'project-installation.sqlite').unlink()
    with pytest.raises(HTTPException):
        with installation(settings):
            pass


def test_forwarded_copy_needs_the_retired_permit_move_and_live_pairing_through_commit(tmp_path):
    from fuli_graph.project_copy_authority import confirm_copy_commit

    device, authority = 'a'*64, 'b'*64
    registry = tmp_path / 'host.sqlite'
    moves = tmp_path / 'project-moves.sqlite'
    runner = tmp_path / 'runner.sqlite'
    with closing(sqlite3.connect(registry)) as db, db:
        db.executescript('PRAGMA user_version=12; CREATE TABLE project_permits(authority,space,project,owner,generation,operation,state);')
        db.execute("INSERT INTO project_permits VALUES(?,'space','one',?,2,'move','revoked')", (authority, device))
    with closing(sqlite3.connect(moves)) as db, db:
        db.executescript('PRAGMA user_version=2; CREATE TABLE move_participants(space,project,move_id,source,target,generation,step,gate_role,pairing);')
        db.execute("INSERT INTO move_participants VALUES('space','one','move',?,?,1,'forwarded','owner','epoch')", (device, authority))
    with closing(sqlite3.connect(runner)) as db, db:
        db.executescript('PRAGMA user_version=6; CREATE TABLE host(id,fingerprint,revoked_at,project_pairing);')
        db.execute("INSERT INTO host VALUES(1,?,NULL,'epoch')", (authority,))
    settings = Settings(bootstrap_token='synthetic-local-bootstrap-token', neo4j_password='synthetic-password',
                        project_registry_path=str(registry), project_registry_version=12,
                        project_device_fingerprint=device, project_authority_fingerprint=authority)
    def confirm(epoch='epoch', generation=2):
        return confirm_copy_commit(settings, 'project:one', 'space', authority, generation, epoch)
    with confirm():
        for path in (runner, moves, registry):
            with closing(sqlite3.connect(path, timeout=0)) as other, pytest.raises(sqlite3.OperationalError):
                other.execute('BEGIN IMMEDIATE')
    for epoch, generation in [('old', 2), ('epoch', 1)]:
        with pytest.raises(HTTPException), confirm(epoch, generation):
            pass
    with closing(sqlite3.connect(runner)) as db, db:
        db.execute("UPDATE host SET revoked_at='now'")
    with pytest.raises(HTTPException), confirm():
        pass

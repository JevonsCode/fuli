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

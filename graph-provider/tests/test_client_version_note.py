from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from fuli_graph.client_version_note import CLIENT_VERSION_HEADER, client_version_note, install_client_version_note


def client(installed='0.23.0b8'):
    application = FastAPI()
    install_client_version_note(application, installed)

    @application.get('/task')
    async def task():
        raise HTTPException(404, 'Task context is unknown or superseded')

    @application.get('/other')
    async def other():
        raise HTTPException(404, 'Project not found', headers={'x-synthetic': '1'})

    return TestClient(application)


def test_an_older_or_unversioned_connection_is_told_to_restart():
    api = client()
    older = api.get('/task', headers={CLIENT_VERSION_HEADER: '0.23.0-beta.7'})
    assert older.status_code == 404
    assert older.json()['detail'].startswith('Task context is unknown or superseded This FULI connection runs FULI 0.23.0-beta.7')
    assert 'restart' in older.json()['detail']
    unversioned = api.get('/task')
    assert 'from before connections reported their version' in unversioned.json()['detail']


def test_a_current_connection_and_other_refusals_stay_unchanged():
    api = client()
    for current in ('0.23.0-beta.8', '0.23.0-beta.8.local.3', '0.23.0', 'not-a-version'):
        assert api.get('/task', headers={CLIENT_VERSION_HEADER: current}).json() == {
            'detail': 'Task context is unknown or superseded'}
    other = api.get('/other')
    assert other.json() == {'detail': 'Project not found'}
    assert other.headers['x-synthetic'] == '1'


def test_prereleases_order_before_their_release():
    assert client_version_note('0.23.0-rc.1', '0.23.0') is not None
    assert client_version_note('0.22.9', '0.23.0a1') is not None
    assert client_version_note('0.23.0-beta.10', '0.23.0b9') is None

import re
from importlib.metadata import version

from fastapi import FastAPI, HTTPException, Request
from fastapi.exception_handlers import http_exception_handler

# A client keeps the FULI MCP connection it started until the person restarts
# it, so after an update a session can still call through an older FULI. A
# task-context refusal it then gets names that and the way out instead of
# only "not found" (rec#74). FULI's own client sends its version in this
# header; a connection that sends none predates it, so it is older too.
CLIENT_VERSION_HEADER = 'x-fuli-client-version'

_RELEASE = re.compile(r'^(\d+)\.(\d+)\.(\d+)(?:-?(alpha|beta|rc|a|b)\.?(\d+))?')
_STAGES = {'alpha': 0, 'a': 0, 'beta': 1, 'b': 1, 'rc': 2}


def _release(text):
    # 0.23.0-beta.7 (FULI) and 0.23.0b7 (this package) order alike; a local
    # build's suffix is ignored, and anything else is not compared.
    match = _RELEASE.match(text or '')
    if not match:
        return None
    major, minor, patch, stage, number = match.groups()
    return (int(major), int(minor), int(patch), _STAGES[stage] if stage else 3, int(number or 0))


def client_version_note(client_version, installed):
    if client_version is None:
        running = 'a FULI from before connections reported their version'
    else:
        client, current = _release(client_version), _release(installed)
        if client is None or current is None or client >= current:
            return None
        running = f'FULI {client_version}'
    return (f'This FULI connection runs {running}, older than the installed {installed}: restart this '
            "session's FULI MCP connection or open a new session, then retry. / 这个会话的 FULI 连接早于已安装的 "
            f'{installed}，请重连本会话的 FULI MCP 或新开会话后重试。')


def install_client_version_note(application: FastAPI, installed=None):
    installed = installed or version('fuli-graph-provider')

    @application.exception_handler(HTTPException)
    async def task_context_refusal(request: Request, error: HTTPException):
        if error.status_code == 404 and isinstance(error.detail, str) and error.detail.startswith('Task context '):
            note = client_version_note(request.headers.get(CLIENT_VERSION_HEADER), installed)
            if note:
                error = HTTPException(error.status_code, f'{error.detail} {note}', headers=error.headers)
        return await http_exception_handler(request, error)

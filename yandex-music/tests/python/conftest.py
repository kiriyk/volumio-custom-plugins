from contextlib import asynccontextmanager

import pytest
from aiohttp import web


@asynccontextmanager
async def running(app):
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        yield f'http://127.0.0.1:{port}'
    finally:
        await runner.cleanup()


@pytest.fixture
def serve():
    return running

"""Real HTTP boundary with an offline Yandex adapter; never shipped in releases."""
import asyncio
import signal
import tempfile

from aiohttp import web
from service.app import create_app


class FixtureBackend:
    def __init__(self, token=None):
        pass

    async def initialize(self):
        return {'id': '1', 'name': 'Fixture listener'}

    async def search(self, text, kind, cursor=None, limit=50):
        return {'items': [{'type': kind, 'id': '42', 'title': text}], 'next_cursor': None}

    async def close(self):
        pass


async def main():
    with tempfile.TemporaryDirectory(prefix='ym-contract-') as state:
        runner = web.AppRunner(create_app(FixtureBackend, state, 'fixture-key'), access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        print(site._server.sockets[0].getsockname()[1], flush=True)
        stopped = asyncio.Event()
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stopped.set)
        try:
            await stopped.wait()
        finally:
            await runner.cleanup()


asyncio.run(main())

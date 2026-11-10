import json
import pathlib
import tempfile
import unittest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from service.app import create_apps, STREAMING
from service.streaming import validate_upstream
from service.errors import ServiceError


class FakeProvider:
    def __init__(self):
        self.finish_count = 0
    async def start(self): pass
    async def close(self): pass
    def account(self): return {'authenticated': True}
    async def begin_login(self, host, path): return 'https://www.qobuz.com/signin/oauth?redirect=' + path
    async def finish_login(self, code): self.finish_count += 1
    async def logout(self): pass
    async def search(self, query, kind, offset, limit): return {'items': [], 'next_cursor': None}
    async def resolve(self, id_, quality): return {'url': self.url, 'codec': 'flac', 'bitrate': None,
                                                'sampleRate': 44100, 'bitDepth': 24}


class AppTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.provider = FakeProvider()
        api, callback = create_apps(self.provider, pathlib.Path(self.tmp.name), 'local-key', upstream_policy=lambda url: None)
        self.streaming = api[STREAMING]
        self.client = TestClient(TestServer(api))
        self.callback = TestClient(TestServer(callback))
        await self.client.start_server(); await self.callback.start_server()
        self.headers = {'X-API-Key': 'local-key'}

    async def asyncTearDown(self):
        await self.callback.close(); await self.client.close(); self.tmp.cleanup()

    async def test_control_requires_key_and_no_origin(self):
        self.assertEqual((await self.client.get('/v1/account')).status, 401)
        self.assertEqual((await self.client.get('/v1/account', headers={**self.headers, 'Origin': 'https://other.test'})).status, 403)
        result = await self.client.get('/v1/account', headers=self.headers)
        self.assertEqual(await result.json(), {'authenticated': True})

    async def test_callback_is_one_use(self):
        result = await self.client.post('/v1/auth/start', json={'host': '192.168.1.106'}, headers=self.headers)
        url = (await result.json())['url']
        path = url.split('redirect=')[1]
        self.assertEqual((await self.callback.get(path + '?code_autorisation=dummy')).status, 200)
        self.assertEqual((await self.callback.get(path + '?code_autorisation=dummy')).status, 410)
        self.assertEqual(self.provider.finish_count, 1)

    async def test_stream_ticket_missing_and_range_rejected(self):
        self.assertEqual((await self.client.get('/stream/missing')).status, 404)

    async def test_range_forwarding_and_logout_revocation(self):
        seen = []
        async def upstream(request):
            seen.append(request.headers.get('Range'))
            return web.Response(body=b'fLaC', status=206,
                headers={'Content-Range': 'bytes 0-3/100', 'Content-Type': 'audio/flac'})
        app = web.Application(); app.router.add_get('/audio', upstream)
        server = TestServer(app); await server.start_server()
        try:
            self.provider.url = str(server.make_url('/audio'))
            result = await self.client.post('/v1/playback/resolve',
                headers=self.headers, json={'track_id': '42', 'quality': '27'})
            ticket = await result.json()
            self.assertEqual(ticket['bitDepth'], 24)
            self.assertNotIn('url', ticket)
            response = await self.client.get(ticket['path'], headers={'Range': 'bytes=0-3'})
            self.assertEqual(response.status, 206); self.assertEqual(await response.read(), b'fLaC')
            self.assertEqual(seen, ['bytes=0-3'])
            self.assertEqual((await self.client.get(ticket['path'], headers={'Range': 'bad'})).status, 416)
            await self.client.post('/v1/auth/logout', headers=self.headers)
            self.assertEqual((await self.client.get(ticket['path'])).status, 404)
        finally:
            await server.close()

    def test_cdn_policy(self):
        validate_upstream('https://streaming-qobuz-std.akamaized.net/file')
        for url in ['http://streaming-qobuz-std.akamaized.net/file', 'https://127.0.0.1/file',
                    'https://streaming-qobuz-std.akamaized.net.attacker.test/file']:
            with self.assertRaises(ServiceError): validate_upstream(url)

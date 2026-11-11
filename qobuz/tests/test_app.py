import asyncio
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

    async def test_logout_revokes_inflight_resolve(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def delayed(id_, quality):
            entered.set(); await release.wait()
            return {'url': 'https://streaming-qobuz-std.akamaized.net/old', 'codec': 'flac', 'bitrate': None}
        self.provider.resolve = delayed
        async def resolve():
            return await self.client.post('/v1/playback/resolve', headers=self.headers,
                json={'track_id': '42', 'quality': '27'})
        task = asyncio.create_task(resolve()); await entered.wait()
        await self.client.post('/v1/auth/logout', headers=self.headers)
        release.set(); response = await task
        self.assertEqual(response.status, 401)
        self.assertEqual(len(self.streaming.tickets), 0)

    def test_cdn_policy(self):
        validate_upstream('https://streaming-qobuz-std.akamaized.net/file')
        for url in ['http://streaming-qobuz-std.akamaized.net/file', 'https://127.0.0.1/file',
                    'https://streaming-qobuz-std.akamaized.net.attacker.test/file']:
            with self.assertRaises(ServiceError): validate_upstream(url)


    async def test_artist_endpoint_validates_id_and_cursor(self):
        calls = []
        async def artist(id_, offset, limit):
            calls.append((id_, offset, limit))
            return {'title': 'Artist', 'artist': {'id': id_, 'name': 'Artist', 'cover_url': ''},
                    'items': [], 'next_cursor': None}
        self.provider.artist = artist
        response = await self.client.get('/v1/artists/123?cursor=50', headers=self.headers)
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())['artist']['id'], '123')
        self.assertEqual(calls, [('123', 50, 50)])
        for path in ['/v1/artists/bad-id', '/v1/artists/123?cursor=-1']:
            self.assertEqual((await self.client.get(path, headers=self.headers)).status, 400)
        self.assertEqual((await self.client.get('/v1/artists/123')).status, 401)

    async def test_favorite_artist_endpoint_returns_artist_page(self):
        calls = []
        async def library_artists(offset, limit):
            calls.append((offset, limit))
            return {'items': [{'type': 'artist', 'id': '123', 'title': 'Artist', 'cover_url': ''}],
                    'next_cursor': None}
        self.provider.library_artists = library_artists
        response = await self.client.get('/v1/library/artists?cursor=50', headers=self.headers)
        self.assertEqual(response.status, 200)
        self.assertEqual((await response.json())['items'][0]['type'], 'artist')
        self.assertEqual(calls, [(50, 50)])

    async def test_download_api_rejects_absent_disk_and_invalid_input(self):
        from service.app import DOWNLOADS
        downloads = self.client.server.app[DOWNLOADS]
        downloads.mount_check = lambda: False
        response = await self.client.post('/v1/downloads', json={'track_id': '42'}, headers=self.headers)
        self.assertEqual(response.status, 409)
        self.assertEqual((await response.json())['error']['code'], 'DISK_UNAVAILABLE')
        for data in ({'track_id': '../bad'}, {'track_id': '42', 'quality': '5'}):
            self.assertEqual((await self.client.post('/v1/downloads', json=data, headers=self.headers)).status, 400)
        self.assertEqual((await self.client.get('/v1/downloads')).status, 401)
        self.assertEqual((await self.client.get('/v1/downloads', headers=self.headers)).status, 200)
        response = await self.client.post('/v1/downloads/missing/cancel', headers=self.headers)
        self.assertEqual(response.status, 404)

    async def test_download_api_enqueue_list_and_cancel(self):
        from service.app import DOWNLOADS
        downloads = self.client.server.app[DOWNLOADS]
        downloads.mount_check = lambda: True
        entered = asyncio.Event()
        async def metadata(path, params):
            entered.set()
            await asyncio.Event().wait()
        self.provider.call = metadata
        response = await self.client.post('/v1/downloads', json={'track_id': '42', 'quality': '6'}, headers=self.headers)
        self.assertEqual(response.status, 202)
        job = await response.json()
        self.assertEqual(job['track_id'], '42')
        await entered.wait()
        listing = await self.client.get('/v1/downloads', headers=self.headers)
        self.assertEqual((await listing.json())['items'][0]['id'], job['id'])
        cancelled = await self.client.post('/v1/downloads/' + job['id'] + '/cancel', headers=self.headers)
        self.assertEqual(cancelled.status, 200)
        self.assertEqual((await cancelled.json())['state'], 'cancelled')


    async def test_logout_cancels_active_and_queued_downloads(self):
        from service.app import DOWNLOADS
        downloads = self.client.server.app[DOWNLOADS]
        downloads.mount_check = lambda: True
        entered = asyncio.Event()
        async def metadata(path, params):
            entered.set()
            await asyncio.Event().wait()
        self.provider.call = metadata
        first = await downloads.enqueue('42')
        await entered.wait()
        second = await downloads.enqueue('43')
        response = await self.client.post('/v1/auth/logout', headers=self.headers)
        self.assertEqual(response.status, 200)
        self.assertEqual([job['state'] for job in downloads.list()['items']], ['cancelled', 'cancelled'])

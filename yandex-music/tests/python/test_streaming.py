import aiohttp
import pytest
import asyncio
from aiohttp import web

from service.app import create_app
from service.streaming import validate_upstream
from test_http import FakeBackend
from service.storage import CredentialStore
from service.errors import ServiceError


@pytest.mark.parametrize('url', ['http://127.0.0.1/a', 'https://localhost/a',
                                'https://yandex.net.evil.example/a',
                                'https://user:pass@storage.yandex.net/a',
                                'file:///etc/passwd', 'https://storage.yandex.net:444/a'])
def test_stream_resolver_cannot_target_arbitrary_or_local_hosts(url):
    with pytest.raises(Exception):
        validate_upstream(url)


def test_real_yandex_storage_hosts_are_accepted():
    validate_upstream('https://s123sas.storage.yandex.net/get-mp3/file?sign=value')
    validate_upstream('https://storage.mds.yandex.net/file')
    validate_upstream('https://strm-m9-169.strm.yandex.net/file')


@pytest.mark.asyncio
async def test_stream_bytes_head_ranges_and_logout_invalidation(tmp_path, serve):
    data = b'0123456789' * 20000
    seen = []
    async def upstream(request):
        seen.append(request.headers.get('Range'))
        headers = {'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes'}
        if request.headers.get('Range') == 'bytes=10-19':
            return web.Response(body=data[10:20], status=206,
                                headers={**headers, 'Content-Range': f'bytes 10-19/{len(data)}'})
        if request.headers.get('Range'):
            return web.Response(status=416, headers={'Content-Range': f'bytes */{len(data)}'})
        return web.Response(body=data, headers=headers)
    upstream_app = web.Application()
    upstream_app.router.add_get('/audio', upstream)
    async with serve(upstream_app) as upstream_url:
        class Streaming(FakeBackend):
            async def resolve(self, id_):
                return {'url': upstream_url + '/audio', 'codec': 'mp3', 'bitrate': 320}
        async with serve(create_app(Streaming, tmp_path, 'key', upstream_policy=lambda u: None)) as url:
            async with aiohttp.ClientSession(headers={'X-API-Key': 'key'}) as session:
                await session.post(url + '/v1/auth/token', json={'token': 'valid'})
                async with session.post(url + '/v1/playback/resolve', json={'track_id': '1'}) as response:
                    ticket = await response.json()
                stream_url = url + ticket['path']
                async with session.get(stream_url) as response:
                    assert await response.read() == data
                    assert response.headers['Content-Type'] == 'audio/mpeg'
                async with session.head(stream_url) as response:
                    assert response.headers['Content-Length'] == str(len(data))
                    assert await response.read() == b''
                async with session.get(stream_url, headers={'Range': 'bytes=10-19'}) as response:
                    assert response.status == 206
                    assert await response.read() == b'0123456789'
                    assert response.headers['Content-Range'] == f'bytes 10-19/{len(data)}'
                for range_ in ('bytes=9999999-', 'bytes=1-3,8-9', 'invalid'):
                    async with session.get(stream_url, headers={'Range': range_}) as response:
                        assert response.status == 416
                await session.post(url + '/v1/auth/logout')
                async with session.get(stream_url) as response:
                    assert response.status == 404
    assert 'bytes=10-19' in seen


@pytest.mark.asyncio
async def test_expired_upstream_link_is_refreshed_once_before_streaming(tmp_path, serve):
    async def upstream(request):
        return web.Response(status=403) if request.query.get('expired') else web.Response(body=b'audio')
    upstream_app = web.Application()
    upstream_app.router.add_get('/audio', upstream)
    async with serve(upstream_app) as upstream_url:
        class Refreshing(FakeBackend):
            calls = 0
            async def resolve(self, id_):
                self.calls += 1
                return {'url': upstream_url + '/audio' + ('?expired=1' if self.calls == 1 else ''),
                        'codec': 'mp3', 'bitrate': 320}
        async with serve(create_app(Refreshing, tmp_path, 'key', upstream_policy=lambda u: None)) as url:
            async with aiohttp.ClientSession(headers={'X-API-Key': 'key'}) as session:
                await session.post(url + '/v1/auth/token', json={'token': 'valid'})
                async with session.post(url + '/v1/playback/resolve', json={'track_id': '1'}) as response:
                    path = (await response.json())['path']
                async with session.get(url + path) as response:
                    assert await response.read() == b'audio'


@pytest.mark.asyncio
async def test_oauth_refresh_during_resolve_keeps_same_account_stream_valid(tmp_path, serve):
    async def upstream(request):
        return web.Response(body=b'audio')
    upstream_app = web.Application()
    upstream_app.router.add_get('/audio', upstream)
    CredentialStore(tmp_path / 'credentials.json').save(
        {'access_token': 'expired-for-stream', 'refresh_token': 'refresh-fixture'})
    async with serve(upstream_app) as upstream_url:
        class Refreshing(FakeBackend):
            async def resolve(self, id_):
                if self.token == 'expired-for-stream':
                    raise ServiceError('AUTH_EXPIRED', 'Sign in again', 401)
                return {'url': upstream_url + '/audio', 'codec': 'mp3', 'bitrate': 320}
            async def refresh(self, token):
                return {'access_token': 'renewed'}
        async with serve(create_app(Refreshing, tmp_path, 'key', upstream_policy=lambda u: None)) as url:
            async with aiohttp.ClientSession(headers={'X-API-Key': 'key'}) as session:
                async with session.post(url + '/v1/playback/resolve', json={'track_id': '1'}) as response:
                    result = await response.json()
                    assert response.status == 200, result
                async with session.get(url + result['path']) as response:
                    assert await response.read() == b'audio'


@pytest.mark.asyncio
async def test_disconnect_closes_upstream_before_downloading_whole_track(tmp_path, serve):
    disconnected = asyncio.Event()
    sent = 0
    async def upstream(request):
        nonlocal sent
        response = web.StreamResponse(headers={'Content-Type': 'audio/mpeg'})
        await response.prepare(request)
        try:
            for _ in range(1024):
                await response.write(b'x' * 65536)
                sent += 65536
                await asyncio.sleep(0.001)
        except ConnectionError:
            disconnected.set()
        return response
    app = web.Application()
    app.router.add_get('/audio', upstream)
    async with serve(app) as upstream_url:
        class Streaming(FakeBackend):
            async def resolve(self, id_):
                return {'url': upstream_url + '/audio', 'codec': 'mp3', 'bitrate': 320}
        async with serve(create_app(Streaming, tmp_path, 'key', upstream_policy=lambda u: None)) as url:
            async with aiohttp.ClientSession(headers={'X-API-Key': 'key'}) as session:
                await session.post(url + '/v1/auth/token', json={'token': 'fixture'})
                async with session.post(url + '/v1/playback/resolve', json={'track_id': '1'}) as response:
                    path = (await response.json())['path']
                async with session.get(url + path) as response:
                    assert await response.content.read(1024) == b'x' * 1024
                await asyncio.wait_for(disconnected.wait(), 3)
                assert sent < 16 * 1024 * 1024

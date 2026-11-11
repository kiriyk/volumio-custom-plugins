import aiohttp
import pytest

from service.app import create_app


class FakeBackend:
    def __init__(self, token=None):
        self.token = token

    async def initialize(self):
        return {'id': '1', 'name': 'Listener'}

    async def library(self, section, cursor=None, limit=50):
        return {'items': [], 'next_cursor': None}

    async def search(self, text, kind, cursor=None, limit=50):
        return {'items': [{'type': kind, 'id': '42', 'title': text}], 'next_cursor': None}

    async def track_quality(self, id_):
        return {'codec': 'flac', 'basis': 'available'}

    async def close(self):
        pass


@pytest.mark.asyncio
async def test_control_api_requires_secret_and_rejects_browser_origins(tmp_path, serve):
    async with serve(create_app(FakeBackend, tmp_path, 'control-secret')) as url:
        async with aiohttp.ClientSession() as session:
            async with session.get(url + '/health') as response:
                assert (await response.json())['api_version'] == 1
            async with session.get(url + '/v1/account') as response:
                assert response.status == 401
            headers = {'X-API-Key': 'control-secret', 'Origin': 'https://evil.example'}
            async with session.post(url + '/v1/auth/token', headers=headers,
                                    json={'token': 'private-token'}) as response:
                assert response.status == 403


@pytest.mark.asyncio
async def test_login_search_logout_and_private_token_storage(tmp_path, serve):
    async with serve(create_app(FakeBackend, tmp_path, 'control-secret')) as url:
        async with aiohttp.ClientSession(headers={'X-API-Key': 'control-secret'}) as session:
            async with session.get(url + '/v1/library/tracks') as response:
                assert (await response.json())['error']['code'] == 'AUTH_REQUIRED'
            async with session.post(url + '/v1/auth/token', json={'token': 'private-token'}) as response:
                assert response.status == 200
                assert 'private-token' not in await response.text()
            async with session.get(url + '/v1/search', params={'q': 'Тест', 'type': 'track'}) as response:
                assert (await response.json())['items'][0]['title'] == 'Тест'
            async with session.get(url + '/v1/tracks/42/quality') as response:
                assert (await response.json())['recording_quality'] == {'codec':'flac','basis':'available'}
            async with session.get(url + '/v1/library/tracks', params={'limit': '0'}) as response:
                assert response.status == 400
            async with session.post(url + '/v1/auth/logout') as response:
                assert (await response.json())['authenticated'] is False
            assert not (tmp_path / 'credentials.json').exists()


@pytest.mark.asyncio
async def test_bad_json_and_unexpected_errors_have_safe_json_responses(tmp_path, serve):
    class Failing(FakeBackend):
        async def search(self, *args, **kwargs):
            raise RuntimeError('OAuth secret-token https://example/?sign=secret')
    async with serve(create_app(Failing, tmp_path, 'key')) as url:
        async with aiohttp.ClientSession(headers={'X-API-Key': 'key'}) as session:
            async with session.post(url + '/v1/auth/token', data='broken') as response:
                assert response.status == 400
            await session.post(url + '/v1/auth/token', json={'token': 'valid'})
            async with session.get(url + '/v1/search?q=test') as response:
                assert response.status == 503
                assert 'secret-token' not in await response.text()

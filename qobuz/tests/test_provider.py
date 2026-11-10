import pathlib
import tempfile
import unittest

from service.provider import Provider, callback_code
from service.storage import CredentialStore
from service.errors import ServiceError


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = CredentialStore(pathlib.Path(self.tmp.name) / 'credentials.json')
        self.store.save({'access_token': 'private-token', 'app_id': '1',
                         'oauth_parameter': 'private', 'stream_candidates': ['candidate']})
        self.calls = []
        self.responses = {}

        async def request(path, params, post=False, token=None):
            self.calls.append((path, params))
            result = self.responses[path]
            if isinstance(result, Exception):
                raise result
            return result
        self.provider = Provider(self.store, request=request)

    def tearDown(self):
        self.tmp.cleanup()

    def test_callback_names(self):
        self.assertEqual(callback_code({'code_autorisation': 'french'}), 'french')
        self.assertEqual(callback_code({'code': 'standard'}), 'standard')
        with self.assertRaises(ServiceError):
            callback_code({})

    def test_private_atomic_storage(self):
        self.assertEqual(self.store.path.stat().st_mode & 0o777, 0o600)
        self.store.save({'access_token': 'replacement'})
        self.assertEqual(self.store.load()['access_token'], 'replacement')
        self.assertNotIn('private-token', str(self.provider.account()))

    async def test_opaque_album_id_and_pagination(self):
        self.responses['/album/get'] = {'id': 'aBc9', 'title': 'Album', 'artist': {'name': 'Artist'},
            'tracks': {'total': 3, 'items': [
                {'id': 3, 'title': 'Song', 'duration': 12, 'streamable': True}]}}
        result = await self.provider.album('aBc9', 0, 1)
        self.assertEqual(self.calls[0][1]['album_id'], 'aBc9')
        self.assertEqual(result['next_cursor'], '1')
        self.assertEqual(result['items'][0]['album'], 'Album')
        self.assertEqual(result['items'][0]['duration_ms'], 12000)

    async def test_empty_page_does_not_loop(self):
        self.responses['/album/get'] = {'id': 'x', 'tracks': {'total': 99, 'items': []}}
        self.assertIsNone((await self.provider.album('x', 50, 50))['next_cursor'])

    async def test_search_types_and_track_ids(self):
        self.responses['/catalog/search'] = {'tracks': {'total': 1, 'items': [
            {'id': 42, 'title': 'Track', 'performer': {'name': 'Artist'}, 'streamable': False}]}}
        result = await self.provider.search('find me', 'track', 0, 50)
        self.assertEqual(self.calls[0][1]['type'], 'tracks')
        self.assertEqual(result['items'][0]['id'], '42')
        self.assertFalse(result['items'][0]['available'])

    async def test_requested_quality_is_not_claimed_as_actual(self):
        self.responses['/track/getFileUrl'] = {'url': 'https://a.qobuz.com/music.flac',
            'mime_type': 'audio/flac', 'format_id': 7, 'sampling_rate': 44.1, 'bit_depth': 24}
        stream = await self.provider.resolve('42', '27')
        self.assertEqual(stream['sampleRate'], 44100)
        self.assertEqual(stream['bitDepth'], 24)
        self.assertEqual(stream['codec'], 'flac')
        self.assertNotIn('access_token', stream)

    async def test_no_hidden_mp3_fallback(self):
        self.responses['/track/getFileUrl'] = {'url': 'https://a.qobuz.com/music.mp3',
            'mime_type': 'audio/mpeg', 'format_id': 5}
        with self.assertRaises(ServiceError) as caught:
            await self.provider.resolve('42', '6')
        self.assertEqual(caught.exception.code, 'UNAVAILABLE')

    async def test_expired_credentials_are_cleared(self):
        self.responses['/catalog/search'] = ServiceError('AUTH_EXPIRED', 'Sign in again', 401)
        with self.assertRaises(ServiceError):
            await self.provider.search('x', 'album', 0, 50)
        self.assertFalse(self.provider.account()['authenticated'])

    async def test_oauth_stores_token_without_exposing_profile(self):
        self.responses['/oauth/callback'] = {'token': 'new-token'}
        self.responses['/user/login'] = {'user_auth_token': 'new-token', 'user': {'id': 1,
            'credential': {'parameters': {'subscription': True}}}}
        await self.provider.finish_login('test-code')
        self.assertEqual(self.store.load()['access_token'], 'new-token')
        self.assertTrue(self.provider.account()['authenticated'])
        self.assertNotIn('new-token', str(self.provider.account()))

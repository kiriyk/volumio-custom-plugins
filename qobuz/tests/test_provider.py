import asyncio
import pathlib
import tempfile
import unittest

from service.provider import Provider, callback_code, map_album, map_track
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

    async def test_old_unauthorized_response_does_not_clear_new_login(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def request(path, params, post=False, token=None):
            if path == '/catalog/search':
                entered.set(); await release.wait()
                raise ServiceError('AUTH_EXPIRED', 'old session', 401)
            if path == '/oauth/callback': return {'token': 'new-token'}
            return {'user_auth_token': 'new-token', 'user': {'id': 1, 'credential': {'parameters': {'valid': True}}}}
        self.provider.transport = request
        task = asyncio.create_task(self.provider.search('x', 'album', 0, 50)); await entered.wait()
        await self.provider.finish_login('new-code'); release.set()
        with self.assertRaises(ServiceError): await task
        self.assertTrue(self.provider.account()['authenticated'])
        self.assertEqual(self.store.load()['access_token'], 'new-token')


    async def test_artist_search_maps_id_name_and_safe_cover(self):
        self.responses['/catalog/search'] = {'artists': {'total': 2, 'items': [
            {'id': 123, 'name': 'Artist', 'image': {'large': 'https://images.test/artist.jpg'}}]}}
        result = await self.provider.search('Artist', 'artist', 0, 1)
        self.assertEqual(self.calls[-1], ('/catalog/search',
            {'query': 'Artist', 'type': 'artists', 'offset': 0, 'limit': 1}))
        self.assertEqual(result, {'items': [{'type': 'artist', 'id': '123', 'title': 'Artist',
            'cover_url': 'https://images.test/artist.jpg'}], 'next_cursor': '1'})

    def test_album_and_track_preserve_navigable_artist_and_album_ids(self):
        album = {'id': 'abc123', 'title': 'Album', 'artist': {'id': 123, 'name': 'Album Artist'}}
        self.assertEqual(map_album(album)['artist_links'], [{'id': '123', 'name': 'Album Artist'}])
        track = map_track({'id': 42, 'performer': {'id': 456, 'name': 'Performer'}}, album)
        self.assertEqual(track['artist_links'], [{'id': '456', 'name': 'Performer'}])
        self.assertEqual(track['artists'], ['Performer'])
        self.assertEqual(track['album_id'], 'abc123')
        fallback = map_track({'id': 43}, album)
        self.assertEqual(fallback['artist_links'], [{'id': '123', 'name': 'Album Artist'}])
        self.assertEqual(map_track({'id': 44})['artist_links'], [])
        self.assertEqual(map_track({'id': 44})['album_id'], '')
        self.assertEqual(map_album({'id': 'x', 'artist': {'name': 'No id'}})['artist_links'], [])

    async def test_artist_page_contains_paginated_albums_and_artist_metadata(self):
        self.responses['/artist/get'] = {'id': 123, 'name': 'Artist',
            'image': {'large': 'https://images.test/artist.jpg'},
            'albums': {'total': 4, 'items': [{'id': 'abc123', 'title': 'Album',
                'artist': {'id': 123, 'name': 'Artist'}}]}}
        result = await self.provider.artist('123', 2, 1)
        self.assertEqual(self.calls[-1], ('/artist/get',
            {'artist_id': '123', 'extra': 'albums', 'offset': 2, 'limit': 1}))
        self.assertEqual(result['title'], 'Artist')
        self.assertEqual(result['artist'], {'id': '123', 'name': 'Artist',
            'cover_url': 'https://images.test/artist.jpg'})
        self.assertEqual(result['items'][0]['id'], 'abc123')
        self.assertEqual(result['items'][0]['type'], 'album')
        self.assertEqual(result['next_cursor'], '3')

    async def test_artist_page_empty_and_invalid_identifiers(self):
        self.responses['/artist/get'] = {'id': 123, 'name': 'Artist',
            'image': {'large': 'http://unsafe.test/image'}, 'albums': {'total': 99, 'items': []}}
        result = await self.provider.artist('123', 50, 50)
        self.assertIsNone(result['next_cursor'])
        self.assertEqual(result['artist']['cover_url'], '')
        with self.assertRaises(ServiceError):
            await self.provider.artist('../bad')

    async def test_library_artists_preserves_album_library(self):
        self.responses['/favorite/getUserFavorites'] = {
            'artists': {'total': 1, 'items': [{'id': 123, 'name': 'Artist'}]},
            'albums': {'total': 1, 'items': [{'id': 'abc123', 'title': 'Album'}]}}
        artists = await self.provider.library_artists(0, 50)
        self.assertEqual(self.calls[-1][1]['type'], 'artists')
        self.assertEqual(artists['items'][0], {'type': 'artist', 'id': '123', 'title': 'Artist', 'cover_url': ''})
        albums = await self.provider.library(0, 50)
        self.assertEqual(self.calls[-1][1]['type'], 'albums')
        self.assertEqual(albums['items'][0]['type'], 'album')

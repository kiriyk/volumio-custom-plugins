from types import SimpleNamespace as Obj

import pytest

from service.backend import YandexBackend
from service.errors import ServiceError


@pytest.mark.asyncio
async def test_recording_quality_is_cached_metadata_without_stream_url():
    class QualityClient(Client):
        calls = 0
        async def tracks_file_info(self, id_, **kwargs):
            self.calls += 1
            return Obj(download_info=Obj(codec='flac-mp4', transport='raw',
                                         url='https://example.test/private', bitrate=0))
    client = QualityClient()
    backend = YandexBackend('token', client=client)
    result = await backend.track_quality('1')
    assert result == {'codec': 'flac', 'basis': 'available'}
    assert await backend.track_quality('1') == result
    assert client.calls == 1
    with pytest.raises(ServiceError):
        await backend.track_quality('../bad')


@pytest.mark.asyncio
async def test_recording_quality_mp3_uses_nonpreview_variants_without_getting_links():
    class QualityClient(Client):
        async def tracks_file_info(self, id_, **kwargs):
            return Obj(download_info=Obj(codec='aac', transport='raw'))
        async def tracks_download_info(self, id_):
            return [Obj(codec='mp3', preview=True, bitrate_in_kbps=320),
                    Obj(codec='mp3', preview=False, bitrate_in_kbps=192)]
    assert await YandexBackend('token', client=QualityClient()).track_quality('1') == {
        'codec': 'mp3', 'bitrate': 192, 'basis': 'available'}


def track(id_, available=True):
    return Obj(id=id_, title=f'Track {id_}', available=available, albums=[], artists=[])


class Client:
    me = Obj(account=Obj(uid=123, display_name='Listener'))

    async def init(self):
        return self

    async def users_likes_tracks(self):
        return Obj(tracks=[Obj(id=3), Obj(id=1), Obj(id=3)])

    async def tracks(self, ids):
        return [track(int(id_)) for id_ in reversed(ids)]

    async def users_playlists(self, kind, user_id):
        return Obj(tracks=[Obj(id=2, track=track(2)), Obj(id=9, track=track(9, False)),
                           Obj(id=2, track=track(2))])

    async def users_playlists_list(self):
        return [Obj(kind=1, title='Mine', owner=Obj(uid=123))]

    async def users_likes_playlists(self):
        return [Obj(playlist=Obj(kind=2, title='Saved', owner=Obj(uid=456)))]

    async def search(self, text, type_, page):
        assert (text, type_, page) == ('тест', 'track', 0)
        return Obj(tracks=Obj(results=[track(4)], total=1, per_page=20))

    async def artists_tracks(self, artist_id, page, page_size):
        return Obj(tracks=[track(page + 1)], pager=Obj(total=2, page=page, per_page=1))

    async def artists_direct_albums(self, artist_id, page, page_size):
        return Obj(albums=[Obj(id=10, title='Album')], pager=Obj(total=1, page=page, per_page=1))


@pytest.mark.asyncio
async def test_artist_catalog_pages_tracks_and_albums():
    backend = YandexBackend('token', client=Client())
    first = await backend.artist_tracks('42', None, 1)
    second = await backend.artist_tracks('42', first['next_cursor'], 1)
    albums = await backend.artist_albums('42', None, 1)
    assert [first['items'][0]['id'], second['items'][0]['id']] == ['1', '2']
    assert second['next_cursor'] is None
    assert albums['items'][0]['title'] == 'Album'


@pytest.mark.asyncio
async def test_resolve_prefers_actual_lossless_codec():
    class LosslessClient(Client):
        async def tracks_file_info(self, id_, **kwargs):
            return Obj(download_info=Obj(codec='flac-mp4', transport='raw',
                                         url='https://example.test/file', bitrate=0))
    stream = await YandexBackend('token', client=LosslessClient()).resolve('1')
    assert stream['codec'] == 'flac-mp4'
    assert stream['url'] == 'https://example.test/file'


@pytest.mark.asyncio
async def test_resolve_falls_back_when_lossless_response_is_not_flac():
    class Mp3Client(Client):
        async def tracks_file_info(self, id_, **kwargs):
            return Obj(download_info=Obj(codec='mp3', transport='raw', url='https://example.test/other'))
        async def tracks_download_info(self, id_):
            class Choice:
                codec, bitrate_in_kbps, preview = 'mp3', 320, False
                async def get_direct_link_async(self):
                    return 'https://example.test/mp3'
            return [Choice()]
    stream = await YandexBackend('token', client=Mp3Client()).resolve('1')
    assert stream == {'url': 'https://example.test/mp3', 'codec': 'mp3', 'bitrate': 320}


@pytest.mark.asyncio
async def test_resolve_mp3_mode_never_requests_lossless_and_strict_mode_rejects_fallback():
    class Formats(Client):
        async def tracks_file_info(self, id_, **kwargs):
            return Obj(download_info=Obj(codec='mp3', transport='raw', url='https://example.test/other'))
        async def tracks_download_info(self, id_):
            class Choice:
                codec, bitrate_in_kbps, preview = 'mp3', 320, False
                async def get_direct_link_async(self):
                    return 'https://example.test/mp3'
            return [Choice()]
    backend = YandexBackend('token', client=Formats())
    assert (await backend.resolve('1', 'mp3'))['codec'] == 'mp3'
    with pytest.raises(ServiceError):
        await backend.resolve('1', 'lossless')


@pytest.mark.asyncio
async def test_empty_artist_track_page_is_not_a_missing_artist():
    class EmptyClient(Client):
        async def artists_tracks(self, artist_id, page, page_size):
            class Empty:
                tracks = []
                pager = Obj(total=0, per_page=page_size)
                def __len__(self):
                    return 0
            return Empty()
    result = await YandexBackend('token', client=EmptyClient()).artist_tracks('42')
    assert result == {'items': [], 'next_cursor': None}


@pytest.mark.asyncio
async def test_liked_track_pages_fetch_only_current_slice_and_preserve_order():
    backend = YandexBackend('token', client=Client())
    await backend.initialize()
    result = await backend.library('tracks', None, 2)
    assert [item['id'] for item in result['items']] == ['3', '1']
    assert result['next_cursor'] == '2'
    await backend.close()


@pytest.mark.asyncio
async def test_collection_includes_owned_and_saved_playlists():
    backend = YandexBackend('token', client=Client())
    result = await backend.library('playlists', None, 50)
    assert [(item['owner'], item['id']) for item in result['items']] == [('123', '1'), ('456', '2')]
    await backend.close()


@pytest.mark.asyncio
async def test_playlist_retains_duplicate_entries_and_unavailable_markers():
    backend = YandexBackend('token', client=Client())
    result = await backend.playlist('123', '1', None, 50)
    assert [item['id'] for item in result['items']] == ['2', '9', '2']
    assert result['items'][1]['available'] is False
    await backend.close()


@pytest.mark.asyncio
async def test_search_maps_real_sdk_result_shape():
    backend = YandexBackend('token', client=Client())
    result = await backend.search('тест', 'track', None, 50)
    assert result['items'][0]['id'] == '4'
    assert result['next_cursor'] is None
    await backend.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(('status', 'code'), [(500, 'SERVICE_UNAVAILABLE'), (429, 'RATE_LIMITED'), (400, 'AUTH_EXPIRED')])
async def test_oauth_refresh_keeps_temporary_failures_distinct_from_invalid_credentials(status, code):
    class Response:
        async def __aenter__(self):
            self.status = status
            return self
        async def __aexit__(self, *args):
            pass
    class Session:
        def post(self, *args, **kwargs):
            return Response()
    backend = YandexBackend('fixture', client=Client())
    backend.session = Session()
    with pytest.raises(ServiceError) as result:
        await backend.refresh('refresh-fixture')
    assert result.value.code == code

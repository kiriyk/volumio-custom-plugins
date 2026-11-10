from types import SimpleNamespace as Obj

import pytest

from service.catalog import entity_dto, paginate, track_dto
from service.errors import ServiceError, public_error


def test_track_metadata_keeps_stable_ids_and_handles_partial_api_fields():
    dto = track_dto(Obj(id=12, title='Трек', duration_ms=123456, available=True,
                        artists=[Obj(name='Артист')],
                        albums=[Obj(id=34, title='Альбом')],
                        cover_uri='avatars.yandex.net/cover/%%'))
    assert dto == {'type': 'track', 'id': '12', 'album_id': '34', 'title': 'Трек',
                   'artists': ['Артист'], 'artist_links': [], 'album': 'Альбом', 'duration_ms': 123456,
                   'cover_url': 'https://avatars.yandex.net/cover/300x300', 'available': True}
    assert track_dto(Obj(id=99, available=False))['available'] is False
    assert track_dto(Obj(id=99, artists=None, albums=None))['artists'] == []


def test_playlist_identity_uses_uid_and_kind_not_title():
    value = entity_dto('playlist', Obj(kind=42, title='Saved', owner=Obj(uid=321),
                                      cover=Obj(uri='avatars.yandex.net/test/%%')))
    assert (value['owner'], value['id'], value['title']) == ('321', '42', 'Saved')


def test_track_keeps_artist_ids_for_navigation():
    dto = track_dto(Obj(id=1, artists=[Obj(id=42, name='Artist'), Obj(id=71, name='Guest')]))
    assert dto['artist_links'] == [{'id': '42', 'name': 'Artist'}, {'id': '71', 'name': 'Guest'}]


def test_playlist_without_optional_owner_uses_playlist_uid():
    value = entity_dto('playlist', Obj(uid=321, kind=42, title='Saved', owner=None))
    assert value['owner'] == '321'


def test_mosaic_playlist_art_uses_first_available_album_cover():
    value = entity_dto('playlist', Obj(uid=321, kind=42, title='Saved',
        cover=Obj(type='mosaic', uri=None, items_uri=['avatars.yandex.net/get-music-content/cover/%%'])))
    assert value['cover_url'] == 'https://avatars.yandex.net/get-music-content/cover/300x300'


def test_pages_preserve_duplicates_and_reject_bad_limits():
    assert paginate(['a', 'b', 'a'], '1', 2) == {'items': ['b', 'a'], 'next_cursor': None}
    assert paginate(['a', 'b', 'c'], None, 2) == {'items': ['a', 'b'], 'next_cursor': '2'}
    assert paginate([], None, 50) == {'items': [], 'next_cursor': None}
    for cursor, limit in [('-1', 50), ('abc', 50), (None, 0), (None, 101)]:
        with pytest.raises(ServiceError):
            paginate([], cursor, limit)


def test_unexpected_sdk_errors_never_expose_request_or_token():
    error = public_error(RuntimeError('Authorization OAuth private-secret https://host/?sign=abc'))
    assert error.code == 'SERVICE_UNAVAILABLE'
    assert 'private-secret' not in error.message
    assert 'sign=' not in error.message

import asyncio
import logging
import re
import time
from collections import OrderedDict

import aiohttp
from yandex_music import ClientAsync
from yandex_music._client_async.device_auth import _DEFAULT_CLIENT_ID, _DEFAULT_CLIENT_SECRET
from yandex_music.utils.request_async import Request
from yandex_music.exceptions import NetworkError, TimedOutError

from .catalog import entity_dto, paginate, pagination, track_dto, value
from .errors import ServiceError

# SDK's DEBUG decorators can include arguments, including OAuth credentials.
logging.getLogger('yandex_music').setLevel(logging.CRITICAL)


class PooledRequest(Request):
    def __init__(self, session):
        super().__init__(timeout=20)
        self.session = session

    async def _request_wrapper(self, *args, **kwargs):
        try:
            async with self.session.request(*args, **self._prepare_kwargs(kwargs)) as response:
                chunks, size = [], 0
                async for chunk in response.content.iter_chunked(65536):
                    size += len(chunk)
                    if size > 16 * 1024 * 1024:
                        raise ServiceError('UNAVAILABLE', 'Music service response is too large', 502)
                    chunks.append(chunk)
                body = b''.join(chunks)
                if not 200 <= response.status < 300:
                    self._handle_error_response(response.status, body)
                return body
        except asyncio.TimeoutError:
            raise TimedOutError from None
        except aiohttp.ClientError:
            raise NetworkError('Upstream connection failed') from None


class YandexBackend:
    def __init__(self, token=None, client=None):
        self.token, self.client, self.session = token, client, None
        self.cache = OrderedDict()
        self.quality_cache = OrderedDict()
        self.quality_lock = asyncio.Lock()

    async def _client(self):
        if self.client is None:
            self.session = aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=8))
            self.client = ClientAsync(self.token, request=PooledRequest(self.session))
        return self.client

    async def initialize(self):
        client = await self._client()
        await client.init()
        account = value(client.me, 'account')
        if not value(account, 'uid'):
            raise ServiceError('AUTH_EXPIRED', 'Sign in again', 401)
        return {'id': str(account.uid), 'name': value(account, 'display_name',
                                                   value(account, 'login', 'Listener'))}

    async def request_device_code(self):
        code = await (await self._client()).request_device_code(device_name='Volumio Yandex Music')
        return {name: getattr(code, name) for name in
                ('device_code', 'user_code', 'verification_url', 'expires_in', 'interval')}

    async def poll_device_token(self, code):
        token = await (await self._client()).poll_device_token(code)
        return token.to_dict() if token else None

    async def refresh(self, refresh_token):
        await self._client()
        async with self.session.post('https://oauth.yandex.ru/token', data={
            'grant_type': 'refresh_token', 'refresh_token': refresh_token,
            'client_id': _DEFAULT_CLIENT_ID, 'client_secret': _DEFAULT_CLIENT_SECRET,
        }, timeout=aiohttp.ClientTimeout(total=20)) as response:
            if response.status == 429:
                raise ServiceError('RATE_LIMITED', 'Try again later', 429)
            if response.status >= 500:
                raise ServiceError('SERVICE_UNAVAILABLE', 'OAuth service is unavailable', 503)
            if response.status != 200:
                raise ServiceError('AUTH_EXPIRED', 'Sign in again', 401)
            result = await response.json()
            if not result.get('access_token'):
                raise ServiceError('AUTH_EXPIRED', 'Sign in again', 401)
            return result

    async def _cached(self, key, fetch):
        entry = self.cache.get(key)
        if entry and entry[0] > time.monotonic():
            self.cache.move_to_end(key)
            return entry[1]
        result = await fetch()
        self.cache[key] = (time.monotonic() + 60, result)
        self.cache.move_to_end(key)
        while len(self.cache) > 8:
            self.cache.popitem(last=False)
        return result

    async def tracks(self, ids):
        if not ids:
            return []
        client = await self._client()
        found = {}
        for offset in range(0, len(ids), 100):
            for track in await client.tracks(ids[offset:offset + 100]):
                found[str(track.id)] = track
        # SDK may reorder results; preserve playlist duplicates and mark missing items.
        return [track_dto(found[str(id_).split(':')[0]]) if str(id_).split(':')[0] in found
                else {'type': 'track', 'id': str(id_), 'title': 'Unavailable',
                      'available': False, 'artists': [], 'album': '', 'album_id': '',
                      'duration_ms': 0, 'cover_url': ''} for id_ in ids]

    async def search(self, text, kind='track', cursor=None, limit=50):
        page, _ = pagination(cursor, limit)
        if kind not in ('track', 'album', 'artist', 'playlist') or not text.strip():
            raise ServiceError('BAD_REQUEST', 'Enter a search query and valid category', 400)
        result = await (await self._client()).search(text[:500], type_=kind, page=page)
        bucket = value(result, {'track': 'tracks', 'album': 'albums',
                                'artist': 'artists', 'playlist': 'playlists'}[kind])
        items = value(bucket, 'results', [])
        more = (page + 1) * value(bucket, 'per_page', len(items) or 1) < value(bucket, 'total', 0)
        return {'items': [entity_dto(kind, item) for item in items],
                'next_cursor': str(page + 1) if more else None}

    async def library(self, section, cursor=None, limit=50):
        client = await self._client()
        pagination(cursor, limit)
        if section == 'tracks':
            result = await self._cached('likes-tracks', client.users_likes_tracks)
            ids = [str(t.id) for t in value(result, 'tracks', [])]
            page = paginate(ids, cursor, limit)
            page['items'] = await self.tracks(page['items'])
            return page
        if section == 'playlists':
            async def fetch():
                own = await client.users_playlists_list()
                saved = await client.users_likes_playlists()
                entries = [*own, *[value(item, 'playlist') for item in saved]]
                seen, output = set(), []
                for item in entries:
                    if item:
                        dto = entity_dto('playlist', item)
                        key = (dto['owner'], dto['id'])
                        if key not in seen:
                            seen.add(key)
                            output.append(dto)
                return output
            return paginate(await self._cached('playlists', fetch), cursor, limit)
        if section in ('albums', 'artists'):
            kind = section[:-1]
            method = client.users_likes_albums if kind == 'album' else client.users_likes_artists
            likes = await self._cached(section, method)
            return paginate([entity_dto(kind, value(item, kind)) for item in likes
                             if value(item, kind)], cursor, limit)
        raise ServiceError('NOT_FOUND', 'Unknown collection section', 404)

    async def playlist(self, owner, kind, cursor=None, limit=50):
        client = await self._client()
        async def fetch():
            return await client.users_playlists(kind, user_id=owner)
        result = await self._cached(f'playlist:{owner}:{kind}', fetch)
        if not result:
            raise ServiceError('NOT_FOUND', 'Playlist was not found', 404)
        page = paginate(value(result, 'tracks', []), cursor, limit)
        entries = page['items']
        missing = [str(item.id) for item in entries if not value(item, 'track')]
        fetched = {item['id']: item for item in await self.tracks(missing)}
        page['items'] = [track_dto(item.track) if value(item, 'track')
                         else fetched[str(item.id)] for item in entries]
        return page

    async def album(self, id_, cursor=None, limit=50):
        client = await self._client()
        result = await self._cached(f'album:{id_}', lambda: client.albums_with_tracks(id_))
        if not result:
            raise ServiceError('NOT_FOUND', 'Album was not found', 404)
        return paginate([track_dto(t) for volume in value(result, 'volumes', []) for t in volume],
                        cursor, limit)

    async def artist(self, id_, cursor=None, limit=50):
        page, size = pagination(cursor, limit)
        client = await self._client()
        if page == 0:
            info = await client.artists_brief_info(id_)
            tracks = [track_dto(t) for t in value(info, 'popular_tracks', [])]
            albums = [entity_dto('album', a) for a in value(info, 'albums', [])]
            return {'items': tracks + albums, 'next_cursor': None}
        return {'items': [], 'next_cursor': None}

    async def _artist_page(self, id_, cursor, limit, kind):
        page, size = pagination(cursor, limit)
        client = await self._client()
        method = client.artists_tracks if kind == 'track' else client.artists_direct_albums
        result = await method(id_, page=page, page_size=size)
        if result is None:
            raise ServiceError('NOT_FOUND', 'Artist was not found', 404)
        items = value(result, 'tracks' if kind == 'track' else 'albums', [])
        pager = value(result, 'pager')
        total = value(pager, 'total', None)
        per_page = value(pager, 'per_page', size)
        more = ((page + 1) * per_page < total) if total is not None else len(items) == size
        return {'items': [entity_dto(kind, item) for item in items],
                'next_cursor': str(page + 1) if more else None}

    async def artist_tracks(self, id_, cursor=None, limit=50):
        return await self._artist_page(id_, cursor, limit, 'track')

    async def artist_albums(self, id_, cursor=None, limit=50):
        return await self._artist_page(id_, cursor, limit, 'album')

    async def track_quality(self, id_):
        if not isinstance(id_, str) or not re.fullmatch(r'\d{1,24}(?::\d{1,24})?', id_):
            raise ServiceError('BAD_REQUEST', 'Invalid track ID', 400)
        # Separate from playback: no stream tickets, media requests or direct-link calls.
        async with self.quality_lock:
            entry = self.quality_cache.get(id_)
            if entry and entry[0] > time.monotonic():
                self.quality_cache.move_to_end(id_)
                return entry[1]
            client = await self._client()
            info = value(await client.tracks_file_info(id_, quality='lossless', transport='raw'), 'download_info')
            if (value(info, 'codec') in ('flac', 'flac-mp4')
                    and value(info, 'transport') == 'raw' and value(info, 'url')):
                result = {'codec': 'flac', 'basis': 'available'}
            else:
                variants = await client.tracks_download_info(id_)
                rates = [value(v, 'bitrate_in_kbps', 0) for v in variants or []
                         if value(v, 'codec') == 'mp3' and not value(v, 'preview', False)]
                rates = [r for r in rates if isinstance(r, (int, float)) and 0 < r <= 320]
                result = {'codec': 'mp3', 'bitrate': max(rates), 'basis': 'available'} if rates else None
            self.quality_cache[id_] = (time.monotonic() + 3600, result)
            self.quality_cache.move_to_end(id_)
            while len(self.quality_cache) > 512:
                self.quality_cache.popitem(last=False)
            return result

    async def resolve(self, id_, quality='auto'):
        client = await self._client()
        if quality not in ('auto', 'lossless', 'mp3'):
            raise ServiceError('BAD_REQUEST', 'Invalid quality', 400)
        if quality != 'mp3':
            result = await client.tracks_file_info(id_, quality='lossless', transport='raw')
            lossless = value(result, 'download_info')
            if (value(lossless, 'codec') in ('flac', 'flac-mp4')
                    and value(lossless, 'transport') == 'raw' and value(lossless, 'url')):
                return {'url': lossless.url, 'codec': lossless.codec,
                        'bitrate': value(lossless, 'bitrate', 0)}
            if quality == 'lossless':
                raise ServiceError('UNAVAILABLE', 'Lossless unavailable', 422)
        choices = await client.tracks_download_info(id_)
        choices = [c for c in choices if c.codec == 'mp3' and not value(c, 'preview', False)]
        if not choices:
            raise ServiceError('UNAVAILABLE', 'No playable MP3; check subscription and availability', 422)
        selected = max(choices, key=lambda c: min(value(c, 'bitrate_in_kbps', 0), 320))
        url = await selected.get_direct_link_async()
        return {'url': url, 'codec': 'mp3', 'bitrate': selected.bitrate_in_kbps}

    async def close(self):
        if self.session:
            await self.session.close()
        self.cache.clear()
        self.quality_cache.clear()

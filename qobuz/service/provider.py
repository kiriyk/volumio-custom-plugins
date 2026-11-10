"""Unofficial Qobuz web protocol, isolated from Volumio and transport UI."""
import asyncio
import base64
import hashlib
import re
import time
from urllib.parse import urlencode

import aiohttp

from .errors import ServiceError

BASE = 'https://www.qobuz.com/api.json/0.2'


def callback_code(params):
    code = params.get('code_autorisation') or params.get('code')
    if not isinstance(code, str) or not code or len(code) > 8192:
        raise ServiceError('BAD_REQUEST', 'Missing authorization code', 400)
    return code


def identifier(value, numeric=False):
    value = str(value)
    if not re.fullmatch(r'\d{1,24}' if numeric else r'[A-Za-z0-9]{1,64}', value):
        raise ServiceError('BAD_REQUEST', 'Invalid identifier', 400)
    return value


def page(items, total, offset, mapper):
    return {'items': [mapper(item) for item in items],
            'next_cursor': str(offset + len(items)) if items and offset + len(items) < total else None}


def artist(item):
    value = item.get('performer') or item.get('artist') or {}
    return value.get('name', '') if isinstance(value, dict) else ''


def cover(item):
    image = item.get('image') or {}
    url = image.get('large') or image.get('small') or ''
    return url if isinstance(url, str) and url.startswith('https://') else ''


def map_album(item):
    return {'type': 'album', 'id': str(item['id']), 'title': item.get('title', ''),
            'artists': [artist(item)], 'cover_url': cover(item)}


def map_track(item, album=None):
    album = item.get('album') or album or {}
    return {'type': 'track', 'id': str(item['id']), 'title': item.get('title', ''),
            'artists': [artist(item) or artist(album)], 'album': album.get('title', ''),
            'cover_url': cover(album), 'duration_ms': int(item.get('duration') or 0) * 1000,
            'available': bool(item.get('streamable', False))}


class Provider:
    def __init__(self, store, request=None):
        self.store = store
        self.credentials = store.load() or {}
        self.transport = request
        self.session = None
        self.lock = asyncio.Lock()
        self.secret = None
        self.auth_epoch = 0
        self.on_change = lambda: None

    async def start(self):
        self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=25),
                                             connector=aiohttp.TCPConnector(limit=4))

    async def close(self):
        if self.session:
            await self.session.close()

    def account(self):
        return {'authenticated': bool(self.credentials.get('access_token'))}

    async def _http(self, path, params=None, post=False, token=None):
        if self.transport:
            return await self.transport(path, params or {}, post=post, token=token)
        headers = {'X-App-Id': self.credentials.get('app_id', ''), 'User-Agent': 'Mozilla/5.0'}
        if token:
            headers['X-User-Auth-Token'] = token
        if post:
            headers['Content-Type'] = 'text/plain;charset=UTF-8'
        async with self.session.request('POST' if post else 'GET', BASE + path,
                params=params, headers=headers, data=b'extra=partner' if post else None,
                allow_redirects=False) as response:
            status = response.status
            if status >= 300:
                code = {400: 'BAD_REQUEST', 401: 'AUTH_EXPIRED', 403: 'UNAVAILABLE',
                        404: 'NOT_FOUND', 410: 'API_CHANGED', 429: 'RATE_LIMITED'}.get(status, 'SERVICE_UNAVAILABLE')
                raise ServiceError(code, 'Qobuz request failed', status if status >= 400 else 502)
            if response.content_length and response.content_length > 8 * 1024 * 1024:
                raise ServiceError()
            data = bytearray()
            async for chunk in response.content.iter_chunked(65536):
                data.extend(chunk)
                if len(data) > 8 * 1024 * 1024:
                    raise ServiceError()
            import json
            return json.loads(data)

    async def call(self, path, params=None):
        token = self.credentials.get('access_token')
        epoch = self.auth_epoch
        if not token:
            raise ServiceError('AUTH_EXPIRED', 'Sign in to Qobuz', 401)
        try:
            return await self._http(path, params, token=token)
        except ServiceError as error:
            if error.code == 'AUTH_EXPIRED' and epoch == self.auth_epoch:
                self.auth_epoch += 1
                self.credentials.pop('access_token', None)
                self.store.clear()
                self.on_change()
            raise

    async def discover(self):
        # Web player metadata discovery follows the open upmpdcli bundle adapter.
        async with self.session.get('https://play.qobuz.com/login') as response:
            if response.status != 200:
                raise ServiceError('API_CHANGED', 'Qobuz web player unavailable', 502)
            html = await response.text()
        match = re.search(r'<script src="(/resources/\d+\.\d+\.\d+-[a-z]\d{3}/bundle\.js)"', html)
        if not match:
            raise ServiceError('API_CHANGED', 'Qobuz web player changed', 502)
        async with self.session.get('https://play.qobuz.com' + match[1]) as response:
            if response.status != 200:
                raise ServiceError('API_CHANGED', 'Qobuz web player changed', 502)
            bundle = await response.text()
        app = re.search(r'production:\{api:\{appId:"(\d+)",appSecret:"\w{32}"', bundle)
        private = re.search(r'privateKey:\s*"([A-Za-z0-9]{6,30})"', bundle)
        candidates = []
        for seed, zone in re.findall(r'[a-z]\.initialSeed\("([\w=]+)",window\.utimezone\.([a-z]+)\)', bundle):
            extra = re.search(r'name:"\w+/' + re.escape(zone.capitalize()) + r'",info:"([\w=]+)",extras:"([\w=]+)"', bundle)
            if extra:
                try:
                    candidates.append(base64.b64decode((seed + extra[1] + extra[2])[:-44]).decode())
                except (ValueError, UnicodeError):
                    continue
        if not app or not private or not candidates:
            raise ServiceError('API_CHANGED', 'Qobuz web player changed', 502)
        self.credentials.update(app_id=app[1], oauth_parameter=private[1], stream_candidates=candidates)

    async def begin_login(self, host, path):
        # Always discover current app parameters for a new browser session.
        await self.discover()
        return 'https://www.qobuz.com/signin/oauth?' + urlencode({
            'ext_app_id': self.credentials['app_id'], 'redirect_url': f'http://{host}:17900{path}'})

    async def finish_login(self, code):
        async with self.lock:
            result = await self._http('/oauth/callback', {'code': code,
                'private_key': self.credentials['oauth_parameter'], 'app_id': self.credentials['app_id']})
            token = result.get('token')
            if not isinstance(token, str) or not token:
                raise ServiceError('AUTH_EXPIRED', 'Qobuz did not complete sign-in', 401)
            profile = await self._http('/user/login', post=True, token=token)
            user = profile.get('user') or {}
            if not user.get('id') or not (user.get('credential') or {}).get('parameters'):
                raise ServiceError('UNAVAILABLE', 'Qobuz subscription required', 403)
            self.credentials.update(access_token=profile.get('user_auth_token') or token, user_id=user['id'])
            self.auth_epoch += 1
            self.store.save(self.credentials)
            self.on_change()
            return self.account()

    async def logout(self):
        async with self.lock:
            self.credentials = {}
            self.auth_epoch += 1
            self.secret = None
            self.store.clear()
            self.on_change()

    async def search(self, query, kind, offset=0, limit=50):
        if kind not in ('track', 'album') or not isinstance(query, str) or not query.strip() or len(query) > 300:
            raise ServiceError('BAD_REQUEST', 'Invalid search', 400)
        data = await self.call('/catalog/search', {'query': query, 'type': kind + 's', 'offset': offset, 'limit': limit})
        result = data.get(kind + 's') or {}
        return page(result.get('items') or [], int(result.get('total') or 0), offset,
                    map_track if kind == 'track' else map_album)

    async def album(self, id_, offset=0, limit=50):
        data = await self.call('/album/get', {'album_id': identifier(id_), 'offset': offset, 'limit': limit})
        tracks = data.get('tracks') or {}
        result = page(tracks.get('items') or [], int(tracks.get('total') or 0), offset,
                      lambda item: map_track(item, data))
        result['title'] = data.get('title', 'Qobuz')
        return result

    async def library(self, offset=0, limit=50):
        data = await self.call('/favorite/getUserFavorites', {'type': 'albums', 'offset': offset, 'limit': limit})
        result = data.get('albums') or {}
        return page(result.get('items') or [], int(result.get('total') or 0), offset, map_album)

    async def track(self, id_):
        data = await self.call('/track/get', {'track_id': identifier(id_, numeric=True)})
        return {'items': [map_track(data)], 'next_cursor': None}

    async def resolve(self, id_, quality='27'):
        id_ = identifier(id_, numeric=True)
        quality = str(quality)
        if quality not in ('6', '27'):
            raise ServiceError('BAD_REQUEST', 'Invalid quality', 400)
        formats = (27, 7, 6) if quality == '27' else (6,)
        candidates = self.credentials.get('stream_candidates') or []
        if self.secret:
            candidates = [self.secret] + [x for x in candidates if x != self.secret]
        for format_id in formats:
            for secret in candidates:
                timestamp = str(time.time())
                signature = hashlib.md5((f'trackgetFileUrlformat_id{format_id}intentstreamtrack_id{id_}'
                                        + timestamp + secret).encode('ascii')).hexdigest()
                try:
                    data = await self.call('/track/getFileUrl', {'track_id': id_, 'format_id': format_id,
                        'intent': 'stream', 'request_ts': timestamp, 'request_sig': signature})
                except ServiceError as error:
                    if error.code == 'BAD_REQUEST':
                        continue
                    raise
                if not data.get('url'):
                    continue
                if data.get('mime_type') != 'audio/flac' or data.get('format_id') not in (6, 7, 27):
                    raise ServiceError('UNAVAILABLE', 'FLAC is unavailable', 422)
                self.secret = secret
                return {'url': data['url'], 'codec': 'flac', 'bitrate': None,
                        'sampleRate': round(float(data.get('sampling_rate') or 0) * 1000),
                        'bitDepth': int(data.get('bit_depth') or 0)}
        raise ServiceError('UNAVAILABLE', 'FLAC is unavailable', 422)

import asyncio
import re
import secrets
import time
from collections import OrderedDict
from urllib.parse import urljoin, urlsplit

import aiohttp
from aiohttp import web

from .errors import ServiceError


def validate_upstream(url):
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or '').lower()
        allowed = ('storage.yandex.net', 'storage.mds.yandex.net', 'music.yandex.net',
                   'music.yandex.ru', 'strm.yandex.net')
        if (parsed.scheme != 'https' or parsed.username or parsed.password
                or parsed.port not in (None, 443)
                or not any(host == suffix or host.endswith('.' + suffix) for suffix in allowed)):
            raise ValueError
    except (ValueError, TypeError):
        raise ServiceError('UNAVAILABLE', 'Untrusted audio upstream', 502) from None


class Streaming:
    def __init__(self, auth, policy=validate_upstream):
        self.auth, self.policy = auth, policy
        self.tickets = OrderedDict()
        self.session = None
        self.semaphore = asyncio.Semaphore(4)
        self.epoch = 0

    async def start(self):
        self.session = aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(limit=4), auto_decompress=False,
            timeout=aiohttp.ClientTimeout(total=None, connect=15, sock_read=30))

    def invalidate(self):
        self.epoch += 1
        self.tickets.clear()

    async def resolve(self, track_id, quality='auto'):
        stream = await self.auth.call('resolve', track_id, quality) if quality != 'auto' else await self.auth.call('resolve', track_id)
        self.policy(stream['url'])
        epoch = self.epoch
        now = time.monotonic()
        for key in list(self.tickets):
            if self.tickets[key]['expires'] < now:
                del self.tickets[key]
        key = secrets.token_urlsafe(24)
        self.tickets[key] = {'id': track_id, 'quality': quality, 'stream': stream, 'expires': now + 43200,
                             'epoch': epoch}
        while len(self.tickets) > 128:
            self.tickets.popitem(last=False)
        return {'path': f'/stream/{key}', 'codec': stream['codec'], 'bitrate': stream['bitrate']}

    async def _open(self, method, url, headers):
        for _ in range(4):
            self.policy(url)
            response = await self.session.request(method, url, headers=headers, allow_redirects=False)
            if response.status not in (301, 302, 303, 307, 308):
                return response
            next_url = urljoin(url, response.headers.get('Location', ''))
            response.release()
            if next_url == url:
                break
            url = next_url
        raise ServiceError('UNAVAILABLE', 'Audio redirect failed', 502)

    async def handle(self, request):
        ticket = self.tickets.get(request.match_info['ticket'])
        if not ticket or ticket['expires'] < time.monotonic():
            raise ServiceError('NOT_FOUND', 'Stream expired; start the track again', 404)
        range_ = request.headers.get('Range')
        if range_ and not re.fullmatch(r'bytes=(?:\d+-\d*|-\d+)', range_):
            return web.Response(status=416)
        headers = {'Range': range_} if range_ else {}
        outgoing, upstream = None, None
        async with self.semaphore:
            try:
                upstream = await self._open(request.method, ticket['stream']['url'], headers)
                if upstream.status in (401, 403, 410):
                    upstream.release()
                    fresh = (await self.auth.call('resolve', ticket['id'], ticket['quality'])
                             if ticket['quality'] != 'auto' else await self.auth.call('resolve', ticket['id']))
                    self.policy(fresh['url'])
                    if ticket['epoch'] != self.epoch:
                        raise ServiceError('AUTH_REQUIRED', 'Account changed', 401)
                    ticket['stream'] = fresh
                    upstream = await self._open(request.method, fresh['url'], headers)
                if upstream.status not in (200, 206, 416):
                    raise ServiceError('UNAVAILABLE', 'Audio upstream is unavailable', 502)
                if range_ and upstream.status == 200:
                    raise ServiceError('UNAVAILABLE', 'Audio upstream does not support seeking', 502)
                if upstream.headers.get('Content-Encoding', 'identity') != 'identity':
                    raise ServiceError('UNAVAILABLE', 'Unsupported audio transfer encoding', 502)
                forwarded = {name: upstream.headers[name] for name in (
                    'Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag',
                    'Last-Modified') if name in upstream.headers}
                forwarded['Cache-Control'] = 'no-store'
                outgoing = web.StreamResponse(status=upstream.status, headers=forwarded)
                await outgoing.prepare(request)
                if request.method != 'HEAD':
                    async for chunk in upstream.content.iter_chunked(65536):
                        if ticket['epoch'] != self.epoch:
                            raise ConnectionResetError('Account changed')
                        await outgoing.write(chunk)
                await outgoing.write_eof()
                return outgoing
            except (aiohttp.ClientError, asyncio.TimeoutError, ConnectionError):
                if outgoing and outgoing.prepared:
                    outgoing.force_close()
                    if request.transport:
                        request.transport.close()
                    return outgoing
                raise ServiceError('UPSTREAM_TIMEOUT', 'Audio connection failed', 502) from None
            finally:
                if upstream:
                    upstream.close()

    async def close(self):
        self.invalidate()
        if self.session:
            await self.session.close()

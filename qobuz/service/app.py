import asyncio
import hmac
import ipaddress
import json
import os
import re
import secrets
import time
from pathlib import Path

from aiohttp import web

from .errors import ServiceError, public_error
from .provider import Provider, callback_code, identifier
from .storage import CredentialStore
from .streaming import Streaming, validate_upstream

STREAMING = web.AppKey('streaming', Streaming)


def create_apps(provider, state_dir, api_key, upstream_policy=None):
    pending = {'login': None}

    @web.middleware
    async def boundary(request, handler):
        try:
            if request.path.startswith('/v1/'):
                if request.headers.get('Origin'):
                    raise ServiceError('ACCESS_DENIED', 'Local API only', 403)
                if request.remote not in ('127.0.0.1', '::1'):
                    raise ServiceError('ACCESS_DENIED', 'Local API only', 403)
                if not hmac.compare_digest(request.headers.get('X-API-Key', '').encode(), api_key.encode()):
                    raise ServiceError('ACCESS_DENIED', 'Local authorization required', 401)
                async with asyncio.timeout(60):
                    response = await handler(request)
            else:
                response = await handler(request)
        except (web.HTTPException, json.JSONDecodeError, ValueError, TypeError, KeyError) as error:
            status = error.status if isinstance(error, web.HTTPException) else 400
            response = web.json_response({'error': {'code': 'NOT_FOUND' if status == 404 else 'BAD_REQUEST'}}, status=status)
        except Exception as error:
            safe = public_error(error)
            response = web.json_response({'error': {'code': safe.code}}, status=safe.status)
        if not response.prepared:
            response.headers['Cache-Control'] = 'no-store'
        return response

    api = web.Application(middlewares=[boundary], client_max_size=16384)
    callback = web.Application(middlewares=[boundary], client_max_size=16384)

    class Bridge:
        async def call(self, method, *args):
            return await getattr(provider, method)(*args)

    streaming = Streaming(Bridge(), upstream_policy or validate_upstream)
    provider.on_change = streaming.invalidate
    api[STREAMING] = streaming

    async def lifecycle(app):
        await provider.start()
        await streaming.start()
        try:
            yield
        finally:
            await streaming.close()
            await provider.close()
    api.cleanup_ctx.append(lifecycle)

    async def health(request):
        return web.json_response({'ready': True, 'api_version': 1})

    async def account(request):
        return web.json_response(provider.account())

    async def start_login(request):
        body = await request.json()
        host = body.get('host')
        address = ipaddress.IPv4Address(host)
        if not address.is_private or address.is_loopback or address.is_unspecified or address.is_multicast:
            raise ValueError('Invalid callback host')
        path = '/oauth/' + secrets.token_urlsafe(24) + '/'
        login = {'path': path, 'expires': time.monotonic() + 600, 'consumed': False}
        url = await provider.begin_login(str(address), path)
        pending['login'] = login
        return web.json_response({'url': url})

    async def oauth(request):
        login = pending['login']
        if not login or request.path != login['path']:
            raise web.HTTPNotFound()
        if login['consumed'] or login['expires'] < time.monotonic():
            return web.Response(text='Ссылка входа использована или устарела. Начни новый вход в настройках Qobuz.', status=410)
        code = callback_code(request.query)
        login['consumed'] = True
        streaming.invalidate()
        try:
            await provider.finish_login(code)
        except Exception:
            return web.Response(text='Не удалось завершить вход. Начни новый вход в настройках Qobuz.', status=502,
                                headers={'Referrer-Policy': 'no-referrer'})
        return web.Response(text='Qobuz: вход выполнен. Можно закрыть вкладку и обновить настройки плагина.',
                            headers={'Referrer-Policy': 'no-referrer'})

    async def logout(request):
        pending['login'] = None
        streaming.invalidate()
        await provider.logout()
        return web.json_response({'authenticated': False})

    def paging(request):
        cursor = request.query.get('cursor', '0')
        if not re.fullmatch(r'\d{1,7}', cursor):
            raise ValueError('Invalid cursor')
        return int(cursor), 50

    async def search(request):
        return web.json_response(await provider.search(request.query.get('q', ''),
            request.query.get('type', 'album'), *paging(request)))

    async def album(request):
        return web.json_response(await provider.album(identifier(request.match_info['id']), *paging(request)))

    async def library(request):
        return web.json_response(await provider.library(*paging(request)))

    async def track(request):
        return web.json_response(await provider.track(request.match_info['id']))

    async def resolve(request):
        data = await request.json()
        return web.json_response(await streaming.resolve(identifier(data.get('track_id', ''), numeric=True), data.get('quality', '27')))

    api.router.add_get('/health', health)
    api.router.add_get('/v1/account', account)
    api.router.add_post('/v1/auth/start', start_login)
    api.router.add_post('/v1/auth/logout', logout)
    api.router.add_get('/v1/search', search)
    api.router.add_get('/v1/albums/{id}', album)
    api.router.add_get('/v1/tracks/{id}', track)
    api.router.add_get('/v1/library/albums', library)
    api.router.add_post('/v1/playback/resolve', resolve)
    api.router.add_get('/stream/{ticket}', streaming.handle)
    callback.router.add_get('/oauth/{nonce}/', oauth)
    return api, callback


async def run():
    state = Path(os.environ['QOBUZ_STATE_DIR'])
    provider = Provider(CredentialStore(state / 'credentials.json'))
    api, callback = create_apps(provider, state, (state / 'api-key').read_text().strip())
    runner = web.AppRunner(api, access_log=None)
    callback_runner = web.AppRunner(callback, access_log=None)
    await runner.setup(); await callback_runner.setup()
    try:
        await web.TCPSite(runner, '127.0.0.1', 17901).start()
        await web.TCPSite(callback_runner, '0.0.0.0', 17900).start()
        await asyncio.Event().wait()
    finally:
        await callback_runner.cleanup(); await runner.cleanup()


if __name__ == '__main__':
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass

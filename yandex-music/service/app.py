import asyncio
import hmac
import json
import logging
import os
import re
import secrets
from pathlib import Path

from aiohttp import web

from .auth import AuthManager
from .backend import YandexBackend
from .catalog import pagination
from .errors import ServiceError, public_error
from .storage import CredentialStore
from .streaming import Streaming, validate_upstream

AUTH = web.AppKey('auth', AuthManager)
STREAMING = web.AppKey('streaming', Streaming)


def create_app(backend=YandexBackend, state_dir=None, api_key=None, upstream_policy=None):
    state_dir = Path(state_dir or os.environ.get('YANDEX_STATE_DIR', '.state'))
    api_key = api_key or os.environ.get('YANDEX_API_KEY')
    if not api_key:
        api_key = (state_dir / 'api-key').read_text().strip()
    if not api_key:
        raise ValueError('Missing local API key')

    @web.middleware
    async def boundary(request, handler):
        request_id = secrets.token_hex(8)
        try:
            if request.path.startswith('/v1/'):
                if request.headers.get('Origin'):
                    raise ServiceError('ACCESS_DENIED', 'Use the Volumio interface', 403)
                if request.url.host not in ('127.0.0.1', 'localhost', '::1'):
                    raise ServiceError('ACCESS_DENIED', 'Local API only', 403)
                supplied = request.headers.get('X-API-Key', '')
                if not hmac.compare_digest(supplied.encode(), api_key.encode()):
                    raise ServiceError('ACCESS_DENIED', 'Local authorization required', 401)
                async with asyncio.timeout(30):
                    response = await handler(request)
            else:
                response = await handler(request)
        except web.HTTPException as error:
            response = web.json_response({'error': {'code': 'BAD_REQUEST' if error.status == 400
                                                    else 'NOT_FOUND',
                                                   'message': 'Invalid request'}}, status=error.status)
        except (json.JSONDecodeError, ValueError, TypeError, KeyError):
            response = web.json_response({'error': {'code': 'BAD_REQUEST',
                                                   'message': 'Invalid request'}}, status=400)
        except Exception as error:
            safe = public_error(error)
            logging.getLogger(__name__).warning('request=%s code=%s', request_id, safe.code)
            response = web.json_response({'error': {'code': safe.code, 'message': safe.message}},
                                         status=safe.status)
        if not response.prepared:
            response.headers['X-Request-ID'] = request_id
            response.headers['Cache-Control'] = 'no-store'
        return response

    app = web.Application(middlewares=[boundary], client_max_size=16384)
    auth = AuthManager(CredentialStore(state_dir / 'credentials.json'), backend)
    streaming = Streaming(auth, upstream_policy or validate_upstream)
    auth.on_change = streaming.invalidate
    app[AUTH], app[STREAMING] = auth, streaming

    async def lifecycle(application):
        await streaming.start()
        await auth.initialize()
        try:
            yield
        finally:
            await streaming.close()
            await auth.close()
    app.cleanup_ctx.append(lifecycle)

    async def health(request):
        return web.json_response({'ready': True, 'api_version': 1})

    async def account(request):
        return web.json_response(auth.account())

    async def body(request):
        data = await request.json()
        if not isinstance(data, dict):
            raise ValueError('JSON object required')
        return data

    async def auth_action(request):
        action = request.match_info['action']
        if action == 'device':
            result = await auth.start()
        elif action == 'token':
            result = await auth.login_token((await body(request)).get('token'))
        elif action == 'logout':
            result = await auth.logout()
        else:
            raise ServiceError('NOT_FOUND', 'Unknown operation', 404)
        return web.json_response(result)

    async def device_status(request):
        return web.json_response(auth.status(request.match_info['session_id']))

    async def catalog(request):
        cursor = request.query.get('cursor')
        _, limit = pagination(cursor, request.query.get('limit', 50))
        route = request.match_info.route.name
        if route == 'search':
            result = await auth.call('search', request.query.get('q', ''),
                                     request.query.get('type', 'track'), cursor, limit)
        elif route == 'library':
            result = await auth.call('library', request.match_info['section'], cursor, limit)
        elif route == 'playlist':
            result = await auth.call('playlist', request.match_info['owner'],
                                     request.match_info['id'], cursor, limit)
        elif route == 'track':
            result = {'items': await auth.call('tracks', [request.match_info['id']]),
                      'next_cursor': None}
        else:
            result = await auth.call(route, request.match_info['id'], cursor, limit)
        return web.json_response(result)

    async def resolve(request):
        data = await body(request)
        id_ = data.get('track_id', '')
        if not isinstance(id_, str) or not re.fullmatch(r'\d+(?::\d+)?', id_):
            raise ServiceError('BAD_REQUEST', 'Invalid track ID', 400)
        quality = data.get('quality', 'auto')
        if quality not in ('auto', 'lossless', 'mp3'):
            raise ServiceError('BAD_REQUEST', 'Invalid quality', 400)
        return web.json_response(await streaming.resolve(id_, quality))

    async def track_quality(request):
        return web.json_response({'recording_quality': await auth.call('track_quality', request.match_info['id'])})

    app.router.add_get('/health', health)
    app.router.add_get('/v1/account', account)
    app.router.add_post('/v1/auth/{action}', auth_action)
    app.router.add_get('/v1/auth/device/{session_id}', device_status)
    app.router.add_get('/v1/search', catalog, name='search')
    app.router.add_get('/v1/library/{section}', catalog, name='library')
    app.router.add_get('/v1/playlists/{owner}/{id}', catalog, name='playlist')
    app.router.add_get('/v1/albums/{id}', catalog, name='album')
    app.router.add_get('/v1/artists/{id}', catalog, name='artist')
    app.router.add_get('/v1/artists/{id}/tracks', catalog, name='artist_tracks')
    app.router.add_get('/v1/artists/{id}/albums', catalog, name='artist_albums')
    app.router.add_get('/v1/tracks/{id}', catalog, name='track')
    app.router.add_get('/v1/tracks/{id}/quality', track_quality)
    app.router.add_post('/v1/playback/resolve', resolve)
    app.router.add_get('/stream/{ticket}', streaming.handle)
    return app


def main():
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(name)s %(message)s')
    web.run_app(create_app(), host='127.0.0.1', port=17899, access_log=None,
                print=lambda line: logging.getLogger(__name__).info('Local service started'))


if __name__ == '__main__':
    main()

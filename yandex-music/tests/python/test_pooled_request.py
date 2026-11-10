import aiohttp
import pytest
from aiohttp import web
from yandex_music import ClientAsync

from service.backend import PooledRequest


@pytest.mark.asyncio
async def test_sdk_metadata_response_is_read_to_eof_across_http_chunks(serve):
    async def fragmented(request):
        response = web.StreamResponse(headers={'Content-Type': 'application/json'})
        await response.prepare(request)
        await response.write(b'{"result":')
        import asyncio
        await asyncio.sleep(0.02)
        await response.write(b'{"id":42}}')
        return response
    app = web.Application()
    app.router.add_get('/', fragmented)
    async with serve(app) as url:
        async with aiohttp.ClientSession() as session:
            request = PooledRequest(session)
            ClientAsync(request=request)
            result = await request.get(url)
    assert result == {'id': 42}

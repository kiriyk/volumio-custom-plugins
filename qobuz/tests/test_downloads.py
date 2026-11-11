import asyncio
import base64
from unittest.mock import Mock
import pathlib
import tempfile
import unittest

from aiohttp import web
from aiohttp.test_utils import TestServer
from mutagen.flac import FLAC, Picture

from service.downloads import Downloads, safe_component
from service.errors import ServiceError


def flac_bytes():
    # Minimal STREAMINFO metadata, 44.1 kHz stereo 16 bit, no encoded samples.
    packed = (44100 << 44) | (1 << 41) | (15 << 36)
    return b'fLaC\x80\x00\x00\x22' + b'\x00\x10\x00\x10' + bytes(6) + packed.to_bytes(8, 'big') + bytes(16)


class DownloadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name) / 'disk' / 'qobuz'
        self.root.parent.mkdir()
        self.mounted = True
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.mode = 'ok'
        self.requests = 0
        self.album_image = None
        self.audio_data = flac_bytes()
        async def audio(request):
            self.requests += 1
            self.started.set()
            if self.mode == 'redirect':
                raise web.HTTPFound('https://untrusted.test/private-token')
            if self.mode == 'error':
                return web.Response(status=403, text='secret signed-url')
            if self.mode == 'invalid':
                return web.Response(body=b'not FLAC', content_type='audio/flac')
            if self.mode == 'slow':
                response = web.StreamResponse(headers={'Content-Type': 'audio/flac'})
                await response.prepare(request)
                await response.write(flac_bytes())
                await self.release.wait()
                return response
            return web.Response(body=self.audio_data, content_type='audio/flac')
        app = web.Application(); app.router.add_get('/audio', audio)
        self.server = TestServer(app); await self.server.start_server()
        self.url = str(self.server.make_url('/audio'))
        case = self
        class Provider:
            async def call(self, path, params):
                return {'id': int(params['track_id']), 'title': '../Song\x00', 'track_number': 1,
                        'performer': {'id': 1, 'name': '../Исполнитель'},
                        'album': {'id': 'abc', 'title': 'Альбом/..', 'image': case.album_image, 'artist': {'id': 1, 'name': '../Исполнитель'}}}
            async def resolve(self, id_, quality):
                return {'url': case.url, 'codec': 'flac', 'sampleRate': 96000, 'bitDepth': 24}
        def policy(url):
            if not url.startswith(str(self.server.make_url('/'))):
                raise ServiceError('UNAVAILABLE', 'Untrusted upstream', 502)
        self.manager = Downloads(Provider(), self.root, mount_check=lambda: self.mounted,
                                 upstream_policy=policy, reserve_bytes=0)
        await self.manager.start()
        self.image_get = self.manager.cover_session.get

    async def asyncTearDown(self):
        self.release.set()
        await self.manager.close()
        await self.server.close()
        self.tmp.cleanup()

    async def finished(self, id_):
        for _ in range(200):
            job = next(item for item in self.manager.list()['items'] if item['id'] == id_)
            if job['state'] in ('completed', 'cancelled', 'error'):
                return job
            await asyncio.sleep(.01)
        self.fail('download never finished')

    async def test_download_tags_unicode_and_actual_audio_quality(self):
        initial = await self.manager.enqueue('42', '27')
        job = await self.finished(initial['id'])
        self.assertEqual(job['state'], 'completed')
        path = pathlib.Path(job['path'])
        self.assertTrue(path.is_relative_to(self.root))
        self.assertIn('Исполнитель', str(path))
        self.assertEqual(path.suffix, '.flac')
        self.assertIn('42', path.name)
        self.assertEqual(FLAC(path)['title'], ['../Song\x00'])
        self.assertEqual((job['sampleRate'], job['bitDepth']), (44100, 16))
        self.assertEqual(job['codec'], 'flac')
        self.assertNotIn('url', job)
        self.assertFalse(list(self.root.rglob('*.part')))

    async def test_missing_disk_never_creates_destination(self):
        self.mounted = False
        with self.assertRaises(ServiceError) as caught:
            await self.manager.enqueue('42')
        self.assertEqual(caught.exception.code, 'DISK_UNAVAILABLE')
        self.assertFalse(self.root.exists())

    async def test_cancel_active_removes_partial_and_advances_queue(self):
        self.mode = 'slow'
        first = await self.manager.enqueue('42')
        await self.started.wait()
        second = await self.manager.enqueue('43')
        await self.manager.cancel(first['id'])
        self.assertEqual((await self.finished(first['id']))['state'], 'cancelled')
        self.mode = 'ok'; self.release.set()
        self.assertEqual((await self.finished(second['id']))['state'], 'completed')
        self.assertFalse(list(self.root.rglob('*.part')))

    async def test_duplicate_and_existing_complete_file_do_not_overwrite(self):
        first = await self.manager.enqueue('42')
        self.assertEqual((await self.manager.enqueue('42'))['id'], first['id'])
        job = await self.finished(first['id'])
        before = pathlib.Path(job['path']).read_bytes()
        self.assertEqual((await self.manager.enqueue('42'))['id'], first['id'])
        self.manager.jobs.clear()
        retry = await self.manager.enqueue('42')
        self.assertEqual((await self.finished(retry['id']))['state'], 'completed')
        self.assertEqual(self.requests, 1)
        self.assertEqual(pathlib.Path(job['path']).read_bytes(), before)

    async def test_upstream_failures_are_sanitized_and_remove_partial(self):
        for mode in ('error', 'invalid', 'redirect'):
            self.mode = mode
            initial = await self.manager.enqueue('42')
            job = await self.finished(initial['id'])
            self.assertEqual(job['state'], 'error', mode)
            self.assertTrue(job['error_code'])
            self.assertNotIn('secret', str(job))
            self.assertNotIn('private-token', str(job))
            self.assertFalse(list(self.root.rglob('*.part')))

    async def test_queue_bound_and_cancel_queued(self):
        self.manager.queue_limit = 1
        self.mode = 'slow'
        first = await self.manager.enqueue('42')
        await self.started.wait()
        second = await self.manager.enqueue('43')
        with self.assertRaises(ServiceError) as caught:
            await self.manager.enqueue('44')
        self.assertEqual(caught.exception.code, 'QUEUE_FULL')
        self.assertEqual((await self.manager.cancel(second['id']))['state'], 'cancelled')
        await self.manager.cancel(first['id'])

    async def test_mount_loss_and_size_guard_do_not_finish_file(self):
        self.manager.max_bytes = 8
        initial = await self.manager.enqueue('42')
        self.assertEqual((await self.finished(initial['id']))['error_code'], 'FILE_TOO_LARGE')
        self.manager.max_bytes = 1024 * 1024
        self.mode = 'slow'
        self.started.clear()
        initial = await self.manager.enqueue('43')
        await self.started.wait()
        self.mounted = False
        self.release.set()
        self.assertEqual((await self.finished(initial['id']))['error_code'], 'DISK_UNAVAILABLE')
        self.assertFalse(list(self.root.rglob('*.flac')))

    async def test_symlink_destination_is_rejected(self):
        self.root.mkdir()
        outside = pathlib.Path(self.tmp.name) / 'outside'; outside.mkdir()
        (self.root / safe_component('../Исполнитель')).symlink_to(outside, target_is_directory=True)
        initial = await self.manager.enqueue('42')
        self.assertEqual((await self.finished(initial['id']))['state'], 'error')
        self.assertFalse(list(outside.iterdir()))

    def test_path_components_keep_unicode_and_remove_traversal_and_controls(self):
        for value in ('../Альбом/..', '\\disk\\name', '..', '\x00\n', 'x' * 400):
            component = safe_component(value)
            self.assertTrue(component)
            self.assertNotIn('/', component)
            self.assertNotIn('\\', component)
            self.assertFalse(component.startswith('.'))
            self.assertLessEqual(len(component.encode('utf-8')), 160)


    async def test_disk_full_stops_before_opening_partial(self):
        self.manager.reserve_bytes = 2**63
        initial = await self.manager.enqueue('42')
        self.assertEqual((await self.finished(initial['id']))['error_code'], 'DISK_FULL')
        self.assertFalse(list(self.root.rglob('*.part')))
        self.assertFalse(list(self.root.rglob('*.flac')))

    async def test_cancelled_queue_entries_do_not_accumulate(self):
        self.mode = 'slow'
        first = await self.manager.enqueue('42')
        await self.started.wait()
        for index in range(50):
            job = await self.manager.enqueue(str(100 + index))
            await self.manager.cancel(job['id'])
        self.assertEqual(self.manager.pending.qsize(), 0)
        await self.manager.cancel(first['id'])


    async def cover_server(self, body, status=200, location=None, chunked=False):
        self.cover_requests = []
        async def cover_response(request):
            self.assertNotIn('X-User-Auth-Token', request.headers)
            self.assertNotIn('Authorization', request.headers)
            self.assertNotIn('Cookie', request.headers)
            if chunked:
                response = web.StreamResponse()
                await response.prepare(request)
                await response.write(body)
                await response.write_eof()
                return response
            return web.Response(body=body, status=status,
                                headers={'Location': location} if location else {})
        app = web.Application(); app.router.add_get('/cover', cover_response)
        server = TestServer(app); await server.start_server()
        self.addAsyncCleanup(server.close)
        original = self.image_get
        def redirected_get(url, **kwargs):
            # Record every image request and route it locally; unsafe requests must never occur.
            self.cover_requests.append((url, kwargs))
            return original(str(server.make_url('/cover')), **kwargs)
        self.manager.cover_session.get = Mock(side_effect=redirected_get)

    @staticmethod
    def flac_parts(data):
        offset, streaminfo = 4, None
        while True:
            block = data[offset]
            length = int.from_bytes(data[offset + 1:offset + 4], 'big')
            contents = data[offset + 4:offset + 4 + length]
            if block & 127 == 0:
                streaminfo = contents
            offset += 4 + length
            if block & 128:
                return streaminfo, data[offset:]

    async def test_new_download_embeds_png_without_changing_audio_or_streaminfo(self):
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=')
        await self.cover_server(png)
        self.album_image = {'large': 'http://static.qobuz.com/cover.png'}
        self.audio_data += b'\xff\xf8UNCHANGED_AUDIO_BYTES'
        initial = await self.manager.enqueue('42')
        job = await self.finished(initial['id'])
        self.assertEqual(job['state'], 'completed')
        path = pathlib.Path(job['path'])
        picture, = FLAC(path).pictures
        self.assertEqual((picture.type, picture.mime, picture.width, picture.height), (3, 'image/png', 1, 1))
        self.assertEqual(picture.data, png)
        self.assertEqual(self.flac_parts(path.read_bytes()), self.flac_parts(self.audio_data))
        self.assertEqual(self.cover_requests[0][0], 'https://static.qobuz.com/cover.png')
        self.assertFalse(self.cover_requests[0][1]['allow_redirects'])

    async def test_new_download_embeds_jpeg_from_thumbnail(self):
        jpeg = (b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00'
                b'\xff\xc0\x00\x11\x08\x00\x02\x00\x03\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00\xff\xd9')
        await self.cover_server(jpeg)
        self.album_image = {'thumbnail': 'https://static.qobuz.com/cover.jpg'}
        initial = await self.manager.enqueue('42')
        job = await self.finished(initial['id'])
        self.assertEqual(job['state'], 'completed')
        picture, = FLAC(job['path']).pictures
        self.assertEqual((picture.type, picture.mime), (3, 'image/jpeg'))
        self.assertEqual((picture.width, picture.height), (3, 2))
        self.assertEqual(picture.data, jpeg)

    async def test_offhost_credentials_and_non_https_image_urls_never_fetch(self):
        await self.cover_server(b'not an image')
        urls = ['https://other.test/cover.jpg', 'https://static.qobuz.com.other.test/a',
                'https://user:password@static.qobuz.com/a', 'https://static.qobuz.com:444/a',
                'http://other.test/a', 'file:///etc/passwd']
        for index, url in enumerate(urls):
            self.album_image = {'large': url}
            job = await self.finished((await self.manager.enqueue(str(100 + index)))['id'])
            self.assertEqual(job['state'], 'completed', url)
            self.assertEqual(FLAC(job['path']).pictures, [])
        self.assertEqual(self.cover_requests, [])

    async def test_invalid_oversized_and_error_images_keep_valid_audio_and_tags(self):
        for index, (body, status) in enumerate([(b'<html>bad</html>', 200), (bytes(2 * 1024**2 + 1), 200), (b'no', 404)]):
            await self.cover_server(body, status)
            self.album_image = {'small': 'https://static.qobuz.com/cover.jpg'}
            job = await self.finished((await self.manager.enqueue(str(100 + index)))['id'])
            self.assertEqual(job['state'], 'completed')
            audio = FLAC(job['path'])
            self.assertEqual(audio.pictures, [])
            self.assertEqual(audio['album'], ['Альбом/..'])

    async def test_untrusted_cover_redirect_is_not_followed(self):
        await self.cover_server(b'', 302, 'https://evil.test/secret')
        self.album_image = {'large': 'https://static.qobuz.com/cover.jpg'}
        job = await self.finished((await self.manager.enqueue('42'))['id'])
        self.assertEqual(job['state'], 'completed')
        self.assertEqual(len(self.cover_requests), 1)
        self.assertEqual(FLAC(job['path']).pictures, [])

    async def test_existing_front_cover_and_completed_file_are_unchanged(self):
        source = pathlib.Path(self.tmp.name) / 'source.flac'; source.write_bytes(flac_bytes())
        audio = FLAC(source)
        picture = Picture(); picture.type = 3; picture.mime = 'image/png'; picture.data = b'existing-image'
        audio.add_picture(picture); audio.save()
        self.audio_data = source.read_bytes()
        await self.cover_server(b'not needed')
        self.album_image = {'large': 'https://static.qobuz.com/cover.jpg'}
        first = await self.finished((await self.manager.enqueue('42'))['id'])
        self.assertEqual(first['state'], 'completed')
        path = pathlib.Path(first['path'])
        self.assertEqual([p.data for p in FLAC(path).pictures], [b'existing-image'])
        before = path.read_bytes()
        self.manager.jobs.clear()
        second = await self.finished((await self.manager.enqueue('42'))['id'])
        self.assertEqual(second['state'], 'completed')
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.cover_requests, [])


    async def test_chunked_oversized_image_is_skipped_without_affecting_flac(self):
        await self.cover_server(bytes(2 * 1024**2 + 1), chunked=True)
        self.album_image = {'large': 'https://static.qobuz.com/cover.png'}
        job = await self.finished((await self.manager.enqueue('42'))['id'])
        self.assertEqual(job['state'], 'completed')
        self.assertEqual(FLAC(job['path']).pictures, [])

    async def test_artwork_timeout_keeps_audio(self):
        async def timeout(*args, **kwargs):
            raise asyncio.TimeoutError()
        self.manager.cover_session.get = Mock(side_effect=timeout)
        self.album_image = {'large': 'https://static.qobuz.com/cover.png'}
        job = await self.finished((await self.manager.enqueue('42'))['id'])
        self.assertEqual(job['state'], 'completed')
        self.assertEqual(FLAC(job['path']).pictures, [])

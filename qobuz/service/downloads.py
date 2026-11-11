"""A bounded, single-worker queue that writes original FLAC only to a mounted disk."""
import asyncio
import os
import secrets
import shutil
import unicodedata
from collections import OrderedDict
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

import aiohttp
from mutagen.flac import FLAC, Picture

from .errors import ServiceError
from .provider import artist, identifier
from .streaming import validate_upstream


DEFAULT_ROOT = '/media/External_HD/qobuz'
TERMINAL = ('completed', 'cancelled', 'error')
COVER_LIMIT = 2 * 1024**2


def safe_component(value):
    value = unicodedata.normalize('NFC', str(value or ''))
    value = ''.join('_' if char in '/\\' or unicodedata.category(char).startswith('C')
                    or char in '<>:"|?*' else char for char in value).strip(' .')
    while len(value.encode('utf-8')) > 160:
        value = value[:-1]
    return value.strip(' .') or 'Unknown'


def _cover_url(value):
    """Only the public Qobuz artwork host may receive anonymous image requests."""
    parsed = urlsplit(value)
    if (parsed.hostname != 'static.qobuz.com' or parsed.username is not None
            or parsed.password is not None):
        raise ValueError('Untrusted artwork')
    if parsed.scheme == 'http' and parsed.port in (None, 80):
        return urlunsplit(('https', 'static.qobuz.com', parsed.path, parsed.query, ''))
    if parsed.scheme != 'https' or parsed.port not in (None, 443):
        raise ValueError('Untrusted artwork')
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ''))


def _picture(data):
    picture = Picture()
    picture.type, picture.desc, picture.data = 3, 'Front cover', data
    if data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 33 and data[12:16] == b'IHDR':
        picture.mime = 'image/png'
        picture.width = int.from_bytes(data[16:20], 'big')
        picture.height = int.from_bytes(data[20:24], 'big')
        picture.depth = data[24] * {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(data[25], 1)
    elif data.startswith(b'\xff\xd8\xff') and data.endswith(b'\xff\xd9'):
        picture.mime = 'image/jpeg'
        offset = 2
        while offset + 4 <= len(data):
            if data[offset] != 255:
                break
            marker = data[offset + 1]
            if marker in (0xD9, 0xDA):
                break
            if marker in (0x01, 0xD8) or 0xD0 <= marker <= 0xD7:
                offset += 2
                continue
            length = int.from_bytes(data[offset + 2:offset + 4], 'big')
            if length < 2 or offset + 2 + length > len(data):
                break
            if marker in (0xC0, 0xC1, 0xC2) and length >= 8:
                picture.height = int.from_bytes(data[offset + 5:offset + 7], 'big')
                picture.width = int.from_bytes(data[offset + 7:offset + 9], 'big')
                picture.depth = data[offset + 4] * data[offset + 9]
                break
            offset += 2 + length
    else:
        return None
    return picture


class Downloads:
    def __init__(self, provider, root=DEFAULT_ROOT, mount_check=None,
                 upstream_policy=validate_upstream, queue_limit=32, history_limit=128,
                 max_bytes=2 * 1024**3, reserve_bytes=64 * 1024**2):
        self.provider = provider
        self.root = Path(root).absolute()
        self.mount_check = mount_check or self.root.parent.is_mount
        self.policy = upstream_policy
        self.queue_limit, self.history_limit = queue_limit, history_limit
        self.max_bytes, self.reserve_bytes = max_bytes, reserve_bytes
        self.jobs = OrderedDict()
        self.pending = asyncio.Queue(maxsize=queue_limit)
        self.session = self.cover_session = self.worker = self.active = None
        self.active_id = None
        self.closing = False

    async def start(self):
        self.session = aiohttp.ClientSession(auto_decompress=False,
            connector=aiohttp.TCPConnector(limit=1),
            timeout=aiohttp.ClientTimeout(total=None, connect=15, sock_read=30))
        self.cover_session = aiohttp.ClientSession(auto_decompress=False,
            cookie_jar=aiohttp.DummyCookieJar(), connector=aiohttp.TCPConnector(limit=1),
            timeout=aiohttp.ClientTimeout(total=10))
        self.worker = asyncio.create_task(self._worker())

    def _mounted(self):
        if not self.mount_check():
            raise ServiceError('DISK_UNAVAILABLE', 'Connect the external disk', 409)

    def _safe_path(self, path):
        self._mounted()
        if self.root.is_symlink() or any(parent.is_symlink()
                for parent in (path, *path.parents) if parent == self.root or self.root in parent.parents):
            raise ServiceError('INVALID_PATH', 'Unsafe destination', 409)
        if not path.resolve().is_relative_to(self.root.resolve()):
            raise ServiceError('INVALID_PATH', 'Unsafe destination', 409)

    def _space(self, required=0):
        self._mounted()
        if shutil.disk_usage(self.root.parent).free < required + self.reserve_bytes:
            raise ServiceError('DISK_FULL', 'Insufficient disk space', 409)

    def list(self):
        return {'items': [dict(job) for job in self.jobs.values()]}

    async def enqueue(self, track_id, quality='27'):
        track_id = identifier(track_id, numeric=True)
        quality = str(quality)
        if quality not in ('6', '27'):
            raise ServiceError('BAD_REQUEST', 'Invalid quality', 400)
        self._mounted()
        if self.closing:
            raise ServiceError('SERVICE_UNAVAILABLE')
        for job in self.jobs.values():
            if job['track_id'] == track_id and (job['state'] in ('queued', 'downloading') or
                    job['state'] == 'completed' and job['path'] and Path(job['path']).is_file()):
                return dict(job)
        if self.pending.full() or sum(job['state'] == 'queued' for job in self.jobs.values()) >= self.queue_limit:
            raise ServiceError('QUEUE_FULL', 'Download queue is full', 429)
        job = {'id': secrets.token_hex(12), 'track_id': track_id, 'title': '', 'artist': '', 'album': '',
               'state': 'queued', 'downloaded': 0, 'total': None, 'path': None, 'error_code': None,
               'codec': None, 'sampleRate': None, 'bitDepth': None}
        self.jobs[job['id']] = job
        while len(self.jobs) > self.history_limit:
            expired = next((key for key, value in self.jobs.items() if value['state'] in TERMINAL), None)
            if expired is None:
                break
            del self.jobs[expired]
        self.pending.put_nowait((job['id'], quality))
        return dict(job)

    async def cancel(self, id_):
        job = self.jobs.get(id_)
        if job is None:
            raise ServiceError('NOT_FOUND', 'Download not found', 404)
        if job['state'] == 'queued':
            job['state'] = 'cancelled'
            self._prune_pending()
        elif job['state'] == 'downloading' and self.active_id == id_:
            task = self.active
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        return dict(job)

    def _prune_pending(self):
        retained = []
        while not self.pending.empty():
            item = self.pending.get_nowait()
            self.pending.task_done()
            if self.jobs.get(item[0], {}).get('state') == 'queued':
                retained.append(item)
        for item in retained:
            self.pending.put_nowait(item)

    async def cancel_all(self):
        for job in self.jobs.values():
            if job['state'] == 'queued':
                job['state'] = 'cancelled'
        self._prune_pending()
        if self.active_id:
            await self.cancel(self.active_id)

    async def _worker(self):
        while True:
            id_, quality = await self.pending.get()
            job = self.jobs.get(id_)
            try:
                if not job or job['state'] != 'queued':
                    continue
                self.active_id = id_
                job['state'] = 'downloading'
                self.active = asyncio.create_task(self._download(job, quality))
                try:
                    await self.active
                except asyncio.CancelledError:
                    if self.closing:
                        return
            finally:
                self.active = self.active_id = None
                self.pending.task_done()

    async def _open(self, url):
        for _ in range(4):
            self.policy(url)
            response = await self.session.get(url, allow_redirects=False)
            if response.status not in (301, 302, 303, 307, 308):
                return response
            next_url = urljoin(url, response.headers.get('Location', ''))
            response.release()
            if next_url == url:
                break
            url = next_url
        raise ServiceError('UNAVAILABLE', 'Audio redirect failed', 502)

    async def _cover(self, album):
        image = album.get('image') or {}
        if not isinstance(image, dict):
            return None
        url = image.get('large') or image.get('thumbnail') or image.get('small')
        if not isinstance(url, str) or not url:
            return None
        try:
            async with asyncio.timeout(10):
                for _ in range(4):
                    url = _cover_url(url)
                    response = await self.cover_session.get(url, allow_redirects=False)
                    try:
                        if response.status in (301, 302, 303, 307, 308):
                            url = urljoin(url, response.headers.get('Location', ''))
                            continue
                        if (response.status != 200
                                or response.headers.get('Content-Encoding', 'identity') != 'identity'
                                or response.content_length is not None and response.content_length > COVER_LIMIT):
                            return None
                        data = bytearray()
                        async for chunk in response.content.iter_chunked(65536):
                            if len(data) + len(chunk) > COVER_LIMIT:
                                return None
                            data.extend(chunk)
                        return _picture(bytes(data))
                    finally:
                        response.close()
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, TypeError):
            # Artwork is optional. Never expose provider URLs or transfer exceptions.
            return None
        return None

    def _complete(self, job, path):
        self._safe_path(path)
        audio = FLAC(path)
        job.update(state='completed', path=str(path), codec='flac',
                   sampleRate=audio.info.sample_rate, bitDepth=audio.info.bits_per_sample,
                   downloaded=path.stat().st_size, total=path.stat().st_size)

    async def _download(self, job, quality):
        partial = response = None
        try:
            self._mounted()
            data = await self.provider.call('/track/get', {'track_id': job['track_id']})
            album = data.get('album') or {}
            job.update(title=data.get('title', ''), artist=artist(data) or artist(album),
                       album=album.get('title', ''))
            directory = self.root / safe_component(job['artist']) / safe_component(job['album'])
            filename = safe_component(job['title']) + ' [' + job['track_id'] + '].flac'
            final = directory / filename
            self._safe_path(final)
            for folder in (self.root, directory.parent, directory):
                self._safe_path(folder)
                self._mounted()
                folder.mkdir(exist_ok=True)
            if final.exists():
                self._complete(job, final)
                return
            stream = await self.provider.resolve(job['track_id'], quality)
            if stream.get('codec') != 'flac':
                raise ServiceError('UNAVAILABLE', 'Original FLAC unavailable', 422)
            response = await self._open(stream['url'])
            if response.status != 200 or response.headers.get('Content-Encoding', 'identity') != 'identity':
                raise ServiceError('UNAVAILABLE', 'Audio upstream unavailable', 502)
            total = response.content_length
            if total is not None and total > self.max_bytes:
                raise ServiceError('FILE_TOO_LARGE', 'Audio exceeds size limit', 422)
            job['total'] = total
            self._space(total or 0)
            partial = directory / (filename + '.' + job['id'] + '.part')
            self._safe_path(partial)
            self._mounted()
            fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(fd, 'wb') as output:
                async for chunk in response.content.iter_chunked(65536):
                    self._mounted()
                    if job['downloaded'] + len(chunk) > self.max_bytes:
                        raise ServiceError('FILE_TOO_LARGE', 'Audio exceeds size limit', 422)
                    self._space(len(chunk))
                    output.write(chunk)
                    job['downloaded'] += len(chunk)
                self._mounted()
                output.flush()
                os.fsync(output.fileno())
            self._safe_path(partial)
            self._space(65536)
            audio = FLAC(partial)
            for key, value in {'title': job['title'], 'artist': job['artist'], 'album': job['album'],
                               'albumartist': artist(album), 'tracknumber': data.get('track_number'),
                               'discnumber': data.get('media_number'), 'qobuz_track_id': job['track_id']}.items():
                if value is not None and value != '':
                    audio[key] = [str(value)]
            if not any(picture.type == 3 for picture in audio.pictures):
                picture = await self._cover(album)
                if picture is not None:
                    try:
                        self._space(len(picture.data) + 65536)
                    except ServiceError as error:
                        if error.code != 'DISK_FULL':
                            raise
                    else:
                        audio.add_picture(picture)
            self._safe_path(partial)
            self._mounted()
            audio.save()
            self._safe_path(final)
            self._mounted()
            # A complete destination is never overwritten, including after a concurrent creator.
            if final.exists():
                self._complete(job, final)
                partial.unlink()
            else:
                # Publish the tagged original FLAC atomically without replacing another file.
                self._publish(partial, final)
                self._complete(job, final)
            partial = None
        except asyncio.CancelledError:
            job.update(state='cancelled', error_code=None)
            raise
        except Exception as error:
            code = error.code if isinstance(error, ServiceError) else (
                'DISK_FULL' if isinstance(error, OSError) and error.errno == 28 else 'DOWNLOAD_FAILED')
            job.update(state='error', error_code=code, path=None)
        finally:
            if response:
                response.close()
            if partial is not None:
                try:
                    self._safe_path(partial)
                    partial.unlink(missing_ok=True)
                except (OSError, ServiceError):
                    pass

    def _publish(self, partial, final):
        # Linux renameat2(RENAME_NOREPLACE) is supported by exFAT and avoids overwrite races.
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        self._mounted()
        if rename(-100, os.fsencode(partial), -100, os.fsencode(final), 1):
            error = ctypes.get_errno()
            raise OSError(error, os.strerror(error))

    async def close(self):
        self.closing = True
        await self.cancel_all()
        if self.worker:
            self.worker.cancel()
            try:
                await self.worker
            except asyncio.CancelledError:
                pass
        if self.session:
            await self.session.close()
        if self.cover_session:
            await self.cover_session.close()

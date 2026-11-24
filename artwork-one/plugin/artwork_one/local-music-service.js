'use strict';

const { spawn } = require('node:child_process');
const { LocalMusicLibrary, field, localPath } = require('./local-music-library');
const { MusicCatalog, remote } = require('./music-catalog');
const { LocalMusicCache, digest } = require('./local-music-cache');

const MAX_IMAGE = 256 * 1024;
const FIELDS = ['cover', 'albumInfo', 'artistInfo'];
const LOCAL_ART = 'http://127.0.0.1:3000';
const CONTROLS = ['/albumart', '/albumart?path=&icon=dot-circle-o&metadata=false'];
const YEAR = /^\d{4}/;
const MB_ENTITY = /^(?:artist|release|release-group|recording)\/(?:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})?$/i;
const MB_INCLUDES = new Set(['url-rels', 'artist-rels', 'work-rels', 'work-level-rels', 'release-groups', 'labels', 'artist-credits']);

function imageKind(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'mjpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) return 'gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function convertImage({ body, file, stream }) {
  const format = body && imageKind(body);
  if (body && !format) return Promise.resolve(null);
  const source = body ? ['-f', 'image2pipe', '-c:v', format, '-i', 'pipe:0'] : ['-i', file, '-map', '0:' + stream];
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/ffmpeg', [
      '-v', 'error', '-protocol_whitelist', 'file,pipe', '-threads', '1', ...source,
      '-frames:v', '1', '-filter_threads', '1', '-vf',
      "scale=w='min(500,iw)':h='min(500,ih)':force_original_aspect_ratio=decrease",
      '-threads', '1', '-an', '-sn', '-dn', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:1'
    ], { stdio: [body ? 'pipe' : 'ignore', 'pipe', 'ignore'], timeout: 5000, killSignal: 'SIGKILL' });
    const chunks = [];
    let size = 0;
    child.on('error', reject);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_IMAGE) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.on('close', (code, signal) => {
      if (size > MAX_IMAGE) return resolve(null);
      if (signal) return reject(new Error('image decoder interrupted'));
      resolve(code === 0 && size ? Buffer.concat(chunks) : null);
    });
    if (body) {
      child.stdin.on('error', () => {}); // child close reports invalid data or decoder failure
      child.stdin.end(body);
    }
  });
}

function validate(data) {
  return data && typeof data.requestId === 'string' && /^[\w-]{1,80}$/.test(data.requestId) &&
    ['artist', 'album'].includes(data.kind) && typeof data.uri === 'string' && data.uri.length <= 4096 &&
    /^[a-z]{2,3}$/.test(data.locale) && Array.isArray(data.fields) && data.fields.length &&
    data.fields.length <= FIELDS.length && data.fields.every(field => FIELDS.includes(field)) &&
    (data.kind === 'album' || data.fields.every(field => field === 'artistInfo'));
}

class LocalMusicService {
  constructor(router, cacheDir, { logger, library, catalog, cache, fetcher = fetch, image = convertImage, musicBrainzProxy, maxBytes } = {}) {
    this.library = library || new LocalMusicLibrary(router);
    this.catalog = catalog || new MusicCatalog({ fetcher, musicBrainzProxy });
    this.fetcher = fetcher;
    this.image = image;
    this.cache = cache || new LocalMusicCache(cacheDir, { maxBytes, onError: (error, operation) => {
      if (operation !== 'lookup') logger?.warn('[artwork_one] local music cache ' + operation + ' failed (' + (error.code || error.name) + ')');
    } });
    this.resolutions = new Map();
    this.probes = new Map();
    this.active = 0;
    this.closed = false;
    this.controls = null;
  }

  stop() {
    this.closed = true;
    this.catalog.stop();
  }

  remember(map, key, work) {
    const now = Date.now();
    const hit = map.get(key);
    if (hit?.until > now) return hit.value;
    const value = work().catch(error => {
      map.delete(key);
      throw error;
    });
    map.set(key, { until: now + 60_000, value });
    if (map.size > 200) map.delete(map.keys().next().value);
    return value;
  }

  async resolve(data) {
    const requestId = typeof data?.requestId === 'string' ? data.requestId.slice(0, 80) : '';
    if (!validate(data)) return { requestId, error: 'invalidRequest' };
    if (this.closed || this.active >= 24) return { requestId, error: 'temporaryError' };
    this.active++;
    try {
      const entity = await this.remember(this.resolutions, JSON.stringify([data.kind, data.uri]), () => this.library.resolve(data));
      if (!entity) return { requestId, error: 'unsupportedEntity' };
      const requested = [...new Set(data.fields)];
      const results = await Promise.all(requested.map(async name => {
        try {
          if (name === 'cover') return await this.cover(entity);
          if (name === 'albumInfo') return await this.albumInfo(entity, data.locale);
          return await this.artistInfo(entity, data.locale);
        } catch {
          return { status: 'temporaryError' };
        }
      }));
      return { requestId, key: digest(entity.key), fields: Object.fromEntries(requested.map((name, i) => [name, results[i]])) };
    } catch {
      return { requestId, error: 'temporaryError' };
    } finally {
      this.active--;
    }
  }

  probe(entity) {
    return this.remember(this.probes, entity.key, () => this.library.fileMetadata(entity.track));
  }

  async fileInfo(uri) {
    if (typeof uri !== 'string' || uri.length > 4096 || this.closed) return null;
    const track = localPath(uri);
    if (!track) return null;
    const source = await this.library.audioSource(track);
    if (!source) return null;
    const { file, stat } = source;
    const key = ['track quality', track, file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
    const result = await this.cache.result(key, async () => {
      const metadata = await this.library.probeAudio(file);
      const bitrate = Number(metadata.format?.bit_rate);
      return { size: stat.size, bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null };
    });
    return { size: stat.size, bitrate: result.value?.bitrate ?? null };
  }

  async match(entity) {
    return this.cache.result(['match', entity.key], async () => {
      if (!entity.artist) return null;
      const local = await this.probe(entity);
      return this.catalog.album(entity, local?.tags);
    });
  }

  async albumsArtControl() {
    if (!this.controls) {
      this.controls = Promise.all(CONTROLS.map(async url => {
        const control = await this.loadLocalArt(url);
        return control && digest(control.body);
      })).catch(error => {
        this.controls = null;
        throw error;
      });
    }
    return this.controls;
  }

  loadLocalArt(url) {
    return remote(LOCAL_ART + url, {
      fetcher: this.fetcher, maxBytes: 10 * 1024 * 1024, allowMissing: true, allowHost: h => h === '127.0.0.1'
    });
  }

  async cover(entity) {
    return this.cache.result(['cover', entity.key], async () => {
      if (entity.art) {
        const art = await this.loadLocalArt(entity.art);
        if (art && imageKind(art.body) && !(await this.albumsArtControl()).includes(digest(art.body)) && await this.image(art)) {
          return { source: 'volumio', url: entity.art };
        }
      }
      const local = await this.probe(entity);
      if (Number.isInteger(local?.picture)) {
        const jpeg = await this.image({ file: local.file, stream: local.picture });
        if (jpeg) return this.coverValue(jpeg, 'embedded');
      }
      const match = await this.match(entity);
      if (match.status === 'temporaryError') throw Object.assign(new Error('album match unavailable'), { retryAfter: match.retryAt });
      if (match.status !== 'found') return null;
      const { releaseId, groupId } = match.value;
      if (releaseId) {
        const candidate = await this.catalog.image('release', releaseId);
        const jpeg = candidate && await this.image(candidate);
        if (jpeg) return this.coverValue(jpeg, 'release', releaseId);
      }
      const candidate = await this.catalog.image('release-group', groupId);
      const jpeg = candidate && await this.image(candidate);
      return jpeg ? this.coverValue(jpeg, 'releaseGroup', groupId) : null;
    });
  }

  coverValue(jpeg, source, mbid) {
    return { source, mbid, id: digest(jpeg), jpeg: jpeg.toString('base64') };
  }

  async albumInfo(entity, locale) {
    const match = await this.match(entity);
    const localYear = YEAR.exec(entity.year || '')?.[0];
    if (match.status === 'temporaryError') {
      return localYear ? { status: 'found', value: { localYear, summaryStatus: 'temporaryError' }, retryAt: match.retryAt } : match;
    }
    if (match.status === 'notFound') return localYear ? { status: 'found', value: { localYear } } : match;
    const { groupId, releaseId, label, year, firstYear } = match.value;
    const facts = { groupId, releaseId, label, year: year || firstYear, yearType: year ? 'release' : 'firstRelease', localYear };
    const summary = await this.cache.result(['album summary', groupId, locale], () => this.catalog.summary('release-group', groupId, locale));
    if (summary.status === 'found') return { ...summary, value: { ...facts, ...summary.value } };
    if (facts.year || label || localYear) return { ...summary, status: 'found', value: { ...facts, summaryStatus: summary.status } };
    return summary;
  }

  async artistInfo(entity, locale) {
    if (!entity.artist) return { status: 'notFound' };
    let artistId;
    if (entity.kind === 'album') {
      const match = await this.match(entity);
      artistId = match.value?.artistId;
    }
    if (!artistId) {
      const identity = await this.cache.result(['artist match', entity.artist], () => this.catalog.artist(entity.artist));
      if (identity.status !== 'found') return identity;
      artistId = identity.value;
    }
    const summary = await this.cache.result(['artist summary', artistId, locale], () => this.catalog.summary('artist', artistId, locale));
    return summary.status === 'found' ? { ...summary, value: { ...summary.value, artistId, artist: entity.artist } } : summary;
  }

  musicBrainz({ entity, params } = {}) {
    if (typeof entity !== 'string' || !MB_ENTITY.test(entity) || !params || typeof params !== 'object') return null;
    const { query, inc, limit } = params;
    if (entity.endsWith('/')) {
      if (typeof query !== 'string' || !query.trim() || query.length > 1000 || !/^\d{1,2}$/.test(limit) || +limit > 25) return null;
      return this.catalog.mb(entity, { query, limit });
    }
    if (typeof inc !== 'string' || !inc.split('+').every(include => MB_INCLUDES.has(include))) return null;
    return this.catalog.mb(entity, { inc });
  }
}

module.exports = { LocalMusicService, convertImage };

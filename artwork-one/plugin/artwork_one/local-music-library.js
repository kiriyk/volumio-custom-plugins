'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const ROOTS = new Set(['USB', 'NAS', 'INTERNAL']);
const AUDIO = /\.(?:flac|mp3|m4a|m4b|mp4|aac|alac|ogg|opus|oga|wav|wave|aif|aiff|ape|wv|wma|dsf|dff|mka|tak|tta|caf|mpc|au|ac3)$/i;
const CUE = /^(.*\.cue)(?:\/track\d+)?$/i;
const DISC = /^(?:disc|disk|cd)\s*[-_. ]?\s*\d+$/i;
const field = (...values) => values.find(v => typeof v === 'string' && v.trim() && v !== '*')?.trim() || '';

function localPath(uri) {
  if (typeof uri !== 'string' || /[\x00-\x1f\x7f]/.test(uri)) return '';
  const normalized = uri.replace(/^\/(?:mnt|music-library)\//, '').replace(/^(?:mnt|music-library)\//, '');
  const parts = normalized.split('/');
  if (parts.length < 2 || !ROOTS.has(parts[0]) || parts.some(p => !p || p === '.' || p === '..')) return '';
  return parts.join('/');
}

function browseUri(uri) {
  const m = /^(albums|artists|genres):\/\/(.*)$/.exec(uri);
  if (!m) return null;
  const parts = m[2].split('/').map(decodeURIComponent);
  if (parts.some(p => /[\x00-\x1f\x7f]/.test(p))) return null;
  if (m[1] === 'artists' && parts.length === 1 && parts[0]) {
    return { kind: 'artist', artist: parts[0], uri: 'artists://' + encodeURIComponent(parts[0]) };
  }
  const albumParts = m[1] === 'genres' ? parts.slice(1) : parts;
  if (albumParts.length !== 2 || !albumParts[1]) return null;
  return { kind: 'album', artist: field(albumParts[0]), title: albumParts[1], uri: m[1] + '://' + parts.map(encodeURIComponent).join('/') };
}

function albumartPath(url) {
  if (typeof url !== 'string' || !url.startsWith('/albumart?') || url.includes('#')) return '';
  return localPath(new URLSearchParams(url.slice(10)).get('path'));
}

function normalizedArt(url) {
  if (typeof url !== 'string' || !url.startsWith('/albumart?') || url.includes('#')) return '';
  return url.replace(/([?&]path=)([^&]*)/, (param, prefix, value) => {
    if (!CUE.test(albumartPath(url))) return param;
    const raw = decodeURIComponent(value.replace(/\+/g, ' '));
    return prefix + encodeURIComponent(path.posix.dirname(CUE.exec(raw)[1]));
  });
}

function trackList(navigation) {
  return navigation?.lists?.flatMap(list => list.items || []).filter(track => track.type === 'song' && localPath(track.uri)) || [];
}

function trackTagRows(result) {
  const records = [];
  for (const line of result.split('\n')) {
    const colon = line.indexOf(': ');
    if (colon < 0) continue;
    const key = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 2);
    if (key === 'file') records.push({});
    const record = records.at(-1);
    if (record && !Object.hasOwn(record, key)) record[key] = value;
  }
  return records;
}

function albumLocation(uri) {
  const cue = CUE.exec(uri);
  if (cue) return cue[1];
  const directory = path.posix.dirname(uri);
  return DISC.test(path.posix.basename(directory)) ? path.posix.dirname(directory) : directory;
}

function sameAlbumLocation(a, b) {
  if (!a || !b) return false;
  if (!AUDIO.test(b) && !CUE.test(b)) return albumLocation(a) === b || path.posix.dirname(a) === b;
  return albumLocation(a) === albumLocation(b);
}

function byTrackOrder(a, b) {
  return (parseInt(a.discnumber, 10) || 0) - (parseInt(b.discnumber, 10) || 0)
    || (parseInt(a.tracknumber, 10) || Number.MAX_SAFE_INTEGER) - (parseInt(b.tracknumber, 10) || Number.MAX_SAFE_INTEGER)
    || naturalPath(a.uri, b.uri);
}

function naturalPath(a, b) {
  return a.localeCompare(b, 'en', { numeric: true });
}

async function ffprobe(file) {
  const { stdout } = await exec('/usr/bin/ffprobe', [
    '-v', 'error', '-show_entries', 'format_tags:stream=index:stream_disposition=attached_pic:stream_tags=comment,title',
    '-of', 'json', file
  ], { timeout: 5000, maxBuffer: 256 * 1024 });
  return JSON.parse(stdout);
}

class LocalMusicLibrary {
  constructor(router, { mountRoot = '/mnt', probe = ffprobe } = {}) {
    this.router = router;
    this.mountRoot = mountRoot;
    this.probe = probe;
  }

  mpd() {
    return this.router.pluginManager.getPlugin('music_service', 'mpd');
  }

  async browse(uri) {
    const data = await this.mpd().handleBrowseUri(uri);
    return data?.navigation;
  }

  async metadata(track) {
    // Use the existing MPD connection with a read-only command. sendMpdCommand
    // can clear the playback error state on a failed command.
    const mpd = this.mpd();
    await mpd.mpdReady;
    const quoted = track.replace(/[\\"]/g, '\\$&');
    const result = await new Promise((resolve, reject) => {
      mpd.clientMpd.sendCommand('find file "' + quoted + '"', (error, value) => error ? reject(error) : resolve(value));
    });
    return trackTagRows(result || '').find(row => row.file === track);
  }

  async resolve({ kind, uri }) {
    let source;
    try { source = browseUri(uri); } catch { return null; }
    if (kind === 'artist') {
      if (source?.kind !== 'artist') return null;
      const nav = await this.browse(source.uri);
      if (nav?.info?.type !== 'artist' || !trackList(nav).length) return null;
      return { kind, artist: field(nav.info.title), key: JSON.stringify(['artist', nav.info.title]) };
    }
    if (source?.kind === 'album') return this.albumPage(source);

    const track = localPath(uri);
    if (!track || (!AUDIO.test(track) && !CUE.test(track))) return null;
    const tags = await this.metadata(track);
    if (!tags || !tags.album) return null;
    const albumArtist = field(tags.albumartist);
    const candidateArtist = field(albumArtist, tags.artist);
    if (candidateArtist) {
      const albumUri = 'albums://' + encodeURIComponent(candidateArtist) + '/' + encodeURIComponent(tags.album);
      const resolved = await this.albumPage(browseUri(albumUri), track);
      if (resolved) return resolved;
    }
    const state = this.router.volumioGetState() || {};
    const art = localPath(state.uri) === track ? normalizedArt(state.albumart) : '';
    return { kind, key: JSON.stringify(['album', albumLocation(track), tags.album, albumArtist]),
      track, title: tags.album, artist: albumArtist, year: tags.date, art };
  }

  async albumPage(source, playingTrack) {
    const nav = await this.browse(source.uri);
    if (nav?.info?.type !== 'album') return null;
    const tracks = trackList(nav);
    if (!tracks.length || (playingTrack && !tracks.some(t => localPath(t.uri) === playingTrack))) return null;
    const artPath = albumartPath(nav.info.albumart);
    const origin = playingTrack || artPath || localPath(tracks[0].uri);
    const candidates = tracks.filter(t => sameAlbumLocation(localPath(t.uri), origin));
    const first = (candidates.length ? candidates : tracks).slice().sort(byTrackOrder)[0];
    const track = localPath(first.uri);
    const title = field(nav.info.album, source.title);
    const artist = field(first.albumartist, nav.info.albumartist, source.artist);
    // Browse results may group distinct pressings under one URI. Only use
    // the artwork selected by Volumio when it belongs to the chosen pressing.
    const art = sameAlbumLocation(track, artPath) ? normalizedArt(nav.info.albumart) : '';
    return { kind: 'album', key: JSON.stringify(['album', albumLocation(track), title, artist]),
      track, title, artist, trackCount: candidates.length || tracks.length, year: field(first.year, nav.info.year), art };
  }

  async checkedFile(uri) {
    const [chain, ...parts] = localPath(uri).split('/');
    if (!ROOTS.has(chain)) return null;
    try {
      // Volumio represents individual USB / NAS mounts as symlinks. A
      // configured mount is a root, and anything below it must stay inside it.
      const mounted = chain === 'INTERNAL' ? [] : parts.slice(0, 1);
      const root = await fs.realpath(path.join(this.mountRoot, chain, ...mounted));
      const file = await fs.realpath(path.join(root, ...parts.slice(mounted.length)));
      if (!file.startsWith(root + path.sep)) return null;
      const stat = await fs.stat(file);
      return stat.isFile() ? { file, stat } : null;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
      return null;
    }
  }

  async audioFile(track) {
    const cue = CUE.exec(track);
    if (!cue) return AUDIO.test(track) ? (await this.checkedFile(track))?.file : null;
    const sheet = await this.checkedFile(cue[1]);
    if (!sheet || sheet.stat.size > 256 * 1024) return null;
    const content = await fs.readFile(sheet.file, { encoding: 'utf8', signal: AbortSignal.timeout(2000) });
    const requested = Number(/\/track(\d+)$/i.exec(track)?.[1]);
    let audio = '';
    let first = '';
    let selected = '';
    for (const line of content.split(/\r?\n/)) {
      const file = /^\s*FILE\s+(?:"([^"]+)"|(.+?))\s+\w+\s*$/i.exec(line);
      if (file) {
        audio = (file[1] || file[2]).replace(/\\/g, '/');
        first ||= audio;
      }
      const number = /^\s*TRACK\s+(\d+)\s+AUDIO\b/i.exec(line);
      if (number && Number(number[1]) === requested) {
        selected = audio;
        break;
      }
    }
    const name = requested ? selected : first;
    if (!name || !AUDIO.test(name) || path.posix.isAbsolute(name) || name.split('/').includes('..')) return null;
    const linked = await this.checkedFile(path.posix.join(path.posix.dirname(cue[1]), name));
    return linked?.file;
  }

  async fileMetadata(track) {
    const file = await this.audioFile(track);
    if (!file) return null;
    let metadata;
    try { metadata = await this.probe(file); }
    catch (error) {
      if (error.code === 1 && !error.killed) return null;
      throw error;
    }
    const tags = Object.fromEntries(Object.entries(metadata.format?.tags || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const pictures = (metadata.streams || []).filter(s => s.disposition?.attached_pic === 1);
    const front = pictures.find(s => /front/i.test(s.tags?.comment || s.tags?.title || ''));
    const picture = front || pictures.find(s => !/(back|leaflet|artist|logo|disc)/i.test(s.tags?.comment || s.tags?.title || ''));
    return { file, tags, picture: picture?.index };
  }
}

module.exports = { LocalMusicLibrary, normalizedArt, localPath, browseUri, albumLocation, trackTagRows, field };

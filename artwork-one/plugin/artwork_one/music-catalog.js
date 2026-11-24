'use strict';

const path = require('node:path');
const { field } = require('./local-music-library');
const USER_AGENT = 'ArtworkOneVolumio/3.2 (https://github.com/kiriyk/volumio-custom-plugins)';
const MBID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const YEAR = /^\d{4}/;
const EDITION = /(?:[\s,–—-]+|[\s]*[([])(?<edition>(?:(?:super[\s-]*)?deluxe(?: edition)?|concert edition|(?:expanded|limited|anniversary|remastered|collector'?s)(?: edition)?|(?:us|uk|jp|japan(?:ese)?|eu|european|de|fr)(?: edition)?))(?:[)\]])?$/i;
const LIVE = /\b(?:live(?:\s+(?:at|in|on|from|album|edition))?|in concert|concert recording|concert edition)\b/i;
const COUNTRY = { us: 'US', uk: 'GB', jp: 'JP', japan: 'JP', japanese: 'JP', eu: 'XE', european: 'XE', de: 'DE', fr: 'FR' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const baseTitle = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\+/g, '&')
  .replace(/[^\p{L}\p{N}&]+/gu, ' ').replace(/\s*&\s*/g, ' & ').trim();
const lucene = s => '"' + String(s).replace(/["\\]/g, '\\$&') + '"';
const yearOf = s => YEAR.exec(s || '')?.[0];
const comparisonCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const list = x => Array.isArray(x) ? x : [];
const idOrEmpty = v => MBID.test(v || '') ? v : '';
const labelsFor = r => [...new Set(list(r['label-info']).map(x => x.label?.name).filter(Boolean))];
const artistNames = a => [a?.name, a?.['sort-name'], ...list(a?.aliases).map(x => x.name)];
const namesFor = d => list(d['artist-credit']).flatMap(x => [x.name, ...artistNames(x.artist)]);

function unique(items) {
  return [...new Map(items.filter(x => x?.id).map(x => [x.id, x])).values()];
}

async function remote(url, { fetcher = fetch, maxBytes = 2 * 1024 * 1024, allowHost, allowMissing = false } = {}) {
  const signal = AbortSignal.timeout(7000);
  let target = new URL(url);
  for (let hops = 0; hops <= 4; hops++) {
    if (target.protocol !== 'https:' && target.hostname !== '127.0.0.1') throw new Error('unsupported URL protocol');
    if (allowHost && !allowHost(target.hostname)) throw new Error('unexpected redirect host');
    const response = await fetcher(target, { signal, redirect: 'manual', headers: { 'User-Agent': USER_AGENT } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next) throw new Error('missing redirect URL');
      target = new URL(next, target);
      continue;
    }
    if (response.status === 404 && allowMissing) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok || Number(response.headers.get('content-length')) > maxBytes) {
      const error = new Error('provider HTTP ' + response.status);
      const retry = response.headers.get('retry-after');
      if (retry !== null) error.retryAfter = /^\d+$/.test(retry) ? Date.now() + 1000 * Number(retry) : Date.parse(retry);
      await response.body?.cancel();
      throw error;
    }
    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) throw new Error('provider response too large');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
    }
    return { body: Buffer.concat(chunks), type: response.headers.get('content-type') || '' };
  }
  throw new Error('too many redirects');
}

function folderEdition(track) {
  const folder = path.posix.basename(path.posix.dirname(track.replace(/\.cue\/track\d+$/i, '.cue')));
  const parts = /\(([^()]+)\)$/.exec(folder)?.[1].split(',').map(s => s.trim()) || [];
  const catalogCode = /^(?=[A-Z0-9 -]*\d)[A-Z0-9][A-Z0-9 -]{3,29}$/;
  const releaseYear = /\((?:repress|reissue)\s+(\d{4})\)/i.exec(folder)?.[1];
  if (parts.length === 3 && /^[A-Z]{2}$/.test(parts[0]) && catalogCode.test(parts[2])) {
    return { country: parts[0], catalog: parts[2], year: releaseYear };
  }
  if (parts.length === 2 && parts.every(p => catalogCode.test(p))) return { catalog: parts[0], year: releaseYear };
  return {};
}

function editionHints(title, tags, track = '') {
  let base = title;
  const folder = folderEdition(track);
  const hints = { title, live: LIVE.test(title), country: field(tags.releasecountry, tags.country, folder.country), deluxe: false,
    catalog: field(tags.catalognumber, tags.catalog_number, tags['catalog number'], folder.catalog),
    barcode: field(tags.barcode), year: folder.year || yearOf(field(tags.date, tags.year)),
    format: field(tags.media, tags.format) };
  for (let i = 0; i < 3; i++) {
    const match = EDITION.exec(base);
    if (!match || !base.slice(0, match.index).trim()) break;
    const edition = match.groups.edition.toLowerCase().replace(/ edition$/, '');
    hints.country ||= COUNTRY[edition] || '';
    hints.deluxe ||= /deluxe/.test(edition);
    base = base.slice(0, match.index).trim();
  }
  return { ...hints, base };
}

function liveGroup(group) {
  return list(group['secondary-types']).includes('Live') || LIVE.test(group.title || '');
}

function titleVariants(title) {
  return [...new Set([title, title.replace(/\+/g, '&'), title.replace(/&/g, '+')])];
}

function confirmedRelease(releases, hints) {
  if (!hints.catalog && !hints.barcode) return null;
  const matches = unique(releases).filter(release => {
    if (hints.catalog && !list(release['label-info']).some(x => comparisonCode(x['catalog-number']) === comparisonCode(hints.catalog))) return false;
    return !hints.barcode || comparisonCode(release.barcode) === comparisonCode(hints.barcode);
  });
  let remaining = matches;
  if (remaining.length > 1 && hints.country) remaining = remaining.filter(x => x.country === hints.country || list(x['release-events']).some(e => list(e.area?.['iso-3166-1-codes']).includes(hints.country)));
  if (remaining.length > 1 && hints.year) remaining = remaining.filter(x => yearOf(x.date) === hints.year);
  if (remaining.length > 1 && hints.format) remaining = remaining.filter(x => list(x.media).some(m => baseTitle(m.format) === baseTitle(hints.format)));
  if (remaining.length > 1 && hints.deluxe) remaining = remaining.filter(x => /deluxe/i.test(x.disambiguation || '') || /deluxe/i.test(x.title || ''));
  return remaining.length === 1 ? remaining[0] : null;
}

class MusicCatalog {
  constructor({ fetcher = fetch, interval = 1000, musicBrainzProxy } = {}) {
    this.fetcher = fetcher;
    this.musicBrainzProxy = musicBrainzProxy;
    this.interval = interval;
    this.nextRequest = 0;
    this.retryAfter = 0;
    this.chain = Promise.resolve();
    this.waiting = 0;
    this.closed = false;
  }

  async json(url, hosts, fetcher = this.fetcher) {
    const response = await remote(url, { fetcher, allowHost: hosts, allowMissing: true });
    return response ? JSON.parse(response.body.toString('utf8')) : null;
  }

  mb(entity, params) {
    if (this.waiting >= 64 || this.closed) return Promise.reject(new Error('catalog queue unavailable'));
    this.waiting++;
    const request = this.chain.then(async () => {
      if (this.retryAfter > Date.now()) throw Object.assign(new Error('catalog cooling down'), { retryAfter: this.retryAfter });
      const delay = Math.max(0, this.nextRequest - Date.now());
      if (delay) await sleep(delay);
      if (this.closed) throw new Error('catalog closed');
      this.nextRequest = Date.now() + this.interval;
      try {
        const proxy = this.musicBrainzProxy;
        const fetcher = proxy ? (url, options) => this.fetcher(url, { ...options, dispatcher: proxy }) : this.fetcher;
        return await this.json('https://musicbrainz.org/ws/2/' + entity + '?' + new URLSearchParams({ ...params, fmt: 'json' }), host => host === 'musicbrainz.org', fetcher);
      } catch (error) {
        if (Number.isFinite(error.retryAfter)) this.retryAfter = Math.max(this.retryAfter, error.retryAfter);
        throw error;
      }
    }).finally(() => { this.waiting--; });
    this.chain = request.catch(() => {});
    return request;
  }

  async artist(name) {
    const result = await this.mb('artist/', { query: 'artist:' + lucene(name) + ' OR alias:' + lucene(name), limit: '25' });
    const key = baseTitle(name);
    const matches = unique(list(result?.artists)).filter(x => artistNames(x).some(v => baseTitle(v) === key));
    return matches.length === 1 && (result.count || 0) <= 25 ? matches[0].id : null;
  }

  async album(entity, tags = {}) {
    const hints = editionHints(entity.title, tags, entity.track);
    hints.year ||= yearOf(entity.year);
    const directId = idOrEmpty(field(tags.musicbrainz_albumid, tags.musicbrainz_releaseid));
    if (directId) {
      const release = await this.mb('release/' + directId, { inc: 'release-groups+labels+artist-credits' });
      if (release?.['release-group']?.id && (!hints.live || liveGroup(release['release-group']))) {
        return this.match(release['release-group'], release);
      }
    }
    const acceptedNames = new Set([hints.title, hints.base].map(baseTitle));
    const artistKey = baseTitle(entity.artist);
    const artistMatches = record => namesFor(record).some(name => baseTitle(name) === artistKey);
    const directGroupId = idOrEmpty(tags.musicbrainz_releasegroupid);
    let group;
    if (directGroupId) {
      const candidate = await this.mb('release-group/' + directGroupId, { inc: 'artist-credits' });
      if (candidate && (!hints.live || liveGroup(candidate))) group = candidate;
    }
    const candidateGroups = new Map();
    if (!group) {
      for (const stage of new Set([hints.title, hints.base])) {
        for (const title of titleVariants(stage)) {
          const data = await this.mb('release-group/', {
            query: 'artist:' + lucene(entity.artist) + ' AND releasegroup:' + lucene(title), limit: '25'
          });
          if ((data?.count || 0) > 25) return null;
          for (const row of list(data?.['release-groups'])) {
            if (artistMatches(row) && acceptedNames.has(baseTitle(row.title)) && (!hints.live || liveGroup(row))) {
              candidateGroups.set(row.id, row);
            }
          }
        }
        if (candidateGroups.size) break;
      }
    }

    let release = null;
    if (hints.catalog || hints.barcode) {
      const query = [
        hints.catalog ? 'catno:' + lucene(hints.catalog) : 'barcode:' + lucene(hints.barcode),
        'artist:' + lucene(entity.artist),
        ...(group ? ['rgid:' + group.id] : [])
      ].join(' AND ');
      const result = await this.mb('release/', { query, limit: '25' });
      if ((result?.count || 0) <= 25) {
        release = confirmedRelease(list(result?.releases).filter(x =>
          artistMatches(x) && acceptedNames.has(baseTitle(x.title)) && x['release-group']?.id &&
          (!hints.live || liveGroup(x['release-group']))
        ), hints);
      }
    }
    if (release) return this.match(group || candidateGroups.get(release['release-group'].id) || release['release-group'], release);
    if (!group) {
      let groups = [...candidateGroups.values()];
      if (groups.length > 1 && entity.trackCount >= 7) {
        const fullLength = groups.filter(g => g['primary-type'] === 'Album');
        if (fullLength.length === 1 && groups.every(g => ['Album', 'Single'].includes(g['primary-type']))) groups = fullLength;
      }
      if (groups.length === 1) [group] = groups;
    }
    return group ? this.match(group, release) : null;
  }

  match(group, release) {
    const names = [...new Set(list((release || group)['artist-credit']).map(x => x.artist?.id).filter(Boolean))];
    return {
      groupId: group.id, releaseId: release?.id, artistId: names.length === 1 ? names[0] : undefined,
      firstYear: yearOf(group['first-release-date']), year: yearOf(release?.date),
      label: release && labelsFor(release).join(' · ') || undefined
    };
  }

  async summary(entity, id, locale) {
    const row = await this.mb(entity + '/' + id, { inc: 'url-rels' });
    const wikidata = list(row?.relations).find(x => x.type === 'wikidata')?.url?.resource;
    const qid = /\/(Q\d+)$/.exec(wikidata || '')?.[1];
    if (!qid) return null;
    const wiki = locale + 'wiki';
    const wd = await this.json('https://www.wikidata.org/w/api.php?' + new URLSearchParams({
      action: 'wbgetentities', ids: qid, props: 'sitelinks', sitefilter: wiki, format: 'json'
    }), host => host === 'www.wikidata.org');
    const title = wd?.entities?.[qid]?.sitelinks?.[wiki]?.title;
    if (!title) return null;
    const host = locale + '.wikipedia.org';
    const data = await this.json('https://' + host + '/w/api.php?' + new URLSearchParams({
      action: 'query', prop: 'extracts|info', inprop: 'url', titles: title, exintro: '1', explaintext: '1',
      redirects: '1', format: 'json', formatversion: '2'
    }), h => h === host);
    const page = data?.query?.pages?.[0];
    const text = page?.extract?.split(/\n\s*\n|\n/).map(s => s.trim()).find(Boolean)?.slice(0, 1400);
    if (!text || !page.fullurl || new URL(page.fullurl).hostname !== host) return null;
    return { text, url: page.fullurl };
  }

  async image(kind, id) {
    return remote('https://coverartarchive.org/' + kind + '/' + id + '/front-500', {
      fetcher: this.fetcher, maxBytes: 4 * 1024 * 1024, allowMissing: true,
      allowHost: host => host === 'coverartarchive.org' || host === 'archive.org' || host.endsWith('.archive.org')
    });
  }

  setProxy(proxy) {
    const previous = this.musicBrainzProxy;
    this.musicBrainzProxy = proxy;
    this.retryAfter = 0;
    void previous?.destroy().catch(() => {});
  }

  stop() {
    this.closed = true;
    this.setProxy(undefined);
  }
}

module.exports = { MusicCatalog, editionHints, confirmedRelease, remote };

'use strict';
const enc = encodeURIComponent;
function track(item) {
  return { service: 'qobuz_custom', type: 'song', uri: `qobuz_custom/track/${enc(item.id)}`,
    title: item.title, name: item.title, artist: (item.artists || []).join(', '), album: item.album || '',
    albumart: item.cover_url || '/albumart', duration: (item.duration_ms || 0) / 1000,
    trackType: 'flac', available: item.available !== false };
}
function item(value) {
  return value.type === 'track' ? track(value) : { service: 'qobuz_custom', type: 'folder',
    uri: `qobuz_custom/album/${enc(value.id)}`, title: value.title,
    artist: (value.artists || []).join(', '), albumart: value.cover_url || '/albumart' };
}
class Browse {
  constructor(api, t = key => key) { this.api = api; this.t = t; }
  resource(uri) {
    const url = new URL(uri, 'http://local/');
    const pathname = url.pathname.replace(/^\//, '');
    const parts = pathname.split('/');
    if (parts[0] !== 'qobuz_custom') throw new Error('BAD_REQUEST');
    let path;
    if (parts[1] === 'album' && /^[A-Za-z0-9]{1,64}$/.test(parts[2]) && parts.length === 3)
      path = `/v1/albums/${parts[2]}`;
    else if (pathname === 'qobuz_custom/library/albums') path = '/v1/library/albums';
    else if (parts[1] === 'search') path = `/v1/search?q=${enc(url.searchParams.get('q') || '')}&type=${enc(url.searchParams.get('type') || 'album')}`;
    else throw new Error('BAD_REQUEST');
    if (url.searchParams.has('cursor')) path += `${path.includes('?') ? '&' : '?'}cursor=${enc(url.searchParams.get('cursor'))}`;
    return path;
  }
  list(items, title = 'Qobuz') { return { title, availableListViews: ['list', 'grid'], items }; }
  async browse(uri) {
    let items, title = 'Qobuz';
    if (uri === 'qobuz_custom') {
      items = [{ service: 'qobuz_custom', type: 'folder', uri: 'qobuz_custom/library/albums', title: this.t('albums'), icon: 'fa-heart' }];
    } else {
      const page = await this.api.request('GET', this.resource(uri));
      items = page.items.map(item); title = page.title || 'Qobuz';
      if (page.next_cursor != null) {
        const [path, query = ''] = uri.split('?'); const params = new URLSearchParams(query);
        params.set('cursor', page.next_cursor);
        items.push({ service: 'qobuz_custom', type: 'folder', title: this.t('more'), icon: 'fa-chevron-right', uri: `${path}?${params}` });
      }
    }
    return { navigation: { prev: { uri: 'qobuz_custom' }, lists: [this.list(items, title)],
      info: { title, service: 'qobuz_custom', uri } } };
  }
  async search(query) {
    const text = typeof query === 'string' ? query : query?.value;
    if (!text?.trim()) return [];
    return Promise.all(['album', 'track'].map(async kind => {
      const page = await this.api.request('GET', `/v1/search?q=${enc(text)}&type=${kind}`);
      const items = page.items.map(item);
      if (page.next_cursor != null) items.push({ service: 'qobuz_custom', type: 'folder', title: this.t('more'),
        uri: `qobuz_custom/search?q=${enc(text)}&type=${kind}&cursor=${enc(page.next_cursor)}` });
      return this.list(items, `Qobuz · ${this.t(kind + 's')}`);
    }));
  }
  async explode(uri) {
    if (/^qobuz_custom\/track\/\d+$/.test(uri)) {
      const page = await this.api.request('GET', `/v1/tracks/${uri.split('/')[2]}`);
      if (!page.items.length || page.items[0].available === false) throw new Error('UNAVAILABLE');
      return page.items.map(track);
    }
    const base = this.resource(uri).split('?')[0];
    if (!base.startsWith('/v1/albums/')) throw new Error('UNAVAILABLE');
    let cursor = null; const seen = new Set(), result = [];
    do {
      const page = await this.api.request('GET', base + (cursor ? `?cursor=${enc(cursor)}` : ''));
      result.push(...page.items.filter(x => x.available !== false).map(track));
      if (result.length > 2000) throw new Error('QUEUE_LIMIT');
      cursor = page.next_cursor;
      if (cursor != null && seen.has(cursor)) throw new Error('SERVICE_UNAVAILABLE');
      seen.add(cursor);
    } while (cursor != null);
    if (!result.length) throw new Error('UNAVAILABLE');
    return result;
  }
}
module.exports = Browse;

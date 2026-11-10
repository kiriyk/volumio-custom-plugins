'use strict';
const { mapTrack, mapItem } = require('./track-mapper');
const enc = encodeURIComponent;

class Browse {
  constructor(api, translate = key => ({ tracks: 'Мне нравится', playlists: 'Мои плейлисты',
    albums: 'Мои альбомы', artists: 'Мои исполнители', more: 'Ещё', allTracks: 'Все треки', allAlbums: 'Все альбомы',
    searchTracks: 'Треки', searchAlbums: 'Альбомы', searchArtists: 'Исполнители', searchPlaylists: 'Плейлисты' }[key] || key), notify = () => {}) {
    this.api = api; this.t = translate; this.notify = notify;
  }
  parse(uri) {
    const [path, query = ''] = uri.split('?');
    const parts = path.split('/').map(decodeURIComponent);
    if (parts[0] !== 'yandex_music') throw new Error('BAD_REQUEST');
    return { parts, query: new URLSearchParams(query), path };
  }
  resource(uri) {
    const { parts, query } = this.parse(uri);
    let path;
    if (parts[1] === 'library' && ['tracks', 'playlists', 'albums', 'artists'].includes(parts[2]))
      path = `/v1/library/${parts[2]}`;
    else if (parts[1] === 'playlist' && parts.length === 4)
      path = `/v1/playlists/${enc(parts[2])}/${enc(parts[3])}`;
    else if (parts[1] === 'artist' && parts.length === 4 && ['tracks', 'albums'].includes(parts[3]))
      path = `/v1/artists/${enc(parts[2])}/${parts[3]}`;
    else if (['track', 'album', 'artist'].includes(parts[1]) && parts.length === 3)
      path = `/v1/${parts[1]}s/${enc(parts[2])}`;
    else if (parts[1] === 'search')
      path = `/v1/search?q=${enc(query.get('q') || '')}&type=${enc(query.get('type') || 'track')}`;
    else throw new Error('NOT_FOUND');
    if (query.has('cursor')) path += `${path.includes('?') ? '&' : '?'}cursor=${enc(query.get('cursor'))}`;
    return path;
  }
  list(items, title = 'Яндекс Музыка') {
    return { title, availableListViews: ['list', 'grid'], items };
  }
  async browse(uri) {
    const parsed = this.parse(uri);
    let items;
    if (parsed.parts.length === 1) {
      items = ['tracks', 'playlists', 'albums', 'artists'].map(section => ({
        service: 'yandex_music', type: 'folder', title: this.t(section),
        uri: `yandex_music/library/${section}`, icon: ({ tracks: 'fa-heart', playlists: 'fa-list', albums: 'fa-music', artists: 'fa-user' })[section] }));
    } else {
      const page = await this.api.request('GET', this.resource(uri));
      items = page.items.map(mapItem);
      if (parsed.parts[1] === 'track' && parsed.parts.length === 3) {
        const links = page.items.flatMap(item => item.artist_links || []);
        items.unshift(...links.filter(artist => artist.id).map(artist => ({ service: 'yandex_music',
          type: 'folder', title: artist.name, icon: 'fa-user', uri: `yandex_music/artist/${enc(artist.id)}` })));
      }
      if (parsed.parts[1] === 'artist' && parsed.parts.length === 3) {
        items.unshift(...['tracks', 'albums'].map(section => ({ service: 'yandex_music', type: 'folder',
          title: this.t(section === 'tracks' ? 'allTracks' : 'allAlbums'),
          icon: section === 'albums' ? 'fa-music' : 'fa-list',
          disablePlayButton: section === 'albums', uri: `${parsed.path}/${section}` })));
      }
      if (page.next_cursor !== null && page.next_cursor !== undefined) {
        parsed.query.set('cursor', page.next_cursor);
        items.push({ service: 'yandex_music', type: 'folder', title: this.t('more'),
          icon: 'fa-chevron-right', uri: `${parsed.path}?${parsed.query}` });
      }
    }
    return { navigation: { prev: { uri: 'yandex_music' },
      lists: [this.list(items)], info: { title: 'Яндекс Музыка', service: 'yandex_music', uri } } };
  }
  async search(query) {
    const text = typeof query === 'string' ? query : query.value;
    if (!text?.trim()) return [];
    return Promise.all(['track', 'album', 'artist', 'playlist'].map(async kind => {
      const page = await this.api.request('GET', `/v1/search?q=${enc(text)}&type=${kind}`);
      const items = page.items.map(mapItem);
      if (page.next_cursor !== null && page.next_cursor !== undefined)
        items.push({ service: 'yandex_music', type: 'folder', title: this.t('more'),
          uri: `yandex_music/search?q=${enc(text)}&type=${kind}&cursor=${enc(page.next_cursor)}` });
      return this.list(items, `Яндекс Музыка · ${this.t('search' + kind[0].toUpperCase() + kind.slice(1) + 's')}`);
    }));
  }
  async explode(uri) {
    const { parts } = this.parse(uri);
    if (parts[1] === 'artist' && !(parts.length === 4 && parts[3] === 'tracks')) throw new Error('UNAVAILABLE');
    const base = this.resource(uri).split('?')[0];
    const output = []; let cursor = null; let count = 0; let skipped = 0;
    const cursors = new Set();
    do {
      const page = await this.api.request('GET', base + (cursor ? `?cursor=${enc(cursor)}` : ''));
      count += page.items.length;
      if (count > 2000 || (count === 2000 && page.next_cursor)) throw new Error('QUEUE_LIMIT');
      for (const item of page.items) {
        if (item.type === 'track' && item.available !== false) output.push(mapTrack(item));
        else skipped++;
      }
      cursor = page.next_cursor;
      if (cursor && cursors.has(cursor)) throw new Error('SERVICE_UNAVAILABLE');
      cursors.add(cursor);
    } while (cursor !== null && cursor !== undefined);
    if (!output.length) throw new Error('UNAVAILABLE');
    if (skipped) this.notify('UNAVAILABLE_SKIPPED');
    return output;
  }
}
module.exports = Browse;

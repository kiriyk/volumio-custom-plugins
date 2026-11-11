'use strict';
const enc = encodeURIComponent;
function track(item) {
  return { service: 'qobuz_custom', type: 'song', uri: `qobuz_custom/track/${enc(item.id)}`,
    title: item.title, name: item.title, artist: (item.artists || []).join(', '), album: item.album || '',
    albumart: item.cover_url || '/albumart', duration: (item.duration_ms || 0) / 1000,
    artistLinks: (item.artist_links || []).map(a => ({name:a.name,uri:`qobuz_custom/artist/${enc(a.id)}`})),
    albumUri: item.album_id ? `qobuz_custom/album/${enc(item.album_id)}` : undefined,
    trackType: 'flac', available: item.available !== false };
}
function item(value) {
  if (value.type === 'track') return track(value);
  return { service: 'qobuz_custom', type: 'folder',
    uri: `qobuz_custom/${value.type}/${enc(value.id)}`, title: value.title,
    artist: (value.artists || []).join(', '), albumart: value.cover_url || undefined,
    icon: value.cover_url ? undefined : value.type === 'artist' ? 'fa-user' : 'fa-music',
    disablePlayButton: value.type === 'artist',
    artistLinks: (value.artist_links || []).map(a => ({ name:a.name,uri:`qobuz_custom/artist/${enc(a.id)}`})) };
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
    else if (pathname === 'qobuz_custom/library/artists') path = '/v1/library/artists';
    else if (parts[1] === 'artist' && /^\d+$/.test(parts[2]) && parts.length === 3) path = `/v1/artists/${parts[2]}`;
    else if (parts[1] === 'track' && /^\d+$/.test(parts[2]) && parts.length === 3) path = `/v1/tracks/${parts[2]}`;
    else if (parts[1] === 'search') path = `/v1/search?q=${enc(url.searchParams.get('q') || '')}&type=${enc(url.searchParams.get('type') || 'album')}`;
    else throw new Error('BAD_REQUEST');
    if (url.searchParams.has('cursor')) path += `${path.includes('?') ? '&' : '?'}cursor=${enc(url.searchParams.get('cursor'))}`;
    return path;
  }
  list(items, title = 'Qobuz') { return { title, availableListViews: ['list', 'grid'], items }; }
  async browse(uri) {
    let items, title = 'Qobuz', info = { title, service:'qobuz_custom', uri }, more = null;
    if (uri === 'qobuz_custom') {
      items = [
        {service:'qobuz_custom',type:'folder',uri:'qobuz_custom/library/albums',title:this.t('albums'),icon:'fa-heart',disablePlayButton:true},
        {service:'qobuz_custom',type:'folder',uri:'qobuz_custom/library/artists',title:this.t('artists'),icon:'fa-user',disablePlayButton:true},
        {service:'qobuz_custom',type:'folder',uri:'qobuz_custom/downloads',title:this.t('downloads'),icon:'fa-download',disablePlayButton:true}
      ];
    } else if (uri === 'qobuz_custom/downloads') {
      const jobs=await this.api.request('GET','/v1/downloads'); title=this.t('downloads');
      items=jobs.items.map(job=>({service:'qobuz_custom',type:'item-no-menu',uri:'qobuz_custom/downloads',
        title:`${job.title || job.track_id} · ${this.t(job.state)}`,artist:job.artist,icon:'fa-download',disablePlayButton:true}));
    } else {
      const page = await this.api.request('GET', this.resource(uri));
      items = page.items.map(item); title = page.title || 'Qobuz';
      if (/^qobuz_custom\/album\//.test(uri)) info = {...info,type:'album',albumart:items[0]?.albumart,artist:items[0]?.artist};
      if (page.artist) info = {...info,type:'artist',disablePlayButton:true,artist:page.artist.name,albumart:page.artist.cover_url};
      if (/^qobuz_custom\/track\//.test(uri) && page.items[0]) {
        const value=page.items[0];title=value.title;
        const links=(value.artist_links || []).map(a=>({service:'qobuz_custom',type:'folder',uri:`qobuz_custom/artist/${enc(a.id)}`,title:a.name,icon:'fa-user',disablePlayButton:true}));
        if (value.album_id) links.push({service:'qobuz_custom',type:'folder',uri:`qobuz_custom/album/${enc(value.album_id)}`,title:value.album || this.t('searchAlbums'),icon:'fa-music'});
        items=[...links,...items];
      }
      if (page.next_cursor != null) {
        const [path, query = ''] = uri.split('?'); const params = new URLSearchParams(query);
        params.set('cursor', page.next_cursor);
        more={service:'qobuz_custom',type:'folder',title:this.t('more'),icon:'fa-chevron-right',disablePlayButton:true,uri:`${path}?${params}`};
        if (!page.artist) items.push(more);
      }
    }
    info.title=title;
    const lists=[this.list(items,title)];
    if (info.type === 'artist' && more) lists.push({...this.list([more],''),awNavigation:true});
    return {navigation:{prev:{uri:'qobuz_custom'},lists,info}};
  }

  async search(query) {
    const text = typeof query === 'string' ? query : query?.value;
    if (!text?.trim()) return [];
    return Promise.all(['artist', 'album', 'track'].map(async kind => {
      const page = await this.api.request('GET', `/v1/search?q=${enc(text)}&type=${kind}`);
      const items = page.items.map(item);
      if (page.next_cursor != null) items.push({ service: 'qobuz_custom', type: 'folder', title: this.t('more'),
        uri: `qobuz_custom/search?q=${enc(text)}&type=${kind}&cursor=${enc(page.next_cursor)}` });
      return this.list(items, `Qobuz · ${this.t(kind === 'album' ? 'searchAlbums' : kind === 'artist' ? 'searchArtists' : 'tracks')}`);
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

'use strict';
const enc = encodeURIComponent;

function mapTrack(track) {
  return { service: 'yandex_music', type: 'song',
    uri: `yandex_music/track/${enc(track.id)}`, title: track.title, name: track.title,
    artist: (track.artists || []).join(', '), album: track.album || '',
    artistLinks: (track.artist_links || []).filter(a => a.id).map(a => ({ name: a.name, uri: `yandex_music/artist/${enc(a.id)}` })),
    albumart: track.cover_url || '/albumart', duration: (track.duration_ms || 0) / 1000,
    trackType: '', available: track.available !== false };
}
function mapItem(item) {
  if (item.type === 'track') return mapTrack(item);
  const uri = item.type === 'playlist'
    ? `yandex_music/playlist/${enc(item.owner)}/${enc(item.id)}`
    : `yandex_music/${item.type}/${enc(item.id)}`;
  return { service: 'yandex_music', type: 'folder', uri, title: item.title,
    artist: (item.artists || []).join(', '), albumart: item.cover_url || '/albumart',
    icon: item.type === 'artist' ? 'fa-user' : item.type === 'playlist' ? 'fa-list' : 'fa-music' };
}
module.exports = { mapTrack, mapItem };

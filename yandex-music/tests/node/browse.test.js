'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Browse = require('../../lib/browse');
const { mapTrack } = require('../../lib/track-mapper');

const track = { type: 'track', id: '12', title: 'Трек', artists: ['Артист'], album: 'Альбом',
  duration_ms: 123456, cover_url: 'https://avatars.yandex.net/image', available: true };

test('queue metadata contains stable service URI and seconds, never stream URLs', () => {
  const mapped = mapTrack(track);
  assert.equal(mapped.uri, 'yandex_music/track/12');
  assert.equal(mapped.duration, 123.456);
  assert.equal(mapped.service, 'yandex_music');
  assert.equal(mapped.albumart, 'https://avatars.yandex.net/image');
});

test('track links retain artist identity for navigation', () => {
  const mapped = mapTrack({ ...track, artist_links: [{ id: '42', name: 'Артист' }] });
  assert.deepEqual(mapped.artistLinks, [{ name: 'Артист', uri: 'yandex_music/artist/42' }]);
});

test('track details provide a separate folder for each artist', async () => {
  const api = { request: async () => ({ items: [{ ...track, artist_links: [{ id: '42', name: 'Артист' }] }], next_cursor: null }) };
  const page = await new Browse(api).browse('yandex_music/track/12');
  assert(page.navigation.lists[0].items.some(item => item.uri === 'yandex_music/artist/42' && item.type === 'folder'));
});

test('root and paged collection use native navigation and escaped continuation URI', async () => {
  const api = { request: async () => ({ items: [track], next_cursor: '50' }) };
  const browse = new Browse(api);
  const root = await browse.browse('yandex_music');
  assert.equal(root.navigation.lists[0].items.length, 4);
  const page = await browse.browse('yandex_music/library/tracks');
  assert.equal(page.navigation.lists[0].items[0].title, 'Трек');
  assert.equal(page.navigation.lists[0].items.at(-1).uri, 'yandex_music/library/tracks?cursor=50');
});

test('playlist expansion follows pages, preserves duplicate order and omits unavailable tracks', async () => {
  const api = { request: async (method, path) => path.includes('cursor=2')
    ? { items: [track], next_cursor: null }
    : { items: [track, { ...track, id: '99', available: false }], next_cursor: '2' } };
  const messages = [];
  const browse = new Browse(api, undefined, message => messages.push(message));
  const queue = await browse.explode('yandex_music/playlist/123/42');
  assert.deepEqual(queue.map(item => item.uri), ['yandex_music/track/12', 'yandex_music/track/12']);
  assert.equal(messages.length, 1);
});

test('search returns Volumio lists for all four supported result types', async () => {
  const api = { request: async (method, path) => ({ items: path.includes('type=track') ? [track] : [], next_cursor: null }) };
  const result = await new Browse(api).search({ value: 'Трек' });
  assert.equal(result.length, 4);
  assert.equal(result[0].title, 'Яндекс Музыка · Треки');
  assert.equal(result[0].items[0].uri, 'yandex_music/track/12');
});

test('empty and entirely unavailable expansion fails rather than starting another track', async () => {
  const api = { request: async () => ({ items: [], next_cursor: null }) };
  await assert.rejects(new Browse(api).explode('yandex_music/album/1'), /UNAVAILABLE/);
});

test('artist page links to paged complete tracks and albums', async () => {
  const paths = [];
  const api = { request: async (method, path) => { paths.push(path); return { items: [track], next_cursor: '1' }; } };
  const browse = new Browse(api);
  const artist = await browse.browse('yandex_music/artist/42');
  const items = artist.navigation.lists[0].items;
  assert(items.some(item => item.uri === 'yandex_music/artist/42/tracks'));
  assert(items.some(item => item.uri === 'yandex_music/artist/42/albums'));
  const page = await browse.browse('yandex_music/artist/42/tracks?cursor=1');
  assert.equal(paths.at(-1), '/v1/artists/42/tracks?cursor=1');
  assert.equal(page.navigation.lists[0].items.at(-1).uri, 'yandex_music/artist/42/tracks?cursor=1');
});

test('all artist tracks can be added to the queue', async () => {
  const api = { request: async () => ({ items: [track], next_cursor: null }) };
  const tracks = await new Browse(api).explode('yandex_music/artist/42/tracks');
  assert.equal(tracks[0].uri, 'yandex_music/track/12');
});

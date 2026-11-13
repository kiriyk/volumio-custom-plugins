import { test } from 'node:test';
import assert from 'node:assert/strict';
import { librarySectionArtwork } from '../src/core/libraryArtwork.ts';

const sections = [
  ['qobuz_custom/library/albums', '/library-albums-qobuz.svg'],
  ['qobuz_custom/library/artists', '/library-artists-qobuz.svg'],
  ['qobuz_custom/downloads', '/library-downloads-qobuz.svg'],
  ['yandex_music/library/tracks', '/library-tracks-yandex.svg'],
  ['yandex_music/library/playlists', '/library-playlists-yandex.svg'],
  ['yandex_music/library/albums', '/library-albums-yandex.svg'],
  ['yandex_music/library/artists', '/library-artists-yandex.svg'],
];

test('all provider root collection tiles receive artwork independent of translated labels', () => {
  for (const [uri, artwork] of sections) {
    assert.equal(librarySectionArtwork({ uri, type: 'folder', title: 'Моя коллекция' }), artwork, uri);
  }
});

test('provider artwork takes precedence over section covers', () => {
  for (const [uri] of sections) {
    assert.equal(librarySectionArtwork({ uri, type: 'folder', albumart: 'https://example.com/cover.jpg' }), undefined);
  }
});

test('pagination and unrelated resources keep their existing artwork behavior', () => {
  const otherUris = ['', 'qobuz_custom', 'yandex_music', 'qobuz_custom/album/123', 'yandex_music/album/123',
    'qobuz_custom/library/tracks', 'qobuz_custom/library/playlists', 'albums://',
    ...sections.map(([uri]) => uri + '?cursor=20')];
  for (const uri of otherUris) {
    assert.equal(librarySectionArtwork({ uri, type: 'folder', title: 'Мои альбомы' }), undefined, uri);
  }
});

test('download jobs sharing the collection URI do not become section tiles', () => {
  assert.equal(librarySectionArtwork({ uri: 'qobuz_custom/downloads', type: 'item-no-menu' }), undefined);
});

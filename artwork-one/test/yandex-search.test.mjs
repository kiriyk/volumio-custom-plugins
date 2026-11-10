import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isYandexRoot, needsYandexListHead } from '../src/core/yandexSearch.ts';

test('only the Yandex source root has its own service search header', () => {
  assert.equal(isYandexRoot('yandex_music'), true);
  assert.equal(isYandexRoot('yandex_music/artist/42'), false);
  assert.equal(isYandexRoot('music-library'), false);
});

test('all Yandex pages without a specific page type keep their breadcrumb header', () => {
  for (const uri of ['yandex_music', 'yandex_music/artist/42', 'yandex_music/album/42', 'yandex_music/playlist/2/1', 'yandex_music/artist/42/tracks']) {
    assert.equal(needsYandexListHead(uri, undefined), true, uri);
  }
  assert.equal(needsYandexListHead('yandex_music/artist/42', 'artist'), false);
  assert.equal(needsYandexListHead('music-library', undefined), false);
});

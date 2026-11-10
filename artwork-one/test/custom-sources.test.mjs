import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCustomMusicRoot, isCustomMusicPage, needsCustomMusicListHead } from '../src/core/customMusicSources.ts';

test('Qobuz and Yandex roots support service search without losing nested breadcrumbs', () => {
  for (const uri of ['qobuz_custom', 'yandex_music']) {
    assert.equal(isCustomMusicRoot(uri), true);
    assert.equal(isCustomMusicPage(uri + '/album/abc'), true);
    assert.equal(needsCustomMusicListHead(uri + '/album/abc', undefined), true);
    assert.equal(isCustomMusicRoot(uri + '/album/abc'), false);
  }
  assert.equal(isCustomMusicPage('qobuz_custom_other/album/a'), false);
  assert.equal(needsCustomMusicListHead('music-library', undefined), false);
});

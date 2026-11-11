import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customService, customCrumbs, playbackQualityState } from '../src/core/customNavigation.ts';

test('source follows stable track URI even when core says mpd', () => {
  assert.equal(customService('qobuz_custom/track/42'), 'qobuz_custom');
  assert.equal(customService('yandex_music/track/42'), 'yandex_music');
  assert.equal(customService('music-library/USB/file.flac'), null);
});
test('direct opening from search still has Qobuz breadcrumb', () => {
  const trail = [{ uri: 'qobuz_custom/album/abc', title: 'Album' }];
  const result = customCrumbs(trail, 'qobuz_custom/album/abc', []);
  assert.equal(result[0].uri, 'qobuz_custom');
  assert.equal(result[0].title, 'Qobuz');
  assert.deepEqual(customCrumbs([], 'qobuz_custom', []), []);
});
test('quality clears misleading MPD bitrate and uses actual matching result', () => {
  const raw = { service:'mpd',uri:'qobuz_custom/track/42',trackType:'mp4',bitrate:'999 Kbps' };
  const state = playbackQualityState(raw,{uri:raw.uri,codec:'flac',sampleRate:44100,bitDepth:24});
  assert.equal(state.service,'qobuz_custom');assert.equal(state.trackType,'flac');
  assert.equal(state.samplerate,'44.1 kHz');assert.equal(state.bitdepth,'24 bit');
  assert.equal(state.bitrate,undefined);
  assert.equal(playbackQualityState(raw,{uri:'qobuz_custom/track/99',codec:'flac',bitDepth:16}).bitdepth,undefined);
});

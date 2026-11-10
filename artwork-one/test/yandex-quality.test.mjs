import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actualYandexQuality } from '../src/core/yandexQuality.ts';

test('formats only measured Yandex stream quality', () => {
  assert.deepEqual(actualYandexQuality({ codec: 'flac-mp4', sampleRate: 44100, bitDepth: 16 }), { trackType: 'flac', samplerate: '44.1 kHz', bitdepth: '16 bit' });
  assert.deepEqual(actualYandexQuality({ codec: 'mp3' }), { trackType: 'mp3' });
});

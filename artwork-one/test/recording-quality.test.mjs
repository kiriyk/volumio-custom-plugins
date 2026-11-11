import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRecordingQuality, artistCountLabel } from '../src/core/recordingQuality.ts';

test('catalog quality shows explicit figures without guessing unknown values', () => {
  assert.equal(formatRecordingQuality({codec:'flac',bitDepth:24,sampleRate:96000,basis:'catalog'}), 'FLAC · 24 бит / 96 кГц');
  assert.equal(formatRecordingQuality({codec:'flac',bitDepth:16,sampleRate:44100,basis:'catalog'}), 'FLAC · 16 бит / 44.1 кГц');
  assert.equal(formatRecordingQuality({codec:'flac',basis:'available'}), 'FLAC');
  assert.equal(formatRecordingQuality({codec:'mp3',bitrate:320,basis:'available'}), 'MP3 · 320 кбит/с');
  assert.equal(formatRecordingQuality(null), '');
  assert.equal(formatRecordingQuality({codec:'unknown'}), '');
});

test('artist counts cannot survive artist to album navigation on reused rows', () => {
  const saved = {uri:'artists://Artist',text:'1 album · 5 tracks'};
  assert.equal(artistCountLabel({uri:saved.uri,type:'folder'},true,saved), saved.text);
  assert.equal(artistCountLabel({uri:'mnt/USB/Album/1.flac',type:'song'},false,saved), '');
  assert.equal(artistCountLabel({uri:'artists://Other',type:'folder'},true,saved), '');
  assert.equal(artistCountLabel({uri:saved.uri,type:'song'},true,saved), '');
});

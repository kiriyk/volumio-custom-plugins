'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseCue, sampleRange} = require('../../lib/cue');

const adele = 'FILE "Adele - 30.flac" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n INDEX 00 03:01:00\n INDEX 01 03:02:12\n';

test('resolves numeric CUE track and exact Adele sample boundaries', () => {
  const segment = parseCue(adele, 'track0001');
  assert.deepEqual(segment, {file: 'Adele - 30.flac', startFrame: 0, endFrame: 13662});
  assert.deepEqual(sampleRange(segment, 44100, 185517528), {startSample: 0, endSample: 8033256});
  assert.equal(parseCue(adele, 2).startFrame, 13662);
  assert.equal(parseCue(adele, 'track0002').endFrame, null);
});

test('multi-file CUE keeps offsets within each file and accepts quoted Unicode paths', () => {
  const cue = 'REM metadata\r\nFILE "диск один/Музыка.flac" WAVE\r\nTRACK 01 AUDIO\r\nINDEX 01 00:01:00\r\nTRACK 02 AUDIO\r\nINDEX 01 01:00:00\r\nFILE "диск два.flac" WAVE\r\nTRACK 03 AUDIO\r\nINDEX 01 00:00:00\r\n';
  assert.equal(parseCue(cue, 1).endFrame, 4500);
  const last = parseCue(cue, 2);
  assert.equal(last.file, 'диск один/Музыка.flac');
  assert.equal(last.endFrame, null);
  assert.deepEqual(sampleRange(last, 44100, 3000000), {startSample: 2646000, endSample: 3000000});
  assert.equal(parseCue(cue, 3).startFrame, 0);
});

test('rejects malformed track declarations, indexes, timestamps and unavailable targets', () => {
  for (const cue of ['', 'TRACK 01 AUDIO\nINDEX 01 00:00:00', adele.replace('TRACK 01 AUDIO', 'TRACK 01 MODE1/2352'), adele.replace('INDEX 01 00:00:00', ''), adele.replace('03:02:12', '03:60:12'), adele.replace('03:02:12', '03:02:75'), adele.replace('03:02:12', 'x'), adele + 'INDEX 01 04:00:00', adele.replace('TRACK 02', 'TRACK 01'), adele.replace('03:02:12', '00:00:00'), adele + 'TRACK 03 AUDIO', 'x'.repeat(1048577)]) {
    assert.throws(() => parseCue(cue, 1), undefined, cue.slice(0, 100));
  }
  for (const target of [0, -1, 3, 'track0001suffix', '1', 'track1', NaN]) assert.throws(() => parseCue(adele, target));
});

test('rejects unsafe FILE paths and malformed FILE syntax', () => {
  for (const file of ['/etc/passwd', '../outside.flac', 'inside/../outside.flac', 'C:\\music\\a.flac', '\\\\host\\a.flac', 'https://host/a.flac', 'a\\b.flac', '.', 'a//b.flac']) {
    assert.throws(() => parseCue(adele.replace('Adele - 30.flac', file), 1), undefined, file);
  }
  for (const declaration of ['FILE "unclosed WAVE', 'FILE "a.flac"', 'FILE "" WAVE']) assert.throws(() => parseCue(adele.replace('FILE "Adele - 30.flac" WAVE', declaration), 1));
});

test('sample conversion rejects rounding, overflow and ranges outside the source', () => {
  for (const args of [[{startFrame: 1, endFrame: 2}, 32000, 10000], [{startFrame: 0, endFrame: 75}, 44100, 44099], [{startFrame: 75, endFrame: null}, 44100, 44100], [{startFrame: -1, endFrame: null}, 44100, 100000], [{startFrame: 0, endFrame: null}, 0, 1], [{startFrame: 0, endFrame: null}, 44100, 1.5], [{startFrame: Number.MAX_SAFE_INTEGER, endFrame: null}, 44100, Number.MAX_SAFE_INTEGER]]) assert.throws(() => sampleRange(...args));
});

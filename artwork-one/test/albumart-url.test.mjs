import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAlbumartPath } from '../src/core/albumartUrl.ts';

const cue = '/mnt/USB/External_HD/Adele - 30 - 2021 [Japan]/Adele - 30.cue';
const directory = '/mnt/USB/External_HD/Adele - 30 - 2021 [Japan]';

test('CUE album cover requests search their directory while preserving other query bytes', () => {
  const before = '/albumart?cacheid=260&web=Adele/30/extralarge&path=' + encodeURIComponent(cue) + '&icon=dot-circle-o&metadata=false';
  const expected = '/albumart?cacheid=260&web=Adele/30/extralarge&path=' + encodeURIComponent(directory) + '&icon=dot-circle-o&metadata=false';
  assert.equal(normalizeAlbumartPath(before), expected);
});

test('virtual CUE tracks and uppercase CUE extensions use their album directory', () => {
  for (const suffix of ['.cue/track0001', '.CUE/track12', '.cue']) {
    const input = '/albumart?path=' + encodeURIComponent('/USB/Музыка/A+B 100%/Disc' + suffix);
    assert.equal(normalizeAlbumartPath(input), '/albumart?path=' + encodeURIComponent('/USB/Музыка/A+B 100%'));
  }
});

test('unescaped paths, query spaces and URL fragments are retained safely', () => {
  assert.equal(normalizeAlbumartPath('/albumart?path=/USB/My+Album/disc.cue&web=A%2FB#cover'),
    '/albumart?path=%2FUSB%2FMy%20Album&web=A%2FB#cover');
});

test('normal audio, folder and image requests keep their existing behavior', () => {
  for (const path of ['/USB/Album', '/USB/Album/song.flac', '/USB/Album/cover.jpg', '/USB/a.cue.backup', '/USB/a.cue/cover.jpg']) {
    const input = '/albumart?path=' + encodeURIComponent(path);
    assert.equal(normalizeAlbumartPath(input), input);
  }
});

test('external URLs, unrelated endpoints, malformed values and absent paths are unchanged', () => {
  for (const input of ['', '/albumart', '/albumart?web=Artist/Album', '/albumart?path=%ZZ',
    '/image?path=%2FUSB%2Fdisc.cue', '//example.com/albumart?path=%2Fdisc.cue',
    'https://example.com/albumart?path=%2Fdisc.cue', '/albumart?path=', '/albumart?web=Artist#cover&path=%2FUSB%2Fdisc.cue']) {
    assert.equal(normalizeAlbumartPath(input), input);
  }
});

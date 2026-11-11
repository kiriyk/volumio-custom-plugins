import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canOpenTrackInfo, trackInfoFolder } from '../src/core/nowPlayingNavigation.ts';
const track = {uri:'qobuz_custom/track/42',service:'mpd',artist:'Artist',album:'Record'};
test('Qobuz reads native track detail and follows artist and album folders', async () => {
  const calls=[];
  const browse=async (...args)=>{calls.push(args);return {navigation:{lists:[{items:[{type:'song',uri:track.uri},{type:'folder',uri:'qobuz_custom/artist/7',title:'Artist'},{type:'folder',uri:'qobuz_custom/album/ab12',title:'Record'}]}]}};};
  assert.equal((await trackInfoFolder(track,'artist',browse)).uri,'qobuz_custom/artist/7');
  assert.equal((await trackInfoFolder(track,'album',browse)).uri,'qobuz_custom/album/ab12');
  assert.deepEqual(calls,[['browse',{uri:track.uri}],['browse',{uri:track.uri}]]);
  assert.equal(canOpenTrackInfo(track),true);
});
test('untrusted and missing folders use only source scoped search', async () => {
  const browse=async()=>({navigation:{lists:[{items:[{type:'folder',uri:'https://example.org/album/1'},{type:'folder',uri:'qobuz_custom/album/a?url=evil'}]}]}});
  assert.equal((await trackInfoFolder(track,'album',browse)).uri,'qobuz_custom/search?q=Record&type=album');
  assert.equal((await trackInfoFolder(track,'artist',async()=>{throw new Error('offline');})).uri,'qobuz_custom/search?q=Artist&type=artist');
});
test('Yandex follows native artist and falls back to album search', async () => {
  const yandex={...track,uri:'yandex_music/track/4',service:'yandex_music'};
  const browse=async()=>({navigation:{lists:[{items:[{type:'folder',uri:'yandex_music/artist/2',title:'Artist'}]}]}});
  assert.equal((await trackInfoFolder(yandex,'artist',browse)).uri,'yandex_music/artist/2');
  assert.equal((await trackInfoFolder(yandex,'album',browse)).uri,'yandex_music/search?q=Record&type=album');
});
test('local MPD has encoded native links without requesting track detail',async()=>{
  const local={service:'mpd',uri:'music-library/USB/a.flac',artist:'A/B',album:'C D'};
  const browse=()=>{throw new Error('must not query');};
  assert.equal((await trackInfoFolder(local,'artist',browse)).uri,'artists://A%2FB');
  assert.equal((await trackInfoFolder(local,'album',browse)).uri,'albums://A%2FB/C%20D');
  assert.equal(await trackInfoFolder({...local,service:'webradio'},'album',browse),null);
});
